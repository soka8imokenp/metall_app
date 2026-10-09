/**
 * «💱 Курс валют» в боте (ТЗ 6.1-6.3, решение заказчика 03.10.2026).
 *
 * Экран сделан по прямой просьбе: «добавь функцию просмотра курса (кнопку) для
 * всех». Поэтому первое, что здесь проверяется, — кнопка есть у того, у кого
 * прав на финансы нет вовсе: официальный курс ЦБ РУз не данные компании.
 * Правом закрыта только загрузка — она пишет в общий справочник.
 *
 * Второе — пересчёт на экране проверки: человек, заводящий расход в долларах,
 * должен увидеть сумму в сумах до нажатия «Записать», а не после.
 *
 * В сеть прогон не ходит: загрузку с банка он не нажимает, а отказ по праву
 * проверяется до любого обращения к источнику.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AdminModule } from '../src/admin/admin.module.js';
import { FinanceModule } from '../src/finance/finance.module.js';
import { WarehouseModule } from '../src/warehouse/warehouse.module.js';
import { AttachmentsModule } from '../src/attachments/attachments.module.js';
import { SalesModule } from '../src/sales/sales.module.js';
import { DocumentsModule } from '../src/documents/documents.module.js';
import { DashboardModule } from '../src/dashboard/dashboard.module.js';
import { ProductionModule } from '../src/production/production.module.js';
import { RefsModule } from '../src/refs/refs.module.js';
import { BotService } from '../src/bot/bot.service.js';
import { BotFinance } from '../src/bot/finance.bot.js';
import { BotWarehouse } from '../src/bot/warehouse.bot.js';
import { BotSales } from '../src/bot/sales.bot.js';
import { BotDocuments } from '../src/bot/documents.bot.js';
import { BotChief } from '../src/bot/chief.bot.js';
import { BotProduction } from '../src/bot/production.bot.js';
import { BotRates } from '../src/bot/rates.bot.js';
import { DigestService } from '../src/bot/digest.service.js';
import { NeedsService } from '../src/warehouse/needs.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { TelegramApi, type TelegramUpdate } from '../src/bot/telegram.api.js';
import { mainMenu } from '../src/bot/menu.js';

// В сеть прогон не ходит: автозагрузка выключена, и экран показывает ровно
// то, что лежит в справочнике.
process.env.RATES_AUTOLOAD = 'off';

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';
/** Кладовщик: ни финансов, ни правки справочников. Директор: и то, и другое. */
const KEEPER = 'a.saidov';
const DIRECTOR = 's.radjabov';
const TG_KEEPER = 980000501n;
const TG_DIR = 980000502n;
/** Предел подписи к фото в Telegram: лишнее он срезает молча. */
const CAPTION_LIMIT = 1024;

interface Sent {
  text?: string;
  buttons: string[];
  data: string[];
}

class FakeTelegram {
  sent: Sent[] = [];
  answers: { id: string; text?: string }[] = [];
  private nextId = 5000;

  private record(chatId: unknown, text: string | undefined, keyboard: unknown) {
    const rows = (keyboard as { text: string; data: string }[][] | undefined) ?? [];
    this.sent.push({
      text,
      buttons: rows.flat().map((b) => b.text),
      data: rows.flat().map((b) => b.data),
    });
    return { message_id: this.nextId++, date: 0, chat: { id: Number(chatId), type: 'private' } };
  }

  getMe() {
    return Promise.resolve({ id: 1, username: 'metall_asia_bot' });
  }
  sendMessage(chatId: unknown, text: string, keyboard?: unknown) {
    return Promise.resolve(this.record(chatId, text, keyboard));
  }
  sendPhoto(chatId: unknown, _photo: unknown, caption: string, keyboard?: unknown) {
    return Promise.resolve(this.record(chatId, caption, keyboard));
  }
  editMessageText(chatId: unknown, _id: number, text: string, keyboard?: unknown) {
    return Promise.resolve(this.record(chatId, text, keyboard));
  }
  editMessageCaption(chatId: unknown, _id: number, caption: string, keyboard?: unknown) {
    return Promise.resolve(this.record(chatId, caption, keyboard));
  }
  setMyCommands() {
    return Promise.resolve(true);
  }
  deleteMessage() {
    return Promise.resolve(true);
  }
  answerCallback(id: string, text?: string) {
    this.answers.push({ id, text });
    return Promise.resolve(true);
  }

