/**
 * Сводка руководителя в боте на стенде: проверка только чтением.
 *
 * Раздел и так ничего не пишет — он показывает цифры и переходы, — но прогон
 * всё равно сверяет, что состояние стенда до и после одно и то же: это данные
 * заказчика, а не площадка проверки.
 *
 * Проверяется то, что без живой базы не проверить: цифры собираются на всех
 * трёх сроках, динамика считается, список ждущих решения ведёт в карточки, а
 * отклонения совпадают с тем, что показывает приветствие.
 *
 * Запуск: APP_DATABASE_URL=<стенд> node qa/stand-bot-chief.mjs [логин]
 */
import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { BotModule } from '../dist/bot/bot.module.js';
import { BotChief } from '../dist/bot/chief.bot.js';
import { DigestService } from '../dist/bot/digest.service.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';

const LOGIN = process.argv[2] ?? 'director';

const plain = (s) =>
  (s.text ?? '')
    .replace(/<blockquote>|<\/blockquote>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\u00a0\u202f]/g, ' ');

const ok = [];
const bad = [];
const check = (name, condition, detail = '') => {
  (condition ? ok : bad).push(detail ? `${name} — ${detail}` : name);
};

const app = await NestFactory.createApplicationContext(BotModule, { logger: ['error'] });
const chief = app.get(BotChief);
const digest = app.get(DigestService);
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

/**
 * Что на стенде до и после. Считаем в контексте человека: политика RLS без
 * него не отдаст ни одной строки, и сверка «ничего не изменил» сошлась бы сама
 * с собой на нулях.
 */
const state = async () => {
  const rows = await prisma.withContext(
    me.userId,
    me.companyIds,
    (tx) =>
      tx.$queryRaw`SELECT (SELECT count(*) FROM finance_operation)::text AS ops,
                          (SELECT count(*) FROM document)::text AS docs,
                          (SELECT count(*) FROM sales_order)::text AS orders`,
  );
  const r = rows[0];
  return `операций ${r.ops}, документов ${r.docs}, заказов ${r.orders}`;
};
const before = await state();

let flow = null;
const press = async (data) => {
  const screen = await chief.route(me, flow, data, false);
  if (screen.flow !== undefined) flow = screen.flow;
  return screen;
};

// 1. Цифры на всех трёх сроках.
for (const [code, name] of [
  ['7', '7 дней'],
  ['30', '30 дней'],
  ['90', '3 месяца'],
]) {
  // Срок выбираем кнопкой: вход в раздел (`c`) открывает тот срок, который
  // человек выбрал в прошлый раз, и для сверки это не то, что нужно.
  const screen = await press(`c:p:${code}`);
  const text = plain(screen);
  const line = text.split('\n').find((l) => l.includes('Выручка')) ?? '';
  check(`цифры за ${name}`, text.includes(name) && /Выручка/.test(text), line.trim());
  check(
    `срок ${name} помечен`,
    screen.keyboard.flat().some((b) => b.text.includes(`✅ ${name}`)),
  );
}

// 2. Динамика словами, а не только число.
const home = await press('c');
check(
  'динамика объяснена словами',
  /больше, чем в прошлые|меньше, чем в прошлые|столько же|срез на сегодня/.test(plain(home)),
  plain(home)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /больше, чем|меньше, чем|срез на сегодня/.test(l)) ?? '',
);
check('видно время сборки', /Обновлено \d\d:\d\d/.test(plain(home)));

// 3. Что ждёт решения — и переходы в карточки.
const waiting = await press('c:w');
const data = waiting.keyboard.flat().map((b) => b.data);
const canDecide =
  profile.permissions.has('finance.approve') ||
  profile.permissions.has('finance.post') ||
  profile.permissions.has('documents.approve');
if (canDecide) {
  check(
    'список решений собран',
    /Ждут вашего решения/.test(plain(waiting)),
    plain(waiting).split('\n').slice(1, 4).join(' / '),
  );
  check(
    'переход в карточку есть',
    data.some((d) => d.startsWith('f:o:') || d.startsWith('d:c:')),
    `кнопок ${data.filter((d) => d.startsWith('f:o:') || d.startsWith('d:c:')).length}`,
  );
} else {
  check(
    'без права согласовывать список пуст и это сказано',
    /Права согласовывать вам не выдано/.test(plain(waiting)),
  );
  check(
    'чужих переходов не предлагают',
    !data.some((d) => d.startsWith('f:o:') || d.startsWith('d:c:')),
  );
}

// 4. Отклонения — те же строки, что в приветствии.
const alarms = await press('c:a');
const all = await digest.all(me.userId, me.companyIds, me.permissions);
const expected = all.filter((l) => l.severity !== 'info');
const shown = plain(alarms)
  .split('\n')
  .filter((l) => /^(🔴|🟡)/.test(l.trim()) && !l.includes('как идут дела'));
check(
  'отклонения показаны все',
  shown.length === expected.length,
  `на экране ${shown.length}, у службы ${expected.length}`,
);
check('значки объяснены', /🔴 просрочено/.test(plain(alarms)));

// 5. Завод и торговый дом рядом — только если компаний у человека две.
if (me.companies.length > 1) {
  const cmp = await press('c:cc');
  const text = plain(cmp);
  check('сравнение компаний собрано', /Завод и торговый дом/.test(text));
  for (const c of me.companies) {
    check(`в сравнении есть ${c.nameRu}`, text.includes(c.nameRu));
  }
  check('своё у каждого выделено', /Своё у каждого/.test(text));
  const revenue = text
    .split('\n')
    .filter((l) => l.includes(':') && /\d/.test(l))
    .slice(0, 2);
  check('цифры рядом', revenue.length === 2, revenue.map((l) => l.trim()).join(' | '));
} else {
  const cmp = await press('c:cc');
  check('с одной компанией сравнение не открывается', /одна компания/.test(cmp.toast ?? ''));
}

const after = await state();
check('прогон ничего не изменил', before === after, after);

for (const line of ok) console.log(`  ок: ${line}`);
for (const line of bad) console.log(`  НЕ ОК: ${line}`);
await db.end();
await app.close();
console.log(bad.length === 0 ? 'стенд: сводка в боте работает' : 'стенд: есть замечания');
process.exit(bad.length === 0 ? 0 : 1);
