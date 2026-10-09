import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { currentContext } from './request-context.js';
import { say } from './say.js';

/**
 * Единый формат ошибки по 04-API-CONTRACT.md §4:
 * { error: { code, message, details, requestId } }.
 *
 * Внутренние сообщения наружу не уходят: клиенту — код и человеческий текст,
 * подробности — в лог. Иначе в интерфейсе всплывает текст ограничения базы.
 */
const CODE_BY_STATUS: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  412: 'VERSION_CONFLICT',
  422: 'BUSINESS_RULE_VIOLATION',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
};

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('api');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = currentContext()?.requestId ?? null;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = say('Внутренняя ошибка сервера', 'Server ichki xatosi');
    let details: unknown = null;

    let code: string | null = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const b = body as { message?: unknown; error?: unknown; details?: unknown; code?: unknown };
        // Код, названный самим отказом. По статусу различимы не все причины:
        // блокировка учётки и неверный пароль — оба 401, а вести себя по ним
        // клиенту надо по-разному. Разбирать текст ответа для этого нельзя —
        // он переводится (ТЗ 13.4) и меняется вместе с формулировкой.
        if (typeof b.code === 'string' && b.code !== '') code = b.code;
        message = Array.isArray(b.message)
          ? say('Проверьте заполнение полей', 'Maydonlar to‘ldirilishini tekshiring')
          : String(b.message ?? b.error ?? message);
        if (Array.isArray(b.message)) details = b.message;
        // Подробности, которые бизнес-правило положило само: текущая версия
        // записи при конфликте (§1.7), число ссылок при отказе в удалении.
        // Без этого фронт знает «конфликт», но не знает, чем он вызван.
        else if (b.details !== undefined) details = b.details;
      }
    } else {
      this.logger.error(
        `requestId=${requestId} ${exception instanceof Error ? exception.stack : String(exception)}`,
      );
    }

    res.status(status).json({
      error: {
        code: code ?? CODE_BY_STATUS[status] ?? 'INTERNAL_ERROR',
        message,
        details,
        requestId,
      },
    });
  }
}