  last(): Sent {
    return this.sent[this.sent.length - 1]!;
  }
  /** Подпись без неразрывных пробелов: Intl разделяет ими разряды. */
  plain(): string {
    return (this.last().text ?? '').replace(/[\u00A0\u202F]/g, ' ');
  }
  clear() {
    this.sent = [];
    this.answers = [];
  }
}

let bot: BotService;
let rates: BotRates;
let tg: FakeTelegram;
let db: Client;
let messageId = 1;

const message = (chatId: bigint, from: bigint, text: string): TelegramUpdate => ({
  update_id: messageId,
  message: {
    message_id: messageId++,
    date: 0,
    text,
    chat: { id: Number(chatId), type: 'private' },
    from: { id: Number(from), is_bot: false },
  },
});

const press = (chatId: bigint, from: bigint, data: string): TelegramUpdate => ({
  update_id: messageId,
  callback_query: {
    id: `cb${messageId++}`,
    data,
    from: { id: Number(from) },
    message: {
      message_id: 700,
      date: 0,
      chat: { id: Number(chatId), type: 'private' },
      photo: [{ file_id: 'welcome' }],
    },
  },
});

async function signIn(tgId: bigint, login: string) {
  await bot.handleUpdate(message(tgId, tgId, '/start'));
  await bot.handleUpdate(press(tgId, tgId, 'l:ru'));
  await bot.handleUpdate(message(tgId, tgId, login));
  await bot.handleUpdate(message(tgId, tgId, PASSWORD));
}

async function pressByText(tgId: bigint, prefix: string) {
  const index = tg.last().buttons.findIndex((b) => b.startsWith(prefix));
  expect(index, `кнопки «${prefix}» нет: ${tg.last().buttons.join(' | ')}`).toBeGreaterThan(-1);
  await bot.handleUpdate(press(tgId, tgId, tg.last().data[index]!));
}

/** Человек в том виде, в каком его видит раздел. */
async function meOf(login: string) {
  const user = await db.query('SELECT id FROM user_account WHERE login = $1', [login]);
  const perms = await db.query(
    `SELECT DISTINCT p.code FROM user_role_assignment a
       JOIN role_permission rp ON rp.role_id = a.role_id
       JOIN permission p ON p.id = rp.permission_id
      WHERE a.user_id = $1`,
    [user.rows[0].id],
  );
  const companies = await db.query(
    `SELECT c.id, c.uid, c.name_ru, c.name_uz FROM company c
      WHERE c.id IN (SELECT company_id FROM user_role_assignment WHERE user_id = $1)
      ORDER BY c.code`,
    [user.rows[0].id],
  );
  return {
    userId: BigInt(user.rows[0].id),
    permissions: new Set<string>(perms.rows.map((r) => r.code)),
    companyIds: companies.rows.map((r) => BigInt(r.id)),
    companies: companies.rows.map((r) => ({
      id: BigInt(r.id),
      uid: r.uid,
      nameRu: r.name_ru,
      nameUz: r.name_uz,
    })),
  };
}

let keeper: Awaited<ReturnType<typeof meOf>>;
let director: Awaited<ReturnType<typeof meOf>>;

