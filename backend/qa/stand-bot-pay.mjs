/**
 * Приём оплаты по заказу в боте на стенде: проверка только чтением.
 *
 * Разговор доводится до экрана проверки и обрывается: «Записать» прогон не
 * нажимает. Это данные заказчика, и заводить в них платёж, чтобы убедиться,
 * что платёж заводится, нельзя. Что запись действительно уменьшает долг,
 * проверено на dev-базе в `test/bot-finance-pay.e2e.spec.ts`.
 *
 * Проверяется то, чего без живой базы не видно: в карточке живого заказа есть
 * остаток и кнопка приёма оплаты, мастер берёт компанию и покупателя из заказа
 * и не спрашивает их, остаток на экране суммы совпадает с тем, что считает
 * служба продаж, сумма больше остатка не принимается.
 *
 * Запуск: APP_DATABASE_URL=<стенд> node qa/stand-bot-pay.mjs [логин]
 */
import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { BotModule } from '../dist/bot/bot.module.js';
import { BotFinance } from '../dist/bot/finance.bot.js';
import { BotSales } from '../dist/bot/sales.bot.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { paymentStateByUid } from '../dist/sales/order-payment.js';

const LOGIN = process.argv[2] ?? 'director';

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
const finance = app.get(BotFinance);
const sales = app.get(BotSales);
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
console.log(`смотрим глазами ${LOGIN}, компаний ${me.companies.length}`);

/** Состояние стенда до и после — в контексте человека, иначе RLS отдаст ноль. */
const state = async () => {
  const rows = await prisma.withContext(
    me.userId,
    me.companyIds,
    (tx) =>
      tx.$queryRaw`SELECT (SELECT count(*) FROM finance_operation)::text AS ops,
                          (SELECT coalesce(sum(paid_amount), 0)::text FROM sales_order) AS paid,
                          (SELECT count(*) FROM sales_order)::text AS orders,
                          (SELECT count(*) FROM attachment)::text AS files`,
  );
  const r = rows[0];
  return `операций ${r.ops}, заказов ${r.orders}, оплачено ${r.paid}, вложений ${r.files}`;
};
const before = await state();

/**
 * Живой заказ с остатком: по нему и пойдёт разговор.
 *
 * Ищем через контекст человека, а не обычным подключением: на стенде
 * приложение ходит в базу ролью `metall_app`, и без контекста политика RLS не
 * отдаёт ни одной строки. Запрос «обычным клиентом» вернул бы пусто, и прогон
 * сказал бы «принимать нечего» на базе, где неоплаченных заказов пятьдесят.
 * Заодно отбор по своим компаниям делает сама политика.
 */
const order = (
  await prisma.withContext(
    me.userId,
    me.companyIds,
    (tx) =>
      tx.$queryRaw`
        SELECT o.uid, o.number
          FROM sales_order o
          JOIN currency cur ON cur.id = o.currency_id
         WHERE o.status <> 'cancelled' AND cur.code = 'UZS'
           AND o.paid_amount < o.amount_total
         ORDER BY o.amount_total DESC LIMIT 1`,
  )
)[0];

if (!order) {
  console.log('НЕ ОК: на стенде не нашлось заказа с остатком — проверять нечего');
  await db.end();
  await app.close();
  process.exit(1);
}
console.log(`заказ ${order.number}`);

const expected = await prisma.withContext(me.userId, me.companyIds, (tx) =>
  paymentStateByUid(tx, order.uid),
);

// 1. Карточка заказа: остаток и кнопка.
const card = await sales.route(me, null, `o:c:${order.uid}`, false);
check('в заказе виден остаток к получению', /Осталось получить/.test(plain(card)));
check(
  'кнопка приёма оплаты есть',
  card.keyboard.flat().some((b) => b.data === `f:pay:${order.uid}`),
);

// 2. Мастер оплаты: известного не спрашивает, остаток называет верно.
let flow = null;
const press = async (data) => {
  const screen = await finance.route(me, flow, data, false);
  if (screen.flow !== undefined) flow = screen.flow;
  return screen;
};
const typed = async (text) => {
  const screen = await finance.text(me, flow, text, false);
  if (screen.flow !== undefined) flow = screen.flow;
  return screen;
};

