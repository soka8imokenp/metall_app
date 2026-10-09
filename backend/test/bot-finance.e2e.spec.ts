/**
 * Финансы в боте целиком (ТЗ 11.2, решение заказчика 02.10).
 *
 * Проверяется то, ради чего раздел и делался: человек, который системой не
 * пользуется, может завести расход по шагам, отправить его, согласовать,
 * провести и отменить — и всё это ложится теми же проводками и тем же
 * журналом, что работа в браузере. Отдельно проверяется, что бот не даёт
 * обойти права и не проводит дважды.
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
/**
 * Директор: заводит, согласовывает и проводит. Менеджер по продажам: бот ему
 * положен, а финансы — нет.
 *
 * Сотрудники здесь свои, не общие с `bot-frame` и `notifications`: привязка
 * Telegram у человека одна, и два файла проверок, идущие параллельно, отбирали
 * бы её друг у друга. Один раз так и вышло — проверка упала не по делу.
 */
const DIRECTOR = 's.radjabov';
const MANAGER = 'b.ergashev';

const TG_DIR = 980000202n;
const TG_MAN = 980000204n;

interface Sent {
  method: string;
  text?: string;
  buttons: string[];
  /** Кнопки по рядам: «по одной в ряд» по плоскому списку не проверить. */
  rows: string[][];
  data: string[];
}

class FakeTelegram {
  sent: Sent[] = [];
  answers: { id: string; text?: string }[] = [];
  private nextId = 2000;

  private record(method: string, chatId: unknown, text: string | undefined, keyboard: unknown) {
    const rows = (keyboard as { text: string; data: string }[][] | undefined) ?? [];
    this.sent.push({
      method,
      text,
      buttons: rows.flat().map((b) => b.text),
      rows: rows.map((r) => r.map((b) => b.text)),
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
    return (this.last().text ?? '').replace(/ /g, ' ');
  }
  clear() {
    this.sent = [];
    this.answers = [];
  }
}

let bot: BotService;
let tg: FakeTelegram;
let db: Client;
let finance: BotFinance;
let messageId = 1;
let runFrom: string;
/** Директор в том виде, в каком его видит раздел: нужно для проверки прав. */
let director: {
  userId: bigint;
  companyIds: bigint[];
  companies: { id: bigint; uid: string; nameRu: string; nameUz: string }[];
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
  finance = moduleRef.get(BotFinance);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  runFrom = (await db.query<{ now: string }>('SELECT now()::text AS now')).rows[0]!.now;
  await clean();
  await signIn(TG_DIR, DIRECTOR);
  await signIn(TG_MAN, MANAGER);

  const user = await db.query('SELECT id FROM user_account WHERE login = $1', [DIRECTOR]);
  const companies = await db.query(
    `SELECT c.id, c.uid, c.name_ru, c.name_uz FROM company c
      WHERE c.id IN (SELECT company_id FROM user_role_assignment WHERE user_id = $1)
      ORDER BY c.code`,
    [user.rows[0].id],
  );
  director = {
    userId: BigInt(user.rows[0].id),
    companyIds: companies.rows.map((r) => BigInt(r.id)),
    companies: companies.rows.map((r) => ({
      id: BigInt(r.id),
      uid: r.uid,
      nameRu: r.name_ru,
      nameUz: r.name_uz,
    })),
  };
});

afterAll(async () => {
  await clean();
  await db.end();
});

/**
 * За собой убираем операции, но не журнал: `audit_log` закрыт на дозапись, и
 * это правильно — запись о том, что проверка провела платёж, тоже история.
 */
async function clean() {
  if (runFrom) {
    const users = `(SELECT id FROM user_account WHERE login = ANY($2))`;
    await db.query(
      `DELETE FROM finance_entry WHERE operation_id IN
         (SELECT id FROM finance_operation WHERE created_at >= $1 AND created_by IN ${users})`,
      [runFrom, [DIRECTOR]],
    );
    // Сторно ссылается на отменённую операцию, поэтому уходит первым.
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

/** Нажать кнопку, подпись которой начинается с этих слов. */
async function pressByText(tgId: bigint, prefix: string) {
  const index = tg.last().buttons.findIndex((b) => b.startsWith(prefix));
  expect(
    index,
    `кнопки «${prefix}» на экране нет: ${tg.last().buttons.join(' | ')}`,
  ).toBeGreaterThan(-1);
  const data = tg.last().data[index]!;
  await bot.handleUpdate(press(tgId, tgId, data));
}

/** Пройти мастер расхода до экрана проверки. */
async function wizardToConfirm(tgId: bigint, amount: string, comment: string) {
  await bot.handleUpdate(press(tgId, tgId, 'f:n:e'));
  await pressByText(tgId, 'ООО');
  await bot.handleUpdate(message(tgId, tgId, amount));
  await pressByText(tgId, 'Заработная плата');
  await pressByText(tgId, 'Касса');
  await pressByText(tgId, '➡️ Пропустить');
  await pressByText(tgId, 'Сегодня');
  await bot.handleUpdate(message(tgId, tgId, comment));
}

async function operationCount(): Promise<number> {
  const out = await db.query('SELECT count(*)::int AS n FROM finance_operation');
  return out.rows[0].n;
}

/** Какую операцию бот только что открыл: номер читаем из подписи. */
function numberOnScreen(): string {
  const m = (tg.last().text ?? '').match(/(РП|ПП)-\d{6}/);
  expect(m, `номера операции на экране нет: ${tg.last().text}`).not.toBeNull();
  return m![0];
}

async function row(number: string) {
  const out = await db.query(
    `SELECT uid, status::text, amount::text, version, comment,
            (SELECT count(*) FROM finance_entry e WHERE e.operation_id = o.id)::int AS entries
       FROM finance_operation o WHERE number = $1 ORDER BY id DESC LIMIT 1`,
    [number],
  );
  return out.rows[0];
}

let created = '';

describe('финансы в боте: раздел', () => {
  it('открывается сразу экранами, а не рассказом о планах', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'm:finance'));
    expect(tg.plain(), 'раздел всё ещё «готовится»').not.toMatch(/Раздел готовится/);
    expect(tg.last().data).toContain('f:n:e');
    expect(tg.last().data).toContain('f:l');
    expect(tg.last().data).toContain('f:d');
    // Экран сначала говорит, зачем он: заказчик 02.10 просил именно это.
    expect(tg.plain()).toMatch(/Здесь деньги/);
    // Дела перечислены пунктами, а не абзацем: человек в возрасте абзац из
    // пяти дел читает как стену.
    const home = tg.plain();
    expect(
      home.split('\n').filter((l) => l.startsWith('• ')).length,
      'раздел снова перечисляет дела абзацем',
    ).toBeGreaterThanOrEqual(3);
  });

  it('менеджера в деньги не пускает', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_MAN, TG_MAN, 'f'));
    const answer = tg.answers[tg.answers.length - 1]!;
    expect(answer.text, 'менеджеру ответили не отказом').toMatch(/прав/i);
    expect(tg.plain(), 'менеджеру показали финансы').not.toMatch(/Здесь деньги/);
  });
});

