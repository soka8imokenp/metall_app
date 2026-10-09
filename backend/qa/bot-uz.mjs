/**
 * Узбекский экран бота: нет ли в нём русских слов.
 *
 * Проверка, которую нельзя сделать тестом дословно: язык разговора в боте
 * собирается из сотни строк, и забытая одна видна только глазами. Прогон
 * проходит мастер расхода целиком по-узбекски и ищет кириллицу в подписях и
 * кнопках. Названия клиентов и номенклатуры из базы в расчёт не берутся: это
 * данные заказчика, они написаны по-русски и переводить их боту нечем.
 *
 * Ничего не записывает: разговор доходит до экрана проверки и обрывается.
 *
 * Запуск: APP_DATABASE_URL=<база> TELEGRAM_BOT_TOKEN=<любой> node qa/bot-uz.mjs [логин]
 */
import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { BotModule } from '../dist/bot/bot.module.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { BotFinance } from '../dist/bot/finance.bot.js';
import { BotWarehouse } from '../dist/bot/warehouse.bot.js';
import { BotSales } from '../dist/bot/sales.bot.js';
import { howToFor } from '../dist/bot/howto.js';

/** Кириллица в интерфейсе. Данные из базы проверяются отдельно от подписей. */
const CYR = /[А-Яа-яЁё]/;
const plain = (s) => (s.text ?? '').replace(/<[^>]+>/g, '');

/**
 * Убрать из строки то, что пришло из базы заказчика.
 *
 * Номера документов (`ПР-00031`), имена людей и названия номенклатуры написаны
 * по-русски, и бот их не переводит — переводить чужие данные он не вправе.
 * Проверяем свои слова, поэтому значения таких полей и номера маскируем, а всё
 * остальное в строке остаётся под проверкой.
 */
const DATA_LABELS = [
  'Mas’ul',
  'Mahsulot',
  'Kompaniya',
  'Mijoz',
  'Kontragent',
  'Sotuv buyurtmasi ostida',
  'Uchastka',
  // Причину остановки пишет человек словами и по-русски: это запись в журнал,
  // а не подпись экрана, и переводить её боту нечем.
  'To‘xtash sababi',
  'Izoh',
];
const mask = (line) => {
  // Без `\b`: в JS граница слова знает только латиницу, и «ПР-00031» мимо неё.
  let out = line.replace(/[А-ЯЁA-Z]{2,4}-\d{2,}/g, '№');
  for (const label of DATA_LABELS) {
    out = out.replace(new RegExp(`(${label}:)[^·\n]*`, 'g'), '$1');
  }
  return out;
};
const LOGIN = process.argv[2] ?? 'accountant';

const app = await NestFactory.createApplicationContext(BotModule, { logger: ['error'] });
const auth = app.get(AuthService);
const prisma = app.get(PrismaService);
const fin = app.get(BotFinance);
const wh = app.get(BotWarehouse);
const sal = app.get(BotSales);

const found = await prisma.withContext(null, [], (tx) =>
  tx.$queryRawUnsafe(
    `SELECT id::text AS id FROM user_account WHERE login = $1 AND is_active`,
    LOGIN,
  ),
);
if (!found[0]) {
  console.error(`нет учётки ${LOGIN}`);
  await app.close();
  process.exit(1);
}
const userId = BigInt(found[0].id);
const access = await auth.loadProfile(userId);
const companies = await auth.companies(access.companyIds);
const me = {
  userId,
  permissions: access.permissions,
  companyIds: access.companyIds,
  companies: companies.map((c) => ({ id: c.id, uid: c.uid, nameRu: c.nameRu, nameUz: c.nameUz })),
};

let flow = null;
const press = async (data) => {
  const s = await fin.route(me, flow, data, true);
  if (s.flow !== undefined) flow = s.flow;
  return s;
};
const say = async (text) => {
  const s = await fin.text(me, flow, text, true);
  if (s.flow !== undefined) flow = s.flow;
  return s;
};
const pick = (screen) => screen.keyboard.flat().find((b) => b.data.startsWith('f:k:'));

