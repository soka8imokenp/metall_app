import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { say } from '../common/say.js';
import { ERR } from '../common/error-codes.js';

export interface DeviceInfo {
  installationId: string;
  platform: 'android' | 'ios' | 'web';
  model?: string;
  osVersion?: string;
  appVersion?: string;
  pushToken?: string | null;
  pushProvider?: 'expo' | 'fcm';
}

/**
 * Устройства — установки мобильного приложения (ТЗ: «Администратор —
 * управление … устройствами»).
 *
 * Устройство заводится при первом входе с телефона и обновляется при каждом
 * следующем: версия приложения и push-адрес меняются, а `installation_id`
 * остаётся. Отзыв — это не удаление: строка остаётся, чтобы было видно, что
 * телефон был и кто его закрыл, а вход с него не проходит, пока его не вернут.
 */
@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Завести или обновить. Отозванный телефон не пускаем — отказ кодом, чтобы
   * приложение показало «устройство отключено администратором», а не
   * «неверный пароль».
   */
  async upsert(userId: bigint, info: DeviceInfo): Promise<{ id: bigint; uid: string }> {
    const existing = await this.prisma.withContext(null, [], (tx) =>
      tx.device.findUnique({
        where: { userId_installationId: { userId, installationId: info.installationId } },
        select: { id: true, revokedAt: true },
      }),
    );
    if (existing?.revokedAt) {
      throw new ForbiddenException({
        code: ERR.deviceRevoked,
        message: say(
          'Это устройство отключено администратором. Обратитесь к нему, чтобы вернуть доступ',
          'Bu qurilma administrator tomonidan o‘chirilgan. Kirishni qaytarish uchun unga murojaat qiling',
        ),
      });
    }
    const data = {
      platform: info.platform,
      model: info.model?.slice(0, 120) ?? null,
      osVersion: info.osVersion?.slice(0, 40) ?? null,
      appVersion: info.appVersion?.slice(0, 40) ?? null,
      lastSeenAt: new Date(),
      // push-адрес переписываем только когда его прислали: вход без него не
      // должен стирать уже известный адрес.
      ...(info.pushToken !== undefined ? { pushToken: info.pushToken || null, pushProvider: info.pushToken ? info.pushProvider ?? 'expo' : null } : {}),
    };
    const row = await this.prisma.withContext(null, [], (tx) =>
      tx.device.upsert({
        where: { userId_installationId: { userId, installationId: info.installationId } },
        create: { userId, installationId: info.installationId, ...data },
        update: data,
        select: { id: true, uid: true },
      }),
    );
    return row;
  }

  /** Привязать устройство к текущей сессии: после регистрации push она уже «с телефона». */
  async attachToSession(sessionUid: string, deviceId: bigint) {
    await this.prisma.withContext(null, [], (tx) =>
      tx.authSession.updateMany({ where: { uid: sessionUid }, data: { deviceId } }),
    );
  }

  async list(filter: { userUid?: string }) {
    const rows = await this.prisma.withContext(null, [], (tx) =>
      tx.device.findMany({
        where: filter.userUid ? { user: { uid: filter.userUid } } : {},
        orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { lastSeenAt: 'desc' }],
        take: 300,
        include: {
          user: { select: { uid: true, login: true, fullName: true } },
          revoker: { select: { fullName: true } },
          _count: { select: { sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } } } },
        },
      }),
    );
    return rows.map((d) => ({
      uid: d.uid,
      platform: d.platform,
      model: d.model,
      osVersion: d.osVersion,
      appVersion: d.appVersion,
      push: !!d.pushToken,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      revokedAt: d.revokedAt,
      revokedBy: d.revoker?.fullName ?? null,
      activeSessions: d._count.sessions,
      user: d.user,
    }));
  }

  async byUid(uid: string) {
    const d = await this.prisma.withContext(null, [], (tx) =>
      tx.device.findUnique({ where: { uid }, select: { id: true, userId: true, revokedAt: true } }),
    );
    if (!d) throw new NotFoundException(say('Устройство не найдено', 'Qurilma topilmadi'));
    return d;
  }

  async setRevoked(id: bigint, by: bigint | null) {
    await this.prisma.withContext(null, [], (tx) =>
      tx.device.update({
        where: { id },
        // отозванному телефону push больше не шлём: адрес стираем сразу
        data: by ? { revokedAt: new Date(), revokedBy: by, pushToken: null } : { revokedAt: null, revokedBy: null },
      }),
    );
  }

  /** push-адрес, который служба доставки назвала недействительным (приложение удалили). */
  async dropPushToken(token: string) {
    await this.prisma.withContext(null, [], (tx) =>
      tx.device.updateMany({ where: { pushToken: token }, data: { pushToken: null } }),
    );
  }
}
