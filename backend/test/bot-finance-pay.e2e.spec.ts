/**
 * Приём оплаты по заказу из бота (ТЗ 11.5, решение заказчика 02.10).
 *
 * Почему это проверяется отдельно и целиком через бота: именно этот путь и
 * просил заказчик — в боте должно быть всё, что нужно сотруднику, потому что
 * его сотрудники компьютером не пользуются. Деньги от клиента принимает тот
 * же человек, который ведёт заказ, и ему нельзя предлагать «зайдите в систему».
 *
 * Что здесь важнее остального:
 * - разговор короче обычного поступления: компанию, покупателя и валюту бот
 *   знает из заказа и не спрашивает;
 * - больше остатка бот не принимает и говорит об этом сразу на вопросе о
 *   сумме, а не отказом в конце мастера;
 * - до проведения долг клиента не меняется, после проведения — уменьшается;
 * - сторно возвращает долг обратно;
 * - из платежа есть путь в заказ, а из заказа — в платёж.
 *
 * Telegram подменён: настоящий разговор с ним означал бы, что проверка
 * зависит от чужого сервера.
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

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

/** Директор: и заводит платёж, и согласовывает, и проводит. */
const DIRECTOR = 's.radjabov';
/** Менеджер по продажам: заказы видит, деньги — нет. */
const MANAGER = 'b.ergashev';

const TG_DIR = 980000302n;
const TG_MAN = 980000304n;

interface Sent {
  method: string;
  text?: string;
  buttons: string[];
  data: string[];
}

class FakeTelegram {
  sent: Sent[] = [];
  answers: { id: string; text?: string }[] = [];
  private nextId = 3000;

  private record(method: string, chatId: unknown, text: string | undefined, keyboard: unknown) {
    const rows = (keyboard as { text: string; data: string }[][] | undefined) ?? [];
    this.sent.push({
      method,
      text,
      buttons: rows.flat().map((b) => b.text),
      data: rows.flat().map((b) => b.data),
    });
    return {
      message_id: this.nextId++,
      date: 0,
      chat: { id: Number(chatId), type: 'private' },
    };
  }

  getMe() {
    return Promise.resolve({ id: 1, username: 'metall_asia_bot' });
  }
  sendMessage(chatId: unknown, text: string, keyboard?: unknown) {
    return Promise.resolve(this.record('sendMessage', chatId, text, keyboard));
  }
  sendPhoto(chatId: unknown, _photo: unknown, caption: string, keyboard?: unknown) {
    return Promise.resolve(this.record('sendPhoto', chatId, caption, keyboard));
  }
  editMessageText(chatId: unknown, _id: number, text: string, keyboard?: unknown) {
    return Promise.resolve(this.record('editMessageText', chatId, text, keyboard));
  }
  editMessageCaption(chatId: unknown, _id: number, caption: string, keyboard?: unknown) {
    return Promise.resolve(this.record('editMessageCaption', chatId, caption, keyboard));
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
  /** Подпись без неразрывных пробелов: иначе проверка сумм читается как ребус. */
  plain(): string {
    return (this.last().text ?? '').replace(/ /g, ' ');
  }
  clear() {
    this.sent = [];
    this.answers = [];
  }
}

let bot: BotService;
let tg: FakeTelegram;
let db: Client;
let messageId = 1;
let runFrom: string;

/** Заказ, по которому платим, и его исходное состояние оплаты. */
let order: {
  uid: string;
  number: string;
  total: string;
  paid: string;
  payment_status: string;
  version: number;
};

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
      RefsModule,
      AttachmentsModule,
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

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  runFrom = (await db.query<{ now: string }>('SELECT now()::text AS now')).rows[0]!.now;
  await clean();
  await signIn(TG_DIR, DIRECTOR);
  await signIn(TG_MAN, MANAGER);

