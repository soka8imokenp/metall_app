import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { say } from '../common/say.js';
import { cut } from './events.js';

/**
 * Доставка исходящих вебхуков (ТЗ 12).
 *
 * Механика взята у очереди уведомлений (`notifications.service.ts`): выборка
 * недоставленного, предел попыток, пара «отметить доставленным / отметить
 * неудачей», последняя ошибка в самой строке. Имена оставлены те же
 * (`pending`, `markSent`, `markFailed`), чтобы два места в системе, делающие
 * одно и то же, читались одинаково.
 *
 * Чего у уведомлений нет и что добавлено здесь — **нарастающая задержка**.
 * Уведомления берут неудачную строку снова на том же проходе: Telegram либо
 * отвечает, либо нет, и повтор через минуту ничего не стоит. Чужой сервер,
 * который лёг, так обстреливать нельзя — и потому что это его добивает, и
 * потому что наши попытки кончатся за пять минут, а поднимут его через час.
 *
 * Шаг — 1, 5, 25, 125 минут (`BACKOFF_BASE_MS * 5^attempts`). После
 * `MAX_ATTEMPTS` строка становится `dead`: сама больше не берётся, но остаётся
 * в журнале с причиной и ждёт кнопки «повторить». Молча терять обмен нельзя —
 * именно про потерянную выписку потом спрашивают.
 */
@Injectable()
export class ExchangeOutboxService {
  private readonly log = new Logger('exchange');

  constructor(private readonly prisma: PrismaService) {}

  /** Тот же предел, что у уведомлений: пять попыток и в «мёртвую» очередь. */
  static readonly MAX_ATTEMPTS = 5;
  /** Первая повторная попытка через минуту, дальше в пять раз реже. */
  static readonly BACKOFF_BASE_MS = 60_000;

  static backoffMs(attempts: number): number {
    return ExchangeOutboxService.BACKOFF_BASE_MS * Math.pow(5, Math.max(0, attempts - 1));
  }

