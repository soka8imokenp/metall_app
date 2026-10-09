/**
 * Каркас Telegram-бота (ТЗ 11): язык → вход → кнопки по правам.
 *
 * Проверяется то, ради чего каркас делался, а не то, что бот «отвечает»:
 * логин и пароль не остаются в переписке, вход — тот же самый, что в вебе
 * (журнал входов, блокировка), меню собирается из прав, право проверяется на
 * нажатии, а не только при отрисовке, и администратор видит чужую роль, но не
 * работает за человека.
 *
 * Telegram здесь подменён: настоящий разговор с ним в тесте означал бы, что
 * проверка зависит от чужого сервера и чьего-то телефона.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AdminModule } from '../src/admin/admin.module.js';
// Раздел финансов боту нужен целиком: каркас открывает его кнопкой «Финансы».
import { FinanceModule } from '../src/finance/finance.module.js';
import { WarehouseModule } from '../src/warehouse/warehouse.module.js';
import { AttachmentsModule } from '../src/attachments/attachments.module.js';
import { SalesModule } from '../src/sales/sales.module.js';
import { DocumentsModule } from '../src/documents/documents.module.js';
import { DashboardModule } from '../src/dashboard/dashboard.module.js';
import { ProductionModule } from '../src/production/production.module.js';
import { RefsModule } from '../src/refs/refs.module.js';
import { SECTIONS, mainMenu } from '../src/bot/menu.js';
import { HOWTO } from '../src/bot/howto.js';
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
import { KINDS } from '../src/notifications/kinds.js';
import { TelegramError } from '../src/bot/telegram.api.js';
import { TelegramApi, type TelegramUpdate } from '../src/bot/telegram.api.js';

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';
const KEEPER = 'a.saidov';
const ADMIN = 'admin';
const ACCOUNTANT = 'm.rahimova';
/** Начальник производства: роль есть в системе, в боте её быть не должно. */
const MASTER = 'j.tashpulatov';
/** Номера, которых нет ни у кого: проверка не должна задеть живую привязку. */
const TG_KEEPER = 980000101n;
const TG_ADMIN = 980000102n;
const CHAT_KEEPER = 980000101n;
const CHAT_ADMIN = 980000102n;

interface Sent {
  method: string;
  chatId: string;
  text?: string;
  buttons: string[];
  data: string[];
}

/** Подставной Telegram: ничего не шлёт, всё записывает. */
class FakeTelegram {
  sent: Sent[] = [];
  deleted: { chatId: string; messageId: number }[] = [];
  answers: { id: string; text?: string }[] = [];
  private nextId = 1000;

