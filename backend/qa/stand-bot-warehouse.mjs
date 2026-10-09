/**
 * Живая проверка раздела «Склад» в боте на данных стенда.
 *
 * Только чтение: экраны остатка, движений, нехватки и листов пересчёта
 * собираются на настоящих справочниках стенда. Записывать приход и списание
 * здесь нельзя — у заказчика на стенде свои остатки, и проверка не должна их
 * двигать. Запись проверена на базе разработки (`test/bot-warehouse.e2e`).
 */
import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { BotModule } from '../dist/bot/bot.module.js';
import { BotWarehouse } from '../dist/bot/warehouse.bot.js';
import { AuthService } from '../dist/auth/auth.service.js';

const LOGIN = process.argv[2] ?? 'warehouse';

const plain = (s) =>
  (s ?? '')
    .replace(/<blockquote>|<\/blockquote>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/ /g, ' ');

const app = await NestFactory.createApplicationContext(BotModule, { logger: ['error'] });
const wh = app.get(BotWarehouse);
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
const show = (title) => {
  console.log(`\n--- ${title}`);
  console.log(plain(screen.text));
  console.log(`[${screen.keyboard.flat().map((b) => b.text).join('] [')}]`);
};
async function press(data, title) {
  screen = await wh.route(me, flow, data, false);
  if (screen.flow !== undefined) flow = screen.flow;
  show(title);
}
async function say(text, title) {
  screen = await wh.text(me, flow, text, false);
  if (screen.flow !== undefined) flow = screen.flow;
  show(title);
}

await press('w', 'раздел');
await press('w:s', 'поиск остатка');
await say('труба', 'остаток по «труба»');
await press('w:m', 'последние движения');
const first = screen.keyboard.flat().find((b) => b.data.startsWith('w:o:'));
if (first) await press(first.data, 'карточка движения');
await press('w:d', 'чего не хватает');
await press('w:i', 'листы пересчёта');
// Мастер прихода доводим до экрана проверки и бросаем: ничего не записываем.
await press('w:n:r', 'новый приход');
if (me.companies.length > 1) {
  const company = screen.keyboard.flat()[0];
  await press(company.data, 'компания');
}
await say('труба', 'выбор номенклатуры поиском');
await press('w:x', 'отменили, ничего не записано');

const moved = await db.query(
  `SELECT count(*)::int AS n FROM stock_move WHERE created_at > now() - interval '5 minutes'`,
);
console.log(`\nдвижений записано проверкой: ${moved.rows[0].n}`);

await db.end();
await app.close();