  // Заказ менеджера, которого проверяем: в сумах, не отменён, не оплачен.
  // Берём самый крупный — на нём остаток точно делится на части.
  const found = await db.query(
    `SELECT o.uid, o.number, o.amount_total::text AS total, o.paid_amount::text AS paid,
            o.payment_status::text, o.version
       FROM sales_order o
       JOIN currency cur ON cur.id = o.currency_id
      WHERE o.status NOT IN ('cancelled') AND cur.code = 'UZS'
        AND o.paid_amount < o.amount_total
        AND o.company_id IN (SELECT company_id FROM user_role_assignment
                              WHERE user_id = (SELECT id FROM user_account WHERE login = $1))
      ORDER BY o.amount_total DESC LIMIT 1`,
    [MANAGER],
  );
  // Заказ берём в компании менеджера: на нём же проверяется, что человеку без
  // права на деньги кнопку приёма оплаты не показывают.
  expect(found.rows[0], 'в базе нужен неоплаченный заказ в сумах').toBeTruthy();
  order = found.rows[0];
});

afterAll(async () => {
  await clean();
  await db.end();
});

async function clean() {
  if (runFrom) {
    const users = `(SELECT id FROM user_account WHERE login = ANY($2))`;
    await db.query(
      `DELETE FROM finance_entry WHERE operation_id IN
         (SELECT id FROM finance_operation WHERE created_at >= $1 AND created_by IN ${users})`,
      [runFrom, [DIRECTOR]],
    );
    await db.query(
      `DELETE FROM finance_operation
        WHERE created_at >= $1 AND created_by IN ${users} AND reversal_of_id IS NOT NULL`,
      [runFrom, [DIRECTOR]],
    );
    await db.query(
      `DELETE FROM finance_operation WHERE created_at >= $1 AND created_by IN ${users}`,
      [runFrom, [DIRECTOR]],
    );
  }
  // Заказ возвращаем как было: он живой, его читают другие проверки.
  if (order) {
    await db.query(
      `UPDATE sales_order
          SET paid_amount = $2::numeric, payment_status = $3::"PaymentStatus", version = $4
        WHERE uid = $1`,
      [order.uid, order.paid, order.payment_status, order.version],
    );
  }
  await db.query('DELETE FROM telegram_session WHERE chat_id = ANY($1)', [
    [String(TG_DIR), String(TG_MAN)],
  ]);
  await db.query(
    `UPDATE user_account SET telegram_user_id = NULL, telegram_linked_at = NULL
      WHERE telegram_user_id = ANY($1)`,
    [[String(TG_DIR), String(TG_MAN)]],
  );
  await db.query(
    `UPDATE user_account SET locale = 'ru', failed_login_count = 0, locked_until = NULL
      WHERE login = ANY($1)`,
    [[DIRECTOR, MANAGER]],
  );
}

async function signIn(tgId: bigint, login: string) {
  await bot.handleUpdate(message(tgId, tgId, '/start'));
  await bot.handleUpdate(press(tgId, tgId, 'l:ru'));
  await bot.handleUpdate(message(tgId, tgId, login));
  await bot.handleUpdate(message(tgId, tgId, PASSWORD));
}

async function pressByText(tgId: bigint, prefix: string) {
  const index = tg.last().buttons.findIndex((b) => b.startsWith(prefix));
  expect(
    index,
    `кнопки «${prefix}» на экране нет: ${tg.last().buttons.join(' | ')}`,
  ).toBeGreaterThan(-1);
  await bot.handleUpdate(press(tgId, tgId, tg.last().data[index]!));
}

const paidNow = async () =>
  Number(
    (
      await db.query<{ paid: string }>(
        `SELECT paid_amount::text AS paid FROM sales_order WHERE uid = $1`,
        [order.uid],
      )
    ).rows[0]!.paid,
  );

const statusNow = async () =>
  (
    await db.query<{ s: string }>(
      `SELECT payment_status::text AS s FROM sales_order WHERE uid = $1`,
      [order.uid],
    )
  ).rows[0]!.s;

