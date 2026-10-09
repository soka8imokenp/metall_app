import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithContext, type RequestContext } from './request-context.js';

/**
 * Заводит контекст запроса и накрывает им весь дальнейший конвейер.
 *
 * Именно middleware, а не guard: AsyncLocalStorage живёт только внутри своего
 * колбэка, а guard из него выходит раньше, чем начнёт работать обработчик.
 * Пользователя и компании guard дописывает в этот же объект.
 */
/** Откуда запрос: телефон представляется сам, всё остальное — браузер. */
export const clientOf = (req: Request): 'web' | 'mobile' =>
  String(req.headers['x-client'] ?? '').toLowerCase() === 'mobile' ? 'mobile' : 'web';

@Injectable()
export class ContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    const locale = String(req.headers['accept-language'] ?? '').startsWith('uz') ? 'uz' : 'ru';

    const ctx: RequestContext = {
      requestId,
      userId: null,
      companyIds: [],
      allCompanyIds: [],
      permissions: new Set(),
      locale,
      // Сюда приходит только HTTP: бот свой контекст заводит сам. Мобильное
      // приложение называет себя заголовком `X-Client: mobile` — по нему
      // журнал отличает действия с телефона (ТЗ 10: «журнал значимых
      // действий, выполненных через мобильное приложение»).
      source: clientOf(req),
    };

    res.setHeader('X-Request-Id', requestId);
    runWithContext(ctx, () => next());
  }
}
