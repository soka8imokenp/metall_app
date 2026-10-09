/**
 * Продажи в боте на стенде: проверка только чтением.
 *
 * Прогон идёт по настоящей базе стенда, поэтому он ничего не записывает:
 * заказы и накладные на стенде смотрит заказчик, и прогон не должен оставлять
 * в них своих. Проверяется то, что без живой базы не проверить: списки по
 * этапам отдаются, карточка собирается, наличие под заказ считается, а мастер
 * нового заказа доходит до прайса и останавливается перед записью.
 *
 * Запуск: APP_DATABASE_URL=<стенд> node qa/stand-bot-sales.mjs
 */
import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { BotModule } from '../dist/bot/bot.module.js';
import { Client } from 'pg';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { BotSales } from '../dist/bot/sales.bot.js';

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
const auth = app.get(AuthService);
const prisma = app.get(PrismaService);
const sales = app.get(BotSales);

/**
 * Кто смотрит: менеджер продаж завода — у завода на стенде есть прайс, и
 * проверять подсказку цены имеет смысл его глазами. Логин можно передать
 * первым аргументом.
 */
const LOGIN = process.argv[2] ?? 'sales_plant';
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
console.log(`смотрим глазами ${LOGIN}, прав ${profile.permissions.size}, компаний ${me.companies.length}`);
if (!profile.permissions.has('sales.edit')) {
  console.error(`у ${LOGIN} нет права sales.edit — мастер заказа проверить нечем`);
  await db.end();
  await app.close();
  process.exit(1);
}

/**
 * Сколько заказов и накладных видит этот человек: прогон обязан оставить
 * столько же. Считаем в его контексте — иначе политика RLS не отдаст ни одной
 * строки, и проверка «ничего не записал» сойдётся сама с собой на нулях.
 */
const count = async () => {
  const rows = await prisma.withContext(
    me.userId,
    me.companyIds,
    (tx) =>
      tx.$queryRaw`SELECT (SELECT count(*) FROM sales_order)::text AS orders,
                          (SELECT count(*) FROM shipment)::text AS shipments`,
  );
  return rows[0];
};
const before = await count();

let flow = null;
const press = async (data) => {
  const screen = await sales.route(me, flow, data, false);
  if (screen.flow !== undefined) flow = screen.flow;
  return screen;
};
const say = async (text) => {
  const screen = await sales.text(me, flow, text, false);
  if (screen.flow !== undefined) flow = screen.flow;
  return screen;
};
const tap = async (screen, prefix) => {
  const hit = screen.keyboard
    .flat()
    .find((b) => plain({ text: b.text }).includes(prefix));
  if (!hit) throw new Error(`кнопки «${prefix}» нет`);
  return press(hit.data);
};

// 1. Раздел и этапы.
let screen = await press('o');
check('раздел открывается', /Здесь заказы/.test(plain(screen)));
check(
  'этапы на месте',
  ['Все заказы', 'Не оплачены', 'В производстве', 'Отгружены'].every((t) =>
    screen.keyboard.flat().some((b) => b.text.includes(t)),
  ),
);

// 2. Список и карточка настоящего заказа.
screen = await press('o:s:all');
const first = screen.keyboard.flat().find((b) => b.data.startsWith('o:c:'));
check('в списке есть заказы', Boolean(first));
if (first) {
  const card = await press(first.data);
  const text = plain(card);
  check('карточка собирается', /Клиент:/.test(text) && /Товар в заказе/.test(text));
  check(
    'статус объяснён словами',
    /обещано|договорились|отложен|делают|Собирают|уехал|нечего ждать|не обещание/i.test(text),
  );
  const uid = first.data.slice(4);
  const avail = await press(`o:a:${uid}`);
  check('наличие под заказ считается', /Наличие под заказ/.test(plain(avail)));
  check(
    'видно, что свободно на складе',
    /свободно на складе/.test(plain(avail)),
    plain(avail).split('\n').slice(1, 3).join(' / '),
  );
}

// 3. Мастер нового заказа — до прайса и ни шагу дальше.
flow = null;
screen = await press('o:n');
check('мастер заказа открывается', /Обещание клиенту/.test(plain(screen)));
if (me.companies.length > 1) {
  screen = await tap(screen, me.companies[0].nameRu);
}
check('спрашивает клиента', /· Клиент/.test(plain(screen)));
const client = screen.keyboard.flat().find((b) => b.data.startsWith('o:k:'));
if (client) {
  screen = await press(client.data);
  check('спрашивает товар', /· Товар/.test(plain(screen)));
  const item = screen.keyboard.flat().find((b) => b.data.startsWith('o:k:'));
  if (item) {
    screen = await press(item.data);
    check('спрашивает количество', /· Количество/.test(plain(screen)));
    screen = await say('1');
    const price = plain(screen);
    check('доходит до цены', /· Цена/.test(price));
    check(
      'цена объяснена',
      /Цена есть|В прайсе цены на этот товар нет/.test(price),
      price.split('\n').find((l) => /Цена есть|прайсе/.test(l)) ?? '',
    );
  }
}
// Дальше не идём: запись заказа на стенде — работа заказчика, не прогона.

const after = await count();
check(
  'прогон ничего не записал',
  before.orders === after.orders && before.shipments === after.shipments,
  `заказов ${after.orders}, накладных ${after.shipments}`,
);

for (const line of ok) console.log(`  ок: ${line}`);
for (const line of bad) console.log(`  НЕ ОК: ${line}`);
await db.end();
await app.close();
console.log(bad.length === 0 ? 'стенд: продажи в боте работают' : 'стенд: есть замечания');
process.exit(bad.length === 0 ? 0 : 1);
