import { HttpException, Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from '../auth/auth.service.js';
import { TelegramLinkService } from '../admin/telegram-link.service.js';
import {
  TelegramApi,
  TelegramError,
  type InlineKeyboard,
  type TelegramUpdate,
} from './telegram.api.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { KINDS, type KindGroup } from '../notifications/kinds.js';
import {
  BLUE,
  CB,
  GREEN,
  RED,
  SECTIONS,
  allowedSections,
  backRow,
  botAllowed,
  mainMenu,
} from './menu.js';
import { DigestService } from './digest.service.js';
import { BotFinance } from './finance.bot.js';
import { BotWarehouse } from './warehouse.bot.js';
import { BotSales } from './sales.bot.js';
import { BotDocuments } from './documents.bot.js';
import { BotChief } from './chief.bot.js';
import { BotProduction } from './production.bot.js';
import { BotRates } from './rates.bot.js';
import type { Incoming, Me, Screen, SectionFlow } from './section.js';
import { T } from './texts.js';
import { ERR } from '../common/error-codes.js';
import { howToFor, howToOne } from './howto.js';
import { fit } from './format.js';

type Step = 'language' | 'login' | 'password' | 'ready';

/**
 * Как часто собираем уведомления. Две минуты — компромисс: «просрочено» не
 * портится от минуты ожидания, а частый проход гонял бы пять запросов на
 * человека впустую.
 */
const TICK_MS = 2 * 60 * 1000;

/**
 * Сколько сообщений человек получает за один проход. Пятнадцать уведомлений
 * подряд читаются как спам — особенно тем, для кого бот и есть вся система:
 * он закроет его и не прочитает ни одного. Остальное придёт следующими
 * проходами, порядок в очереди — по времени события.
 */
const PER_USER_PER_TICK = 3;

/** Подпись к фотографии в Telegram — не больше 1024 знаков. */
const CAPTION_LIMIT = 1024;

/**
 * Команды — страховка для того, кто понимает, а не второй способ управления.
 * Открыть панель, настройки, выйти, подсказка — и `/admin`, который каждый раз
 * проверяет право. Ничего, чем можно сломать бота или чужой разговор, здесь нет.
 */
const COMMANDS = ['/start', '/menu', '/settings', '/quit', '/exit', '/help', '/admin'] as const;

/** Экран, который уже на виду: правим его, а не плодим новые сообщения. */
interface Edit {
  messageId: number;
  hasPhoto: boolean;
}

interface Session {
  chatId: bigint;
  telegramUserId: bigint;
  userId: bigint | null;
  locale: string;
  step: Step;
  pendingLogin: string | null;
  /** Незаконченный разговор раздела. Пусто — человек ничего не заполняет. */
  flow: SectionFlow | null;
}

/**
 * Каркас бота (ТЗ 11): язык → вход → кнопки по правам.
 *
 * Чего здесь нет и не будет: бизнес-действий. Разделы открываются и честно
 * говорят, что в них появится. Пустая кнопка, которая молча ничего не делает,
 * хуже отсутствующей.
 *
 * Три решения, которые стоит знать, читая код.
 *
 * **Право проверяется на каждом нажатии, а не только при отрисовке меню.**
 * Между двумя нажатиями администратор мог снять право, а кнопка у человека на
 * экране осталась — Telegram её не забирает.
 *
 * **Пароль живёт внутри одной функции.** Он приходит сообщением, сообщение
 * удаляется сразу, значение уходит в `AuthService.login` и больше нигде не
 * появляется: ни в сессии, ни в журнале, ни в логе процесса.
 *
 * **Действия человека идут от его учётной записи.** Бот не отдельный
 * пользователь системы: он работает в контексте того, кто вошёл, и его правки
 * ложатся в журнал с источником `bot`.
 */
@Injectable()
export class BotService {
  private readonly log = new Logger('bot');
  private running = false;
  private offset = 0;
  /** Когда последний раз собирали и отправляли уведомления. */
  private lastTick = 0;
  private photo: { key: string; bytes: ArrayBuffer; fileName: string } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly links: TelegramLinkService,
    private readonly digest: DigestService,
    private readonly finance: BotFinance,
    private readonly warehouse: BotWarehouse,
    private readonly sales: BotSales,
    private readonly documents: BotDocuments,
    private readonly chief: BotChief,
    private readonly production: BotProduction,
    private readonly rates: BotRates,
    private readonly notifications: NotificationsService,
    private readonly api: TelegramApi,
  ) {}

  // --- хранение разговора ---------------------------------------------------

  private async session(chatId: bigint, telegramUserId: bigint): Promise<Session> {
    return this.prisma.withContext(null, [], async (tx) => {
      const rows = await tx.$queryRaw<
        {
          chat_id: bigint;
          telegram_user_id: bigint;
          user_id: bigint | null;
          locale: string;
          step: string;
          pending_login: string | null;
          flow: unknown;
        }[]
      >`
        SELECT chat_id, telegram_user_id, user_id, locale, step, pending_login, flow
          FROM telegram_session WHERE chat_id = ${chatId}`;
      const row = rows[0];
      if (row) {
        await tx.$executeRaw`
          UPDATE telegram_session SET last_seen_at = now() WHERE chat_id = ${chatId}`;
        return {
          chatId,
          telegramUserId,
          userId: row.user_id === null ? null : BigInt(row.user_id),
          locale: row.locale,
          step: row.step as Step,
          pendingLogin: row.pending_login,
          flow: (row.flow as SectionFlow | null) ?? null,
        };
      }
      await tx.$executeRaw`
        INSERT INTO telegram_session (chat_id, telegram_user_id)
        VALUES (${chatId}, ${telegramUserId})`;
      return {
        chatId,
        telegramUserId,
        userId: null,
        locale: 'ru',
        step: 'language',
        pendingLogin: null,
        flow: null,
      };
    });
  }

  private async save(chatId: bigint, patch: Partial<Session>): Promise<void> {
    await this.prisma.withContext(null, [], async (tx) => {
      if (patch.locale !== undefined) {
        await tx.$executeRaw`UPDATE telegram_session SET locale = ${patch.locale} WHERE chat_id = ${chatId}`;
      }
      if (patch.step !== undefined) {
        await tx.$executeRaw`UPDATE telegram_session SET step = ${patch.step} WHERE chat_id = ${chatId}`;
      }
      if (patch.pendingLogin !== undefined) {
        await tx.$executeRaw`UPDATE telegram_session SET pending_login = ${patch.pendingLogin} WHERE chat_id = ${chatId}`;
      }
      if (patch.userId !== undefined) {
        await tx.$executeRaw`UPDATE telegram_session SET user_id = ${patch.userId} WHERE chat_id = ${chatId}`;
      }
      if (patch.flow !== undefined) {
        // `$executeRawUnsafe` ради явного приведения к jsonb: тегированный
        // шаблон отдаёт строку как text, и Postgres отказывается её принять.
        await tx.$executeRawUnsafe(
          'UPDATE telegram_session SET flow = $2::jsonb WHERE chat_id = $1',
          chatId,
          patch.flow === null ? null : JSON.stringify(patch.flow),
        );
      }
    });
  }

  // --- кто это и что ему можно ----------------------------------------------

  /**
   * Права и имя — всегда из базы, не из того, что лежало в сессии при входе.
   * Роль могли снять час назад, и бот обязан это заметить.
   */
  private async profile(userId: bigint) {
    const user = await this.auth.userById(userId);
    if (!user || !user.isActive) return null;
    const access = await this.auth.loadProfile(userId);
    const companies = await this.auth.companies(access.companyIds);
    const roles = await this.roleCodes(userId);
    return {
      user,
      permissions: access.permissions,
      companyIds: access.companyIds,
      companies,
      roles,
      /**
       * Проверяется здесь, а не один раз при входе: роль могли поменять уже
       * после привязки, и человек, которого перевели в цех, бота теряет.
       */
      canUseBot: botAllowed(roles),
    };
  }

  private async roleCodes(userId: bigint): Promise<string[]> {
    const rows = await this.prisma.withContext(
      userId,
      [],
      (tx) =>
        tx.$queryRaw<{ code: string }[]>`
        SELECT DISTINCT r.code
          FROM user_role_assignment a JOIN role r ON r.id = a.role_id
         WHERE a.user_id = ${userId}`,
    );
    return rows.map((r) => r.code);
  }

  /** Привязка жива, пока у человека стоит этот номер аккаунта Telegram. */
  private async linkedUserId(telegramUserId: bigint): Promise<bigint | null> {
    return this.prisma.withContext(null, [], async (tx) => {
      const rows = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM user_account
         WHERE telegram_user_id = ${telegramUserId} AND is_active`;
      return rows[0] ? BigInt(rows[0].id) : null;
    });
  }

  // --- экраны ---------------------------------------------------------------

  private langKeyboard(): InlineKeyboard {
    return [
      [
        { text: '🇷🇺 Русский', data: CB.lang('ru'), style: BLUE },
        { text: '🇺🇿 O‘zbekcha', data: CB.lang('uz'), style: BLUE },
      ],
    ];
  }

  private async welcomePhoto() {
    if (!this.photo) {
      const here = dirname(fileURLToPath(import.meta.url));
      const bytes = await readFile(join(here, 'assets', 'welcome.jpg'));
      this.photo = {
        key: 'welcome',
        bytes: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
        fileName: 'metall-asia.jpg',
      };
    }
    return this.photo;
  }

  /**
   * Любой экран бота — сообщение с шапкой: так попросил клиент, и так человеку
   * видно, что он в своей системе, а не в случайной переписке.
   *
   * Переход между экранами меняет подпись того же сообщения с фотографией
   * (`editMessageCaption`), а не шлёт простыню заново — у сообщения с фото
   * текста нет, и `editMessageText` на нём отказывает. Новый экран приходит
   * как `sendPhoto`; второй раз файл не грузится, уходит `file_id`.
   *
   * Картинка — украшение, доступ — нет: не нашлось файла шапки или Telegram
   * отказал — показываем то же самое текстом. Проверено на себе: `tsc`
   * переносит только код, и первый же «Старт» падал на отсутствующем файле.
   */
  private async panel(
    chatId: bigint,
    caption: string,
    keyboard?: InlineKeyboard,
    edit?: Edit,
  ): Promise<void> {
    const fitted = fit(caption, CAPTION_LIMIT);
    if (fitted.cut > 0) {
      // Молча обрезанный экран — это пропавший хвост, который никто не ищет.
      this.log.warn(`подпись не влезла: обрезано ${fitted.cut} знаков`);
    }
    const text = fitted.text;
    try {
      if (edit?.hasPhoto) {
        await this.api.editMessageCaption(chatId, edit.messageId, text, keyboard);
      } else if (edit) {
        await this.api.editMessageText(chatId, edit.messageId, text, keyboard);
      } else {
        await this.api.sendPhoto(chatId, await this.welcomePhoto(), text, keyboard);
      }
      return;
    } catch (e) {
      this.log.error(`панель: ${(e as Error).message}`);
    }
    await this.api.sendMessage(chatId, text, keyboard);
  }

  /**
   * Показать экран раздела.
   *
   * Разделы не знают ни про Telegram, ни про то, каким сообщением их покажут:
   * они возвращают подпись, кнопки и — если человек что-то заполняет — новое
   * состояние разговора. Сохранение состояния здесь же, одной транзакцией с
   * показом: сохранить и не показать значит оставить человека на шаге, вопрос
   * которого он не видит.
   */
  private async render(chatId: bigint, screen: Screen, edit?: Edit): Promise<void> {
    if (screen.flow !== undefined) await this.save(chatId, { flow: screen.flow });
    await this.panel(chatId, screen.text, screen.keyboard, screen.fresh ? undefined : edit);
    // Файл уезжает отдельным сообщением: панель живёт одной подписью, которую
    // бот правит на каждом переходе, а счёт человек пересылает клиенту и
    // возвращается к нему через месяц.
    if (screen.file) await this.api.sendDocument(chatId, screen.file);
  }

  /**
   * Живые разделы бота: что их открывает, какое право нужно и кто их рисует.
   *
   * Таблицей, а не цепочкой `if` по префиксам: разделов четыре, и правило
   * «права финансов не пускают в склад» должно читаться в одном месте. Ключ —
   * тот же, что у раздела в меню, иначе кнопка меню и обработчик нажатия
   * однажды разойдутся.
   */
  private get sections(): Record<
    string,
    {
      open: string;
      prefix: string;
      permission: string;
      kind: SectionFlow['kind'];
      route: (me: Me, flow: SectionFlow | null, data: string, uz: boolean) => Promise<Screen>;
      text: (me: Me, flow: SectionFlow, raw: string, uz: boolean) => Promise<Screen>;
      /**
       * Присланный файл. Есть только у разделов, которым он нужен: фото чека в
       * финансах и снимок при списании на складе. Остальным он не нужен, и
       * пустая заглушка у них была бы обещанием, которого они не держат.
       */
      photo?: (me: Me, flow: SectionFlow, file: Incoming, uz: boolean) => Promise<Screen>;
    }
  > {
    return {
      finance: {
        open: CB.fin,
        prefix: 'f:',
        permission: 'finance.view',
        kind: 'fin',
        route: (me, flow, data, uz) => this.finance.route(me, flow, data, uz),
        text: (me, flow, raw, uz) => this.finance.text(me, flow, raw, uz),
        photo: (me, flow, file, uz) => this.finance.photo(me, flow, file, uz),
      },
      warehouse: {
        open: CB.wh,
        prefix: 'w:',
        permission: 'warehouse.view',
        kind: 'wh',
        route: (me, flow, data, uz) => this.warehouse.route(me, flow, data, uz),
        text: (me, flow, raw, uz) => this.warehouse.text(me, flow, raw, uz),
        photo: (me, flow, file, uz) => this.warehouse.photo(me, flow, file, uz),
      },
      sales: {
        open: CB.sal,
        prefix: 'o:',
        permission: 'sales.view',
        kind: 'sales',
        route: (me, flow, data, uz) => this.sales.route(me, flow, data, uz),
        text: (me, flow, raw, uz) => this.sales.text(me, flow, raw, uz),
      },
      documents: {
        open: CB.doc,
        prefix: 'd:',
        permission: 'documents.view',
        kind: 'doc',
        route: (me, flow, data, uz) => this.documents.route(me, flow, data, uz),
        text: (me, flow, raw, uz) => this.documents.text(me, flow, raw, uz),
      },
      production: {
        open: CB.prod,
        prefix: 'p:',
        permission: 'production.view',
        kind: 'prod',
        route: (me, flow, data, uz) => this.production.route(me, flow, data, uz),
        text: (me, flow, raw, uz) => this.production.text(me, flow, raw, uz),
        photo: (me, flow, file, uz) => this.production.photo(me, flow, file, uz),
      },
      dashboard: {
        open: CB.chief,
        prefix: 'c:',
        permission: 'dashboard.view',
        kind: 'chief',
        route: (me, flow, data, uz) => this.chief.route(me, flow, data, uz),
        text: (me, flow, raw, uz) => this.chief.text(me, flow, raw, uz),
      },
    };
  }

  /** Какому разделу принадлежит это нажатие. */
  private sectionFor(data: string) {
    return Object.values(this.sections).find((s) => data === s.open || data.startsWith(s.prefix));
  }

  /** Какой раздел ведёт этот разговор. */
  private sectionOf(kind: SectionFlow['kind']) {
    return Object.values(this.sections).find((s) => s.kind === kind);
  }

  /** Что о человеке нужно знать разделу: кто он и что ему можно. */
  private meFor(me: {
    user: { id: bigint };
    permissions: Set<string>;
    companyIds: bigint[];
    companies: { id: bigint; uid: string; nameRu: string; nameUz: string }[];
  }): Me {
    return {
      userId: me.user.id,
      permissions: me.permissions,
      companyIds: me.companyIds,
      companies: me.companies.map((c) => ({
        id: c.id,
        uid: c.uid,
        nameRu: c.nameRu,
        nameUz: c.nameUz,
      })),
    };
  }

  private async showLanguage(chatId: bigint, uz: boolean, edit?: Edit) {
    await this.panel(chatId, T.welcome(uz), this.langKeyboard(), edit);
  }

  private async showMenu(chatId: bigint, userId: bigint, uz: boolean, edit?: Edit) {
    const me = await this.profile(userId);
    if (!me) {
      await this.api.sendMessage(chatId, T.gone(uz));
      return;
    }
    if (!me.canUseBot) {
      await this.api.sendMessage(chatId, T.notForBot(uz));
      return;
    }
    const sections = allowedSections(me.permissions);
    const lines = await this.digest.lines(userId, me.companyIds, me.permissions, uz);
    const text = sections.length === 0 ? T.noRights(uz) : T.hello(uz, me.user.fullName, lines);
    await this.panel(chatId, text, mainMenu(me.permissions, uz), edit);
  }

  private async showSettings(chatId: bigint, uz: boolean, edit?: Edit) {
    await this.panel(chatId, T.settings(uz), this.settingsKeyboard(uz), edit);
  }

  /**
   * «Как пользоваться»: пути только к тому, на что у человека есть право.
   * Путь, который отобьётся на первом нажатии, обманывает дважды — человек
   * пробует и решает, что бот сломан.
   */
  private async showHowTo(chatId: bigint, permissions: Set<string>, uz: boolean, edit?: Edit) {
    const paths = howToFor(permissions);
    const rows: InlineKeyboard = paths.map((p) => [
      { text: uz ? p.uz : p.ru, data: CB.howToOne(p.key), style: BLUE },
    ]);
    rows.push(backRow(uz));
    await this.panel(
      chatId,
      T.howTo(uz, paths.length > 0, permissions.has('admin.users')),
      rows,
      edit,
    );
  }

  /**
   * Один путь: что нажимать и что получится. Право проверяется и здесь — кнопка
   * могла остаться на экране от прежней роли.
   */
  private async showHowToOne(
    chatId: bigint,
    permissions: Set<string>,
    key: string,
    uz: boolean,
    edit?: Edit,
  ) {
    const path = howToOne(permissions, key);
    if (!path) {
      await this.showHowTo(chatId, permissions, uz, edit);
      return;
    }
    await this.panel(
      chatId,
      T.howToOne(
        uz,
        uz ? path.uz : path.ru,
        uz ? path.pathUz : path.pathRu,
        uz ? path.outUz : path.outRu,
      ),
      [[{ text: uz ? '⬅️ Yordamga' : '⬅️ К подсказке', data: CB.howTo, style: BLUE }], backRow(uz)],
      edit,
    );
  }

  private async showAdmin(chatId: bigint, uz: boolean, edit?: Edit) {
    await this.panel(chatId, T.adminTitle(uz), this.adminKeyboard(uz), edit);
  }

  /** Выход: сессия чистая, экран — снова выбор языка. */
  private async logout(chatId: bigint, uz: boolean, edit?: Edit) {
    await this.save(chatId, {
      userId: null,
      step: 'language',
      pendingLogin: null,
      flow: null,
    });
    if (edit) await this.panel(chatId, T.loggedOut(uz), undefined, edit);
    else await this.api.sendMessage(chatId, T.loggedOut(uz));
    await this.showLanguage(chatId, uz);
  }

  private settingsKeyboard(uz: boolean): InlineKeyboard {
    return [
      [
        {
          text: uz ? '🌐 Til: O‘zbekcha' : '🌐 Язык: Русский',
          data: CB.settingsLang,
          style: GREEN,
        },
      ],
      [
        {
          text: uz ? '🔔 Xabarnomalar' : '🔔 Уведомления',
          data: CB.notifications,
          style: GREEN,
        },
      ],
      // «Как пользоваться» стоит первой строкой снизу: человек, который ищет
      // подсказку, чаще всего не знает и слова «настройки» — он просто жмёт
      // зелёную кнопку и смотрит, что внутри.
      [
        {
          text: uz ? '❓ Qanday foydalanish' : '❓ Как пользоваться',
          data: CB.howTo,
          style: GREEN,
        },
      ],
      [{ text: uz ? '👤 Men kim' : '👤 Кто я', data: CB.whoAmI, style: GREEN }],
      // Выход — единственное, что отнимает доступ: пусть видно, что это не «назад».
      [{ text: uz ? '🚪 Chiqish' : '🚪 Выйти', data: CB.logout, style: RED }],
      backRow(uz),
    ];
  }

  /**
   * Указатель по группам поводов.
   *
   * Поводов четырнадцать, и одним списком их показывать нельзя по двум
   * причинам: подпись панели в Telegram — 1024 знака, а четырнадцать
   * переключателей подряд человек не читает. Группы называют, сколько в каждой
   * включено, — иначе непонятно, куда заходить.
   */
  private async showNotifications(
    chatId: bigint,
    userId: bigint,
    permissions: Set<string>,
    uz: boolean,
    edit?: Edit,
  ) {
    const mine = KINDS.filter((k) => permissions.has(k.permission));
    if (mine.length === 0) {
      await this.panel(
        chatId,
        T.notifyNone(uz),
        [
          [
            {
              text: uz ? '⬅️ Sozlamalar' : '⬅️ Настройки',
              data: CB.settings,
              style: GREEN,
            },
          ],
        ],
        edit,
      );
      return;
    }
    const chosen = await this.notifications.settings(userId);
    const groups: KindGroup[] = ['money', 'work', 'system'];
    const lines: string[] = [];
    const keyboard: InlineKeyboard = [];
    for (const group of groups) {
      const kinds = mine.filter((k) => k.group === group);
      // Группа без своих поводов не показывается: у кладовщика денег нет.
      if (kinds.length === 0) continue;
      const on = kinds.filter((k) => chosen.get(k.kind) ?? true).length;
      const name = T.notifyGroupName(uz, group);
      lines.push(T.notifyGroupLine(uz, name, on, kinds.length));
      keyboard.push([{ text: name, data: CB.notificationGroup(group), style: BLUE }]);
    }
    keyboard.push([
      {
        text: uz ? '⬅️ Sozlamalar' : '⬅️ Настройки',
        data: CB.settings,
        style: GREEN,
      },
    ]);
    await this.panel(chatId, T.notifyGroups(uz, lines), keyboard, edit);
  }

  /**
   * Поводы одной группы: что включено и зачем оно нужно. Выключенное видно
   * сразу — иначе человек не поймёт, почему бот молчит.
   */
  private async showNotificationGroup(
    chatId: bigint,
    userId: bigint,
    permissions: Set<string>,
    group: KindGroup,
    uz: boolean,
    edit?: Edit,
  ) {
    const mine = KINDS.filter((k) => k.group === group && permissions.has(k.permission));
    if (mine.length === 0) {
      await this.showNotifications(chatId, userId, permissions, uz, edit);
      return;
    }
    const chosen = await this.notifications.settings(userId);
    const lines = mine.map((k) => {
      const on = chosen.get(k.kind) ?? true;
      return `${on ? '✅' : '⬜'} ${uz ? k.uz : k.ru} — ${uz ? k.aboutUz : k.aboutRu}`;
    });
    const keyboard: InlineKeyboard = mine.map((k) => {
      const on = chosen.get(k.kind) ?? true;
      return [
        {
          text: `${on ? '✅' : '⬜'} ${uz ? k.uz : k.ru}`,
          data: CB.notificationToggle(k.kind),
          style: on ? GREEN : BLUE,
        },
      ];
    });
    keyboard.push([
      { text: uz ? '⬅️ Xabarnomalar' : '⬅️ Уведомления', data: CB.notifications, style: GREEN },
    ]);
    await this.panel(
      chatId,
      `${T.notifyGroupName(uz, group)}\n\n${T.notifications(uz, lines)}`,
      keyboard,
      edit,
    );
  }

  // --- уведомления ----------------------------------------------------------

  /**
   * Один проход: собрать события и отправить то, что ещё не отправлено.
   *
   * Живёт в том же цикле, что опрос Telegram, а не отдельным таймером: процесс
   * один, и два потока писали бы в одну очередь одновременно. Ошибка одного
   * сообщения не останавливает остальные.
   */
  async tick(): Promise<void> {
    try {
      await this.notifications.scan();
      const batch = await this.notifications.pending(30, PER_USER_PER_TICK);
      const sentTo = new Map<string, number>();
      for (const n of batch) {
        const key = String(n.userId);
        const already = sentTo.get(key) ?? 0;
        if (already >= PER_USER_PER_TICK) continue;
        sentTo.set(key, already + 1);
        const uz = n.locale === 'uz';
        try {
          await this.api.sendMessage(n.chatId, uz ? n.textUz : n.textRu, [
            [{ text: T.openPanel(uz), data: CB.menu, style: BLUE }],
          ]);
          await this.notifications.markSent(n.id);
        } catch (e) {
          const error = e as TelegramError;
          if (unreachable(error)) {
            // Не ошибка отправки, а состояние человека: бот ему написать не может.
            await this.notifications.markBlocked(n.userId);
            this.log.warn(`боту закрыли дверь: user ${n.userId} (${error.message})`);
          } else {
            await this.notifications.markFailed(n.id, error.message);
            this.log.error(`уведомление ${n.id}: ${error.message}`);
          }
        }
      }
    } catch (e) {
      this.log.error(`проход уведомлений: ${(e as Error).message}`);
    }
  }

  // --- разбор обновлений ----------------------------------------------------

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) await this.onMessage(update.message);
    else if (update.callback_query) await this.onCallback(update.callback_query);
  }

  private async onMessage(message: NonNullable<TelegramUpdate['message']>): Promise<void> {
    const chatId = BigInt(message.chat.id);
    const from = message.from?.id;
    if (!from || message.chat.type !== 'private') return;
    const tgId = BigInt(from);
    const session = await this.session(chatId, tgId);
    const text = (message.text ?? '').trim();
    const uz = session.locale === 'uz';

    const command = commandOf(text);
    if (command) {
      await this.onCommand(chatId, tgId, session, command, uz);
      return;
    }

    if (session.step === 'login') {
      // Логин — такой же след в переписке, как пароль: по нему видно, под кем
      // человек работает. Убираем оба.
      await this.forget(chatId, message.message_id);
      const login = text.slice(0, 64);
      await this.save(chatId, { pendingLogin: login, step: 'password' });
      await this.api.sendMessage(chatId, T.askPassword(uz, escape(login)));
      return;
    }

    if (session.step === 'password') {
      await this.forget(chatId, message.message_id);
      await this.tryLogin(chatId, tgId, session.pendingLogin ?? '', text, uz);
      return;
    }

    // Фото или файл. Чек фотографируют чаще, чем переписывают, и это
    // единственный способ приложить бумагу к записи из телефона.
    const sent = incomingOf(message);
    if (sent) {
      await this.onFile(chatId, session, sent, uz);
      return;
    }

    // Человек заполняет что-то по шагам — значит он отвечает на вопрос, который
    // бот задал последним, а не пишет в пустоту.
    if (session.flow && session.userId) {
      const me = await this.profile(session.userId);
      if (!me) {
        await this.api.sendMessage(chatId, T.gone(uz));
        return;
      }
      if (!me.canUseBot) {
        await this.api.sendMessage(chatId, T.notForBot(uz));
        return;
      }
      const section = this.sectionOf(session.flow.kind);
      if (!section) {
        // Разговор остался от прошлой выкладки, когда разделы метились иначе.
        await this.save(chatId, { flow: null });
        await this.api.sendMessage(chatId, T.hint(uz));
        return;
      }
      if (!me.permissions.has(section.permission)) {
        // Право сняли посреди разговора: ответ принимать нельзя, но и молчать
        // о причине тоже — иначе бот выглядит сломанным.
        await this.save(chatId, { flow: null });
        await this.api.sendMessage(chatId, T.lostRight(uz));
        return;
      }
      await this.render(chatId, await section.text(this.meFor(me), session.flow, text, uz));
      return;
    }

    // Любой другой текст панель не открывает. Иначе на каждое «спасибо» бот
    // снова здоровается, а открытый экран уезжает вверх переписки — клиент
    // попросил это убрать прямо: панель приходит по `/start`, и только.
    await this.api.sendMessage(chatId, T.hint(uz));
  }

  /**
   * Присланный файл отдаём разделу, который его ждёт.
   *
   * Ждёт — значит разговор идёт и в нём открыт шаг с фотографией. Файл «просто
   * в чат» не принимаем: приложить его было бы некуда, а молча проглотить —
   * значит обмануть человека, который считает, что чек уже в системе.
   */
  private async onFile(
    chatId: bigint,
    session: Session,
    sent: { fileId: string; fileName?: string; mimeType?: string },
    uz: boolean,
  ): Promise<void> {
    if (!session.flow || !session.userId) {
      await this.api.sendMessage(chatId, T.photoNowhere(uz));
      return;
    }
    const me = await this.profile(session.userId);
    if (!me) {
      await this.api.sendMessage(chatId, T.gone(uz));
      return;
    }
    if (!me.canUseBot) {
      await this.api.sendMessage(chatId, T.notForBot(uz));
      return;
    }
    const section = this.sectionOf(session.flow.kind);
    if (!section?.photo) {
      await this.api.sendMessage(chatId, T.photoNowhere(uz));
      return;
    }
    if (!me.permissions.has(section.permission)) {
      await this.save(chatId, { flow: null });
      await this.api.sendMessage(chatId, T.lostRight(uz));
      return;
    }

    let file: Incoming;
    try {
      const info = await this.api.getFile(sent.fileId);
      const path = info.file_path ?? '';
      const bytes = Buffer.from(await this.api.downloadFile(path));
      const ext = (path.split('.').pop() ?? 'jpg').toLowerCase();
      file = {
        fileName: sent.fileName ?? `telegram-${Date.now()}.${ext}`,
        mimeType: sent.mimeType ?? MIME_BY_EXT[ext] ?? 'image/jpeg',
        bytes,
      };
    } catch (e) {
      this.log.warn(`файл из Telegram: ${(e as Error).message}`);
      await this.api.sendMessage(chatId, T.photoFailed(uz));
      return;
    }

    await this.render(chatId, await section.photo(this.meFor(me), session.flow, file, uz));
  }

  /**
   * Команды. Управление — только `/admin`, и право на него проверяется здесь
   * же, на каждом вызове: роль могли снять после прошлого раза.
   */
  private async onCommand(
    chatId: bigint,
    tgId: bigint,
    session: Session,
    command: string,
    uz: boolean,
  ): Promise<void> {
    const linked = session.userId ?? (await this.linkedUserId(tgId));

    if (command === '/start' || command === '/menu') {
      if (linked) {
        // Написал сам — значит, дверь снова открыта: очередь может ему писать.
        await this.notifications.markReachable(linked);
        await this.save(chatId, {
          userId: linked,
          step: 'ready',
          pendingLogin: null,
        });
        await this.showMenu(chatId, linked, uz);
      } else {
        await this.save(chatId, {
          step: 'language',
          userId: null,
          pendingLogin: null,
        });
        await this.showLanguage(chatId, uz);
      }
      return;
    }

    const me = linked ? await this.profile(linked) : null;
    if (me && !me.canUseBot) {
      await this.api.sendMessage(chatId, T.notForBot(uz));
      return;
    }

    if (command === '/help') {
      // Вошедшему человеку /help отдаёт не список команд, а пути к его делам:
      // за подсказкой приходят с вопросом «как мне записать приход», а не «какие
      // есть команды». Невошедшему путей не из чего собрать — ему список.
      if (me) await this.showHowTo(chatId, me.permissions, uz);
      else await this.api.sendMessage(chatId, T.help(uz, false));
      return;
    }

    if (command === '/settings') {
      if (!me) {
        await this.api.sendMessage(chatId, T.hint(uz));
        return;
      }
      await this.showSettings(chatId, uz);
      return;
    }

    if (command === '/quit' || command === '/exit') {
      if (!me) {
        await this.api.sendMessage(chatId, T.hint(uz));
        return;
      }
      await this.logout(chatId, uz);
      return;
    }

    if (!me || !me.permissions.has('admin.users')) {
      await this.api.sendMessage(chatId, T.notAdmin(uz));
      return;
    }
    await this.showAdmin(chatId, uz);
  }

  /** Удалить сообщение человека. Не вышло — не повод ронять разговор. */
  private async forget(chatId: bigint, messageId: number): Promise<void> {
    try {
      await this.api.deleteMessage(chatId, messageId);
    } catch (e) {
      this.log.warn(`не удалось удалить сообщение входа: ${(e as Error).message}`);
    }
  }

  private async tryLogin(
    chatId: bigint,
    tgId: bigint,
    login: string,
    password: string,
    uz: boolean,
  ): Promise<void> {
    let userId: bigint;
    try {
      // Пароль дальше этой строки не идёт. Счётчик ошибок, блокировка и журнал
      // входов — те же, что в вебе: это один и тот же вход, а не второй.
      const result = await this.auth.login(login, password, `telegram:${tgId}`, { withoutSession: true });
      userId = result.user.id;
    } catch (e) {
      // Блокировку узнаём по коду отказа: текст ответа переводится, и
      // проверка по слову «заблокирован» на узбекском молчит (ТЗ 13.4).
      const body = e instanceof HttpException ? e.getResponse() : null;
      const locked =
        typeof body === 'object' && body !== null &&
        (body as { code?: string }).code === ERR.accountLocked;
      await this.save(chatId, { step: 'login', pendingLogin: null });
      await this.api.sendMessage(chatId, locked ? T.locked(uz) : T.badCredentials(uz));
      return;
    }

    // Отказ до привязки: иначе в системе осталась бы запись, что человек
    // подключён к боту, которым ему пользоваться незачем.
    if (!botAllowed(await this.roleCodes(userId))) {
      await this.save(chatId, { step: 'login', pendingLogin: null });
      await this.api.sendMessage(chatId, T.notForBot(uz));
      return;
    }

    const access = await this.auth.loadProfile(userId);
    try {
      await this.links.linkByLogin(userId, tgId, access.companyIds[0]);
    } catch (e) {
      this.log.warn(`привязка не удалась: ${(e as Error).message}`);
      await this.save(chatId, { step: 'login', pendingLogin: null });
      await this.api.sendMessage(chatId, T.takenAccount(uz));
      return;
    }

    // Язык, выбранный до входа, становится языком человека: иначе бот говорит
    // по-узбекски, а веб по-русски.
    await this.prisma.withContext(
      null,
      [],
      (tx) =>
        tx.$executeRaw`UPDATE user_account SET locale = ${uz ? 'uz' : 'ru'} WHERE id = ${userId}`,
    );
    await this.notifications.markReachable(userId);
    await this.save(chatId, { userId, step: 'ready', pendingLogin: null });
    await this.showMenu(chatId, userId, uz);
  }

  private adminKeyboard(uz: boolean): InlineKeyboard {
    return [
      [
        {
          text: uz ? '🔗 Kim ulangan' : '🔗 Кто подключён',
          data: CB.adminLinked,
          style: BLUE,
        },
      ],
      [
        {
          text: uz ? '👓 Rol ko‘zi bilan' : '👓 Смотреть как роль',
          data: CB.adminRoles,
          style: BLUE,
        },
      ],
      backRow(uz),
    ];
  }

  private async onCallback(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const message = query.message;
    if (!message) {
      await this.api.answerCallback(query.id);
      return;
    }
    const chatId = BigInt(message.chat.id);
    const tgId = BigInt(query.from.id);
    const session = await this.session(chatId, tgId);
    const data = query.data ?? '';
    let uz = session.locale === 'uz';
    const edit: Edit = {
      messageId: message.message_id,
      hasPhoto: (message.photo?.length ?? 0) > 0,
    };

    // Язык выбирают до входа — единственное действие, которому учётка не нужна.
    if (data.startsWith('l:')) {
      uz = data === 'l:uz';
      await this.save(chatId, { locale: uz ? 'uz' : 'ru', step: 'login' });
      await this.api.answerCallback(query.id);
      // Вход начинается на том же экране: шапка остаётся, меняется подпись.
      await this.panel(chatId, T.askLogin(uz), undefined, edit);
      return;
    }

    const userId = session.userId ?? (await this.linkedUserId(tgId));
    const me = userId ? await this.profile(userId) : null;
    if (!me || !userId) {
      await this.api.answerCallback(query.id, T.gone(uz));
      await this.showLanguage(chatId, uz, edit);
      return;
    }

    if (!me.canUseBot) {
      await this.api.answerCallback(query.id, T.notForBot(uz));
      return;
    }

    if (data === CB.menu) {
      await this.api.answerCallback(query.id);
      await this.showMenu(chatId, userId, uz, edit);
      return;
    }

    if (data === CB.settings) {
      await this.api.answerCallback(query.id);
      await this.showSettings(chatId, uz, edit);
      return;
    }

    if (data === CB.settingsLang) {
      const next = !uz;
      await this.save(chatId, { locale: next ? 'uz' : 'ru' });
      await this.prisma.withContext(
        null,
        [],
        (tx) =>
          tx.$executeRaw`UPDATE user_account SET locale = ${next ? 'uz' : 'ru'} WHERE id = ${userId}`,
      );
      await this.api.answerCallback(query.id, T.langChanged(next));
      await this.showSettings(chatId, next, edit);
      return;
    }

    if (data === CB.notifications) {
      await this.api.answerCallback(query.id);
      await this.showNotifications(chatId, userId, me.permissions, uz, edit);
      return;
    }

    if (data.startsWith('n:g:')) {
      const group = data.slice(4) as KindGroup;
      await this.api.answerCallback(query.id);
      await this.showNotificationGroup(chatId, userId, me.permissions, group, uz, edit);
      return;
    }

    if (data.startsWith('n:')) {
      const kind = KINDS.find((k) => k.kind === data.slice(2));
      // Право проверяем и здесь: кнопка могла остаться от прежней роли.
      if (!kind || !me.permissions.has(kind.permission)) {
        await this.api.answerCallback(query.id, T.lostRight(uz));
        return;
      }
      const on = await this.notifications.toggle(userId, kind.kind);
      const name = uz ? kind.uz : kind.ru;
      await this.api.answerCallback(query.id, on ? T.notifyOn(uz, name) : T.notifyOff(uz, name));
      // Возвращаем в ту же группу, а не в указатель: человек пришёл включить
      // несколько поводов подряд, и выкидывать его на шаг назад после каждого
      // нажатия значит заставить его искать место заново.
      await this.showNotificationGroup(chatId, userId, me.permissions, kind.group, uz, edit);
      return;
    }

    if (data === CB.howTo) {
      await this.api.answerCallback(query.id);
      await this.showHowTo(chatId, me.permissions, uz, edit);
      return;
    }

    if (data.startsWith(CB.howToOne(''))) {
      await this.api.answerCallback(query.id);
      await this.showHowToOne(chatId, me.permissions, data.slice(CB.howToOne('').length), uz, edit);
      return;
    }

    if (data === CB.whoAmI) {
      const roles = await this.rolesOf(userId, uz);
      const companies = me.companies.map((c) => (uz ? c.nameUz : c.nameRu)).join(', ');
      await this.api.answerCallback(query.id);
      await this.panel(
        chatId,
        T.whoAmI(uz, me.user.fullName, me.user.login, roles.join(', ') || '—', companies || '—'),
        [backRow(uz)],
        edit,
      );
      return;
    }

    if (data === CB.logout) {
      await this.api.answerCallback(query.id);
      await this.logout(chatId, uz, edit);
      return;
    }

    const touched = this.sectionFor(data);
    if (touched) {
      // Право на раздел проверяем на каждом нажатии: кнопка на экране живёт
      // дольше, чем роль, которая её выдала.
      if (!me.permissions.has(touched.permission)) {
        await this.api.answerCallback(query.id, T.lostRight(uz));
        await this.showMenu(chatId, userId, uz, edit);
        return;
      }
      const screen = await touched.route(this.meFor(me), session.flow, data, uz);
      await this.api.answerCallback(query.id, screen.toast);
      await this.render(chatId, screen, edit);
      return;
    }

    // Курс валют открыт всем вошедшим: это открытая цифра ЦБ РУз, а не данные
    // компании. Правом закрыта только кнопка «Обновить» — её проверяет сам
    // экран, потому что она пишет в справочник.
    if (data === CB.rates || data.startsWith('r:')) {
      const screen = await this.rates.route(this.meFor(me), data, uz);
      await this.api.answerCallback(query.id, screen.toast);
      await this.render(chatId, screen, edit);
      return;
    }

    if (data.startsWith('m:')) {
      const section = SECTIONS.find((s) => s.key === data.slice(2));
      if (!section) {
        await this.api.answerCallback(query.id, T.gone(uz));
        return;
      }
      // Та самая проверка на нажатии: кнопка осталась на экране, право — нет.
      if (!me.permissions.has(section.permission)) {
        await this.api.answerCallback(query.id, T.lostRight(uz));
        await this.showMenu(chatId, userId, uz, edit);
        return;
      }
      const live = this.sections[section.key];
      if (live) {
        // Живой раздел открывает свои экраны, а не рассказ о планах.
        await this.api.answerCallback(query.id);
        const screen = await live.route(this.meFor(me), session.flow, live.open, uz);
        await this.render(chatId, screen, edit);
        return;
      }
      await this.api.answerCallback(query.id);
      await this.panel(
        chatId,
        T.sectionSoon(
          uz,
          `${section.emoji} ${uz ? section.uz : section.ru}`,
          uz ? section.soonUz : section.soonRu,
        ),
        [backRow(uz)],
        edit,
      );
      return;
    }

    if (data.startsWith('a')) {
      if (!me.permissions.has('admin.users')) {
        await this.api.answerCallback(query.id, T.notAdmin(uz));
        return;
      }
      await this.onAdminCallback(query.id, chatId, edit, data, uz);
      return;
    }

    await this.api.answerCallback(query.id, T.gone(uz));
  }

  private async onAdminCallback(
    queryId: string,
    chatId: bigint,
    edit: Edit,
    data: string,
    uz: boolean,
  ): Promise<void> {
    if (data === CB.admin) {
      await this.api.answerCallback(queryId);
      await this.showAdmin(chatId, uz, edit);
      return;
    }

    if (data === CB.adminLinked) {
      const rows = await this.prisma.withContext(
        null,
        [],
        (tx) =>
          tx.$queryRaw<{ full_name: string; login: string; tg: bigint | null }[]>`
          SELECT full_name, login, telegram_user_id AS tg
            FROM user_account WHERE is_active ORDER BY login`,
      );
      const lines = rows.map((r) => `${r.tg === null ? '○' : '●'} ${r.full_name} (${r.login})`);
      await this.api.answerCallback(queryId);
      await this.panel(
        chatId,
        T.adminLinked(uz, lines),
        [
          [
            {
              text: uz ? '⬅️ Boshqaruv' : '⬅️ Админ',
              data: CB.admin,
              style: BLUE,
            },
          ],
          backRow(uz),
        ],
        edit,
      );
      return;
    }

    if (data === CB.adminRoles) {
      const roles = await this.prisma.withContext(
        null,
        [],
        (tx) =>
          tx.$queryRaw<{ code: string; name_ru: string; name_uz: string }[]>`
          SELECT code, name_ru, name_uz FROM role ORDER BY name_ru`,
      );
      await this.api.answerCallback(queryId);
      await this.panel(
        chatId,
        T.adminRoles(uz),
        [
          ...roles.map((r) => [
            {
              text: uz ? r.name_uz : r.name_ru,
              data: CB.adminAsRole(r.code),
              style: BLUE,
            },
          ]),
          [
            {
              text: uz ? '⬅️ Boshqaruv' : '⬅️ Админ',
              data: CB.admin,
              style: BLUE,
            },
          ],
        ],
        edit,
      );
      return;
    }

    if (data.startsWith('a:r:')) {
      const code = data.slice(4);
      const rows = await this.prisma.withContext(
        null,
        [],
        (tx) =>
          tx.$queryRaw<{ name_ru: string; name_uz: string; code: string }[]>`
          SELECT r.name_ru, r.name_uz, p.code
            FROM role r
            LEFT JOIN role_permission rp ON rp.role_id = r.id
            LEFT JOIN permission p ON p.id = rp.permission_id
           WHERE r.code = ${code}`,
      );
      if (rows.length === 0) {
        await this.api.answerCallback(queryId, T.gone(uz));
        return;
      }
      const name = uz ? rows[0]!.name_uz : rows[0]!.name_ru;
      const permissions = rows.map((r) => r.code).filter(Boolean);
      // Это показ, а не подмена человека: кнопки роли выводятся как картинка
      // меню, нажать их нельзя. Подмена ломала бы журнал как доказательство.
      const shown = allowedSections(permissions)
        .map((s) => `${s.emoji} ${uz ? s.uz : s.ru}`)
        .join('\n');
      await this.api.answerCallback(queryId);
      await this.panel(
        chatId,
        `${T.adminAsRole(uz, name)}\n\n${shown || '—'}`,
        [
          [
            {
              text: uz ? '⬅️ Rollar' : '⬅️ Роли',
              data: CB.adminRoles,
              style: BLUE,
            },
          ],
          backRow(uz),
        ],
        edit,
      );
      return;
    }

    await this.api.answerCallback(queryId, T.gone(uz));
  }

  private async rolesOf(userId: bigint, uz: boolean): Promise<string[]> {
    const rows = await this.prisma.withContext(
      userId,
      [],
      (tx) =>
        tx.$queryRaw<{ name_ru: string; name_uz: string }[]>`
        SELECT DISTINCT r.name_ru, r.name_uz
          FROM user_role_assignment a JOIN role r ON r.id = a.role_id
         WHERE a.user_id = ${userId}`,
    );
    return rows.map((r) => (uz ? r.name_uz : r.name_ru));
  }

  // --- опрос Telegram -------------------------------------------------------

  async start(): Promise<void> {
    const me = await this.api.getMe();
    this.log.log(`бот @${me.username} на связи`);
    // Список в меню Telegram: без `/admin` — управление не предлагаем всем.
    try {
      await this.api.setMyCommands([
        { command: 'start', description: 'Панель / Panel' },
        { command: 'settings', description: 'Настройки / Sozlamalar' },
        { command: 'quit', description: 'Выйти / Chiqish' },
        { command: 'help', description: 'Подсказка / Yordam' },
      ]);
    } catch (e) {
      this.log.warn(`список команд не обновлён: ${(e as Error).message}`);
    }
    this.running = true;
    while (this.running) {
      try {
        if (Date.now() - this.lastTick > TICK_MS) {
          this.lastTick = Date.now();
          await this.tick();
        }
        const updates = await this.api.getUpdates(this.offset, 25);
        for (const update of updates) {
          this.offset = update.update_id + 1;
          try {
            await this.handleUpdate(update);
          } catch (e) {
            // Разговор одного человека не должен ронять бота у остальных.
            this.log.error(`обновление ${update.update_id}: ${(e as Error).message}`);
          }
        }
      } catch (e) {
        this.log.error(`опрос: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}

/**
 * Команда — только из нашего короткого списка. Пароль, начатый со «/», этим
 * списком не перекрывается и остаётся паролем.
 */
function commandOf(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const first = text.split(/[\s@]/)[0]!.toLowerCase();
  return (COMMANDS as readonly string[]).includes(first) ? first : null;
}

/**
 * Отказ Telegram, который значит «этому человеку бот писать не может»: он
 * заблокировал бота, удалил аккаунт или никогда не нажимал «Старт». Повторять
 * такое бессмысленно — повтор не вернёт доступ.
 */
function unreachable(error: TelegramError): boolean {
  if (error.code === 403) return true;
  return /blocked|chat not found|user is deactivated|can't initiate conversation/i.test(
    error.message,
  );
}

/** Логин показываем обратно человеку: в нём может оказаться знак разметки. */
function escape(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Тип файла по расширению: Telegram в `getFile` его не присылает. */
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  pdf: 'application/pdf',
};

/**
 * Что человек прислал: сжатое фото или файл.
 *
 * У фотографии берём самый крупный размер — мелкие Telegram кладёт для
 * предпросмотра, и чек на них не читается. Имени у фотографии нет, его
 * придумает каркас по расширению пути.
 */
function incomingOf(
  message: NonNullable<TelegramUpdate['message']>,
): { fileId: string; fileName?: string; mimeType?: string } | null {
  const sizes = message.photo ?? [];
  const biggest = sizes[sizes.length - 1];
  if (biggest) return { fileId: biggest.file_id };
  if (message.document) {
    return {
      fileId: message.document.file_id,
      fileName: message.document.file_name,
      mimeType: message.document.mime_type,
    };
  }
  return null;
}
