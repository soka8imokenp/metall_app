/**
 * Фото из Telegram: чек к операции и снимок к движению (ТЗ 6.1, 5.4).
 *
 * Зачем это в боте. Бумажный чек к вечеру теряется в кармане, а списанный
 * товар через час увозят — и спор «что там было» через месяц решается только
 * снимком. Сфотографировать умеет и тот, кто системой не пользуется: это
 * единственный способ приложить бумагу к записи, не заходя в систему.
 *
 * Чего бот не делает: не читает сумму с фотографии. Распознавание ошибается
 * на тысячах, а исправлять их пришлось бы бухгалтеру по той же фотографии. В
 * записи остаётся сумма, которую назвал человек, — и так сказано на экране.
 *
 * Telegram подменён целиком, включая выдачу файла: настоящий разговор с ним
 * означал бы, что проверка зависит от чужого сервера.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
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

/**
 * Директор: деньги и производство. Кладовщик: склад.
 *
 * Производство проверяется на директоре, а не на мастере цеха: `BOT_ROLES`
 * (menu.ts) пускает в бота пять ролей, и производственных среди них нет —
 * решение клиента 02.10, мастер работает в самой системе. Директор при этом
 * держит `production.manage`, то есть и кнопку фото к заданию.
 */
const DIRECTOR = 's.radjabov';
const KEEPER = 'a.saidov';
/**
 * Менеджер: склад видит, двигать товар не может, производство не видит вовсе —
 * на нём проверяется право и на складе, и в цеху.
 */
const WATCHER = 'b.ergashev';

const TG_DIR = 980000402n;
const TG_KEEP = 980000404n;
const TG_WATCH = 980000406n;

/** «Снимок»: содержимое для проверки неважно, важно, что это те же байты. */
const SHOT = Buffer.from('фото чека из проверки — не настоящая картинка', 'utf8');
const SHOT_SHA = createHash('sha256').update(SHOT).digest('hex');

interface Sent {
  method: string;
  text?: string;
  buttons: string[];
  data: string[];
}

class FakeTelegram {
  sent: Sent[] = [];
  answers: { id: string; text?: string }[] = [];
  /** Что отдавать на `downloadFile`: по умолчанию наш «снимок». */
  bytes: Buffer = SHOT;
  /**
   * Мелкий размер Telegram кладёт для предпросмотра, и чек на нём не читается.
   * Поэтому подделка отдаёт по нему другие байты: проверка «берём крупный»
   * иначе проходила бы и тогда, когда бот берёт превью.
   */
  preview: Buffer = Buffer.from('это превью, чек на нём не читается', 'utf8');
  /** Какое расширение будет у пути файла: от него бот берёт тип. */
  ext = 'jpg';
  private nextId = 4000;

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
  getFile(fileId: string) {
    return Promise.resolve({ file_id: fileId, file_path: `photos/${fileId}.${this.ext}` });
  }
  downloadFile(path: string) {
    const body = path.includes('-small') ? this.preview : this.bytes;
    const copy = new ArrayBuffer(body.length);
    new Uint8Array(copy).set(body);
    return Promise.resolve(copy);
  }