beforeAll(async () => {
  tg = new FakeTelegram();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PrismaModule,
      AuthModule,
      AdminModule,
      FinanceModule,
      WarehouseModule,
      SalesModule,
      DocumentsModule,
      DashboardModule,
      ProductionModule,
      AttachmentsModule,
      RefsModule,
    ],
    providers: [
      BotService,
      BotFinance,
      BotWarehouse,
      BotSales,
      BotDocuments,
      BotChief,
      BotProduction,
      BotRates,
      DigestService,
      NeedsService,
      NotificationsService,
      { provide: TelegramApi, useValue: tg },
    ],
  }).compile();
  bot = moduleRef.get(BotService);
  rates = moduleRef.get(BotRates);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  // Курс на сегодня должен быть: иначе экран честно скажет «курс на вчера», и
  // проверка свежести проверяла бы погоду, а не код.
  await db.query(
    `INSERT INTO currency_rate (currency_id, rate_date, rate, source)
     SELECT id, (now() AT TIME ZONE 'Asia/Tashkent')::date, 11772.95, 'cbu.uz'
       FROM currency WHERE code = 'USD'
     ON CONFLICT (currency_id, rate_date) DO UPDATE SET rate = 11772.95, source = 'cbu.uz'`,
  );
  await signIn(TG_KEEPER, KEEPER);
  await signIn(TG_DIR, DIRECTOR);
  keeper = await meOf(KEEPER);
  director = await meOf(DIRECTOR);
}, 60_000);

afterAll(async () => {
  await db?.end();
});