const start = await press(`f:pay:${order.uid}`);
const startText = plain(start);
check('разговор начался с суммы', /Сколько денег пришло по заказу/.test(startText));
check('номер заказа назван', startText.includes(order.number));
check('компанию не спрашивает', !/По какой компании/.test(startText));
const shown = (startText.match(/Неоплаченный остаток: ([\d  ,]+)/) ?? [])[1] ?? '';
const asNumber = Number(shown.replace(/[  ]/g, '').replace(',', '.'));
check(
  'остаток совпадает со службой',
  Math.abs(asNumber - expected.remaining) < 0.02,
  `на экране ${shown.trim()}, служба ${expected.remaining.toFixed(2)}`,
);

// 3. Больше остатка не принимает.
const over = await typed(String(Math.ceil(expected.remaining) + 1000));
check('сумму больше остатка не берёт', /больше остатка/.test(plain(over)));

// 4. Половина остатка доводит до экрана проверки. Дальше прогон не идёт:
// «Записать» на данных заказчика не нажимаем.
const half = (expected.remaining / 2).toFixed(2);
const accountScreen = await typed(half);
check('после суммы спрашивает счёт', flow?.step === 'account', `шаг ${flow?.step}`);
// Строка «дальше» — то, из-за чего человек не бросает разговор на середине.
check(
  'на шаге сказано, что спрошу дальше',
  /Дальше: .*Проверка/.test(plain(accountScreen)),
  (plain(accountScreen).match(/Дальше:.*/) ?? ['нет строки'])[0],
);
const accountButton = accountScreen.keyboard.flat().find((b) => b.data.startsWith('f:k:'));
check(
  'счёт в валюте заказа предложен',
  Boolean(accountButton),
  accountButton?.text ?? 'нет кнопок',
);
if (accountButton) {
  await press(accountButton.data);
  await press('f:k:today');
  const confirm = await press('f:k:-');
  const text = plain(confirm);
  check('на проверке виден заказ', text.includes(order.number));
  check('на проверке виден остаток после платежа', /Останется по заказу/.test(text));
  check(
    'записывать предлагают одной кнопкой',
    confirm.keyboard.flat().some((b) => b.data === 'f:go'),
  );
  check(
    'на проверке есть «я не понял»',
    confirm.keyboard.flat().some((b) => b.data === 'f:ex'),
  );

  // «Я не понял» — объяснение словами. Ничего не записывает, поэтому прогон
  // его нажимает: на данных заказчика это по-прежнему только чтение.
  const said = plain(await press('f:ex'));
  check('объяснение простыми словами', /Простыми словами/.test(said));
  check('объяснение говорит про долг по заказу', said.includes(order.number));
  const back = plain(await press('f:cf'));
  check('с объяснения возвращает на проверку', /Проверьте/.test(back));
}

// 5. Фото чека: экран есть и объясняет, что снимать. Сам снимок прогон не
// отправляет — это данные заказчика, и вложение в них заводить незачем.
const anyOp = (
  await prisma.withContext(
    me.userId,
    me.companyIds,
    (tx) =>
      tx.$queryRaw`
        SELECT uid, number FROM finance_operation
         WHERE operation_type IN ('income', 'expense')
         ORDER BY id DESC LIMIT 1`,
  )
)[0];
if (anyOp) {
  const card = await finance.route(me, null, `f:o:${anyOp.uid}`, false);
  check(
    'в карточке операции есть кнопка фото',
    card.keyboard.flat().some((b) => b.data === `f:ph:${anyOp.uid}`),
  );
  const ask = await finance.route(me, null, `f:ph:${anyOp.uid}`, false);
  const text = plain(ask);
  check('экран просит снимок и называет запись', text.includes(anyOp.number));
  check('сказано, что снимать', /сумма и дата должны быть видны/.test(text));
  check('сказано, что сумму с фото бот не читает', /Сумму с фотографии я не читаю/.test(text));
}

const after = await state();
check('прогон ничего не изменил', before === after, after);

for (const line of ok) console.log(`  ок: ${line}`);
for (const line of bad) console.log(`  НЕ ОК: ${line}`);
await db.end();
await app.close();
console.log(bad.length === 0 ? 'стенд: приём оплаты в боте работает' : 'стенд: есть замечания');
process.exit(bad.length === 0 ? 0 : 1);