  last(): Sent {
    return this.sent[this.sent.length - 1]!;
  }
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
/** Операция, к которой прикладываем чек, и движение, к которому снимок. */
let operation: { uid: string; number: string };
let move: { uid: string };
let order: { uid: string; number: string };
const madeAttachments: string[] = [];

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

/** Сообщение с фотографией: Telegram присылает несколько размеров. */
const photo = (chatId: bigint, from: bigint, id = 'shot'): TelegramUpdate => ({
  update_id: messageId,
  message: {
    message_id: messageId++,
    date: 0,
    chat: { id: Number(chatId), type: 'private' },
    from: { id: Number(from), is_bot: false },
    photo: [
      { file_id: `${id}-small`, file_size: 900 },
      { file_id: `${id}-big`, file_size: 90_000 },
    ],
  },
});

/** Сообщение с файлом: так присылают PDF и так же — что-нибудь лишнее. */
const file = (
  chatId: bigint,
  from: bigint,
  fileName: string,
  mimeType: string,
): TelegramUpdate => ({
  update_id: messageId,
  message: {
    message_id: messageId++,
    date: 0,
    chat: { id: Number(chatId), type: 'private' },
    from: { id: Number(from), is_bot: false },
    document: { file_id: 'doc-1', file_name: fileName, mime_type: mimeType },
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
  expect(
    index,
    `кнопки «${prefix}» на экране нет: ${tg.last().buttons.join(' | ')}`,
  ).toBeGreaterThan(-1);
  await bot.handleUpdate(press(tgId, tgId, tg.last().data[index]!));
}

const attachmentsOf = async (column: string, uid: string) =>
  (
    await db.query<{
      uid: string;
      kind: string;
      mime: string;
      size: string;
      sha: string;
      comment: string | null;
      author: string | null;
    }>(
      `SELECT a.uid, a.kind::text AS kind, a.mime_type AS mime, a.size_bytes::text AS size,
              a.sha256 AS sha, a.comment, u.login AS author
         FROM attachment a
         LEFT JOIN user_account u ON u.id = a.created_by
        WHERE a.${column} = (SELECT id FROM ${column.replace('_id', '')} WHERE uid = $1::uuid)
        ORDER BY a.id`,
      [uid],
    )
  ).rows;

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
  await clean();
  await signIn(TG_DIR, DIRECTOR);
  await signIn(TG_KEEP, KEEPER);
  await signIn(TG_WATCH, WATCHER);

  const op = await db.query<{ uid: string; number: string }>(
    `SELECT uid, number FROM finance_operation ORDER BY id DESC LIMIT 1`,
  );
  expect(op.rows[0], 'в базе нужна финансовая операция').toBeTruthy();
  operation = op.rows[0]!;

  const mv = await db.query<{ uid: string }>(`SELECT uid FROM stock_move ORDER BY id DESC LIMIT 1`);
  expect(mv.rows[0], 'в базе нужно движение по складу').toBeTruthy();
  move = mv.rows[0]!;

  // Заказ в работе: только по такому цех сдаёт выпуск, и только у такого
  // карточка в боте показывает кнопки смены.
  const po = await db.query<{ uid: string; number: string }>(
    `SELECT uid, number FROM production_order WHERE status = 'in_progress' ORDER BY id LIMIT 1`,
  );
  expect(po.rows[0], 'в базе нужен заказ на производство в работе').toBeTruthy();
  order = po.rows[0]!;
});

afterAll(async () => {
  // Вложения проверки уносим вместе с файлами: это база разработки, а не
  // свалка снимков. Файл лежит на диске по ключу из строки, поэтому сначала
  // читаем ключ, потом удаляем строку.
  const root = process.env.ATTACHMENTS_DIR ?? join(process.cwd(), 'var', 'attachments');
  for (const uid of madeAttachments) {
    const row = await db.query<{ key: string }>(
      `SELECT storage_key AS key FROM attachment WHERE uid = $1::uuid`,
      [uid],
    );
    await db.query(`DELETE FROM attachment WHERE uid = $1::uuid`, [uid]);
    // Файл уносим после строки: оставить его на диске значит копить снимки
    // проверки в рабочем дереве.
    if (row.rows[0]) await rm(join(root, row.rows[0].key), { force: true });
  }
  await clean();
  await db.end();
});

async function clean() {
  const chats = [String(TG_DIR), String(TG_KEEP), String(TG_WATCH)];
  await db.query('DELETE FROM telegram_session WHERE chat_id = ANY($1)', [chats]);
  await db.query(
    `UPDATE user_account SET telegram_user_id = NULL, telegram_linked_at = NULL
      WHERE telegram_user_id = ANY($1)`,
    [chats],
  );
  await db.query(
    `UPDATE user_account SET locale = 'ru', failed_login_count = 0, locked_until = NULL
      WHERE login = ANY($1)`,
    [[DIRECTOR, KEEPER, WATCHER]],
  );
}

describe('фото чека к финансовой операции', () => {
  it('фото «просто в чат» бот не проглатывает, а объясняет, куда его приложить', async () => {
    tg.clear();
    const before = await attachmentsOf('finance_operation_id', operation.uid);

    await bot.handleUpdate(photo(TG_DIR, TG_DIR));

    expect(tg.plain(), 'не сказано, что делать со снимком').toMatch(
      /не знаю, к чему его приложить/,
    );
    expect(tg.plain(), 'не сказано, как приложить правильно').toMatch(/откройте нужную запись/i);
    const after = await attachmentsOf('finance_operation_id', operation.uid);
    expect(after.length, 'снимок прилип к записи сам собой').toBe(before.length);
  });

  it('в карточке операции есть кнопка фото, и она объясняет, что снимать', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, `f:o:${operation.uid}`));
    expect(tg.last().data, 'кнопки фото в карточке нет').toContain(`f:ph:${operation.uid}`);

    await pressByText(TG_DIR, '📷 Фото чека');
    const text = tg.plain();
    expect(text).toContain(operation.number);
    expect(text, 'не сказано, что снимать').toMatch(/сумма и дата должны быть видны/);
    // Прямо сказано, чего бот не делает: сумму с фотографии он не читает.
    expect(text, 'не сказано, что сумму с фото бот не читает').toMatch(
      /Сумму с фотографии я не читаю/,
    );
  });

  it('текст вместо снимка не принимается, просьба повторяется целиком', async () => {
    tg.clear();
    await bot.handleUpdate(message(TG_DIR, TG_DIR, '1 500 000'));
    expect(tg.plain(), 'текст приняли за снимок').toMatch(/жду снимок/i);
    expect(tg.plain(), 'просьба не повторена').toMatch(/Пришлите фото чека/);
  });

  it('присланный снимок ложится к операции теми же байтами', async () => {
    tg.clear();
    const before = new Set(
      (await attachmentsOf('finance_operation_id', operation.uid)).map((r) => r.uid),
    );

    await bot.handleUpdate(photo(TG_DIR, TG_DIR));

    expect(tg.plain(), 'не сказано, что фото приложено').toMatch(/Фото приложено к записи/);
    expect(tg.plain(), 'в карточке не видно числа файлов').toMatch(/Приложено файлов/);

    const added = (await attachmentsOf('finance_operation_id', operation.uid)).filter(
      (r) => !before.has(r.uid),
    );
    expect(added.length, 'вложения в базе нет').toBe(1);
    madeAttachments.push(added[0]!.uid);

    expect(added[0]!.kind).toBe('photo');
    expect(added[0]!.mime, 'тип файла взят не из расширения').toBe('image/jpeg');
    // Байты — те, что у крупного размера: превью не годится, на нём чек не
    // читается.
    expect(added[0]!.sha, 'приложили не крупный размер').toBe(SHOT_SHA);
    expect(Number(added[0]!.size)).toBe(SHOT.length);
    // Автор — тот, кто прислал: вложение подписано человеком, а не ботом.
    expect(added[0]!.author).toBe(DIRECTOR);
    expect(added[0]!.comment, 'не видно, что файл пришёл из Telegram').toMatch(/Telegram/);
  });

  it('второй снимок к той же операции складывается рядом, а не затирает первый', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, `f:ph:${operation.uid}`));
    tg.bytes = Buffer.from('второй снимок', 'utf8');
    await bot.handleUpdate(photo(TG_DIR, TG_DIR, 'shot2'));
    tg.bytes = SHOT;

    const rows = await attachmentsOf('finance_operation_id', operation.uid);
    const second = rows.find(
      (r) => r.sha === createHash('sha256').update('второй снимок', 'utf8').digest('hex'),
    );
    expect(second, 'второй снимок не записался').toBeTruthy();
    madeAttachments.push(second!.uid);
    // Первый остался на месте: второй снимок кладётся рядом, а не вместо.
    expect(
      rows.some((r) => r.sha === SHOT_SHA),
      'первый снимок исчез',
    ).toBe(true);
    expect(tg.plain()).toMatch(/Всего файлов: \d/);
  });

  it('файл не того типа служба не принимает и говорит словами', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, `f:ph:${operation.uid}`));
    const before = await attachmentsOf('finance_operation_id', operation.uid);

    await bot.handleUpdate(file(TG_DIR, TG_DIR, 'заметки.txt', 'text/plain'));

    expect(tg.plain(), 'отказ не словами').toMatch(/только jpeg, png, webp, heic и pdf/);
    const after = await attachmentsOf('finance_operation_id', operation.uid);
    expect(after.length, 'файл не того типа всё же записался').toBe(before.length);
  });
});

