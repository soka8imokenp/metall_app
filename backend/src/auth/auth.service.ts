import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomInt } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service.js';
import { ACCESS_TTL, SessionsService, type Client } from './sessions.service.js';
import { DevicesService, type DeviceInfo } from './devices.service.js';
import { say } from '../common/say.js';
import { ERR } from '../common/error-codes.js';

export interface AccessProfile {
  userId: bigint;
  companyIds: bigint[];
  permissions: Set<string>;
  /** Пароль выдан не самим человеком: дальше смены пароля не пускаем. */
  mustChangePassword: boolean;
}

/** Через столько неудачных попыток вход блокируется. */
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

/** Столько кругов bcrypt — столько же, сколько в `admin/users.service.ts`. */
const ROUNDS = 10;

/**
 * Нижняя граница длины пароля, который человек ставит себе сам.
 *
 * Вход длину не проверяет и проверять не должен (`da9a9c8`): там это отбивало
 * учётку с коротким паролем, не дойдя до сверки хеша. Длину задаёт тот
 * маршрут, который пароль устанавливает, — вот этот.
 */
export const MIN_PASSWORD = 8;

/**
 * Дефолтный пароль нужен здесь по одной причине: такой пароль нельзя поставить
 * себе «новым». Иначе обязательная смена превращается в нажатие кнопки —
 * человек вводит то же самое, признак снимается, и пароль по всем девяти
 * учёткам остаётся общеизвестным.
 *
 * Само правило живёт отдельным файлом: его знают ещё сид и скрипт учёток
 * стенда, а когда оно было в каждом своей строкой — разъехалось.
 */
import { defaultPasswordFor } from '../common/default-password.js';

export { defaultPasswordFor };

