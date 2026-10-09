import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { writeAudit } from '../common/audit.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Привязка учётной записи Telegram к человеку (ТЗ 11.2, общие правила 6.7).
 *
 * Бот у нас один на все роли, и после привязки он показывает человеку ровно его
 * кнопки. Но сначала бот должен знать, кто ему пишет: столбец
 * `user_account.telegram_user_id` был с первого дня, а заполнить его было нечем.
 *
 * Как это устроено и почему именно так.
 *
 * **Код одноразовый и живёт минуты.** У бота нет пароля: привязка — это доверие
 * к аккаунту Telegram. Значит окно, в котором код чего-то стоит, должно быть
 * узким, а сам код — не угадываемым (восемь знаков из однозначного алфавита,
 * `randomInt` из `node:crypto`, а не `Math.random`).
 *
 * **В базе код лежит хешем.** Увидеть его можно один раз — в ответе на выдачу.
 * Даже владелец базы не может прочитать выданный код и подключиться вместо
 * человека.
 *
 * **Выдача нового кода отзывает прежние.** Иначе у человека на руках
 * оказывается несколько живых кодов, и «код виден один раз» перестаёт что-либо
 * значить.
 *
 * **Привязка одна на человека и одна на аккаунт Telegram.** Второе держит
 * уникальный индекс в базе: один аккаунт Telegram не может работать за двоих, и
 * «кто это сделал» в журнале должно отвечать на вопрос однозначно.
 */
@Injectable()
export class TelegramLinkService {
  /** Срок жизни кода. Минуты, а не часы: см. комментарий к классу. */
  static readonly TTL_MINUTES = 15;
  /**
   * Алфавит без похожих знаков: ноль и «О», единица и «I» человек диктует и
   * набирает с ошибкой, а код вводится руками в чужом приложении.
   */
  private static readonly ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';

  constructor(private readonly prisma: PrismaService) {}