describe('финансы в боте: мастер расхода', () => {
  it('ведёт по одному вопросу на экран и объясняет каждый', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:n:e'));
    // У бухгалтера две компании, поэтому первый вопрос о ней.
    expect(tg.plain()).toMatch(/Шаг 1 из 7 · Компания/);
    expect(tg.plain(), 'не сказано, зачем выбирать компанию').toMatch(/книгу этой компании/);

    await pressByText(TG_DIR, 'ООО');
    expect(tg.plain()).toMatch(/Шаг 2 из 7 · Сумма/);
    expect(tg.plain(), 'нет примера, как писать сумму').toMatch(/1500000/);
    // Номер шага говорит, сколько осталось, но не говорит чего. Человек,
    // который не знает, что дальше три коротких ответа, бросает на середине.
    expect(tg.plain(), 'не сказано, что спрошу дальше').toMatch(
      /Дальше: Статья → Счёт → Контрагент → Дата → Примечание → Проверка/,
    );
  });

  it('сумму словами не угадывает и показывает пример снова', async () => {
    tg.clear();
    await bot.handleUpdate(message(TG_DIR, TG_DIR, 'пятьсот тысяч'));
    expect(tg.plain()).toMatch(/не похоже на сумму/);
    expect(tg.plain(), 'после ошибки вопрос не повторён').toMatch(/Шаг 2 из 7 · Сумма/);
  });

  it('принимает сумму с пробелами и доводит до проверки', async () => {
    tg.clear();
    await bot.handleUpdate(message(TG_DIR, TG_DIR, '1 500 000'));
    expect(tg.plain()).toMatch(/Шаг 3 из 7 · Статья/);

    await pressByText(TG_DIR, 'Заработная плата');
    expect(tg.plain()).toMatch(/Шаг 4 из 7 · Счёт/);
    expect(tg.plain(), 'не объяснено, что такое касса').toMatch(/наличные/);

    await pressByText(TG_DIR, 'Касса');
    expect(tg.plain()).toMatch(/Шаг 5 из 7 · Контрагент/);

    await pressByText(TG_DIR, '➡️ Пропустить');
    expect(tg.plain()).toMatch(/Шаг 6 из 7 · Дата/);

    // Два ответа в одном ряду на телефоне стоят в полпальца друг от друга, и
    // «вчера» ставят вместо «сегодня».
    expect(tg.last().rows.slice(0, 2), 'кнопки даты снова в один ряд').toEqual([
      ['Сегодня'],
      ['Вчера'],
    ]);

    await pressByText(TG_DIR, 'Сегодня');
    expect(tg.plain()).toMatch(/Шаг 7 из 7 · Примечание/);

    await bot.handleUpdate(message(TG_DIR, TG_DIR, 'аванс за октябрь'));
    expect(tg.plain(), 'нет экрана проверки перед записью').toMatch(/Проверьте/);
    expect(tg.plain()).toContain('1 500 000 сум');
    expect(tg.plain()).toContain('Заработная плата');
    expect(tg.plain()).toContain('аванс за октябрь');
    // Главное, что человек должен понять до нажатия: деньги ещё не уходят.
    expect(tg.plain()).toMatch(/Деньги сейчас никуда не уходят/);
  });

  it('записывает черновик и сразу говорит, что дальше', async () => {
    // Экран проверки не стираем: нажимаем ту самую кнопку, которую человек
    // видит после прошлого шага.
    await pressByText(TG_DIR, '✅ Записать');
    created = numberOnScreen();
    expect(tg.plain()).toMatch(/черновик/);
    expect(tg.plain(), 'не сказано, какой шаг следующий').toMatch(/отправить на согласование/i);

    const op = await row(created);
    expect(op.status).toBe('draft');
    expect(Number(op.amount)).toBe(1500000);
    expect(op.comment).toBe('аванс за октябрь');
    // Черновик — это заявка, а не платёж: проводок у него быть не должно.
    expect(op.entries, 'у черновика появились проводки').toBe(0);
  });

  it('в журнале видно, что заявку завели из Telegram', async () => {
    const audit = await db.query(
      `SELECT action, source::text FROM audit_log
        WHERE entity_type = 'finance_operation' AND entity_id = $1 AND action = 'create'`,
      [(await row(created)).uid],
    );
    expect(audit.rows.length, 'создание заявки не попало в журнал').toBe(1);
    expect(audit.rows[0].source, 'источник записи не «bot»').toBe('bot');
  });

  it('нажатие «Записать» после записи ничего не повторяет', async () => {
    // У бота это обычное дело: человек не уверен, что нажатие прошло.
    const before = await operationCount();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:go'));
    expect(await operationCount(), 'появилась вторая такая же заявка').toBe(before);
  });

  it('повторная доставка того же нажатия не заводит вторую заявку', async () => {
    tg.clear();
    await wizardToConfirm(TG_DIR, '33000', 'повтор нажатия');
    const before = await operationCount();
    // Telegram при обрыве связи повторяет доставку, и два обработчика успевают
    // прочитать разговор до того, как первый его закроет. От этого спасает
    // только ключ повторной отправки, а не очистка разговора.
    await Promise.all([
      bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:go')),
      bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:go')),
    ]);
    expect(await operationCount(), 'одно нажатие завело две заявки').toBe(before + 1);
  });

  it('кнопка с прошлого шага разговор не ломает', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:n:e'));
    await pressByText(TG_DIR, 'ООО');
    // Шаг «Сумма» ждёт текста, а приехала кнопка выбора статьи.
    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:k:00000000-0000-0000-0000-000000000000'));
    expect(tg.plain()).toMatch(/с прошлого шага/);
    expect(tg.plain(), 'текущий вопрос не показан').toMatch(/Шаг 2 из 7 · Сумма/);
  });

  it('«Назад» возвращает к прошлому вопросу, а «Отменить» ничего не пишет', async () => {
    tg.clear();
    await bot.handleUpdate(message(TG_DIR, TG_DIR, '70000'));
    expect(tg.plain()).toMatch(/Шаг 3 из 7 · Статья/);
    await pressByText(TG_DIR, '⬅️ Назад');
    expect(tg.plain()).toMatch(/Шаг 2 из 7 · Сумма/);
    await pressByText(TG_DIR, '❌ Отменить');
    expect(tg.plain(), 'после отмены не вернулись в раздел').toMatch(/Здесь деньги/);
    const session = await db.query('SELECT flow FROM telegram_session WHERE chat_id = $1', [
      String(TG_DIR),
    ]);
    expect(session.rows[0].flow, 'незаконченный разговор остался в базе').toBeNull();
  });
});

