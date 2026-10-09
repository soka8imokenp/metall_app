import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UnprocessableEntityException } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { Public, RequirePermissions } from './auth.guard.js';
import { DevicesService } from './devices.service.js';
import { SessionsService } from './sessions.service.js';
import { DeviceDto } from './auth.controller.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { currentContext, requireContext } from '../common/request-context.js';
import { writeAudit } from '../common/audit.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

class UidParams {
  @IsUUID()
  uid!: string;
}

class UserFilter {
  @IsOptional()
  @IsUUID()
  userUid?: string;
}

class ReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/;

/**
 * Настройки мобильного приложения, которые меняет администратор: минимальная
 * версия (ниже — приложение просит обновиться и не работает), актуальная
 * версия и ссылка на обновление, короткое сообщение для всех.
 */
class MobileConfigDto {
  @IsOptional() @Matches(VERSION, { message: 'Версия: три числа через точку, например 1.4.0' }) minVersion?: string;
  @IsOptional() @Matches(VERSION, { message: 'Версия: три числа через точку, например 1.4.0' }) latestVersion?: string;
  @IsOptional() @IsString() @MaxLength(500) updateUrl?: string;
  @IsOptional() @IsString() @MaxLength(500) messageRu?: string;
  @IsOptional() @IsString() @MaxLength(500) messageUz?: string;
}

type MobileConfig = MobileConfigDto;

/** Компания для записи в журнал: журнал ведётся по компании, а устройство — человека. */
function auditCompany(): bigint {
  const ctx = currentContext();
  const ids = ctx?.companyIds?.length ? ctx.companyIds : (ctx?.allCompanyIds ?? []);
  if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
  return ids[0]!;
}

/**
 * Устройства, сессии и настройки мобильного приложения (ТЗ: «Администратор —
 * управление доступом, устройствами и настройками мобильного приложения»).
 *
 * Телефон регистрирует себя сам (`POST /devices/register`), администратор
 * видит устройства и сессии всех людей и может их отозвать. Отзыв телефона
 * закрывает все его сессии сразу.
 */
@Controller()
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly sessions: SessionsService,
    private readonly prisma: PrismaService,
  ) {}

  // --- телефон ----------------------------------------------------------------

  /**
   * Регистрация телефона и его push-адреса. Зовётся после входа и при смене
   * push-адреса; текущая сессия привязывается к устройству.
   */
  @Post('devices/register')
  async register(@Body() dto: DeviceDto) {
    const ctx = requireContext();
    const device = await this.devices.upsert(ctx.userId!, dto);
    if (ctx.sessionUid) await this.devices.attachToSession(ctx.sessionUid, device.id);
    return { uid: device.uid };
  }

  /** Настройки приложения. Открыто: проверка версии идёт до входа. */
  @Public()
  @Get('mobile/config')
  async config() {
    return this.readConfig();
  }

  // --- администратор ------------------------------------------------------------

  @Get('admin/devices')
  @RequirePermissions('admin.users')
  list(@Query() q: UserFilter) {
    return this.devices.list({ userUid: q.userUid });
  }

  @Post('admin/devices/:uid/revoke')
  @RequirePermissions('admin.users')
  @HttpCode(200)
  async revoke(@Param() p: UidParams, @Body() body: ReasonDto) {
    const ctx = requireContext();
    const d = await this.devices.byUid(p.uid);
    await this.devices.setRevoked(d.id, ctx.userId!);
    await this.sessions.revokeByDevice(d.id, ctx.userId!, body.reason?.trim() || 'device_revoked');
    await this.audit('device', p.uid, 'revoke', { reason: body.reason ?? null });
    return { ok: true };
  }

  @Post('admin/devices/:uid/restore')
  @RequirePermissions('admin.users')
  @HttpCode(200)
  async restore(@Param() p: UidParams) {
    const d = await this.devices.byUid(p.uid);
    await this.devices.setRevoked(d.id, null);
    await this.audit('device', p.uid, 'restore', null);
    return { ok: true };
  }

  @Get('admin/sessions')
  @RequirePermissions('admin.users')
  sessionsList(@Query() q: UserFilter) {
    return this.sessions.list({ userUid: q.userUid });
  }

  @Delete('admin/sessions/:uid')
  @RequirePermissions('admin.users')
  async sessionRevoke(@Param() p: UidParams, @Body() body: ReasonDto) {
    const ctx = requireContext();
    await this.sessions.revoke(p.uid, ctx.userId!, body?.reason?.trim() || 'admin');
    await this.audit('session', p.uid, 'revoke', { reason: body?.reason ?? null });
    return { ok: true };
  }

  @Get('admin/mobile-config')
  @RequirePermissions('settings.edit')
  adminConfig() {
    return this.readConfig();
  }

  @Put('admin/mobile-config')
  @RequirePermissions('settings.edit')
  async saveConfig(@Body() dto: MobileConfigDto) {
    const ctx = requireContext();
    const before = await this.readConfig();
    const next: MobileConfig = { ...before, ...dto };
    if (next.minVersion && next.latestVersion && cmpVersion(next.minVersion, next.latestVersion) > 0) {
      throw new UnprocessableEntityException(
        say('Минимальная версия не может быть выше актуальной', 'Minimal versiya joriy versiyadan yuqori bo‘lishi mumkin emas'),
      );
    }
    await this.prisma.withContext(null, [], (tx) =>
      tx.appSetting.upsert({
        where: { key: 'mobile' },
        create: { key: 'mobile', value: next as object, updatedBy: ctx.userId },
        update: { value: next as object, updatedBy: ctx.userId, updatedAt: new Date() },
      }),
    );
    await this.audit('app_setting', 'mobile', 'update', { from: before, to: next });
    return next;
  }

  private async readConfig(): Promise<MobileConfig> {
    const row = await this.prisma.withContext(null, [], (tx) => tx.appSetting.findUnique({ where: { key: 'mobile' } }));
    return { minVersion: undefined, latestVersion: undefined, updateUrl: undefined, ...((row?.value as MobileConfig) ?? {}) };
  }

  private audit(entityType: string, entityId: string, action: string, changes: Record<string, unknown> | null) {
    return this.prisma.withTenant((tx) =>
      writeAudit(tx, { companyId: auditCompany(), entityType, entityId, action, changes }),
    );
  }
}

/** Сравнение версий «1.4.0»: −1, 0, 1. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