  /** Те же области видимости, что у остального админа: люди компании не принадлежат. */
  private withAdminScope<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const ctx = currentContext();
    const ids = ctx?.allCompanyIds?.length ? ctx.allCompanyIds : (ctx?.companyIds ?? []);
    return this.prisma.withContext(ctx?.userId ?? null, ids, fn);
  }

  private auditCompany(): bigint {
    const ctx = currentContext();
    const ids = ctx?.companyIds?.length ? ctx.companyIds : (ctx?.allCompanyIds ?? []);
    if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
    return ids[0]!;
  }

  /** Хеш кода. Сравнение идёт по хешу, в базе открытого кода нет. */
  static hash(code: string): string {
    return createHash('sha256').update(TelegramLinkService.normalize(code)).digest('hex');
  }

  /** Человек диктует код как угодно: пробелы, дефисы и регистр значения не имеют. */
  static normalize(code: string): string {
    return String(code ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  private static generate(): string {
    const a = TelegramLinkService.ALPHABET;
    let out = '';
    for (let i = 0; i < 8; i++) out += a[randomInt(a.length)];
    // Показываем парами по четыре: так его и диктуют.
    return `${out.slice(0, 4)}-${out.slice(4)}`;
  }

  private async userByUid(tx: Tx, uid: string) {
    const rows = await tx.$queryRaw<
      { id: bigint; login: string; full_name: string; is_active: boolean; tg: bigint | null }[]
    >`
      SELECT id, login, full_name, is_active, telegram_user_id AS tg
        FROM user_account WHERE uid = ${uid}::uuid`;
    if (!rows[0]) throw new NotFoundException(MSG.personNotFound());
    return rows[0];
  }

  /**
   * Выдать код. Возвращает его открытым текстом — единственный раз за всю жизнь
   * кода, и ровно поэтому маршрут отвечает им, а не кладёт в журнал.
   */
  async issueCode(userUid: string) {
    return this.withAdminScope(async (tx) => {
      const user = await this.userByUid(tx, userUid);
      if (!user.is_active) {
        throw new UnprocessableEntityException(say('Учётка отключена: сначала включите человека, потом подключайте Telegram', 'Hisob o‘chirilgan: avval xodimni yoqing, keyin Telegram ulang'));
      }
      if (user.tg !== null) {
        throw new ConflictException(say('Telegram уже подключён: сначала отключите прежний аккаунт, потом выдавайте код', 'Telegram allaqachon ulangan: avval oldingi akkauntni uzing, keyin kod bering'));
      }

      // Прежние неиспользованные коды гасим: живым должен быть один.
      await tx.$executeRaw`
        UPDATE telegram_link_code SET revoked_at = now()
         WHERE user_id = ${user.id} AND used_at IS NULL AND revoked_at IS NULL`;

      const code = TelegramLinkService.generate();
      const expiresAt = new Date(Date.now() + TelegramLinkService.TTL_MINUTES * 60_000);
      await tx.$executeRaw`
        INSERT INTO telegram_link_code (user_id, code_hash, expires_at, created_by)
        VALUES (${user.id}, ${TelegramLinkService.hash(code)}, ${expiresAt},
                ${currentContext()?.userId ?? null})`;

      await writeAudit(tx, {
        companyId: this.auditCompany(),
        entityType: 'user_telegram',
        entityId: userUid,
        action: 'code_issued',
        // Самого кода в журнале нет: это секрет, а не след действия.
        changes: {
          login: { from: null, to: user.login },
          expiresAt: { from: null, to: expiresAt.toISOString() },
        },
      });

      return {
        code,
        expiresAt: expiresAt.toISOString(),
        ttlMinutes: TelegramLinkService.TTL_MINUTES,
        login: user.login,
      };
    });
  }

  /** Отключить привязку. Доступно администратору всегда: телефон теряют. */
  async unlink(userUid: string) {
    return this.withAdminScope(async (tx) => {
      const user = await this.userByUid(tx, userUid);
      if (user.tg === null) {
        throw new UnprocessableEntityException(say('Telegram у этого человека не подключён', 'Bu xodimda Telegram ulanmagan'));
      }
      await tx.$executeRaw`
        UPDATE user_account SET telegram_user_id = NULL, telegram_linked_at = NULL
         WHERE id = ${user.id}`;
      await tx.$executeRaw`
        UPDATE telegram_link_code SET revoked_at = now()
         WHERE user_id = ${user.id} AND used_at IS NULL AND revoked_at IS NULL`;

      await writeAudit(tx, {
        companyId: this.auditCompany(),
        entityType: 'user_telegram',
        entityId: userUid,
        action: 'unlink',
        changes: { telegramUserId: { from: String(user.tg), to: null } },
      });
      return { uid: userUid, linked: false };
    });
  }

  /**
   * Привязка после входа логином и паролем — путь, который выбрал заказчик
   * (решение 02.10): его люди в веб не заходят, и взять код им негде.
   *
   * Пароль сюда не попадает: его проверил `AuthService.login`, со всеми теми же
   * последствиями, что в вебе, — журнал входов, счётчик ошибок, блокировка.
   * Здесь только сама привязка.
   *
   * Если у человека уже привязан другой аккаунт Telegram, привязка
   * **переносится**: он доказал, что знает пароль, а телефон меняют чаще, чем
   * зовут администратора. Перенос виден в журнале парой «было — стало».
   * А вот занятый чужим человеком аккаунт Telegram не отдаём — это тот случай,
   * когда двое работали бы под одной перепиской.
   */
  async linkByLogin(userId: bigint, telegramUserId: bigint, companyIdForAudit?: bigint) {
    const scope = companyIdForAudit === undefined ? [] : [companyIdForAudit];
    return this.prisma.withContext(null, scope, async (tx) => {
      const rows = await tx.$queryRaw<{ uid: string; tg: bigint | null }[]>`
        SELECT uid, telegram_user_id AS tg FROM user_account WHERE id = ${userId}`;
      const row = rows[0];
      if (!row) throw new NotFoundException(MSG.personNotFound());

      const taken = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM user_account
         WHERE telegram_user_id = ${telegramUserId} AND id <> ${userId}`;
      if (taken[0]) {
        throw new ConflictException(say('Этот аккаунт Telegram уже привязан к другому человеку: сначала отключите прежнюю привязку', 'Bu Telegram akkaunti boshqa xodimga bog‘langan: avval oldingi bog‘lanishni uzing'));
      }

      if (row.tg !== null && BigInt(row.tg) === telegramUserId) return { uid: row.uid, moved: false };

      await tx.$executeRaw`
        UPDATE user_account
           SET telegram_user_id = ${telegramUserId}, telegram_linked_at = now()
         WHERE id = ${userId}`;
      // Выданные коды гасим: человек вошёл другим путём, старый код живым
      // оставлять незачем.
      await tx.$executeRaw`
        UPDATE telegram_link_code SET revoked_at = now()
         WHERE user_id = ${userId} AND used_at IS NULL AND revoked_at IS NULL`;

      if (companyIdForAudit !== undefined) {
        await writeAudit(tx, {
          companyId: companyIdForAudit,
          entityType: 'user_telegram',
          entityId: row.uid,
          action: 'link',
          changes: {
            telegramUserId: {
              from: row.tg === null ? null : String(row.tg),
              to: String(telegramUserId),
            },
          },
          source: 'bot',
          userId,
        });
      }
      return { uid: row.uid, moved: row.tg !== null };
    });
  }

  /**
   * Принять код от бота: `/start <код>`.
   *
   * Маршрута у этого нет и не будет: код сюда приносит процесс бота, который
   * знает `telegram_user_id` от самого Telegram. Открытый маршрут означал бы,
   * что подключиться может любой, кто угадал код, — а код у нас короткий
   * ровно потому, что его диктуют голосом.
   *
   * Контекста запроса здесь нет — бот не сессия человека, — поэтому область
   * задаём сами. Компания нужна не для `user_account` (он компании не
   * принадлежит), а для записи в журнал: `audit_log` закрыт политикой по
   * компании, и без неё запись отклоняется политикой, а не падает молча.
   */
  async claim(code: string, telegramUserId: bigint, companyIdForAudit?: bigint) {
    const hash = TelegramLinkService.hash(code);
    if (TelegramLinkService.normalize(code).length !== 8) {
      throw new UnprocessableEntityException(say('Код состоит из восьми знаков', 'Kod sakkiz belgidan iborat'));
    }
    const scope = companyIdForAudit === undefined ? [] : [companyIdForAudit];
    return this.prisma.withContext(null, scope, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: bigint;
          user_id: bigint;
          user_uid: string;
          login: string;
          is_active: boolean;
          expires_at: Date;
          used_at: Date | null;
          revoked_at: Date | null;
          tg: bigint | null;
        }[]
      >`
        SELECT c.id, c.user_id, u.uid AS user_uid, u.login, u.is_active,
               c.expires_at, c.used_at, c.revoked_at, u.telegram_user_id AS tg
          FROM telegram_link_code c
          JOIN user_account u ON u.id = c.user_id
         WHERE c.code_hash = ${hash}`;
      const row = rows[0];
      // Все отказы говорят одно и то же: по сообщению нельзя понять, существует
      // ли код. Иначе перебор получает подсказку.
      const no = () => new UnprocessableEntityException(say('Код не найден или уже не действует', 'Kod topilmadi yoki amal qilmaydi'));
      if (!row) throw no();
      if (row.used_at !== null || row.revoked_at !== null) throw no();
      if (row.expires_at.getTime() <= Date.now()) throw no();
      if (!row.is_active) throw no();
      if (row.tg !== null) throw no();

      const taken = await tx.$queryRaw<{ login: string }[]>`
        SELECT login FROM user_account WHERE telegram_user_id = ${telegramUserId}`;
      if (taken[0]) {
        throw new ConflictException(say('Этот аккаунт Telegram уже привязан к другому человеку: сначала отключите прежнюю привязку', 'Bu Telegram akkaunti boshqa xodimga bog‘langan: avval oldingi bog‘lanishni uzing'));
      }

      await tx.$executeRaw`
        UPDATE user_account
           SET telegram_user_id = ${telegramUserId}, telegram_linked_at = now()
         WHERE id = ${row.user_id}`;
      await tx.$executeRaw`
        UPDATE telegram_link_code SET used_at = now() WHERE id = ${row.id}`;

      if (companyIdForAudit !== undefined) {
        await writeAudit(tx, {
          companyId: companyIdForAudit,
          entityType: 'user_telegram',
          entityId: row.user_uid,
          action: 'link',
          changes: { telegramUserId: { from: null, to: String(telegramUserId) } },
          source: 'bot',
          userId: row.user_id,
        });
      }

      return { uid: row.user_uid, login: row.login, linked: true };
    });
  }
}