  private record(method: string, chatId: unknown, text: string | undefined, keyboard: unknown) {
    const rows = (keyboard as { text: string; data: string }[][] | undefined) ?? [];
    this.sent.push({
      method,
      chatId: String(chatId),
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
  deleteMessage(chatId: unknown, messageId: number) {
    this.deleted.push({ chatId: String(chatId), messageId });
    return Promise.resolve(true);
  }
  answerCallback(id: string, text?: string) {
    this.answers.push({ id, text });
    return Promise.resolve(true);
  }

  last(): Sent {
    return this.sent[this.sent.length - 1]!;
  }
  clear() {
    this.sent = [];
    this.deleted = [];
    this.answers = [];
  }
}

let bot: BotService;
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
      message_id: 500,
      date: 0,
      chat: { id: Number(chatId), type: 'private' },
      // Панель — сообщение с фотографией: Telegram отдаёт её в нажатии.
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
  await clean();
});

afterAll(async () => {
  await clean();
  await db.end();
});

/** За собой убираем: привязка и разговор — следы проверки, а не данные. */
async function clean() {
  await db.query('DELETE FROM telegram_session WHERE chat_id = ANY($1)', [
    [String(CHAT_KEEPER), String(CHAT_ADMIN)],
  ]);
  await db.query(
    `UPDATE user_account SET telegram_user_id = NULL, telegram_linked_at = NULL
      WHERE telegram_user_id = ANY($1)`,
    [[String(TG_KEEPER), String(TG_ADMIN)]],
  );
  await db.query(
    `UPDATE user_account SET locale = 'ru', failed_login_count = 0, locked_until = NULL
      WHERE login = ANY($1)`,
    [[KEEPER, ADMIN]],
  );
}

async function signIn(chat: bigint, tgId: bigint, login: string, password: string) {
  await bot.handleUpdate(message(chat, tgId, '/start'));
  await bot.handleUpdate(press(chat, tgId, 'l:ru'));
  await bot.handleUpdate(message(chat, tgId, login));
  await bot.handleUpdate(message(chat, tgId, password));
}

describe('каркас бота: вход', () => {
  it('встречает языком, спрашивает логин и пароль и не оставляет их в переписке', async () => {
    tg.clear();
    await bot.handleUpdate(message(CHAT_KEEPER, TG_KEEPER, '/start'));
    expect(tg.last().method, 'шапка не отправлена').toBe('sendPhoto');
    expect(tg.last().data).toEqual(['l:ru', 'l:uz']);

    await bot.handleUpdate(press(CHAT_KEEPER, TG_KEEPER, 'l:ru'));
    expect(tg.last().text).toMatch(/логин/i);

    const loginMessage = message(CHAT_KEEPER, TG_KEEPER, KEEPER);
    await bot.handleUpdate(loginMessage);
    expect(
      tg.deleted.map((d) => d.messageId),
      'сообщение с логином осталось в чате',
    ).toContain(loginMessage.message!.message_id);
    expect(tg.last().text).toMatch(/пароль/i);

    const passwordMessage = message(CHAT_KEEPER, TG_KEEPER, PASSWORD);
    await bot.handleUpdate(passwordMessage);
    expect(
      tg.deleted.map((d) => d.messageId),
      'сообщение с паролем осталось в чате',
    ).toContain(passwordMessage.message!.message_id);

    const session = await db.query(
      'SELECT user_id, step, pending_login FROM telegram_session WHERE chat_id = $1',
      [String(CHAT_KEEPER)],
    );
    expect(session.rows[0].step).toBe('ready');
    expect(session.rows[0].pending_login, 'логин остался лежать в сессии').toBeNull();
  });

  it('пароль нигде не сохраняется: ни в сессии, ни в журнале входов', async () => {
    const session = await db.query('SELECT * FROM telegram_session WHERE chat_id = $1', [
      String(CHAT_KEEPER),
    ]);
    expect(JSON.stringify(session.rows[0])).not.toContain(PASSWORD);

    const log = await db.query(
      `SELECT ip, success FROM login_log
        WHERE user_id = (SELECT id FROM user_account WHERE login = $1)
        ORDER BY id DESC LIMIT 1`,
      [KEEPER],
    );
    expect(log.rows[0].success, 'вход через бота не попал в журнал входов').toBe(true);
    expect(log.rows[0].ip, 'вместо IP ожидали номер аккаунта Telegram').toBe(
      `telegram:${TG_KEEPER}`,
    );
  });

  it('привязка записана и видна в журнале действий', async () => {
    const user = await db.query('SELECT telegram_user_id FROM user_account WHERE login = $1', [
      KEEPER,
    ]);
    expect(String(user.rows[0].telegram_user_id)).toBe(String(TG_KEEPER));

    const audit = await db.query(
      `SELECT action, source::text, changes FROM audit_log
        WHERE entity_type = 'user_telegram' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0].action).toBe('link');
    expect(audit.rows[0].source, 'источник записи не «bot»').toBe('bot');
  });

  it('неверный пароль не пускает и возвращает к вводу логина', async () => {
    tg.clear();
    const chat = 980000103n;
    const tgId = 980000103n;
    await bot.handleUpdate(message(chat, tgId, '/start'));
    await bot.handleUpdate(press(chat, tgId, 'l:ru'));
    await bot.handleUpdate(message(chat, tgId, KEEPER));
    await bot.handleUpdate(message(chat, tgId, 'не тот пароль'));
    expect(tg.last().text).toMatch(/неверный логин или пароль/i);

    const session = await db.query('SELECT step FROM telegram_session WHERE chat_id = $1', [
      String(chat),
    ]);
    expect(session.rows[0].step).toBe('login');
    await db.query('DELETE FROM telegram_session WHERE chat_id = $1', [String(chat)]);
    await db.query(
      `UPDATE user_account SET failed_login_count = 0, locked_until = NULL WHERE login = $1`,
      [KEEPER],
    );
  });
});

describe('каркас бота: первый экран', () => {
  it('без картинки шапки вход всё равно открывается', async () => {
    const chat = 980000104n;
    const broken = new Error('нет файла шапки');
    const original = tg.sendPhoto.bind(tg);
    tg.sendPhoto = () => Promise.reject(broken);
    tg.clear();
    try {
      await bot.handleUpdate(message(chat, chat, '/start'));
    } finally {
      tg.sendPhoto = original;
    }
    expect(tg.last().method, 'без картинки человек не увидел выбор языка').toBe('sendMessage');
    expect(tg.last().data).toEqual(['l:ru', 'l:uz']);
    await db.query('DELETE FROM telegram_session WHERE chat_id = $1', [String(chat)]);
  });
});

describe('каркас бота: меню по правам', () => {
  it('кладовщику показаны его разделы и нет кнопки админа', async () => {
    tg.clear();
    await bot.handleUpdate(message(CHAT_KEEPER, TG_KEEPER, '/start'));
    const menu = tg.last();
    expect(menu.buttons.join(' ')).toMatch(/Склад/);
    expect(menu.buttons.join(' '), 'кладовщику показали кнопку админа').not.toMatch(/Админ/);
    expect(menu.data, 'кладовщику показали финансы').not.toContain('m:finance');
  });

  it('раздел без права не открывается, даже если нажать кнопку из старого сообщения', async () => {
    tg.clear();
    await bot.handleUpdate(press(CHAT_KEEPER, TG_KEEPER, 'm:finance'));
    expect(tg.answers.map((a) => a.text).join(' ')).toMatch(/права/i);
  });

  it('свой раздел открывается настоящими экранами, а не рассказом о планах', async () => {
    tg.clear();
    await bot.handleUpdate(press(CHAT_KEEPER, TG_KEEPER, 'm:warehouse'));
    expect(tg.last().text, 'раздел всё ещё «готовится»').not.toMatch(/Раздел готовится/);
    expect(tg.last().text).toMatch(/Здесь товар/);
    // Кнопки раздела, а не одно «назад»: нажатие дошло до самого склада.
    expect(tg.last().data).toContain('w:s');
    expect(tg.last().data).toContain('w:m');
  });

  /**
   * Список незаконченного — то, по чему сверяют приёмку, и единственное место,
   * где бот сам рассказывает о планах. Если у готового раздела в нём осталась
   * строка, бот обещает человеку то, что уже сделано, а приёмка считает это
   * недоделкой. Проверяется свойство, а не перечень: новый раздел попадёт под
   * ту же проверку.
   */
  it('список незаконченного не врёт: у готового раздела он пуст, у неготового — нет', () => {
    for (const s of SECTIONS) {
      if (s.live) {
        expect(s.soonRu, `раздел «${s.ru}» готов, а обещает ещё`).toEqual([]);
        expect(s.soonUz, `раздел «${s.ru}» готов, а обещает ещё по-узбекски`).toEqual([]);
      } else {
        expect(s.soonRu.length, `раздел «${s.ru}» не готов и молчит о планах`).toBeGreaterThan(0);
        expect(s.soonUz.length, `раздел «${s.ru}» не говорит о планах по-узбекски`).toBe(
          s.soonRu.length,
        );
      }
    }
  });

  it('язык переключается в настройках и запоминается у человека', async () => {
    tg.clear();
    await bot.handleUpdate(press(CHAT_KEEPER, TG_KEEPER, 's:l'));
    const locale = await db.query('SELECT locale FROM user_account WHERE login = $1', [KEEPER]);
    expect(locale.rows[0].locale).toBe('uz');
    expect(tg.last().buttons.join(' ')).toMatch(/Sozlamalar|Til/);

    await bot.handleUpdate(press(CHAT_KEEPER, TG_KEEPER, 's:l'));
    const back = await db.query('SELECT locale FROM user_account WHERE login = $1', [KEEPER]);
    expect(back.rows[0].locale).toBe('ru');
  });
});

describe('каркас бота: «как пользоваться»', () => {
  /**
   * Подсказка — не описание бота, а пути нажатий к делам этого человека: он
   * пришёл с вопросом «как записать приход», а не «какие есть команды».
   */
  it('в настройках есть подсказка, и в ней только свои дела', async () => {
    tg.clear();
    await bot.handleUpdate(press(CHAT_KEEPER, TG_KEEPER, 's'));
    expect(tg.last().buttons.join(' '), 'в настройках нет подсказки').toMatch(/Как пользоваться/);

    await bot.handleUpdate(press(CHAT_KEEPER, TG_KEEPER, 's:how'));
    const shown = tg.last().buttons.join(' | ');
    expect(tg.last().text).toMatch(/Как пользоваться/);
    expect(shown, 'кладовщику не предложили принять товар').toMatch(/Принять товар на склад/);
    expect(shown, 'кладовщику показали чужое дело про деньги').not.toMatch(/расход денег/);
    // Общие правила разговора: без них человек не знает, что «Отменить»
    // ничего не записывает.
    expect(tg.last().text, 'в подсказке нет общих правил').toMatch(/Отменить/);
  });

  it('путь говорит, что нажимать и что получится', async () => {
    tg.clear();
    await bot.handleUpdate(press(CHAT_KEEPER, TG_KEEPER, 's:howto:wh-in'));
    const text = tg.last().text ?? '';
    expect(text, 'не сказано, какие кнопки нажимать').toMatch(/Склад.+Приход.+Записать/s);
    expect(text, 'не сказано, что получится в конце').toMatch(/Что получится/);
    expect(tg.last().buttons.join(' '), 'с пути некуда вернуться').toMatch(/К подсказке/);
  });

  it('чужой путь не открывается, даже если нажать кнопку из старого сообщения', async () => {
    tg.clear();
    await bot.handleUpdate(press(CHAT_KEEPER, TG_KEEPER, 's:howto:fin-out'));
    // Не отказ и не пустой экран: человека возвращает в его же подсказку.
    expect(tg.last().text, 'кладовщику открыли денежный путь').not.toMatch(/Что получится/);
    expect(tg.last().text).toMatch(/Как пользоваться/);
  });

  /**
   * Подпись панели в Telegram — 1024 знака, и лишнее она обрезает молча. У
   * администратора дел больше всех: если подсказку однажды снова сделают одной
   * простынёй, хвост у него пропадёт без всякой ошибки.
   */
  it('подсказка влезает в подпись панели', async () => {
    // Вход обязателен: без него бот показывает экран языка, он короткий, и
    // проверка зеленела бы, не открыв подсказку вовсе. Так и было.
    await signIn(CHAT_ADMIN, TG_ADMIN, ADMIN, PASSWORD);
    tg.clear();
    await bot.handleUpdate(press(CHAT_ADMIN, TG_ADMIN, 's:how'));
    const shown = tg.last().text ?? '';
    expect(shown, 'открылась не подсказка').toMatch(/Как пользоваться/);
    expect(shown.length, 'подсказка не влезает в подпись').toBeLessThanOrEqual(1024);
    expect(shown, 'хвост подсказки обрезан').not.toMatch(/…$/);
  });

  /**
   * У администратора видов уведомлений больше всех — все пятнадцать. Экран их
   * перечисляет с объяснением, и предел подписи тот же: добавят шестнадцатый
   * повод, и хвост списка пропадёт у него молча.
   */
  it('экран уведомлений влезает в подпись панели и ничего не теряет', async () => {
    await signIn(CHAT_ADMIN, TG_ADMIN, ADMIN, PASSWORD);
    tg.clear();
    await bot.handleUpdate(press(CHAT_ADMIN, TG_ADMIN, 'n'));
    const index = tg.last();
    expect(index.text, 'открылся не указатель уведомлений').toMatch(/Бот сам пишет/);
    expect((index.text ?? '').length, 'указатель не влезает в подпись').toBeLessThanOrEqual(1024);

    // У администратора все поводы, и каждый обязан найтись в своей группе:
    // лишь бы влезло — не цель, цель — чтобы ничего не пропало. Группы
    // перечислены руками: новая группа без строки здесь не проверялась бы, а
    // её виды выглядели бы потерянными — так и случилось с «Системой».
    const seen = new Set<string>();
    for (const group of ['money', 'work', 'system']) {
      tg.clear();
      await bot.handleUpdate(press(CHAT_ADMIN, TG_ADMIN, `n:g:${group}`));
      const screen = tg.last();
      expect(
        (screen.text ?? '').length,
        `группа ${group} не влезает в подпись`,
      ).toBeLessThanOrEqual(1024);
      expect(screen.text, `список группы ${group} обрезан`).not.toMatch(/…$/);
      for (const d of screen.data) if (d.startsWith('n:') && !d.startsWith('n:g:')) seen.add(d);
    }
    for (const k of KINDS) {
      expect([...seen], `вида ${k.kind} нет ни в одной группе`).toContain(`n:${k.kind}`);
    }
  });

  /**
   * Путь начинается с кнопки главного меню. Если раздел переименуют, а здесь
   * забудут, человек будет искать на экране слово, которого там нет.
   */
  it('пути ведут по настоящим кнопкам меню', () => {
    const all = new Set<string>([
      ...SECTIONS.map((x) => x.permission),
      ...HOWTO.map((x) => x.permission),
    ]);
    const labels = mainMenu(all, false)
      .flat()
      .map((b) => b.text);
    for (const path of HOWTO) {
      const first = path.pathRu.split(' → ')[0]!.trim();
      expect(
        labels,
        `путь «${path.ru}» начинается с кнопки «${first}», которой нет в меню`,
      ).toContain(first);
    }
  });
});

describe('каркас бота: администратор', () => {
  it('кладовщику /admin не отвечает панелью', async () => {
    tg.clear();
    await bot.handleUpdate(message(CHAT_KEEPER, TG_KEEPER, '/admin'));
    expect(tg.last().text).toMatch(/не доступен/i);
  });

  it('администратору панель открывается и показывает меню чужой роли', async () => {
    await signIn(CHAT_ADMIN, TG_ADMIN, ADMIN, PASSWORD);
    tg.clear();
    await bot.handleUpdate(message(CHAT_ADMIN, TG_ADMIN, '/admin'));
    expect(tg.last().data).toContain('a:who');

    await bot.handleUpdate(press(CHAT_ADMIN, TG_ADMIN, 'a:r'));
    expect(tg.last().data.some((d) => d.startsWith('a:r:'))).toBe(true);

    await bot.handleUpdate(press(CHAT_ADMIN, TG_ADMIN, 'a:r:warehouse_keeper'));
    const shown = tg.last();
    expect(shown.text).toMatch(/Склад/);
    // Это показ, а не подмена: кнопок роли в клавиатуре нет, нажать нечего.
    expect(shown.data, 'меню роли отдали кнопками — это уже работа за человека').not.toContain(
      'm:warehouse',
    );
  });

  it('список подключённых показывает и тех, у кого бота нет', async () => {
    tg.clear();
    await bot.handleUpdate(press(CHAT_ADMIN, TG_ADMIN, 'a:who'));
    const text = tg.last().text ?? '';
    expect(text).toMatch(/●/);
    expect(text).toMatch(/○/);
  });

  it('выход снимает разговор и снова спрашивает язык', async () => {
    tg.clear();
    await bot.handleUpdate(press(CHAT_ADMIN, TG_ADMIN, 's:out'));
    const session = await db.query(
      'SELECT user_id, step FROM telegram_session WHERE chat_id = $1',
      [String(CHAT_ADMIN)],
    );
    expect(session.rows[0].user_id).toBeNull();
    expect(session.rows[0].step).toBe('language');
    expect(tg.last().method).toBe('sendPhoto');
  });
});

describe('каркас бота: панель и команды', () => {
  // Эти проверки должны падать и по одной: вход здесь свой, а не чужой остаток.
  beforeAll(async () => {
    await clean();
    await signIn(CHAT_KEEPER, TG_KEEPER, KEEPER, PASSWORD);
    await signIn(CHAT_ADMIN, TG_ADMIN, ADMIN, PASSWORD);
  });

  it('произвольный текст не открывает панель заново', async () => {
    await bot.handleUpdate(message(CHAT_KEEPER, TG_KEEPER, '/start'));
    tg.clear();
    await bot.handleUpdate(message(CHAT_KEEPER, TG_KEEPER, 'спасибо, понял'));
    expect(
      tg.sent.map((m) => m.method),
      'на обычный текст бот снова прислал панель',
    ).toEqual(['sendMessage']);
    expect(tg.last().text, 'подсказка не говорит, чем открыть панель').toMatch(/\/start/);
    expect(tg.last().buttons, 'вместе с подсказкой уехали кнопки').toEqual([]);
    expect(tg.last().text, 'бот снова поздоровался').not.toMatch(/Здравствуйте/);
  });

  it('каждый экран остаётся с шапкой', async () => {
    tg.clear();
    await bot.handleUpdate(message(CHAT_KEEPER, TG_KEEPER, '/start'));
    expect(tg.last().method, 'приветствие пришло без картинки').toBe('sendPhoto');
    expect(tg.last().text).toMatch(/Здравствуйте/);
    for (const data of ['m:warehouse', 's', 's:who', 'm']) {
      tg.clear();
      await bot.handleUpdate(press(CHAT_KEEPER, TG_KEEPER, data));
      expect(tg.last().method, `экран ${data} потерял шапку`).toBe('editMessageCaption');
    }
  });

  it('/settings открывает настройки, /help перечисляет только безопасные команды', async () => {
    tg.clear();
    await bot.handleUpdate(message(CHAT_KEEPER, TG_KEEPER, '/settings'));
    expect(tg.last().method).toBe('sendPhoto');
    expect(tg.last().data).toContain('s:l');

    tg.clear();
    await bot.handleUpdate(message(CHAT_KEEPER, TG_KEEPER, '/help'));
    const help = tg.last().text ?? '';
    expect(help).toMatch(/\/start/);
    expect(help).toMatch(/\/quit/);
    expect(help, 'кладовщику показали команду управления').not.toMatch(/\/admin/);
  });

  it('администратору подсказка показывает и команду управления', async () => {
    tg.clear();
    await bot.handleUpdate(message(CHAT_ADMIN, TG_ADMIN, '/help'));
    expect(tg.last().text ?? '').toMatch(/\/admin/);
  });

  it('/quit выходит и возвращает выбор языка с шапкой', async () => {
    tg.clear();
    await bot.handleUpdate(message(CHAT_KEEPER, TG_KEEPER, '/quit'));
    const session = await db.query(
      'SELECT user_id, step FROM telegram_session WHERE chat_id = $1',
      [String(CHAT_KEEPER)],
    );
    expect(session.rows[0].user_id).toBeNull();
    expect(session.rows[0].step).toBe('language');
    expect(tg.last().method).toBe('sendPhoto');
    expect(tg.last().data).toEqual(['l:ru', 'l:uz']);
  });
});

describe('каркас бота: кому бот нужен', () => {
  const CHAT_ACC = 980000105n;
  const TG_ACC = 980000105n;
  const CHAT_MASTER = 980000106n;
  const TG_MASTER = 980000106n;

  async function wipe() {
    await db.query('DELETE FROM telegram_session WHERE chat_id = ANY($1)', [
      [String(CHAT_ACC), String(CHAT_MASTER)],
    ]);
    await db.query(
      `UPDATE user_account SET telegram_user_id = NULL, telegram_linked_at = NULL
        WHERE telegram_user_id = ANY($1)`,
      [[String(TG_ACC), String(TG_MASTER)]],
    );
    await db.query(
      `UPDATE user_account SET failed_login_count = 0, locked_until = NULL, locale = 'ru'
        WHERE login = ANY($1)`,
      [[ACCOUNTANT, MASTER]],
    );
  }

  beforeAll(wipe);
  afterAll(wipe);

  it('начальника производства бот не пускает и привязку не записывает', async () => {
    tg.clear();
    await signIn(CHAT_MASTER, TG_MASTER, MASTER, PASSWORD);
    expect(tg.last().text, 'мастера пустили в бота').toMatch(/в самой системе/i);

    const user = await db.query('SELECT telegram_user_id FROM user_account WHERE login = $1', [
      MASTER,
    ]);
    expect(user.rows[0].telegram_user_id, 'привязка записана тому, кому бот не нужен').toBeNull();

    const session = await db.query(
      'SELECT user_id, step FROM telegram_session WHERE chat_id = $1',
      [String(CHAT_MASTER)],
    );
    expect(session.rows[0].user_id).toBeNull();
    expect(session.rows[0].step).toBe('login');
  });

  it('приветствие показывает тревоги этой роли, а не список компаний', async () => {
    tg.clear();
    await signIn(CHAT_ACC, TG_ACC, ACCOUNTANT, PASSWORD);
    const hello = tg.last().text ?? '';
    expect(hello).toMatch(/Здравствуйте/);
    expect(hello, 'сводка пришла простым текстом, а не цитатой').toMatch(
      /<blockquote>[\s\S]+<\/blockquote>/,
    );
    expect(hello, 'не видно, что сводка свежая').toMatch(/Обновлено \d{2}:\d{2}/);
    expect(hello, 'под приветствием снова список компаний').not.toMatch(/METALL ASIA/);
    expect(hello, 'под приветствием снова «выберите раздел»').not.toMatch(/Выберите раздел/);

    const pending = await db.query(
      `SELECT count(*)::int AS n FROM finance_operation WHERE status = 'pending_approval'`,
    );
    const n = pending.rows[0].n as number;
    if (n > 0) {
      expect(hello, 'сводка финансиста не назвала операции на согласовании').toContain(
        `Операции на согласовании: ${n.toLocaleString('ru-RU')}`,
      );
    } else {
      expect(hello).toMatch(/На что обратить внимание|Срочного ничего нет/);
    }
  });

  it('кладовщик не видит в приветствии чужих цифр', async () => {
    tg.clear();
    await bot.handleUpdate(message(CHAT_KEEPER, TG_KEEPER, '/start'));
    const hello = tg.last().text ?? '';
    expect(hello, 'кладовщику показали финансовую сводку').not.toMatch(/согласовании|оплата/i);

    const sheets = await db.query(
      `SELECT count(*)::int AS n FROM inventory_sheet
        WHERE status IN ('draft', 'counting', 'review')`,
    );
    const n = sheets.rows[0].n as number;
    if (n > 0) {
      expect(hello, 'сводка склада не назвала незакрытую инвентаризацию').toContain(
        `Незакрытая инвентаризация: ${n.toLocaleString('ru-RU')}`,
      );
    }
  });
});

describe('каркас бота: уведомления', () => {
  beforeAll(async () => {
    await clean();
    await db.query(
      `DELETE FROM notification_outbox
        WHERE user_id = (SELECT id FROM user_account WHERE login = $1)`,
      [KEEPER],
    );
    await db.query(
      `DELETE FROM notification_setting
        WHERE user_id = (SELECT id FROM user_account WHERE login = $1)`,
      [KEEPER],
    );
    await signIn(CHAT_KEEPER, TG_KEEPER, KEEPER, PASSWORD);
    /**
     * Блок проверяет очередь, а не отбор поводов: кладовщику оставляем один
     * складской повод и выключаем остальные. Иначе «ушло ровно одно» зависит
     * от того, что ещё успело накопиться в базе, и проверка краснеет не по делу.
     */
    for (const k of KINDS) {
      if (k.kind === 'stock_critical') continue;
      await db.query(
        `INSERT INTO notification_setting (user_id, kind, enabled)
         VALUES ((SELECT id FROM user_account WHERE login = $1), $2, false)
         ON CONFLICT (user_id, kind) DO UPDATE SET enabled = false`,
        [KEEPER, k.kind],
      );
    }
  });

  const mine = async () => {
    const r = await db.query(
      `SELECT kind, sent_at, attempts FROM notification_outbox
        WHERE user_id = (SELECT id FROM user_account WHERE login = $1)`,
      [KEEPER],
    );
    return r.rows as { kind: string; sent_at: Date | null; attempts: number }[];
  };

  it('кладовщику приходит складское уведомление, и повторно его не присылают', async () => {
    tg.clear();
    await bot.tick();
    const sent = tg.sent.filter(
      (m) => m.method === 'sendMessage' && /Критический остаток/.test(m.text ?? ''),
    );
    expect(sent.length, 'уведомление о критическом остатке не ушло').toBe(1);
    expect(sent[0]!.text, 'в уведомлении не сказано, что делать').toMatch(/Что сделать/);
    expect(sent[0]!.data, 'из уведомления нечем открыть панель').toContain('m');

    const rows = await mine();
    const critical = rows.filter((r) => r.kind === 'stock_critical');
    expect(critical).toHaveLength(1);
    expect(critical[0]!.sent_at, 'отправленное не отмечено').not.toBeNull();

    tg.clear();
    await bot.tick();
    expect(
      tg.sent.filter((m) => /Критический остаток/.test(m.text ?? '')),
      'одно и то же событие пришло дважды',
    ).toHaveLength(0);
  });

  it('если боту закрыли дверь, очередь это запоминает и не долбится', async () => {
    await db.query(
      `UPDATE notification_outbox SET sent_at = NULL
        WHERE user_id = (SELECT id FROM user_account WHERE login = $1)`,
      [KEEPER],
    );
    const original = tg.sendMessage.bind(tg);
    tg.sendMessage = () =>
      Promise.reject(new TelegramError('sendMessage', 403, 'bot was blocked by the user'));
    try {
      await bot.tick();
    } finally {
      tg.sendMessage = original;
    }

    const blocked = await db.query('SELECT telegram_blocked FROM user_account WHERE login = $1', [
      KEEPER,
    ]);
    expect(blocked.rows[0].telegram_blocked, 'закрытая дверь не отмечена').toBe(true);

    tg.clear();
    await bot.tick();
    expect(
      tg.sent.filter((m) => /Критический остаток/.test(m.text ?? '')),
      'очередь продолжает писать тому, кто закрыл бота',
    ).toHaveLength(0);

    // Человек вернулся сам — дверь снова открыта.
    await bot.handleUpdate(message(CHAT_KEEPER, TG_KEEPER, '/start'));
    const back = await db.query('SELECT telegram_blocked FROM user_account WHERE login = $1', [
      KEEPER,
    ]);
    expect(back.rows[0].telegram_blocked, 'вернувшемуся человеку бот всё ещё не пишет').toBe(false);
  });

  /**
   * Чужой хвост не должен затыкать остальных. Поводов стало десять, и человек
   * с накопившейся очередью легко набирает больше, чем проход отдаёт целиком:
   * пока его разгребают, кладовщик не узнаёт о критическом остатке.
   */
  it('очередь одного человека не затыкает остальных', async () => {
    // Второй человек должен быть в боте: кому бот писать не может, тот и не в
    // очереди — проверка тогда зеленела бы ни на чём.
    await signIn(CHAT_ADMIN, TG_ADMIN, ADMIN, PASSWORD);
    const who = async (login: string) =>
      (await db.query('SELECT id FROM user_account WHERE login = $1', [login])).rows[0]
        .id as string;
    const keeperId = await who(KEEPER);
    const adminId = await who(ADMIN);
    for (const id of [keeperId, adminId]) {
      await db.query('DELETE FROM notification_outbox WHERE user_id = $1', [id]);
    }
    // У кладовщика хвост длиннее всего прохода, у администратора — одно дело.
    for (let i = 0; i < 40; i += 1) {
      await db.query(
        `INSERT INTO notification_outbox (user_id, kind, dedupe_key, text_ru, text_uz)
         VALUES ($1, 'stock_critical', $2, $3, $3)`,
        [keeperId, `хвост-${i}`, `Хвост очереди ${i}`],
      );
    }
    await db.query(
      `INSERT INTO notification_outbox (user_id, kind, dedupe_key, text_ru, text_uz)
       VALUES ($1, 'document_pending', 'доля-1', $2, $2)`,
      [adminId, 'Доля второго человека'],
    );

    tg.clear();
    await bot.tick();
    expect(
      tg.sent.filter((m) => /Доля второго человека/.test(m.text ?? '')).length,
      'человека с одним делом вытеснил чужой хвост',
    ).toBe(1);

    for (const id of [keeperId, adminId]) {
      await db.query('DELETE FROM notification_outbox WHERE user_id = $1', [id]);
    }
  });

  it('за один проход человек получает не больше трёх сообщений', async () => {
    const id = (await db.query('SELECT id FROM user_account WHERE login = $1', [KEEPER])).rows[0]
      .id as string;
    await db.query('DELETE FROM notification_outbox WHERE user_id = $1', [id]);
    for (let i = 0; i < 5; i += 1) {
      await db.query(
        `INSERT INTO notification_outbox (user_id, kind, dedupe_key, text_ru, text_uz)
         VALUES ($1, 'stock_critical', $2, $3, $3)`,
        [id, `проверка-${i}`, `Проверка очереди ${i}`],
      );
    }
    tg.clear();
    await bot.tick();
    const mineSent = tg.sent.filter((m) => /Проверка очереди/.test(m.text ?? ''));
    expect(mineSent.length, 'бот вывалил человеку всю очередь сразу').toBe(3);

    tg.clear();
    await bot.tick();
    expect(
      tg.sent.filter((m) => /Проверка очереди/.test(m.text ?? '')).length,
      'остаток очереди не пришёл следующим проходом',
    ).toBe(2);
    await db.query('DELETE FROM notification_outbox WHERE user_id = $1', [id]);
  });

  it('уведомления включаются и выключаются человеком в настройках', async () => {
    tg.clear();
    await bot.handleUpdate(press(CHAT_KEEPER, TG_KEEPER, 's'));
    expect(tg.last().data, 'в настройках нет кнопки уведомлений').toContain('n');

    await bot.handleUpdate(press(CHAT_KEEPER, TG_KEEPER, 'n'));
    const index = tg.last();
    expect(index.text, 'экран не объясняет, зачем уведомления').toMatch(/Бот сам пишет/);
    expect(index.text, 'не сказано, сколько поводов включено').toMatch(/включено \d+ из \d+/);
    expect(index.data, 'в указателе нет группы про работу').toContain('n:g:work');

    await bot.handleUpdate(press(CHAT_KEEPER, TG_KEEPER, 'n:g:work'));
    const screen = tg.last();
    expect(screen.text).toMatch(/✅ Критический остаток/);
    expect(screen.data).toContain('n:stock_critical');

    tg.clear();
    await bot.handleUpdate(press(CHAT_KEEPER, TG_KEEPER, 'n:stock_critical'));
    expect(tg.answers.map((a) => a.text).join(' ')).toMatch(/выключено/);
    expect(tg.last().text, 'выключенный вид показан как включённый').toMatch(
      /⬜ Критический остаток/,
    );

    const off = await db.query(
      `SELECT enabled FROM notification_setting
        WHERE user_id = (SELECT id FROM user_account WHERE login = $1) AND kind = 'stock_critical'`,
      [KEEPER],
    );
    expect(off.rows[0].enabled).toBe(false);

    await bot.handleUpdate(press(CHAT_KEEPER, TG_KEEPER, 'n:stock_critical'));
    expect(tg.last().text).toMatch(/✅ Критический остаток/);
  });

  afterAll(async () => {
    await db.query(
      `DELETE FROM notification_outbox
        WHERE user_id = (SELECT id FROM user_account WHERE login = $1)`,
      [KEEPER],
    );
    await db.query(
      `DELETE FROM notification_setting
        WHERE user_id = (SELECT id FROM user_account WHERE login = $1)`,
      [KEEPER],
    );
  });
});
