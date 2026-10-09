/**
 * Живая проверка раздела «Финансы» в боте на данных стенда.
 *
 * Зовёт те же методы, что зовёт разговор в Telegram, но без Telegram: кнопки
 * нажимаются по подписям, которые бот показал. Так видно, что экраны собираются
 * на настоящих справочниках стенда, а не только на сеяных данных разработки.
 *
 * Операции, которые проверка заводит, она же и убирает: на стенде смотрит
 * заказчик, и лишние платежи в его отчётах — мусор. Журнал действий остаётся:
 * он закрыт на дозапись, и это правильно.
 *
 * Запуск (адреса базы — из окружения стенда):
 *   APP_DATABASE_URL=... OWNER_URL=... TELEGRAM_BOT_TOKEN=probe \
 *   node qa/stand-bot-finance.mjs director
 */
import 'reflect-metadata';
// Подпись токенов и прочее общее окружение — из `.env` рабочего каталога.
// Адрес базы задан переменной снаружи, и dotenv его не перетирает.
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { BotModule } from '../dist/bot/bot.module.js';
import { BotFinance } from '../dist/bot/finance.bot.js';
import { AuthService } from '../dist/auth/auth.service.js';

const LOGIN = process.argv[2] ?? 'director';

const plain = (s) =>
  (s ?? '')
    .replace(/<blockquote>|<\/blockquote>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/ /g, ' ');

const app = await NestFactory.createApplicationContext(BotModule, { logger: ['error'] });
const fin = app.get(BotFinance);
const auth = app.get(AuthService);

const db = new Client({ connectionString: process.env.OWNER_URL });
await db.connect();
const from = (await db.query('SELECT now()::text AS now')).rows[0].now;
const user = await db.query('SELECT id FROM user_account WHERE login = $1', [LOGIN]);
if (!user.rows[0]) throw new Error(`нет такого человека: ${LOGIN}`);
const userId = BigInt(user.rows[0].id);
const access = await auth.loadProfile(userId);
const companies = await auth.companies(access.companyIds);
const me = {
  userId,
  permissions: access.permissions,
  companyIds: access.companyIds,
  companies: companies.map((c) => ({
    id: c.id,
    uid: c.uid,
    nameRu: c.nameRu,
    nameUz: c.nameUz,
  })),
};
console.log(`${LOGIN}: прав ${access.permissions.size}, компаний ${companies.length}`);

let flow = null;
let screen = null;

function show(title) {
  console.log(`\n--- ${title}`);
  console.log(plain(screen.text));
  console.log(`[${screen.keyboard.flat().map((b) => b.text).join('] [')}]`);
}
async function press(data, title) {
  screen = await fin.route(me, flow, data, false);
  if (screen.flow !== undefined) flow = screen.flow;
  show(title);
}
async function tap(prefix, title) {
  const i = screen.keyboard.flat().findIndex((b) => b.text.startsWith(prefix));
  if (i < 0) throw new Error(`нет кнопки «${prefix}»: ${screen.keyboard.flat().map((b) => b.text)}`);
  await press(screen.keyboard.flat()[i].data, title ?? prefix);
}
async function say(text, title) {
  screen = await fin.text(me, flow, text, false);
  if (screen.flow !== undefined) flow = screen.flow;
  show(title);
}

await press('f', 'раздел');
await press('f:n:e', 'новый расход');
if (companies.length > 1) await tap('ООО', 'компания');
await say('450 000', 'сумма с пробелами');
await tap('Оплата поставщикам', 'статья');
await tap('Касса', 'счёт');
await tap('➡️', 'контрагент пропущен');
await tap('Сегодня', 'дата');
await tap('➡️', 'примечание пропущено');
await tap('✅ Записать', 'записано');

const number = plain(screen.text).match(/(РП|ПП)-\d{6}/)[0];
await tap('📤', 'подтверждение отправки');
await tap('Да —', 'отправлено');
await tap('✅ Согласовать', 'подтверждение согласования');
await tap('Да —', 'согласовано');
await tap('💸 Провести', 'подтверждение проведения');
await tap('Да —', 'проведено');

const posted = await db.query(
  `SELECT o.status::text, (SELECT count(*)::int FROM finance_entry e WHERE e.operation_id = o.id) AS entries,
          (SELECT coalesce(sum(debit),0)::text FROM finance_entry e WHERE e.operation_id = o.id) AS debit,
          (SELECT coalesce(sum(credit),0)::text FROM finance_entry e WHERE e.operation_id = o.id) AS credit
     FROM finance_operation o WHERE o.number = $1`,
  [number],
);
console.log(`\n${number}: ${posted.rows[0].status}, проводок ${posted.rows[0].entries}, дебет ${posted.rows[0].debit}, кредит ${posted.rows[0].credit}`);

await tap('↩️ Сторно', 'подтверждение сторно');
await tap('Да —', 'сторно сделано');
await press('f:l', 'список операций');
await press('f:w', 'ждут решения');
await press('f:d', 'долги');
await press('f:pf', 'план и факт');

const audit = await db.query(
  `SELECT action, source::text FROM audit_log
    WHERE entity_type = 'finance_operation' AND occurred_at >= $1 ORDER BY id`,
  [from],
);
console.log(`\nжурнал: ${audit.rows.map((r) => `${r.action}/${r.source}`).join(', ')}`);

// Убираем за собой: заявка проверки не должна жить в отчётах заказчика.
const where = `created_at >= $1 AND created_by = $2`;
await db.query(
  `DELETE FROM finance_entry WHERE operation_id IN (SELECT id FROM finance_operation WHERE ${where})`,
  [from, String(userId)],
);
await db.query(
  `DELETE FROM finance_operation WHERE ${where} AND reversal_of_id IS NOT NULL`,
  [from, String(userId)],
);
const gone = await db.query(`DELETE FROM finance_operation WHERE ${where}`, [from, String(userId)]);
const left = await db.query(
  `SELECT count(*)::int AS n FROM finance_operation WHERE ${where}`,
  [from, String(userId)],
);
console.log(`\nубрано операций: ${gone.rowCount}, осталось: ${left.rows[0].n}`);

await db.end();
await app.close();