  /**
   * Что пора отправлять. Без разреза по компании: отправка идёт от службы, а не
   * от человека, и `withContext(null, [])` обходит RLS так же, как это делает
   * очередь уведомлений.
   */
  async pending(limit = 20): Promise<Outgoing[]> {
    return this.prisma.withContext(null, [], async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT m.id, m.uid, m.event, m.url, m.request_body, m.attempts,
                s.signing_secret, s.code AS system_code
           FROM exchange_message m JOIN external_system s ON s.id = m.system_id
          WHERE m.direction = 'out'
            AND m.status = 'pending'
            AND m.attempts < $1
            AND m.next_attempt_at <= now()
            AND s.is_active
          ORDER BY m.next_attempt_at, m.id
          LIMIT $2`,
        ExchangeOutboxService.MAX_ATTEMPTS,
        limit,
      );
      return rows.map((r) => ({
        id: BigInt(r.id),
        uid: r.uid,
        event: r.event,
        url: r.url,
        body: r.request_body ?? '{}',
        attempts: Number(r.attempts),
        secret: r.signing_secret ?? null,
        systemCode: r.system_code,
      }));
    });
  }

  /**
   * Один проход очереди. Возвращает, сколько отправлено и сколько не вышло —
   * по этим двум числам прогон и тест видят, что проход вообще что-то делал.
   */
  async tick(limit = 20): Promise<{ sent: number; failed: number }> {
    const batch = await this.pending(limit);
    let sent = 0;
    let failed = 0;
    for (const msg of batch) {
      try {
        const res = await this.deliver(msg);
        if (res.ok) {
          await this.markSent(msg.id, res.status, res.text);
          sent += 1;
        } else {
          await this.markFailed(msg.id, `HTTP ${res.status}`, res.status, res.text);
          failed += 1;
        }
      } catch (e) {
        // Недоступный получатель — не ошибка нашей службы: строка остаётся в
        // очереди со своей причиной, а проход идёт дальше.
        await this.markFailed(msg.id, (e as Error).message, null, null);
        failed += 1;
      }
    }
    return { sent, failed };
  }

  /**
   * Отправка. Подпись — HMAC-SHA256 по тем самым байтам тела, что уходят:
   * получатель считает её у себя и сверяет. Подписи нет, если секрет не задан —
   * тогда у получателя остаётся только ключ, и это его выбор, а не наш.
   *
   * Таймаут обязателен: без него зависший получатель держит проход очереди, и
   * остальные обмены не уходят вовсе.
   */
  private async deliver(msg: Outgoing): Promise<{ ok: boolean; status: number; text: string }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Exchange-Event': msg.event,
      'X-Exchange-Message-Id': msg.uid,
    };
    if (msg.secret) {
      headers['X-Exchange-Signature'] =
        'sha256=' + createHmac('sha256', msg.secret).update(msg.body, 'utf8').digest('hex');
    }
    const res = await fetch(msg.url, {
      method: 'POST',
      headers,
      body: msg.body,
      signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text };
  }

  async markSent(id: bigint, httpStatus: number, response: string | null): Promise<void> {
    await this.prisma.withContext(null, [], async (tx) => {
      await tx.$queryRawUnsafe(
        `UPDATE exchange_message
            SET status = 'done', attempts = attempts + 1, processed_at = now(),
                http_status = $2, response_body = $3, last_error = NULL
          WHERE id = $1`,
        id,
        httpStatus,
        response ? cut(response) : null,
      );
    });
  }

  /**
   * Неудача: причина видна в самой строке, следующая попытка отложена, а после
   * предела строка помечается `dead` — чтобы очередь не ходила по ней вечно, но
   * и чтобы обмен не исчез из журнала.
   */
  async markFailed(
    id: bigint,
    error: string,
    httpStatus: number | null,
    response: string | null,
  ): Promise<void> {
    await this.prisma.withContext(null, [], async (tx) => {
      await tx.$queryRawUnsafe(
        `UPDATE exchange_message
            SET attempts = attempts + 1,
                last_error = $2,
                http_status = $3,
                response_body = $4,
                status = CASE WHEN attempts + 1 >= $5 THEN 'dead' ELSE 'pending' END,
                -- Нарастающая задержка: 1, 5, 25, 125 минут. В правой части
                -- UPDATE слово attempts — это ещё прежнее значение, то есть на
                -- единицу меньше нового, и степень выходит ровно та, что нужна:
                -- после первой неудачи 5^0 = минута.
                next_attempt_at = now() + (
                  ($6::bigint * power(5, attempts)::bigint) * interval '1 millisecond')
          WHERE id = $1`,
        id,
        error.slice(0, 500),
        httpStatus,
        response ? cut(response) : null,
        ExchangeOutboxService.MAX_ATTEMPTS,
        String(ExchangeOutboxService.BACKOFF_BASE_MS),
      );
    });
  }

  /**
   * Повтор из журнала кнопкой. Счёт попыток обнуляется: человек нажал её не
   * для того, чтобы увидеть «попыток уже пять», а потому что на той стороне
   * починили. Срок — сейчас, иначе кнопка ничего не даёт в течение часа.
   */
  async retry(uid: string): Promise<{ uid: string; status: string }> {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: bigint; direction: string }[]>(
        // Компания названа прямо: RLS на `exchange_message` нет намеренно —
        // очередь проходит служба, у неё компании нет (миграция
        // 20261006190000_exchange_rls_fix). Без этой строки по чужому uid можно
        // было бы перезапустить обмен соседней компании.
        `SELECT id, direction FROM exchange_message
          WHERE uid = $1::uuid AND company_id = ANY (app.current_company_ids())`,
        uid,
      );
      const row = rows[0];
      if (!row) throw new NotFoundException(say('Обмен не найден', 'Almashinuv topilmadi'));
      await tx.$queryRawUnsafe(
        `UPDATE exchange_message
            SET status = 'pending', attempts = 0, next_attempt_at = now(),
                last_error = NULL, processed_at = NULL
          WHERE id = $1`,
        row.id,
      );
      return { uid, status: 'pending' };
    });
  }
}

/** Десять секунд: больше ждать чужой сервер незачем, очередь повторит. */
const DELIVER_TIMEOUT_MS = 10_000;

export interface Outgoing {
  id: bigint;
  uid: string;
  event: string;
  url: string;
  body: string;
  attempts: number;
  secret: string | null;
  systemCode: string;
}