describe('снимок к движению по складу', () => {
  it('кладовщик прикладывает снимок к движению, и он виден в карточке', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_KEEP, TG_KEEP, `w:o:${move.uid}`));
    expect(tg.last().data, 'кнопки фото в карточке движения нет').toContain(`w:ph:${move.uid}`);

    await pressByText(TG_KEEP, '📷 Приложить фото');
    expect(tg.plain(), 'не сказано, что снимать').toMatch(/бирк/);

    tg.bytes = Buffer.from('снимок брака', 'utf8');
    await bot.handleUpdate(photo(TG_KEEP, TG_KEEP, 'wh'));
    tg.bytes = SHOT;

    expect(tg.plain(), 'не сказано, что фото приложено').toMatch(/Фото приложено к движению/);
    const rows = await attachmentsOf('stock_move_id', move.uid);
    const mine = rows.find(
      (r) => r.sha === createHash('sha256').update('снимок брака', 'utf8').digest('hex'),
    );
    expect(mine, 'вложения к движению нет').toBeTruthy();
    madeAttachments.push(mine!.uid);
    expect(mine!.author).toBe(KEEPER);
    // Карточка движения сразу показывает, что снимок есть.
    expect(tg.plain()).toMatch(/Приложено файлов/);
  });

  it('у кого нет права двигать товар — у того нет и кнопки, и нажатие не проходит', async () => {
    // Менеджер по продажам склад видит, но права «warehouse.move» у него нет:
    // приложить снимок к движению значит дописать к нему доказательство.
    tg.clear();
    await bot.handleUpdate(press(TG_WATCH, TG_WATCH, `w:o:${move.uid}`));
    expect(tg.last().data, 'кнопку фото показали без права').not.toContain(`w:ph:${move.uid}`);

    tg.clear();
    await bot.handleUpdate(press(TG_WATCH, TG_WATCH, `w:ph:${move.uid}`));
    const answer = tg.answers[tg.answers.length - 1];
    expect(answer?.text ?? tg.plain(), 'право не проверено на нажатии').toMatch(/прав/i);
    expect(tg.plain(), 'показали экран ожидания снимка').not.toMatch(/Пришлите фото к движению/);
  });
});