const screens = [];
screens.push(['moliya', await press('f')]);
screens.push(['1-qadam', await press('f:n:e')]);
const company = pick(screens[1][1]);
if (company) screens.push(['kompaniya', await press(company.data)]);
screens.push(['summa', await say('250000')]);
const item = pick(screens[screens.length - 1][1]);
if (item) screens.push(['modda', await press(item.data)]);
const account = pick(screens[screens.length - 1][1]);
if (account) screens.push(['hisob', await press(account.data)]);
screens.push(['kontragent', await press('f:k:-')]);
screens.push(['sana', await press('f:k:today')]);
screens.push(['tekshirish', await press('f:k:-')]);
screens.push(['tushunmadim', await press('f:ex')]);
screens.push(['qaytish', await press('f:cf')]);
flow = null;
screens.push(['ombor', await wh.route(me, null, 'w', true)]);
// Курс валют: экран видит каждый, значит и по-узбекски он должен быть чист.
const rates = app.get((await import('../dist/bot/rates.bot.js')).BotRates);
screens.push(['valyuta kursi', await rates.screen(me, true)]);
screens.push(['sotuv', await sal.route(me, null, 'o', true)]);

// Производство: раздел цеха тоже весь узбекский — и его сводки, и этапы.
const { BotProduction } = await import('../dist/bot/production.bot.js');
const prod = app.get(BotProduction);
if (me.permissions.has('production.view')) {
  screens.push(['ishlab chiqarish', await prod.route(me, null, 'p', true)]);
  screens.push(['topshiriqlarim', await prod.route(me, null, 'p:me', true)]);
  screens.push(['sexda nima bor', await prod.route(me, null, 'p:sh', true)]);
  screens.push(['chetlanishlar', await prod.route(me, null, 'p:dv', true)]);
  const ishda = await prod.route(me, null, 'p:s:active', true);
  screens.push(['ishdagi buyurtmalar', ishda]);
  const order = ishda.keyboard.flat().find((b) => b.data.startsWith('p:c:'));
  if (order) {
    const card = await prod.route(me, null, order.data, true);
    screens.push(['buyurtma kartasi', card]);
    const stages = card.keyboard.flat().find((b) => b.data.startsWith('p:g:'));
    if (stages) screens.push(['bosqichlar', await prod.route(me, null, stages.data, true)]);
  }
}

const bad = [];
for (const [name, screen] of screens) {
  const lines = plain(screen)
    .split('\n')
    .map(mask)
    .filter((l) => CYR.test(l));
  // Названия из базы в кнопках — данные заказчика, их бот не переводит.
  const labels = screen.keyboard
    .flat()
    .map((b) => mask(b.text))
    .filter((t) => CYR.test(t) && !/^[А-ЯA-Z«"]/.test(t));
  console.log(`${lines.length === 0 && labels.length === 0 ? 'ок' : 'НЕ ОК'}: ${name}`);
  for (const l of lines) {
    bad.push(`${name}: ${l.trim().slice(0, 120)}`);
    console.log(`    русская строка: ${l.trim().slice(0, 120)}`);
  }
  for (const l of labels) {
    bad.push(`${name}: кнопка ${l}`);
    console.log(`    русская кнопка: ${l}`);
  }
}

// Подсказка «как пользоваться» — тоже интерфейс, и она у каждой роли своя.
for (const path of howToFor(me.permissions)) {
  if (CYR.test(path.uz) || CYR.test(path.pathUz) || CYR.test(path.outUz)) {
    bad.push(`подсказка «${path.key}» по-узбекски с русскими словами`);
    console.log(`НЕ ОК: подсказка ${path.key}`);
  }
}

console.log('---');
console.log(
  bad.length === 0
    ? `узбекский экран чист: ${screens.length} экранов, подсказка на ${howToFor(me.permissions).length} дел`
    : `НЕ ОК: русского текста в узбекском экране — ${bad.length}`,
);
await app.close();
process.exit(bad.length ? 1 : 0);
