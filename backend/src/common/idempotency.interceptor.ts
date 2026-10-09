import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { Observable, from, of, switchMap, catchError, throwError } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service.js';
import { currentContext } from './request-context.js';
import { say } from './say.js';
import { ERR } from './error-codes.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * Где ключ не обязателен: вход и обновление токена (повтор безопасен и так) и
 * регистрация телефона (это `upsert`, второй вызов ничего не удваивает).
 */
const EXEMPT = ['/auth/', '/devices/register'];
const KEY_RE = /^[A-Za-z0-9-]{16,80}$/;

/**
 * Ключ повтора для запросов с телефона (контракт §1.6, 02-ARCHITECTURE п.7).
 *
 * Телефон в цеху теряет связь посреди запроса и повторяет его. Без ключа
 * повтор «отметить выпуск 5 т» записал бы выпуск дважды. Поэтому для клиента
 * `X-Client: mobile` любая запись **обязана** нести `Idempotency-Key`:
 *
 *   - первый запрос с ключом выполняется, ответ запоминается на сутки;
 *   - повтор с тем же ключом и тем же телом получает сохранённый ответ,
 *     ничего не выполняя второй раз;
 *   - тот же ключ с другим телом — 409: это другой запрос под старым ключом;
 *   - пока первый запрос ещё идёт, повтор получает 409, а не второй запуск.
 *
 * Ключ сперва «занимается» строкой-заготовкой, и только потом выполняется
 * обработчик: два одновременных повтора не проскочат оба. Ошибка обработчика
 * заготовку снимает — неудачный запрос можно повторить тем же ключом.
 *
 * Браузер правило не затрагивает: веб работает как раньше, службы склада,
 * продаж и финансов держат свои ключи сами.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const ctx = currentContext();
    if (!ctx || ctx.source !== 'mobile' || !ctx.userId || !MUTATING.has(req.method)) return next.handle();
    if (EXEMPT.some((p) => req.path.includes(p))) return next.handle();

    const key = String(req.headers['idempotency-key'] ?? '');
    if (!key) {
      throw new BadRequestException({
        code: ERR.idempotencyKeyRequired,
        message: say('Запрос с телефона должен нести ключ повтора (Idempotency-Key)', 'Telefondan so‘rov takrorlash kalitini (Idempotency-Key) olib kelishi kerak'),
      });
    }
    if (!KEY_RE.test(key)) {
      throw new BadRequestException(say('Ключ повтора: 16–80 латинских букв, цифр и дефисов', 'Takrorlash kaliti: 16–80 lotin harfi, raqam va chiziqcha'));
    }

    const userId = ctx.userId;
    const company = ctx.companyIds[0] ?? ctx.allCompanyIds[0];
    if (company === undefined) return next.handle();
    const companies = ctx.allCompanyIds.length ? ctx.allCompanyIds : ctx.companyIds;
    const endpoint = `${req.method} ${req.path}`.slice(0, 300);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? null));
    const hash = createHash('sha256').update(endpoint).update('\n').update(body).digest('hex');

    const claim = this.prisma.withContext(userId, companies, async (tx) => {
      // Старые ключи убираем попутно, изредка: отдельный будильник ради этого не нужен.
      if (Math.random() < 0.02) await tx.$executeRaw`DELETE FROM idempotency_key WHERE expires_at < now()`;
      const taken = await tx.$queryRaw<{ key: string }[]>`
        INSERT INTO idempotency_key (key, company_id, user_id, endpoint, request_hash, response_status, response_body, expires_at)
        VALUES (${key}, ${company}, ${userId}, ${endpoint}, ${hash}, 0, '{}'::jsonb, now() + interval '24 hours')
        ON CONFLICT (key) DO NOTHING
        RETURNING key`;
      if (taken.length) return { fresh: true as const };
      const rows = await tx.$queryRaw<{ user_id: bigint | null; request_hash: string; response_status: number; response_body: unknown }[]>`
        SELECT user_id, request_hash, response_status, response_body FROM idempotency_key WHERE key = ${key}`;
      return { fresh: false as const, row: rows[0] };
    });

    return from(claim).pipe(
      switchMap((c) => {
        if (!c.fresh) {
          const row = c.row;
          if (!row || String(row.user_id) !== String(userId) || row.request_hash !== hash) {
            throw new ConflictException({
              code: ERR.idempotencyKeyReused,
              message: say('Этот ключ повтора уже использован для другого запроса', 'Bu takrorlash kaliti boshqa so‘rov uchun ishlatilgan'),
            });
          }
          if (row.response_status === 0) {
            throw new ConflictException(say('Этот запрос ещё выполняется — подождите', 'Bu so‘rov hali bajarilmoqda — kuting'));
          }
          // Повтор: отдаём тот же ответ, ничего не выполняя второй раз.
          return of(row.response_body);
        }
        return next.handle().pipe(
          switchMap((value) =>
            from(
              this.prisma
                .withContext(userId, companies, (tx) =>
                  tx.$executeRaw`
                    UPDATE idempotency_key
                       SET response_status = 1, response_body = ${JSON.stringify(value ?? null, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}::jsonb
                     WHERE key = ${key}`,
                )
                .then(() => value),
            ),
          ),
          catchError((err) =>
            from(
              this.prisma
                .withContext(userId, companies, (tx) => tx.$executeRaw`DELETE FROM idempotency_key WHERE key = ${key} AND response_status = 0`)
                .catch(() => undefined),
            ).pipe(switchMap(() => throwError(() => err))),
          ),
        );
      }),
    );
  }
}