/**
 * Снимок к заданию цеха (ТЗ 4.1, 4.6).
 *
 * До этого раздел «Производство» в боте фото не принимал: в модуле некуда было
 * его положить. Теперь вложения у задания есть, и мастер с телефоном у стана
 * прикладывает снимок там же, где отмечает брак, — не доходя до компьютера
 * через весь пролёт.
 */
describe('снимок к заданию цеха', () => {
  it('руководитель прикладывает фото к заданию, и карточка говорит, что оно есть', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, `p:c:${order.uid}`));
    expect(tg.last().data, 'кнопки фото в карточке задания нет').toContain(`p:ph:${order.uid}`);

    await pressByText(TG_DIR, '📷 Приложить фото');
    expect(tg.plain(), 'не сказано, что снимать').toMatch(/фото/i);

    tg.bytes = Buffer.from('снимок раковины по кромке', 'utf8');
    await bot.handleUpdate(photo(TG_DIR, TG_DIR, 'prod'));
    tg.bytes = SHOT;

    expect(tg.plain(), 'не сказано, что фото приложено').toMatch(/Фото приложено/);
    const rows = await attachmentsOf('production_order_id', order.uid);
    const mine = rows.find(
      (r) =>
        r.sha === createHash('sha256').update('снимок раковины по кромке', 'utf8').digest('hex'),
    );
    expect(mine, 'вложения к заданию нет').toBeTruthy();
    madeAttachments.push(mine!.uid);
    expect(mine!.author).toBe(DIRECTOR);
    expect(mine!.kind).toBe('photo');
  });

  it('у кого нет права вести производство — у того нет ни кнопки, ни нажатия', async () => {
    // У менеджера по продажам нет ни `production.view`, ни `production.manage`:
    // производство он в боте не открывает вовсе. Проверяются оба конца —
    // кнопки в ответе нет, и прямое нажатие по её коду тоже не проходит:
    // кнопку рисует карточка, а право на снимок считает сам обработчик.
    tg.clear();
    await bot.handleUpdate(press(TG_WATCH, TG_WATCH, `p:c:${order.uid}`));
    expect(tg.last().data, 'кнопку фото показали без права').not.toContain(`p:ph:${order.uid}`);

    tg.clear();
    await bot.handleUpdate(press(TG_WATCH, TG_WATCH, `p:ph:${order.uid}`));
    const answer = tg.answers[tg.answers.length - 1];
    expect(answer?.text ?? tg.plain(), 'право не проверено на нажатии').toMatch(/прав/i);
  });

  it('файл не того типа служба не принимает и говорит словами', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, `p:ph:${order.uid}`));
    const before = await attachmentsOf('production_order_id', order.uid);

    await bot.handleUpdate(file(TG_DIR, TG_DIR, 'смена.txt', 'text/plain'));

    expect(tg.plain(), 'отказ не словами').toMatch(/только jpeg, png, webp, heic и pdf/);
    const after = await attachmentsOf('production_order_id', order.uid);
    expect(after.length, 'файл не того типа всё же записался').toBe(before.length);
  });
});