/** Номер платежа с экрана. */
function numberOnScreen(): string {
  const m = (tg.last().text ?? '').match(/ПП-\d{6}/);
  expect(m, `номера платежа на экране нет: ${tg.last().text}`).not.toBeNull();
  return m![0];
}

/** Остаток к оплате так, как его считает служба: с незаконченными платежами. */
async function free(): Promise<number> {
  const r = await db.query<{ free: string }>(
    `SELECT (o.amount_total - coalesce(sum(f.amount) FILTER (
              WHERE f.status IN ('posted', 'draft', 'pending_approval', 'approved')), 0))::text
            AS free
       FROM sales_order o
       LEFT JOIN finance_operation f
              ON f.source_doc_type = 'sales_order' AND f.source_doc_id = o.id
             AND f.operation_type = 'income'
      WHERE o.uid = $1
      GROUP BY o.amount_total`,
    [order.uid],
  );
  return Number(r.rows[0]!.free);
}

let payment = '';

describe('оплата по заказу из бота', () => {
  it('в карточке заказа виден остаток и кнопка приёма оплаты', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, `o:c:${order.uid}`));

    expect(tg.plain()).toContain(order.number);
    expect(tg.plain(), 'остатка к получению на экране нет').toMatch(/Осталось получить/);
    expect(tg.last().data).toContain(`f:pay:${order.uid}`);
  });

  it('спрашивает только сумму: компанию и клиента берёт из заказа', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, `f:pay:${order.uid}`));

    const text = tg.plain();
    expect(text).toMatch(/Оплата по заказу/);
    expect(text).toContain(order.number);
    expect(text, 'остаток на экране суммы не назван').toMatch(/Неоплаченный остаток/);
    // Шагов меньше, чем в обычном поступлении: там их семь с компанией.
    expect(text).toMatch(/Шаг 1 из 4/);
    expect(text, 'спрашивает про компанию, хотя она в заказе').not.toMatch(/По какой компании/);
  });

  it('сумму больше остатка не принимает и остаётся на том же вопросе', async () => {
    tg.clear();
    const over = Math.round(Number(order.total) * 2);
    await bot.handleUpdate(message(TG_DIR, TG_DIR, String(over)));

    expect(tg.plain(), 'лишнюю сумму приняли').toMatch(/больше остатка/);
    // Вопрос повторён целиком: человеку не надо листать переписку вверх.
    expect(tg.plain()).toMatch(/Сколько денег пришло по заказу/);
  });

  it('по шагам доводит до проверки и показывает остаток после платежа', async () => {
    const part = Math.floor((await free()) / 2);
    tg.clear();
    await bot.handleUpdate(message(TG_DIR, TG_DIR, String(part)));
    // Статья подставлена сама: в компании она одна. Следующий вопрос — счёт.
    expect(tg.plain(), 'после суммы спросили не про счёт').toMatch(/деньги/i);
    await pressByText(TG_DIR, 'Касса');
    await pressByText(TG_DIR, 'Сегодня');
    await pressByText(TG_DIR, '➡️ Пропустить');

    const text = tg.plain();
    expect(text).toMatch(/Проверьте/);
    expect(text, 'заказа на проверке нет').toContain(order.number);
    expect(text, 'остатка после платежа на проверке нет').toMatch(/Останется по заказу/);
  });

  it('записанный платёж оплату заказа не меняет: это ещё заявка', async () => {
    const before = await paidNow();
    await pressByText(TG_DIR, '✅ Записать');

    payment = numberOnScreen();
    expect(tg.plain(), 'не сказано, что долг пока не уменьшился').toMatch(/не уменьшился/);
    expect(tg.plain(), 'заказа в карточке платежа нет').toContain(order.number);
    expect(await paidNow()).toBeCloseTo(before, 2);

    const link = await db.query<{ t: string | null; n: string | null }>(
      `SELECT f.source_doc_type AS t, o.number AS n
         FROM finance_operation f
         LEFT JOIN sales_order o ON o.id = f.source_doc_id
        WHERE f.number = $1`,
      [payment],
    );
    expect(link.rows[0]!.t).toBe('sales_order');
    expect(link.rows[0]!.n).toBe(order.number);
  });

  it('проведение уменьшает долг по заказу', async () => {
    const before = await paidNow();
    const amount = Number(
      (
        await db.query<{ a: string }>(
          `SELECT amount::text AS a FROM finance_operation WHERE number = $1`,
          [payment],
        )
      ).rows[0]!.a,
    );

    await pressByText(TG_DIR, '📤 Отправить');
    await pressByText(TG_DIR, 'Да');
    await pressByText(TG_DIR, '✅ Согласовать');
    await pressByText(TG_DIR, 'Да');
    await pressByText(TG_DIR, '💸 Провести');
    await pressByText(TG_DIR, 'Да');

    expect(tg.plain()).toMatch(/Деньги прошли/);
    expect(await paidNow()).toBeCloseTo(before + amount, 2);
    expect(await statusNow()).toBe('partial');
  });

  it('из платежа есть путь в заказ, и там видна оплата', async () => {
    await pressByText(TG_DIR, '⬅️ К заказу');
    expect(tg.plain()).toContain(order.number);
    expect(tg.plain(), 'в заказе не видно оплаченного').toMatch(/оплачено/);
  });

  it('сторно платежа возвращает долг обратно', async () => {
    const before = await paidNow();
    const amount = Number(
      (
        await db.query<{ a: string }>(
          `SELECT amount::text AS a FROM finance_operation WHERE number = $1`,
          [payment],
        )
      ).rows[0]!.a,
    );

    const op = await db.query<{ uid: string }>(
      `SELECT uid FROM finance_operation WHERE number = $1`,
      [payment],
    );
    await bot.handleUpdate(press(TG_DIR, TG_DIR, `f:o:${op.rows[0]!.uid}`));
    await pressByText(TG_DIR, '↩️ Сторно');
    await pressByText(TG_DIR, 'Да');

    expect(tg.plain()).toMatch(/Сторно сделано/);
    expect(await paidNow()).toBeCloseTo(before - amount, 2);
  });

  it('когда остаток занят заявками, платить нечего', async () => {
    // Заводим платёж на весь свободный остаток и не проводим его.
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, `f:pay:${order.uid}`));
    await bot.handleUpdate(message(TG_DIR, TG_DIR, (await free()).toFixed(2)));
    await pressByText(TG_DIR, 'Касса');
    await pressByText(TG_DIR, 'Сегодня');
    await pressByText(TG_DIR, '➡️ Пропустить');
    await pressByText(TG_DIR, '✅ Записать');

    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, `f:pay:${order.uid}`));
    expect(tg.plain(), 'бот предложил платить второй раз').toMatch(/платить нечего/);
    expect(tg.plain()).toMatch(/ждёт согласования/);
    expect(tg.last().data, 'нет пути назад в заказ').toContain(`o:c:${order.uid}`);
  });

  it('менеджеру по продажам приём оплаты не предлагают', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_MAN, TG_MAN, `o:c:${order.uid}`));
    expect(tg.plain(), 'менеджер не увидел заказ').toContain(order.number);
    expect(tg.last().data, 'менеджеру дали кнопку приёма оплаты').not.toContain(
      `f:pay:${order.uid}`,
    );

    tg.clear();
    await bot.handleUpdate(press(TG_MAN, TG_MAN, `f:pay:${order.uid}`));
    const answer = tg.answers[tg.answers.length - 1];
    expect(answer?.text ?? tg.plain(), 'менеджеру ответили не отказом').toMatch(/прав/i);
  });
});
