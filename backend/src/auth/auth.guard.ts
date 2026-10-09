import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { SessionsService } from './sessions.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { requireContext } from '../common/request-context.js';
import { say } from '../common/say.js';
import { ERR } from '../common/error-codes.js';

export const PUBLIC_ROUTE = 'public_route';
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

export const REQUIRED_PERMISSIONS = 'required_permissions';
export const RequirePermissions = (...codes: string[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, codes);

/**
 * Маршрут, доступный с временным паролем.
 *
 * Таких ровно столько, сколько нужно, чтобы пароль сменить: прочитать свой
 * профиль и поставить новый. Метка стоит на самих маршрутах, а не списком
 * путей внутри стража: список путей расходится с маршрутами молча, а забытая
 * метка видна отказом в первом же прогоне.
 */
export const ALLOW_TEMP_PASSWORD = 'allow_temp_password';
export const AllowTempPassword = () => SetMetadata(ALLOW_TEMP_PASSWORD, true);

/**
 * Разбирает токен, дописывает в контекст запроса пользователя и компании,
 * проверяет права.
 *
 * Компании берутся из заголовка X-Company-Id (uid через запятую) и обязательно
 * пересекаются с тем, что пользователю разрешено. Заголовок сужает видимость,
 * но никогда не расширяет: иначе им открывалась бы чужая компания.
 */

/**
 * Заголовок приходит снаружи, а `company.uid` — столбец типа uuid: нечитаемое
 * значение роняет сам запрос к базе, и наружу уходит 500 со стеком Prisma в
 * журнале. Поэтому форму проверяем здесь, до похода в базу.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const ctx = requireContext();

    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException(say('Нужен токен доступа', 'Kirish tokeni kerak'));

    let userId: bigint;
    let sid: string | undefined;
    try {
      const payload = await this.auth.verify(token);
      userId = BigInt(payload.sub);
      sid = payload.sid;
    } catch {
      throw new UnauthorizedException(say('Токен недействителен или истёк', 'Token yaroqsiz yoki muddati o‘tgan'));
    }

    // Токен цел, но сессию могли отозвать (администратор, выход, отзыв
    // телефона). Проверяем на каждом запросе — иначе отзыв действовал бы,
    // только когда токен истечёт сам. Старые токены без `sid` живут до срока.
    if (sid) {
      if (!(await this.sessions.isAlive(sid, userId))) {
        throw new UnauthorizedException({
          code: ERR.sessionExpired,
          message: say('Сессия завершена — войдите заново', 'Seans tugadi — qaytadan kiring'),
        });
      }
      ctx.sessionUid = sid;
    }

    const profile = await this.auth.loadProfile(userId);

    // Временный пароль. Проверка стоит до всего остального — до компаний и до
    // прав: человек с временным паролем не должен получать ни данных, ни даже
    // ответа «нет прав», по которому видно, что в системе есть.
    //
    // Отказ, а не выход из сессии: токен нужен, чтобы пароль сменить.
    if (profile.mustChangePassword) {
      const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_TEMP_PASSWORD, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allowed) {
        throw new ForbiddenException({
          code: ERR.passwordChangeRequired,
          message: say(
            'Пароль временный: смените его, чтобы продолжить',
            'Parol vaqtinchalik: davom etish uchun uni o‘zgartiring',
          ),
        });
      }
    }

    if (profile.companyIds.length === 0) {
      throw new ForbiddenException(say('Пользователю не назначена ни одна компания', 'Foydalanuvchiga birorta kompaniya berilmagan'));
    }

    const requested = (req.headers['x-company-id'] as string | undefined)
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    let companyIds = profile.companyIds;
    if (requested?.length) {
      // Отбрасывать непонятную часть молча нельзя: доступ сузится не туда, куда
      // просили, и запрос об этом не скажет. Поэтому требуем годным весь
      // заголовок целиком.
      const broken = requested.filter((uid) => !UUID_RE.test(uid));
      if (broken.length) {
        throw new BadRequestException(say(`X-Company-Id: ожидается uid компании, получено «${broken[0]}»`, `X-Company-Id: kompaniya uid kutilmoqda, kelgani «${broken[0]}»`));
      }

      // Контекст — уже разрешённые пользователю компании, поэтому чужой uid
      // отсюда просто не вернётся. Пересечение ниже оставлено всё равно:
      // заголовок обязан сужать доступ на уровне кода, а не только политикой.
      const rows = await this.prisma.withContext(userId, profile.companyIds, (tx) =>
        tx.company.findMany({
          where: { uid: { in: requested } },
          select: { id: true },
        }),
      );
      const allowed = new Set(profile.companyIds.map(String));
      companyIds = rows.map((r) => r.id).filter((id) => allowed.has(String(id)));
      if (companyIds.length === 0) {
        throw new ForbiddenException(say('Нет доступа к указанной компании', 'Ko‘rsatilgan kompaniyaga ruxsat yo‘q'));
      }
    }

    ctx.userId = userId;
    ctx.companyIds = companyIds;
    ctx.allCompanyIds = profile.companyIds;
    ctx.permissions = profile.permissions;

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required?.length && !required.every((code) => profile.permissions.has(code))) {
      throw new ForbiddenException(say('Недостаточно прав для этого действия', 'Bu amal uchun huquq yetarli emas'));
    }

    return true;
  }
}
