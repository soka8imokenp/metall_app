import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { say } from '../common/say.js';
import { ERR } from '../common/error-codes.js';

/**
 * Сессии входа (02-ARCHITECTURE 7.1, контракт §2).
 *
 * Каждый вход — строка `auth_session`, и токен доступа несёт её `uid` в поле
 * `sid`. Страж на каждом запросе проверяет, что сессия жива: так отзыв
 * администратором действует сразу, а не когда истечёт токен.
 *
 * **Браузер и телефон живут по-разному.** Браузеру токен выдаётся на 12 часов,
 * как и раньше: веб-клиент обновлять токен не умеет, и укоротить ему жизнь —
 * значит выкидывать бухгалтера из системы посреди дня. Телефону — короткий
 * токен на 15 минут и refresh-токен на 30 дней, который меняется при каждом
 * обновлении. В базе лежит только SHA-256 refresh-токена: утечка базы не даёт
 * войти чужим телефоном.
 *
 * Старые токены без `sid` (выданы до этой миграции) принимаются, пока не
 * истекут сами, — иначе выкатка выбила бы всех из системы одним махом.
 */

export type Client = 'web' | 'mobile';

/** Жизнь токена доступа, секунды. */
export const ACCESS_TTL: Record<Client, number> = { web: 12 * 3600, mobile: 15 * 60 };
/** Сколько живёт сессия телефона без обновления. */
const MOBILE_SESSION_DAYS = 30;
/** Чаще этого отметку «последнее обращение» не переписываем: запись на каждый запрос не нужна. */
const TOUCH_EVERY_MS = 5 * 60_000;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newRefreshToken = () => randomBytes(32).toString('base64url');

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Завести сессию при входе. Refresh-токен — только телефону. */
  async create(input: { userId: bigint; client: Client; deviceId: bigint | null; ip?: string; userAgent?: string }) {
    const refreshToken = input.client === 'mobile' ? newRefreshToken() : null;
    const expiresAt = new Date(
      Date.now() + (input.client === 'mobile' ? MOBILE_SESSION_DAYS * 86_400_000 : ACCESS_TTL.web * 1000),
    );
    const row = await this.prisma.withContext(null, [], (tx) =>
      tx.authSession.create({
        data: {
          userId: input.userId,
          client: input.client,
          deviceId: input.deviceId,
          refreshHash: refreshToken ? hashToken(refreshToken) : null,
          ip: input.ip ?? null,
          userAgent: input.userAgent?.slice(0, 300) ?? null,
          expiresAt,
        },
        select: { uid: true },
      }),
    );
    return { uid: row.uid, refreshToken, expiresAt };
  }

  /**
   * Жива ли сессия. Зовётся стражем на каждом запросе, поэтому один запрос по
   * уникальному индексу и редкая отметка времени — не чаще раза в 5 минут.
   */
  async isAlive(uid: string, userId: bigint): Promise<boolean> {
    const rows = await this.prisma.withContext(null, [], (tx) =>
      tx.$queryRaw<{ id: bigint; last_used_at: Date }[]>`
        SELECT s.id, s.last_used_at
          FROM auth_session s
          LEFT JOIN device d ON d.id = s.device_id
         WHERE s.uid = ${uid}::uuid
           AND s.user_id = ${userId}
           AND s.revoked_at IS NULL
           AND s.expires_at > now()
           AND (d.id IS NULL OR d.revoked_at IS NULL)`,
    );
    const row = rows[0];
    if (!row) return false;
    if (Date.now() - new Date(row.last_used_at).getTime() > TOUCH_EVERY_MS) {
      // Отметка — не повод задерживать ответ и не повод его ронять.
      void this.prisma
        .withContext(null, [], (tx) => tx.$executeRaw`UPDATE auth_session SET last_used_at = now() WHERE id = ${row.id}`)
        .catch(() => undefined);
    }
    return true;
  }

  /**
   * Обновление по refresh-токену. Токен одноразовый: в ответ выдаётся новый,
   * старый перестаёт подходить. Отказ один на все причины (нет такой сессии,
   * отозвана, истекла, учётка выключена, телефон отозван) — подбирающему
   * незачем знать, какая из них.
   */
  async rotate(refreshToken: string, ip?: string) {
    const hash = hashToken(refreshToken);
    const rows = await this.prisma.withContext(null, [], (tx) =>
      tx.$queryRaw<{ id: bigint; uid: string; user_id: bigint }[]>`
        SELECT s.id, s.uid::text AS uid, s.user_id
          FROM auth_session s
          JOIN user_account u ON u.id = s.user_id
          LEFT JOIN device d ON d.id = s.device_id
         WHERE s.refresh_hash = ${hash}
           AND s.client = 'mobile'
           AND s.revoked_at IS NULL
           AND s.expires_at > now()
           AND u.is_active
           AND (d.id IS NULL OR d.revoked_at IS NULL)`,
    );
    const row = rows[0];
    if (!row) {
      throw new UnauthorizedException({
        code: ERR.sessionExpired,
        message: say('Сессия завершена — войдите заново', 'Seans tugadi — qaytadan kiring'),
      });
    }
    const next = newRefreshToken();
    const expiresAt = new Date(Date.now() + MOBILE_SESSION_DAYS * 86_400_000);
    await this.prisma.withContext(null, [], (tx) =>
      tx.$executeRaw`
        UPDATE auth_session
           SET refresh_hash = ${hashToken(next)}, expires_at = ${expiresAt},
               last_used_at = now(), ip = COALESCE(${ip ?? null}, ip)
         WHERE id = ${row.id}`,
    );
    return { sessionUid: row.uid, userId: BigInt(row.user_id), refreshToken: next };
  }

  /** Свои живые сессии; текущая отмечена. */
  async listOwn(userId: bigint, currentUid?: string | null) {
    const rows = await this.list({ userId });
    return rows.map((r) => ({ ...r, current: r.uid === currentUid }));
  }

  /** Живые сессии — свои или (для администратора) любого человека. */
  async list(filter: { userId?: bigint; userUid?: string }) {
    const rows = await this.prisma.withContext(null, [], (tx) =>
      tx.authSession.findMany({
        where: {
          revokedAt: null,
          expiresAt: { gt: new Date() },
          ...(filter.userId ? { userId: filter.userId } : {}),
          ...(filter.userUid ? { user: { uid: filter.userUid } } : {}),
        },
        orderBy: { lastUsedAt: 'desc' },
        take: 200,
        include: {
          device: { select: { uid: true, platform: true, model: true, appVersion: true } },
          user: { select: { uid: true, login: true, fullName: true } },
        },
      }),
    );
    return rows.map((r) => ({
      uid: r.uid,
      client: r.client as Client,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      ip: r.ip,
      userAgent: r.userAgent,
      device: r.device,
      user: r.user,
    }));
  }

  /**
   * Отозвать сессию. `ownerId` — когда отзывает сам человек: чужую через свой
   * маршрут не отозвать, и такой отказ неотличим от «не найдено».
   */
  async revoke(uid: string, by: bigint, reason: string, ownerId?: bigint) {
    const n = await this.prisma.withContext(null, [], (tx) =>
      tx.authSession.updateMany({
        where: { uid, revokedAt: null, ...(ownerId ? { userId: ownerId } : {}) },
        data: { revokedAt: new Date(), revokedBy: by, revokeReason: reason, refreshHash: null },
      }),
    );
    if (n.count === 0) throw new NotFoundException(say('Сессия не найдена', 'Seans topilmadi'));
  }

  /** Все сессии устройства — при отзыве телефона. */
  async revokeByDevice(deviceId: bigint, by: bigint, reason: string) {
    await this.prisma.withContext(null, [], (tx) =>
      tx.authSession.updateMany({
        where: { deviceId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: by, revokeReason: reason, refreshHash: null },
      }),
    );
  }

  /** Владелец сессии — для журнала и проверок прав. */
  async ownerOf(uid: string) {
    return this.prisma.withContext(null, [], (tx) =>
      tx.authSession.findUnique({ where: { uid }, select: { userId: true } }),
    );
  }
}
