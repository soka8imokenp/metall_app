/**
 * Документы в боте на стенде: проверка только чтением.
 *
 * Статусы документов на стенде смотрит заказчик, поэтому прогон ничего не
 * двигает: ни согласования, ни отмены. Файлы тоже не просит — сборка PDF
 * кладёт его в хранилище и помечает документ, а это запись. Печать проверена
 * на базе разработки (`test/bot-documents.e2e`).
 *
 * Проверяется то, что без живой базы не проверить: вкладки реестра отдаются,
 * карточка собирается со строками, статус объяснён словами, а кнопки маршрута
 * совпадают с тем, что разрешает служба этому человеку.
 *
 * Запуск: APP_DATABASE_URL=<стенд> node qa/stand-bot-documents.mjs [логин]
 */
import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { BotModule } from '../dist/bot/bot.module.js';
import { BotDocuments } from '../dist/bot/documents.bot.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';

const LOGIN = process.argv[2] ?? 'accountant';

const plain = (s) =>
  (s.text ?? '')
    .replace(/<blockquote>|<\/blockquote>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[  ]/g, ' ');

const ok = [];
const bad = [];
const check = (name, condition, detail = '') => {
  (condition ? ok : bad).push(detail ? `${name} — ${detail}` : name);
};

const app = await NestFactory.createApplicationContext(BotModule, { logger: ['error'] });
const docs = app.get(BotDocuments);
const auth = app.get(AuthService);
const prisma = app.get(PrismaService);

const db = new Client({ connectionString: process.env.APP_DATABASE_URL });
await db.connect();
const found = await db.query('SELECT id FROM user_account WHERE login = $1', [LOGIN]);
if (!found.rows[0]) {
  console.error(`на стенде нет учётки ${LOGIN}`);
  await db.end();
  await app.close();
  process.exit(1);
}
const profile = await auth.loadProfile(BigInt(found.rows[0].id));
const companies = await auth.companies(profile.companyIds);
const me = {
  userId: BigInt(found.rows[0].id),
  permissions: profile.permissions,
  companyIds: profile.companyIds,
  companies: companies.map((c) => ({
    id: c.id,
    uid: c.uid,
    nameRu: c.nameRu,
    nameUz: c.nameUz,
  })),
};
console.log(
  `смотрим глазами ${LOGIN}: согласование ${profile.permissions.has('documents.approve') ? 'есть' : 'нет'}`,
);

/** Статусы документов до и после: прогон обязан оставить их теми же. */
const snapshot = async () => {
  const rows = await prisma.withContext(
    me.userId,
    me.companyIds,
    (tx) =>
      tx.$queryRaw`SELECT status::text AS status, count(*)::text AS n
                     FROM document GROUP BY status ORDER BY status`,
  );
  return rows.map((r) => `${r.status}:${r.n}`).join(' ');
};
const before = await snapshot();

let flow = null;
const press = async (data) => {
  const screen = await docs.route(me, flow, data, false);
  if (screen.flow !== undefined) flow = screen.flow;
  return screen;
};

let screen = await press('d');
check('раздел открывается', /счёта, договоры/.test(plain(screen)));
check(
  'вкладки на месте',
  ['Ждут решения', 'Черновики', 'Возвращённые', 'Все документы'].every((t) =>
    screen.keyboard.flat().some((b) => b.text.includes(t)),
  ),
);

screen = await press('d:s:wait');
const waiting = screen.keyboard.flat().filter((b) => b.data.startsWith('d:c:'));
check(
  'список ждущих решения отдаётся',
  /Ждут решения/.test(plain(screen)),
  `бумаг ${waiting.length}`,
);

const open = waiting[0] ?? null;
if (open) {
  const card = await press(open.data);
  const text = plain(card);
  check('карточка собирается', /Тип:/.test(text) && /Сумма:/.test(text));
  check('строки документа видны', /В документе/.test(text));
  check('статус объяснён словами', /ждёт решения/.test(text));
  const labels = card.keyboard
    .flat()
    .map((b) => b.text)
    .join(' | ');
  const canApprove = profile.permissions.has('documents.approve');
  check('кнопки маршрута по правам', canApprove === /Утвердить/.test(labels), labels);
  check('файл можно получить', /PDF/.test(labels) && /DOCX/.test(labels));
} else {
  check('на стенде есть документы на согласовании', false, 'список пуст');
}

// Выписка счёта из заказа: доводим до экрана «что попадёт в бумагу» и
// останавливаемся. Нажать «Выписать» нельзя: номер выдаётся из серии
// заказчика, и прогон съел бы его на ровном месте.
const order = (
  await prisma.withContext(
    me.userId,
    me.companyIds,
    (tx) =>
      tx.$queryRaw`
        SELECT o.uid, o.number FROM sales_order o
         WHERE o.status <> 'cancelled'
           AND (SELECT count(*) FROM sales_order_line l WHERE l.sales_order_id = o.id) > 0
         ORDER BY o.id DESC LIMIT 1`,
  )
)[0];
if (order) {
  let flow = null;
  const step = async (data) => {
    const screen = await docs.route(me, flow, data, false);
    if (screen.flow !== undefined) flow = screen.flow;
    return screen;
  };
  const types = await step(`d:ns:${order.uid}`);
  const labels = types.keyboard
    .flat()
    .map((b) => b.text)
    .join(' | ');
  check('из заказа предлагают счёт', /Счёт на оплату/.test(labels), labels);
  check('товарно-транспортную из заказа не предлагают', !/накладная/i.test(labels));

  const button = types.keyboard.flat().find((b) => b.text.includes('Счёт на оплату'));
  if (button) {
    const confirm = await step(button.data);
    const text = plain(confirm);
    check('до выписки показано, что попадёт в бумагу', text.includes(order.number));
    check('сказано, что документ — снимок заказа', /снимок заказа/.test(text));
    check(
      'выписать предлагают одной кнопкой',
      confirm.keyboard.flat().some((b) => b.data === 'd:ngo'),
    );
  }
} else {
  check('на стенде есть заказ со строками', false, 'заказов со строками нет');
}

const after = await snapshot();
check('прогон ничего не изменил', before === after, after);

for (const line of ok) console.log(`  ок: ${line}`);
for (const line of bad) console.log(`  НЕ ОК: ${line}`);
await db.end();
await app.close();
console.log(bad.length === 0 ? 'стенд: документы в боте работают' : 'стенд: есть замечания');
process.exit(bad.length === 0 ? 0 : 1);
