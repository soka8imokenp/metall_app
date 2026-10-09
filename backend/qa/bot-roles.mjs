/**
 * Что умеет бот у каждой роли: обход только чтением.
 *
 * Прогон отвечает на вопрос приёмки «бот готов под все роли?» не словами, а
 * обходом: под каждым демо-входом он собирает главное меню из прав этого
 * человека, открывает каждый его раздел настоящим кодом бота и печатает
 * подписи кнопок. Ничего не записывает: открываются только экраны-списки,
 * разговоры (новая операция, оплата, отгрузка) не начинаются.
 *
 * Запуск: APP_DATABASE_URL=<база> node qa/bot-roles.mjs
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
import { BotDocuments } from '../dist/bot/documents.bot.js';
import { BotChief } from '../dist/bot/chief.bot.js';
import { BotProduction } from '../dist/bot/production.bot.js';
import { DigestService } from '../dist/bot/digest.service.js';
import { allowedSections, botAllowed, mainMenu, CB } from '../dist/bot/menu.js';
import { howToFor } from '../dist/bot/howto.js';

const plain = (s) => (s ?? '').replace(/<[^>]+>/g, '').replace(/[  ]/g, ' ');
const labels = (kb) => (kb ?? []).flat().map((b) => b.text);

/** Язык обхода: `node qa/bot-roles.mjs uz` смотрит узбекскими глазами. */
const UZ = process.argv[2] === 'uz';

const app = await NestFactory.createApplicationContext(BotModule, { logger: ['error'] });
const auth = app.get(AuthService);
const prisma = app.get(PrismaService);
const digest = app.get(DigestService);
const parts = {
  finance: { open: CB.fin, svc: app.get(BotFinance), permission: 'finance.view' },
  warehouse: { open: CB.wh, svc: app.get(BotWarehouse), permission: 'warehouse.view' },
  sales: { open: CB.sal, svc: app.get(BotSales), permission: 'sales.view' },
  documents: { open: CB.doc, svc: app.get(BotDocuments), permission: 'documents.view' },
  dashboard: { open: CB.chief, svc: app.get(BotChief), permission: 'dashboard.view' },
  production: { open: CB.prod, svc: app.get(BotProduction), permission: 'production.view' },
};

/**
 * Кто есть в системе и какие у него роли. Роли берутся в контексте самого
 * человека — так же, как их берёт бот: обычное соединение приходит в базу как
 * `metall_app`, и политика RLS без контекста не отдаёт ни строки назначения.
 */
const logins = await prisma.withContext(null, [], (tx) =>
  tx.$queryRawUnsafe(
    `SELECT id::text AS id, login FROM user_account WHERE is_active ORDER BY login`,
  ),
);
const users = [];
for (const u of logins) {
  const rows = await prisma.withContext(BigInt(u.id), [], (tx) =>
    tx.$queryRawUnsafe(
      `SELECT DISTINCT r.code FROM user_role_assignment a JOIN role r ON r.id = a.role_id WHERE a.user_id = $1`,
      BigInt(u.id),
    ),
  );
  users.push({ ...u, roles: rows.map((r) => r.code).join(',') });
}

const bad = [];
let passed = 0;
for (const row of users) {
  const roles = (row.roles ?? '').split(',').filter(Boolean);
  const allowed = botAllowed(roles);
  console.log(
    `\n=== ${row.login} [${roles.join(', ') || 'без роли'}] — ${allowed ? 'в бота пускают' : 'в бота НЕ пускают'}`,
  );
  if (!allowed) continue;
  passed += 1;

  const profile = await auth.loadProfile(BigInt(row.id));
  const companies = await auth.companies(profile.companyIds);
  const me = {
    userId: BigInt(row.id),
    permissions: profile.permissions,
    companyIds: profile.companyIds,
    companies: companies.map((c) => ({ id: c.id, uid: c.uid, nameRu: c.nameRu, nameUz: c.nameUz })),
  };

  const lines = await digest.lines(me.userId, me.companyIds, me.permissions, UZ);
  console.log(`  приветствие: строк ${lines.length}`);
  for (const l of lines) console.log(`    ${plain(l)}`);

  // «Как пользоваться»: пути к делам именно этого человека.
  const paths = howToFor(me.permissions);
  console.log(
    `  подсказка: путей ${paths.length} — ${paths.map((p) => (UZ ? p.uz : p.ru)).join(' | ')}`,
  );
  if (paths.length === 0) bad.push(`${row.login}: подсказка пустая`);

  const menu = mainMenu(me.permissions, UZ);
  console.log(`  меню: ${labels(menu).join(' | ')}`);
  const sections = allowedSections(me.permissions).map((s) => s.key);
  if (sections.length === 0) bad.push(`${row.login}: меню пустое`);

  for (const key of sections) {
    const part = parts[key];
    if (!part) {
      // Разделов-заглушек больше нет: все шесть профилей ТЗ 11 живые.
      bad.push(`${row.login}/${key}: раздел не открывается — остался «появится позже»`);
      continue;
    }
    const screen = await part.svc.route(me, null, part.open, UZ);
    const btns = labels(screen.keyboard);
    console.log(`  ${key}: кнопок ${btns.length} — ${btns.join(' | ')}`);
    if (btns.length <= 1) bad.push(`${row.login}/${key}: одна кнопка «назад», смотреть нечего`);
    if (plain(screen.text).trim().length < 40)
      bad.push(`${row.login}/${key}: экран без объяснения`);
  }
}

console.log('\n---');
if (passed === 0) bad.push('в бота не пустило ни одной учётки — проверять нечего');
if (bad.length) {
  console.log('НЕ ОК:');
  for (const b of bad) console.log(`  ${b}`);
} else {
  console.log(
    'ОК: у каждой допущенной роли непустое меню, каждый раздел открывается и объясняет себя',
  );
}
await app.close();
process.exit(bad.length ? 1 : 0);
