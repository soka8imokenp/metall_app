/**
 * Живая проверка раздела «Производство» в боте на данных стенда.
 *
 * Только чтение: заказы цеха, карточка, этапы, мои задания, сводка цеха и
 * журнал отклонений собираются на настоящих данных стенда. Отметки этапа,
 * выпуск и брак здесь не нажимаем — у заказчика на стенде свои заказы и свой
 * склад, и проверка не должна их двигать. Запись проверена на базе разработки
 * (`test/bot-production.e2e`).
 */
import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { BotModule } from '../dist/bot/bot.module.js';
import { BotProduction } from '../dist/bot/production.bot.js';
import { AuthService } from '../dist/auth/auth.service.js';

const LOGIN = process.argv[2] ?? 'master';

const plain = (s) =>
  (s ?? '')
    .replace(/<blockquote>|<\/blockquote>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/ /g, ' ');

const app = await NestFactory.createApplicationContext(BotModule, { logger: ['error'] });
const prod = app.get(BotProduction);
const auth = app.get(AuthService);

const db = new Client({ connectionString: process.env.OWNER_URL });
await db.connect();
const user = await db.query('SELECT id FROM user_account WHERE login = $1', [LOGIN]);
if (!user.rows[0]) throw new Error(`нет такого человека: ${LOGIN}`);
const userId = BigInt(user.rows[0].id);
const access = await auth.loadProfile(userId);
const companies = await auth.companies(access.companyIds);
const me = {
  userId,
  permissions: access.permissions,
  companyIds: access.companyIds,
  companies: companies.map((c) => ({ id: c.id, uid: c.uid, nameRu: c.nameRu, nameUz: c.nameUz })),
};

let flow = null;
let screen = null;
const bad = [];
const show = (title) => {
  const text = plain(screen.text);
  console.log(`\n######## ${title}  (${text.length} знаков)`);
  console.log(text);
  console.log(
    'КНОПКИ: ' +
      screen.keyboard.map((row) => row.map((b) => b.text).join(' | ')).join(' // '),
  );
  // Подпись панели в Telegram — 1024 знака, лишнее он обрезает молча.
  if (text.length > 1024) bad.push(`${title}: подпись ${text.length} знаков, не влезает`);
};
async function press(data, title) {
  screen = await prod.route(me, flow, data, false);
  if (screen.flow !== undefined) flow = screen.flow;
  show(title);
}

await press('p', 'раздел');
await press('p:me', 'мои задания');
await press('p:sh', 'что в цеху сейчас');
await press('p:dv', 'отклонения за 30 дней');
await press('p:s:active', 'заказы в работе');

// Смотрим заказ, у которого этапы развёрнуты: без них показывать нечего, а в
// цеху на экран смотрят именно ради них.
const orders = screen.keyboard.flat().filter((b) => b.data.startsWith('p:c:'));
if (orders.length === 0) {
  bad.push('в работе нет ни одного заказа — карточку смотреть не на чем');
} else {
  let withStages = null;
  for (const o of orders) {
    screen = await prod.route(me, null, o.data, false);
    if (screen.keyboard.flat().some((b) => b.data.startsWith('p:g:'))) {
      withStages = o;
      break;
    }
  }
  await press((withStages ?? orders[0]).data, 'карточка заказа');
  const stages = screen.keyboard.flat().find((b) => b.data.startsWith('p:g:'));
  if (!stages) {
    bad.push('ни у одного заказа в работе нет этапов');
  } else {
    await press(stages.data, 'этапы заказа');
    const one = screen.keyboard.flat().find((b) => b.data.startsWith('p:t:'));
    if (one) await press(one.data, 'этап');
  }
}

const moved = await db.query(
  `SELECT (SELECT count(*)::int FROM stock_move WHERE created_at > now() - interval '5 minutes') AS moves,
          (SELECT count(*)::int FROM production_stage_event WHERE occurred_at > now() - interval '5 minutes') AS marks,
          (SELECT count(*)::int FROM production_output WHERE occurred_at > now() - interval '5 minutes') AS outputs`,
);
console.log(
  `\nпроверка записала: движений ${moved.rows[0].moves}, отметок ${moved.rows[0].marks}, выпусков ${moved.rows[0].outputs}`,
);
if (moved.rows[0].moves + moved.rows[0].marks + moved.rows[0].outputs > 0) {
  bad.push('проверка на чтение что-то записала');
}

console.log('\n---');
console.log(bad.length === 0 ? 'ОК: раздел читается, ничего не записано' : 'НЕ ОК:\n  ' + bad.join('\n  '));
await db.end();
await app.close();
process.exit(bad.length ? 1 : 0);