/** Временный пароль при сбросе: читается голосом и набирается с клавиатуры. */
function makeTempPassword(): string {
  // Без похожих знаков: 0/O, 1/l/I. Пароль называют по телефону, и «ноль или
  // буква о» — это второй звонок.
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 12; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/**
 * Вход и профиль доступа.
 *
 * Всё здесь ходит обычной ролью приложения, без обхода RLS. Читать без
 * контекста компаний получается потому, что учётные записи, журнал входов и
 * справочник прав — не данные арендатора и политик не несут, а назначения
 * ролей открыты отдельной политикой по `app.user_id`. Подробности — в
 * `prisma.service.ts` и в миграции `auth_without_bypassrls`.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly sessions: SessionsService,
    private readonly devices: DevicesService,
  ) {}

  /**
   * Заявка на сброс пароля.
   *
   * Пароль здесь не меняется и не рассылается: тракта рассылки в системе нет,
   * а выдать новый по одному знанию логина — отдать учётку тому, кто логин
   * угадал. Заявка кладётся в очередь администратору, он узнаёт человека и
   * выдаёт пароль тем способом, которым у них принято.
   *
   * Ответ одинаков и на существующий логин, и на выдуманный: иначе форма
   * «забыли пароль» становится справочником действующих учётных записей —
   * ровно то, от чего бережётся сам вход.
   */
  async requestPasswordReset(login: string, contact: string, note?: string) {
    const clean = login.trim();
    const user = await this.prisma.withContext(null, [], (tx) =>
      tx.userAccount.findUnique({ where: { login: clean } }),
    );

    // Повторное нажатие обновляет свою же открытую заявку, а не плодит
    // новые: частичный уникальный индекс держит одну открытую на логин.
    await this.prisma.withContext(null, [], (tx) =>
      tx.$executeRaw`
        INSERT INTO "password_reset_request" ("login", "contact", "note", "user_id")
        VALUES (${clean}, ${contact.trim()}, ${note?.trim() || null}, ${user?.id ?? null})
        ON CONFLICT ("login") WHERE "status" = 'new'
        DO UPDATE SET "contact" = EXCLUDED."contact",
                      "note" = EXCLUDED."note",
                      "user_id" = EXCLUDED."user_id",
                      "created_at" = now()
      `,
    );
  }

  async passwordResetRequests(status: string) {
    const rows = await this.prisma.withContext(null, [], (tx) =>
      tx.passwordResetRequest.findMany({
        where: status === 'all' ? {} : { status },
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: {
          user: { select: { fullName: true, isActive: true } },
          handler: { select: { fullName: true } },
        },
      }),
    );

    return rows.map((r) => ({
      uid: r.uid,
      login: r.login,
      contact: r.contact,
      note: r.note,
      status: r.status,
      createdAt: r.createdAt,
      // Есть ли такая учётка — видно только тому, кто заявки разбирает.
      // Наружу этот признак не уходит.
      known: r.userId !== null,
      fullName: r.user?.fullName ?? null,
      active: r.user?.isActive ?? null,
      handledBy: r.handler?.fullName ?? null,
      handledAt: r.handledAt,
      handledNote: r.handledNote,
    }));
  }

  /**
   * Разбор заявки руководителем.
   *
   * `done` — это не «отметка о том, что пароль как-то передали»: здесь и
   * выдаётся новый пароль. Он временный, возвращается **один раз** в ответе на
   * это действие и больше нигде не хранится и не показывается — ни в списке
   * заявок, ни в журнале. Передать его человеку — дело того, кто сбросил: он
   * узнаёт человека, он и отвечает за канал.
   *
   * Заодно снимается блокировка и обнуляется счётчик неудачных входов: человек
   * как раз и упёрся в неё, перебирая забытый пароль, и выдать ему новый,
   * оставив учётку запертой на четверть часа, значит не решить его задачу.
   *
   * `rejected` пароля не выдаёт: человека не узнали, и заявка закрывается
   * ничем. Признак «пароль временный» при этом не трогается.
   */
  async handlePasswordReset(
    uid: string,
    action: 'done' | 'rejected',
    userId: bigint,
    note?: string,
  ): Promise<{ password: string | null }> {
    const row = await this.prisma.withContext(null, [], (tx) =>
      tx.passwordResetRequest.findUnique({ where: { uid } }),
    );
    if (!row) throw new NotFoundException(say('Заявка не найдена', 'Ariza topilmadi'));
    if (row.status !== 'new') {
      throw new ConflictException(say('Заявку уже закрыли', 'Ariza allaqachon yopilgan'));
    }

    // Заявка на логин, которого в системе нет, закрывается без выдачи: такие
    // в очереди бывают — форма «забыли пароль» принимает любой логин, чтобы не
    // стать справочником действующих учёток.
    const issue = action === 'done' && row.userId !== null;
    const password = issue ? makeTempPassword() : null;

    await this.prisma.withContext(null, [], async (tx) => {
      if (password && row.userId !== null) {
        await tx.userAccount.update({
          where: { id: row.userId },
          data: {
            passwordHash: await bcrypt.hash(password, ROUNDS),
            mustChangePassword: true,
            failedLoginCount: 0,
            lockedUntil: null,
          },
        });
      }
      await tx.passwordResetRequest.update({
        where: { uid },
        data: {
          status: action,
          handledBy: userId,
          handledAt: new Date(),
          handledNote: note?.trim() || null,
        },
      });
    });

    return { password };
  }

  /**
   * Смена своего пароля.
   *
   * Текущий пароль спрашивается всегда, даже когда признак «пароль временный»
   * уже стоит: токен мог остаться в чужих руках на незапертом экране, и без
   * этой проверки сменить пароль учётке смог бы кто угодно, кто до неё дошёл.
   *
   * Новый пароль не может быть ни дефолтным `<логин>123`, ни текущим —
   * иначе обязательная смена становится нажатием кнопки.
   */
  async changeOwnPassword(userId: bigint, currentPassword: string, newPassword: string) {
    const user = await this.prisma.withContext(null, [], (tx) =>
      tx.userAccount.findUnique({ where: { id: userId } }),
    );
    if (!user) throw new NotFoundException(say('Учётная запись не найдена', 'Hisob topilmadi'));

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException(say('Текущий пароль неверен', 'Hozirgi parol xato'));
    }

    const next = newPassword.trim();
    // Сравнение без учёта регистра: `ADMIN123` — тот же общеизвестный пароль,
    // и обойти правило сдвигом раскладки нельзя.
    if (next.toLowerCase() === defaultPasswordFor(user.login).toLowerCase()) {
      throw new UnprocessableEntityException(
        say(
          'Это пароль по умолчанию. Придумайте свой — его знают все, кому называли логин',
          'Bu standart parol. O‘zingizning parolingizni o‘ylab toping — uni login aytilgan hammasi biladi',
        ),
      );
    }
    if (await bcrypt.compare(next, user.passwordHash)) {
      throw new UnprocessableEntityException(
        say('Новый пароль совпадает с текущим', 'Yangi parol hozirgisi bilan bir xil'),
      );
    }

    await this.prisma.withContext(null, [], async (tx) => {
      await tx.userAccount.update({
        where: { id: userId },
        data: {
          passwordHash: await bcrypt.hash(next, ROUNDS),
          mustChangePassword: false,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
    });
  }

  /**
   * Вход. `client` — откуда: браузер или телефон (заголовок `X-Client`).
   * Телефон заодно регистрирует себя как устройство (`device`) и получает
   * refresh-токен; отозванное устройство не пускается и с верным паролем.
   */
  async login(
    login: string,
    password: string,
    ip?: string,
    opts: { client?: Client; userAgent?: string; device?: DeviceInfo; withoutSession?: boolean } = {},
  ) {
    const user = await this.prisma.withContext(null, [], (tx) =>
      tx.userAccount.findUnique({ where: { login } }),
    );

    // Одинаковый ответ на «нет такого логина» и «неверный пароль»: иначе форма
    // входа превращается в справочник действующих учётных записей.
    const invalid = new UnauthorizedException(say('Неверный логин или пароль', 'Login yoki parol xato'));

    if (!user || !user.isActive) {
      await this.logLogin(null, false, ip, 'unknown_or_inactive');
      throw invalid;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.logLogin(user.id, false, ip, 'locked');
      throw new UnauthorizedException({
        code: ERR.accountLocked,
        message: say('Учётная запись временно заблокирована', 'Hisob vaqtincha bloklangan'),
      });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      await this.prisma.withContext(null, [], (tx) =>
        tx.userAccount.update({
          where: { id: user.id },
          data: {
            failedLoginCount: failed,
            lockedUntil:
              failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
          },
        }),
      );
      await this.logLogin(user.id, false, ip, 'bad_password');
      throw invalid;
    }

    const client: Client = opts.client ?? 'web';
    // Телефон проверяем до того, как считать вход удачным: с отозванного
    // устройства не входят, и в журнале это должно остаться отказом.
    let device: { id: bigint; uid: string } | null = null;
    if (client === 'mobile' && opts.device) {
      try {
        device = await this.devices.upsert(user.id, opts.device);
      } catch (e) {
        await this.logLogin(user.id, false, ip, 'device_revoked');
        throw e;
      }
    }

    await this.prisma.withContext(null, [], (tx) =>
      tx.userAccount.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
      }),
    );
    await this.logLogin(user.id, true, ip, null);

    const profile = await this.loadProfile(user.id);
    // Бот сверяет пароль тем же входом, но токен ему не нужен: человек в боте
    // опознаётся по Telegram, и сессия здесь была бы мёртвой строкой.
    if (opts.withoutSession) return { token: null, user, profile, session: null, device: null };
    const session = await this.sessions.create({
      userId: user.id,
      client,
      deviceId: device?.id ?? null,
      ip,
      userAgent: opts.userAgent,
    });
    const token = await this.issueAccess(user.id, user.login, session.uid, client);

    return {
      token,
      user,
      profile,
      session: { uid: session.uid, refreshToken: session.refreshToken, expiresIn: ACCESS_TTL[client] },
      device: device ? { uid: device.uid } : null,
    };
  }

  /** Токен доступа с номером сессии внутри (`sid`). Срок — по виду клиента. */
  issueAccess(userId: bigint, login: string, sessionUid: string, client: Client) {
    return this.jwt.signAsync({ sub: String(userId), login, sid: sessionUid }, { expiresIn: ACCESS_TTL[client] });
  }

  /** Обновление токена телефоном: новый токен доступа и новый refresh-токен. */
  async refresh(refreshToken: string, ip?: string) {
    const r = await this.sessions.rotate(refreshToken, ip);
    const user = await this.userById(r.userId);
    const token = await this.issueAccess(r.userId, user!.login, r.sessionUid, 'mobile');
    return { token, accessToken: token, refreshToken: r.refreshToken, expiresIn: ACCESS_TTL.mobile };
  }

  /**
   * Права и доступные компании — всегда из базы, не из токена.
   *
   * Признак «пароль временный» читается здесь же, одним запросом с
   * назначениями: его проверяет страж на каждом запросе, и отдельный поход в
   * базу на каждый запрос ради одного `boolean` ничего не добавил бы.
   */
  async loadProfile(userId: bigint): Promise<AccessProfile> {
    return this.prisma.withContext(userId, [], async (tx) => {
      const account = await tx.userAccount.findUnique({
        where: { id: userId },
        select: { mustChangePassword: true },
      });
      const mustChangePassword = account?.mustChangePassword ?? false;

      // Контекст компаний пустой, и это не мешает: строки назначений пускает
      // политика own_assignments — по пользователю, а не по компаниям. Иначе
      // получился бы замкнутый круг, ради которого раньше держался пул с
      // BYPASSRLS.
      const assignments = await tx.userRoleAssignment.findMany({
        where: { userId },
        select: { roleId: true, companyId: true },
      });

      const companyIds = [...new Set(assignments.map((a) => a.companyId))];
      const roleIds = [...new Set(assignments.map((a) => a.roleId))];
      if (roleIds.length === 0) {
        return { userId, companyIds, permissions: new Set<string>(), mustChangePassword };
      }

      // Справочники ролей и прав общие для всех компаний, политик на них нет.
      const granted = await tx.rolePermission.findMany({
        where: { roleId: { in: roleIds } },
        select: { permission: { select: { code: true } } },
      });

      return {
        userId,
        companyIds,
        permissions: new Set(granted.map((rp) => rp.permission.code)),
        mustChangePassword,
      };
    });
  }

  async userById(userId: bigint) {
    return this.prisma.withContext(null, [], (tx) =>
      tx.userAccount.findUnique({ where: { id: userId } }),
    );
  }

  /**
   * Язык человека. Один на бота и на веб: в боте он уже запоминался здесь же,
   * а веб до этого держал выбор только в памяти вкладки и забывал его при
   * перезагрузке. Язык — настройка человека, а не состояние страницы.
   */
  async setLocale(userId: bigint, locale: 'ru' | 'uz') {
    await this.prisma.withContext(null, [], (tx) =>
      tx.userAccount.update({ where: { id: userId }, data: { locale } }),
    );
  }

  async companies(companyIds: bigint[]) {
    return this.prisma.withContext(null, companyIds, (tx) =>
      tx.company.findMany({
        where: { id: { in: companyIds } },
        orderBy: { code: 'asc' },
      }),
    );
  }

  verify(token: string) {
    return this.jwt.verifyAsync<{ sub: string; sid?: string }>(token);
  }

  private logLogin(
    userId: bigint | null,
    success: boolean,
    ip?: string,
    failureReason?: string | null,
  ) {
    return this.prisma.withContext(null, [], (tx) =>
      tx.loginLog.create({
        data: { userId, success, ip: ip ?? null, failureReason: failureReason ?? null },
      }),
    );
  }
}
