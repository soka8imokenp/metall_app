import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/auth.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UpdatesService } from './updates.service.js';

/**
 * Обновление приложения: проверка и скачивание. Открыто — проверка идёт и с
 * экрана входа, а старая версия может не суметь войти, пока не обновится.
 */
@Controller('mobile/update')
export class UpdatesController {
  constructor(
    private readonly updates: UpdatesService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get()
  async check() {
    const release = await this.updates.latest();
    // Минимальная версия — из настроек администратора (`/admin/mobile-config`):
    // ниже неё приложение не даёт работать, пока не обновишься.
    const row = await this.prisma.withContext(null, [], (tx) => tx.appSetting.findUnique({ where: { key: 'mobile' } }));
    const cfg = (row?.value ?? {}) as { minVersion?: string; messageRu?: string; messageUz?: string };
    return {
      configured: this.updates.configured,
      version: release?.version ?? null,
      notes: release?.notes ?? '',
      publishedAt: release?.publishedAt ?? null,
      size: release?.size ?? null,
      minVersion: cfg.minVersion ?? null,
      downloadPath: release ? '/mobile/update/apk' : null,
    };
  }

  @Public()
  @Get('apk')
  async apk(@Res() res: Response) {
    const { release, body } = await this.updates.download();
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Length', String(release.size));
    res.setHeader('Content-Disposition', `attachment; filename="MetallAsia-${release.version}.apk"`);
    res.setHeader('Cache-Control', 'no-store');
    body.pipe(res);
  }
}
