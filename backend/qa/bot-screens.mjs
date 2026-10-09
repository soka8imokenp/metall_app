/**
 * Как выглядят экраны бота на живых данных.
 *
 * Прогон обходит разделы и карточки настоящим кодом бота и печатает подписи
 * целиком — так видно глазами то, что тесты проверяют по признакам. Заодно
 * проверяет само устройство текста: подпись панели влезает в предел Telegram
 * (1024 знака — лишнее он обрезает молча), поля идут пунктами, а пояснение
 * отделено от цитаты пустой строкой.
 *
 * Только чтение: разговоры доходят до экрана проверки и обрываются.
 *
 * Запуск: APP_DATABASE_URL=<база> TELEGRAM_BOT_TOKEN=<любой> node qa/bot-screens.mjs [логин]
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

const app = await NestFactory.createApplicationContext(BotModule, { logger: ['error'] });
const auth = app.get(AuthService);
const prisma = app.get(PrismaService);
const fin = app.get(BotFinance);
const wh = app.get(BotWarehouse);
const sal = app.get(BotSales);

const found = await prisma.withContext(null, [], (tx) =>
  tx.$queryRawUnsafe(`SELECT id::text AS id FROM user_account WHERE login='director'`),
);
const userId = BigInt(found[0].id);
const a = await auth.loadProfile(userId);
const cs = await auth.companies(a.companyIds);
const me = {
  userId,
  permissions: a.permissions,
  companyIds: a.companyIds,
  companies: cs.map((c) => ({ id: c.id, uid: c.uid, nameRu: c.nameRu, nameUz: c.nameUz })),
};

let flow = null;
/** Предел подписи к картинке в Telegram. Лишнее он обрезает без ошибки. */
const CAPTION_LIMIT = 1024;
const bad = [];

const show = (name, s) => {
  const text = s.text ?? '';
  console.log(`\n######## ${name}  (${text.length} знаков)`);
  console.log(text);
  console.log('КНОПКИ: ' + s.keyboard.map((r) => r.map((b) => b.text).join(' | ')).join(' // '));
  if (text.length > CAPTION_LIMIT) bad.push(`${name}: подпись ${text.length} знаков — обрежется`);
  // После цитаты — пустая строка: иначе пояснение слипается с полями.
  if (/<\/blockquote>\n[^\n]/.test(text)) bad.push(`${name}: текст слипся с цитатой`);
  // Проверять «поля пунктами» здесь нечем: в цитатах живут и примеры, и
  // подсказки, и списки записей со своим значком. Это держат тесты экранов
  // проверки и карточек, где точно известно, что внутри поля.
};
const press = async (svc, data) => {
  const s = await svc.route(me, flow, data, false);
  if (s.flow !== undefined) flow = s.flow;
  return s;
};
const say = async (svc, t) => {
  const s = await svc.text(me, flow, t, false);
  if (s.flow !== undefined) flow = s.flow;
  return s;
};

show('финансы: раздел', await press(fin, 'f'));
show('финансы: шаг 1', await press(fin, 'f:n:e'));
const c = (await press(fin, 'f')).keyboard;
flow = null;
let s = await press(fin, 'f:n:e');
const comp = s.keyboard.flat().find((b) => b.data.startsWith('f:k:'));
s = await press(fin, comp.data);
show('финансы: сумма', s);
s = await say(fin, '250000');
show('финансы: статья', s);
const item = s.keyboard.flat().find((b) => b.data.startsWith('f:k:'));
s = await press(fin, item.data);
show('финансы: счёт', s);
const acc = s.keyboard.flat().find((b) => b.data.startsWith('f:k:'));
s = await press(fin, acc.data);
show('финансы: контрагент', s);
s = await press(fin, 'f:k:-');
show('финансы: дата', s);
s = await press(fin, 'f:k:today');
show('финансы: примечание', s);
s = await press(fin, 'f:k:-');
show('финансы: проверка', s);
show('финансы: я не понял', await press(fin, 'f:ex'));
flow = null;
show('финансы: операции', await press(fin, 'f:l'));
const list = (await press(fin, 'f:l')).keyboard.flat().find((b) => b.data.startsWith('f:o:'));
if (list) show('финансы: карточка операции', await press(fin, list.data));
flow = null;
show('склад: раздел', await press(wh, 'w'));
show('склад: приход шаг 1', await press(wh, 'w:n:r'));
flow = null;
show('продажи: раздел', await press(sal, 'o'));
const ord = (await press(sal, 'o:s:all')).keyboard.flat().find((b) => b.data.startsWith('o:c:'));
if (ord) show('продажи: карточка заказа', await press(sal, ord.data));

const docs = app.get((await import('../dist/bot/documents.bot.js')).BotDocuments);
flow = null;
let d = await press(docs, 'd');
show('документы: раздел', d);
d = await press(docs, 'd:s:all');
const one = d.keyboard.flat().find((b) => b.data.startsWith('d:c:'));
if (one) show('документы: карточка', await press(docs, one.data));
flow = null;
let w2 = await press(wh, 'w:m');
const mv = w2.keyboard.flat().find((b) => b.data.startsWith('w:o:'));
if (mv) show('склад: карточка движения', await press(wh, mv.data));

const rates = app.get((await import('../dist/bot/rates.bot.js')).BotRates);
show('курс валют', await rates.screen(me, false));

const prod = app.get((await import('../dist/bot/production.bot.js')).BotProduction);
flow = null;
show('производство: раздел', await press(prod, 'p'));
show('производство: мои задания', await press(prod, 'p:me'));
show('производство: что в цеху', await press(prod, 'p:sh'));
show('производство: отклонения', await press(prod, 'p:dv'));
const shop = await press(prod, 'p:s:active');
show('производство: заказы в работе', shop);
const po = shop.keyboard.flat().find((b) => b.data.startsWith('p:c:'));
if (po) {
  const card = await press(prod, po.data);
  show('производство: карточка заказа', card);
  const st = card.keyboard.flat().find((b) => b.data.startsWith('p:g:'));
  if (st) {
    const list = await press(prod, st.data);
    show('производство: этапы', list);
    const one = list.keyboard.flat().find((b) => b.data.startsWith('p:t:'));
    if (one) show('производство: этап', await press(prod, one.data));
  }
}
flow = null;

const chief = app.get((await import('../dist/bot/chief.bot.js')).BotChief);
flow = null;
show('сводка', await press(chief, 'c'));
show('сводка: ждут решения', await press(chief, 'c:w'));
show('сводка: на что смотреть', await press(chief, 'c:a'));
console.log('\n---');
console.log(
  bad.length === 0
    ? 'экраны в порядке: влезают в подпись Telegram, пояснения отделены от цитат'
    : 'НЕ ОК:\n  ' + bad.join('\n  '),
);
await app.close();
process.exit(bad.length ? 1 : 0);