describe('финансы в боте: путь заявки', () => {
  it('черновик объясняет статус и отправляется на согласование', async () => {
    tg.clear();
    const op = await row(created);
    await bot.handleUpdate(press(TG_DIR, TG_DIR, `f:o:${op.uid}`));
    expect(tg.plain(), 'карточка не объясняет статус').toMatch(/Это черновик/);
    // Согласовать черновик нельзя никому: сначала его отправляют.
    expect(
      tg.last().buttons.some((b) => b.includes('Согласовать')),
      'черновик предложили согласовать',
    ).toBe(false);

    await pressByText(TG_DIR, '📤 Отправить');
    expect(tg.plain(), 'перед отправкой не спросили подтверждения').toMatch(/Отправить заявку/);
    await pressByText(TG_DIR, 'Да —');
    expect(tg.plain()).toMatch(/Отправлено/);
    expect((await row(created)).status).toBe('pending_approval');
  });

  it('кому согласование не выдано — тому ни кнопки, ни прямого нажатия', async () => {
    const op = await row(created);
    expect(op.status, 'заявка не отправлена, проверять нечего').toBe('pending_approval');

    // Человек с правом заводить и проводить, но без права согласовывать — это
    // финансист. Собираем набор прав руками, а не заводим второго сотрудника с
    // привязкой Telegram: привязка общая, и соседние проверки её отбирают.
    const poster = {
      ...director,
      permissions: new Set(['finance.view', 'finance.post']),
    };
    const card = await finance.card(poster, op.uid, false);
    expect(
      card.keyboard.flat().some((b) => b.text.includes('Согласовать')),
      'согласование предложили тому, кому его не выдано',
    ).toBe(false);

    // Кнопки на экране нет, но её данные известны: право обязано проверяться
    // на нажатии, иначе запрет держится только на том, что кнопку не нарисовали.
    const pressed = await finance.route(poster, null, `f:y:a:${op.uid}:${op.version}`, false);
    expect(pressed.toast, 'отказа не было').toMatch(/прав/i);
    expect((await row(created)).status, 'заявку согласовал тот, кому это не выдано').toBe(
      'pending_approval',
    );
  });

  it('директор видит заявку в «ждут решения» и согласовывает', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:w'));
    expect(tg.plain(), 'заявки нет в списке ожидающих').toContain(created);

    await pressByText(TG_DIR, '⏳');
    await pressByText(TG_DIR, '✅ Согласовать');
    expect(tg.plain(), 'не сказано, что деньги спишутся позже').toMatch(/спишутся не сейчас/);
    await pressByText(TG_DIR, 'Да —');
    expect((await row(created)).status).toBe('approved');
    // Проводок всё ещё нет: обещание заплатить — не платёж.
    expect((await row(created)).entries, 'согласование создало проводки').toBe(0);
  });

  it('перед проведением говорит словами, что сейчас случится', async () => {
    tg.clear();
    const op = await row(created);
    await bot.handleUpdate(press(TG_DIR, TG_DIR, `f:o:${op.uid}`));
    await pressByText(TG_DIR, '💸 Провести');
    expect(tg.plain(), 'проведение подано как обычная кнопка').toMatch(/само движение денег/);
    expect(tg.plain()).toMatch(/только сторно/);
  });

  it('проведение создаёт ровно две проводки, и они сходятся', async () => {
    await pressByText(TG_DIR, 'Да —');
    expect(tg.plain()).toMatch(/Проведено/);
    const op = await row(created);
    expect(op.status).toBe('posted');
    expect(op.entries, 'проводок не две').toBe(2);
    const balance = await db.query(
      `SELECT sum(debit)::text AS debit, sum(credit)::text AS credit
         FROM finance_entry WHERE operation_id = (SELECT id FROM finance_operation WHERE uid = $1)`,
      [op.uid],
    );
    expect(balance.rows[0].debit).toBe(balance.rows[0].credit);
  });

  it('второе нажатие той же кнопки второй раз не проводит', async () => {
    tg.clear();
    const op = await db.query(`SELECT uid, version FROM finance_operation WHERE number = $1`, [
      created,
    ]);
    // Версия та, что была до проведения: именно её человек видел на экране.
    const stale = Number(op.rows[0].version) - 1;
    await bot.handleUpdate(press(TG_DIR, TG_DIR, `f:y:p:${op.rows[0].uid}:${stale}`));
    expect(tg.plain(), 'повтор прошёл как новое проведение').toMatch(/Не получилось/);
    expect((await row(created)).entries, 'появились лишние проводки').toBe(2);
  });

  it('сторно возвращает деньги и обе операции остаются в истории', async () => {
    tg.clear();
    const op = await row(created);
    await bot.handleUpdate(press(TG_DIR, TG_DIR, `f:o:${op.uid}`));
    await pressByText(TG_DIR, '↩️ Сторно');
    expect(tg.plain(), 'не объяснено, что останутся обе записи').toMatch(/тарихда|истории/i);
    await pressByText(TG_DIR, 'Да —');
    expect(tg.plain()).toMatch(/Сторно сделано/);

    const original = await row(created);
    expect(original.status, 'исходная операция не помечена сторнированной').toBe('reversed');
    const mirror = await db.query(
      `SELECT o.status::text, o.number,
              (SELECT count(*)::int FROM finance_entry e WHERE e.operation_id = o.id) AS entries
         FROM finance_operation o
        WHERE o.reversal_of_id = (SELECT id FROM finance_operation WHERE uid = $1)`,
      [original.uid],
    );
    expect(mirror.rows.length, 'обратной операции нет').toBe(1);
    expect(mirror.rows[0].status).toBe('posted');
    expect(mirror.rows[0].entries).toBe(2);

    // Сумма по счёту кассы вернулась к нулю: именно это значит «деньги вернулись».
    const net = await db.query(
      `SELECT coalesce(sum(e.debit - e.credit), 0)::text AS net
         FROM finance_entry e
         JOIN finance_operation o ON o.id = e.operation_id
        WHERE o.id IN (SELECT id FROM finance_operation WHERE uid = $1
                       UNION ALL
                       SELECT id FROM finance_operation
                        WHERE reversal_of_id = (SELECT id FROM finance_operation WHERE uid = $1))`,
      [original.uid],
    );
    expect(Number(net.rows[0].net), 'после сторно сальдо не вернулось к исходному').toBe(0);
  });

  it('и сторно в журнале отдельной записью с источником bot', async () => {
    const audit = await db.query(
      `SELECT source::text, changes FROM audit_log
        WHERE entity_type = 'finance_operation' AND action = 'reverse'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0].source).toBe('bot');
    expect(audit.rows[0].changes.reversalOf.to, 'в журнале не видно, что именно отменили').toBe(
      created,
    );
  });
});

describe('финансы в боте: отчёты', () => {
  it('долги отвечают числами и умеют показать только просроченные', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:d'));
    expect(tg.plain()).toMatch(/Долги клиентов/);
    await pressByText(TG_DIR, 'Только просроченные');
    expect(tg.plain()).toMatch(/Просроченные долги/);
  });

  it('план и факт показывают, сколько заложено и сколько ушло', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:pf'));
    expect(tg.plain()).toMatch(/План и факт/);
    expect(tg.plain(), 'не сказано, что это за числа').toMatch(/заложено на период/);
  });
});

/**
 * Повтор прошлой записи (решение заказчика 02.10: в боте должно быть всё, что
 * нужно сотруднику). Зарплата, аренда и связь приходят каждый месяц одними и
 * теми же: восемь экранов ради той же записи — работа, от которой бот должен
 * избавлять, а не добавлять.
 */
describe('финансы в боте: повтор прошлой записи', () => {
  it('предлагает повторить последнюю свою запись и спрашивает только сумму', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'f'));
    expect(tg.last().data, 'кнопки повтора на экране финансов нет').toContain('f:rp');

    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:rp'));
    const text = tg.plain();
    expect(text, 'не сказано, что именно повторяем').toMatch(/Повторяем запись/);
    expect(text, 'в повторе не видно статьи прошлой записи').toContain('Заработная плата');
    expect(text, 'в повторе не видно счёта прошлой записи').toContain('Касса');
    // Шагов три: сумма, дата и проверка. Остальное взято из прошлой записи.
    expect(text).toMatch(/Шаг 1 из 2/);
    expect(text, 'снова спрашивает про компанию').not.toMatch(/По какой компании/);
  });

  it('кнопка «та же сумма» подставляет сумму прошлой записи', async () => {
    const same = tg.last().buttons.find((b) => b.startsWith('🔁 Та же сумма'));
    expect(same, `кнопки «та же сумма» нет: ${tg.last().buttons.join(' | ')}`).toBeTruthy();

    await pressByText(TG_DIR, '🔁 Та же сумма');
    expect(tg.plain(), 'после суммы спросили не про дату').toMatch(/Когда это было/);
    await pressByText(TG_DIR, 'Сегодня');

    const text = tg.plain();
    expect(text, 'нет экрана проверки перед записью').toMatch(/Проверьте/);
    // Сумма, статья и счёт — те же, что в прошлой записи.
    expect(text).toContain('33 000 сум');
    expect(text).toContain('Заработная плата');
    expect(text).toContain('Касса');
  });

  it('повторённая запись ложится отдельным черновиком, а не правит прошлую', async () => {
    const before = await operationCount();
    await pressByText(TG_DIR, '✅ Записать');
    const number = numberOnScreen();

    expect(await operationCount(), 'повтор не завёл новую запись').toBe(before + 1);
    const op = await row(number);
    expect(op.status).toBe('draft');
    expect(Number(op.amount)).toBe(33000);
  });

  /**
   * Повтор берёт запись самого человека, а не последнюю в системе. Иначе
   * бухгалтер предложил бы директору повторить чужую заявку, а в журнале
   * автором стал бы директор — и «кто это завёл» перестало бы иметь ответ.
   */
  it('повторяет свою запись, а не последнюю в системе', async () => {
    const other = await db.query(
      `SELECT u.id, c.id AS company_id, c.uid, c.name_ru, c.name_uz
         FROM user_account u
         JOIN user_role_assignment ura ON ura.user_id = u.id
         JOIN company c ON c.id = ura.company_id
        WHERE u.login = 'm.rahimova'
        ORDER BY c.code`,
    );
    expect(other.rows[0], 'в базе нужен бухгалтер с компаниями').toBeTruthy();
    const accountant = {
      userId: BigInt(other.rows[0].id),
      permissions: new Set(['finance.view', 'finance.post']),
      companyIds: other.rows.map((r: { company_id: string }) => BigInt(r.company_id)),
      companies: other.rows.map(
        (r: { company_id: string; uid: string; name_ru: string; name_uz: string }) => ({
          id: BigInt(r.company_id),
          uid: r.uid,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
        }),
      ),
    };

    const screen = await finance.route(accountant, null, 'f:rp', false);
    // Префикс не только РП и ПП: в базе есть и прежние номера заявок.
    const number = (screen.text.match(/[А-Я]{2,4}-\d{6}/) ?? [])[0];
    expect(number, `бухгалтеру не предложили ничего: ${screen.text}`).toBeTruthy();

    const owner = await db.query(
      `SELECT created_by::text AS created_by FROM finance_operation WHERE number = $1`,
      [number],
    );
    expect(owner.rows[0].created_by, 'повтор предложил чужую запись').toBe(
      String(accountant.userId),
    );
  });

  it('платёж по заказу в повтор не попадает: у него свой остаток', async () => {
    // Заводим черновик платежа по живому заказу — он становится последней
    // записью человека. Повтор обязан предложить не его: «повторить» для
    // такого платежа означало бы заплатить по заказу второй раз.
    const order = await db.query(
      `SELECT o.uid FROM sales_order o JOIN currency cur ON cur.id = o.currency_id
        WHERE o.status <> 'cancelled' AND cur.code = 'UZS'
          AND o.paid_amount < o.amount_total
        ORDER BY o.amount_total DESC LIMIT 1`,
    );
    expect(order.rows[0], 'в базе нужен неоплаченный заказ').toBeTruthy();

    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, `f:pay:${order.rows[0].uid}`));
    await bot.handleUpdate(message(TG_DIR, TG_DIR, '1000'));
    await pressByText(TG_DIR, 'Касса');
    await pressByText(TG_DIR, 'Сегодня');
    await pressByText(TG_DIR, '➡️ Пропустить');
    await pressByText(TG_DIR, '✅ Записать');
    const payment = numberOnScreen();

    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:rp'));
    expect(tg.plain(), 'повтор предложил платёж по заказу').not.toContain(payment);
    expect(tg.plain()).toMatch(/Повторяем запись/);
  });
});

describe('финансы в боте: как выглядит экран', () => {
  /**
   * Экран проверки и карточка — то, что человек читает перед деньгами. Поля
   * идут пунктами, заголовок стоит отдельной строкой, а пояснение отделено от
   * полей пустой строкой: слитый текст он пролистывает, не читая.
   */
  it('экран проверки: поля пунктами, пояснение отдельным абзацем', async () => {
    tg.clear();
    await wizardToConfirm(TG_DIR, '90 000', 'проверка вида');
    const text = tg.last().text ?? '';
    expect(text, 'поля проверки снова слитым списком').toMatch(/<blockquote>• /);
    expect(text, 'заголовок слипся с полями').toMatch(/<\/b>\n\n<blockquote>/);
    expect(text, 'пояснение слиплось с полями').toMatch(/<\/blockquote>\n\n/);
    expect(text.split('\n').filter((l) => l.startsWith('• ')).length).toBeGreaterThanOrEqual(5);
    await pressByText(TG_DIR, '❌ Отменить');
  });

  it('карточка операции: заголовок строкой, поля пунктами', async () => {
    tg.clear();
    await bot.handleUpdate(press(TG_DIR, TG_DIR, 'f:l'));
    await pressByText(TG_DIR, '✅');
    const text = tg.last().text ?? '';
    const first = text.split('\n')[0] ?? '';
    expect(first, 'заголовок карточки оказался пунктом списка').not.toMatch(/^•/);
    expect(first, 'в заголовке нет номера операции').toMatch(/[А-Я]{2,4}-\d{6}/);
    expect(text, 'поля карточки снова слитым списком').toMatch(/<blockquote>• /);
    expect(text, 'объяснение статуса слиплось с полями').toMatch(/<\/blockquote>\n\n/);
  });
});

describe('финансы в боте: «я не понял»', () => {
  /**
   * Перечень полей и объяснение — разные вещи. Человек, которому бот заменил
   * систему, из строки «Статья: Заработная плата» не узнаёт, уйдут ли деньги
   * сейчас. Кнопка отвечает именно на это и ничего не записывает.
   */
  it('объясняет проверку словами, ничего не пишет и возвращает назад', async () => {
    const before = await db.query('SELECT count(*)::int AS n FROM finance_operation');
    tg.clear();
    await wizardToConfirm(TG_DIR, '70 000', 'проверка объяснения');
    expect(tg.plain(), 'нет экрана проверки').toMatch(/Проверьте/);
    expect(tg.last().buttons, 'на проверке нет кнопки «я не понял»').toContain('🤔 Я не понял');

    await pressByText(TG_DIR, '🤔 Я не понял');
    const said = tg.plain();
    expect(said, 'объяснение не названо простыми словами').toMatch(/Простыми словами/);
    expect(said, 'не сказано, что это заявка, а не платёж').toMatch(/со счёта не уйдут/);
    expect(said, 'не сказано, как поправить').toMatch(/Назад/);
    expect(said, 'объяснение повторяет перечень полей').not.toMatch(/Проверьте/);

    const after = await db.query('SELECT count(*)::int AS n FROM finance_operation');
    expect(after.rows[0].n, 'объяснение записало операцию').toBe(before.rows[0].n);

    await pressByText(TG_DIR, '⬅️ Вернуться к проверке');
    expect(tg.plain(), 'с объяснения не вернулись на проверку').toMatch(/Проверьте/);
    expect(tg.last().buttons).toContain('✅ Записать');

    // Разговор обрываем: эта проверка не должна оставлять записей.
    await pressByText(TG_DIR, '❌ Отменить');
    const end = await db.query('SELECT count(*)::int AS n FROM finance_operation');
    expect(end.rows[0].n).toBe(before.rows[0].n);
  });
});
