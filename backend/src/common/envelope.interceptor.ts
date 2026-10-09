import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { currentContext } from './request-context.js';

/** Ответ всегда в конверте { data, meta } — см. 04-API-CONTRACT.md §3. */
export interface Envelope<T> {
  data: T;
  meta: Record<string, unknown>;
}

const isEnvelope = (v: unknown): v is { __meta: Record<string, unknown>; data: unknown } =>
  typeof v === 'object' && v !== null && '__meta' in v;

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<Envelope<unknown>> {
    return next.handle().pipe(
      map((value) => {
        const requestId = currentContext()?.requestId ?? null;
        // Обработчик может вернуть свою мету (пагинация, период) —
        // тогда забираем её из служебного поля, а не гадаем по форме ответа.
        if (isEnvelope(value)) {
          const { __meta, data } = value;
          return { data, meta: { requestId, ...__meta } };
        }
        return { data: value, meta: { requestId } };
      }),
    );
  }
}

/** Помощник, чтобы обработчик мог приложить к ответу мету. */
export const withMeta = <T>(data: T, meta: Record<string, unknown>) => ({
  data,
  __meta: meta,
});