describe('курс валют в боте', () => {
  /** Разряды Intl разделяет неразрывным пробелом. */
  const nbsp = (v: string) => v.replace(/[\u00A0\u202F]/g, ' ');

  it('кнопка стоит в меню у каждого, кто вошёл, — даже без доступа к финансам', async () => {
    expect(keeper.permissions.has('finance.view')).toBe(false);
    const keeperMenu = mainMenu(keeper.permissions, false).flat();
    expect(keeperMenu.map((b) => b.text)).toContain('💱 Курс валют');
    expect(mainMenu(director.permissions, false).flat().map((b) => b.text)).toContain(
      '💱 Курс валют',
    );
    // И это именно та кнопка, которую бот отдаёт в чат.
    tg.clear();
    await bot.handleUpdate(message(TG_KEEPER, TG_KEEPER, '/start'));
    expect(tg.last().buttons).toContain('💱 Курс валют');
  });

  it('экран говорит курс к суму, его дату и когда курс проверяли', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_KEEPER, TG_KEEPER, 'r'));
    const screen = tg.plain();
    expect(screen).toMatch(/Курс валют/);
    expect(screen).toMatch(/Доллар США/);
    // Курс показан как «1 $ = … сум»: код валюты человек в возрасте не читает.
    expect(screen).toMatch(/1 \$ = .*11 772,95 сум/);
    expect(screen).toMatch(/Центрального банка/);
    expect(screen).toMatch(/Проверено в \d{2}:\d{2}/);
    // Сум назван прямо — это ответ на вопрос «а где же он».
    expect(screen).toMatch(/Узбекский сум.*учётная валюта/s);
  });

  it('экран влезает в подпись Telegram целиком', async () => {
    const screen = await rates.screen(director, false);
    expect(screen.text.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    const uz = await rates.screen(director, true);
    expect(uz.text.length).toBeLessThanOrEqual(CAPTION_LIMIT);
  });

  it('узбекский экран без кириллицы', async () => {
    const screen = await rates.screen(keeper, true);
    const letters = screen.text.replace(/<[^>]+>/g, '');
    expect(letters, `кириллица в узбекском экране: ${letters}`).not.toMatch(/[А-Яа-яЁё]/);
    expect(letters).toMatch(/Markaziy bank/);
  });

  it('загрузку с банка жмёт только тот, кому можно править справочники', async () => {
    expect(keeper.permissions.has('refs.edit')).toBe(false);
    expect(director.permissions.has('refs.edit')).toBe(true);

    const keeperScreen = await rates.screen(keeper, false);
    expect(keeperScreen.keyboard.flat().map((b) => b.data)).not.toContain('r:s');
    const bossScreen = await rates.screen(director, false);
    expect(bossScreen.keyboard.flat().map((b) => b.data)).toContain('r:s');

    // Нажатие в обход экрана — из старого сообщения — тоже отбивается, и в
    // справочник ничего не пишется.
    const before = await db.query('SELECT count(*)::int AS n, max(created_at) AS at FROM currency_rate');
    const answer = await rates.route(keeper, 'r:s', false);
    expect(answer.toast).toMatch(/Банк не ответил|позже/);
    const after = await db.query('SELECT count(*)::int AS n, max(created_at) AS at FROM currency_rate');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(String(after.rows[0].at)).toBe(String(before.rows[0].at));
  });

  it('курс не на сегодня — экран говорит это прямо, а не выдаёт за свежий', async () => {
    const today = (
      await db.query(`SELECT (now() AT TIME ZONE 'Asia/Tashkent')::date::text AS d`)
    ).rows[0].d as string;
    const saved = await db.query(
      `DELETE FROM currency_rate
        WHERE rate_date = $1::date AND currency_id = (SELECT id FROM currency WHERE code = 'USD')
        RETURNING rate::text, source`,
      [today],
    );
    try {
      const screen = await rates.screen(keeper, false);
      expect(nbsp(screen.text)).toMatch(/Доллар США[\s\S]*курс на \d{2}\.\d{2}\.\d{4}/);
    } finally {
      for (const r of saved.rows) {
        await db.query(
          `INSERT INTO currency_rate (currency_id, rate_date, rate, source)
           SELECT id, $1::date, $2::numeric, $3 FROM currency WHERE code = 'USD'`,
          [today, r.rate, r.source],
        );
      }
    }
  });

  it('валютный расход на экране проверки сразу пересчитан в сумы', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:n:e'));
    await pressByText(TG_DIR, 'ООО');
    await bot.handleUpdate(message(TG_DIR, TG_DIR, '100'));
    await pressByText(TG_DIR, 'Заработная плата');
    // Счёт в валюте: его подпись заканчивается кодом валюты.
    const usd = tg.last().buttons.findIndex((b) => b.includes('(USD)'));
    expect(usd, `валютного счёта в списке нет: ${tg.last().buttons.join(' | ')}`).toBeGreaterThan(
      -1,
    );
    await bot.handleUpdate(press(TG_DIR, TG_DIR, tg.last().data[usd]!));
    await pressByText(TG_DIR, '➡️ Пропустить');
    await pressByText(TG_DIR, 'Сегодня');
    await bot.handleUpdate(message(TG_DIR, TG_DIR, 'проверка пересчёта'));

    const screen = tg.plain();
    expect(screen).toMatch(/Проверьте/);
    expect(screen).toMatch(/Сумма.*100 \$/);
    // 100 $ по курсу 11 772,95 — это 1 177 295 сум, и курс назван с датой.
    expect(screen).toMatch(/В сумах: 1 177 295 сум/);
    expect(screen).toMatch(/по курсу 11 772,95 на \d{2}\.\d{2}\.\d{4}/);

    // Разговор обрываем: в данные ничего не пишем.
    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:x'));
  });

  it('сумовой расход лишней строкой не засоряется', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:n:e'));
    await pressByText(TG_DIR, 'ООО');
    await bot.handleUpdate(message(TG_DIR, TG_DIR, '100000'));
    await pressByText(TG_DIR, 'Заработная плата');
    await pressByText(TG_DIR, 'Касса');
    await pressByText(TG_DIR, '➡️ Пропустить');
    await pressByText(TG_DIR, 'Сегодня');
    await bot.handleUpdate(message(TG_DIR, TG_DIR, 'проверка без валюты'));

    const screen = tg.plain();
    expect(screen).toMatch(/Проверьте/);
    expect(screen).not.toMatch(/В сумах:/);
    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:x'));
  });
});
