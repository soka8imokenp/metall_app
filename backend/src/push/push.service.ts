import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { DevicesService } from '../auth/devices.service.js';
import { KINDS } from '../notifications/kinds.js';

/**
 * Push-уведомления на телефоны (ТЗ 10: «push-уведомления о заданиях,
 * согласованиях и изменениях статусов»; 06-BACKEND §7: «через тот же outbox»).
 *
 * Тексты не сочиняются заново: это те же строки `notification_outbox`, что
 * уходят в Telegram, — та же сборка, те же права, те же личные выключатели.
 * У push своя отметка (`push_sent_at`): одно уведомление может дойти в бот
 * и не дойти на телефон, и наоборот.
 *
 * **Чем доставляем.** Служба Expo (`exp.host`): приложение собрано на Expo,
 * и её адрес принимает токены и Android (FCM), и iPhone (APNs). Ключи FCM и
 * APNs заводятся в аккаунте Expo, а не здесь. Подменить на прямой FCM — одна
 * функция `PUSH_SEND`.
 *
 * **Чего не шлём.** Уведомления, собранные раньше, чем телефон зарегистрировался:
 * иначе первый вход вывалил бы человеку всю историю очереди.
 */

export const PUSH_SEND = 'PUSH_SEND';

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}
/** Результат на каждое сообщение: дошло или почему нет. */
export type PushTicket = { ok: true } | { ok: false; error: string; deadToken?: boolean };
export type PushSend = (messages: PushMessage[]) => Promise<PushTicket[]>;

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';

export const expoPushSend: PushSend = async (messages) => {
  const res = await fetch(EXPO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages.map((m) => ({ ...m, sound: 'default', priority: 'high' }))),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`push: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { status: string; message?: string; details?: { error?: string } }[] };
  return (json.data ?? []).map((t) =>
    t.status === 'ok'
      ? { ok: true as const }
      : { ok: false as const, error: t.details?.error ?? t.message ?? 'error', deadToken: t.details?.error === 'DeviceNotRegistered' },
  );
};

/** Сколько раз пробуем, прежде чем оставить строку. */
const MAX_ATTEMPTS = 5;
/** Не больше стольких уведомлений человеку за проход: пачка из двадцати — это шум. */
const PER_USER = 3;

interface Row {
  id: bigint;
  user_id: bigint;
  kind: string;
  text_ru: string;
  text_uz: string;
  locale: string;
  tokens: string[];
}

@Injectable()
export class PushService {
  private readonly log = new Logger('push');

  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
    @Inject(PUSH_SEND) private readonly send: PushSend,
  ) {}

  /** Один проход доставки. Возвращает, сколько уведомлений ушло. */
  async deliver(limit = 50): Promise<number> {
    const rows = await this.pending(limit);
    if (rows.length === 0) return 0;

    const messages: PushMessage[] = [];
    const owner: { row: Row; token: string }[] = [];
    for (const row of rows) {
      const uz = row.locale === 'uz';
      const kind = KINDS.find((k) => k.kind === row.kind);
      for (const token of row.tokens) {
        messages.push({
          to: token,
          title: kind ? (uz ? kind.uz : kind.ru) : 'METALL ASIA',
          body: uz ? row.text_uz : row.text_ru,
          data: { kind: row.kind, outboxId: String(row.id) },
        });
        owner.push({ row, token });
      }
    }

    let tickets: PushTicket[];
    try {
      tickets = await this.send(messages);
    } catch (e) {
      const error = (e as Error).message;
      for (const row of rows) await this.mark(row.id, false, error);
      this.log.warn(`доставка не удалась: ${error}`);
      return 0;
    }

    // Строка считается доставленной, если дошла хотя бы до одного телефона человека.
    const result = new Map<bigint, { ok: boolean; error: string | null }>();
    tickets.forEach((t, i) => {
      const o = owner[i];
      if (!o) return;
      const prev = result.get(o.row.id) ?? { ok: false, error: null };
      if (t.ok) prev.ok = true;
      else {
        prev.error = t.error;
        if (t.deadToken) void this.devices.dropPushToken(o.token);
      }
      result.set(o.row.id, prev);
    });
    let sent = 0;
    for (const row of rows) {
      const r = result.get(row.id) ?? { ok: false, error: 'no ticket' };
      await this.mark(row.id, r.ok, r.ok ? null : r.error);
      if (r.ok) sent += 1;
    }
    if (sent) this.log.log(`push: отправлено ${sent}`);
    return sent;
  }

  /**
   * Что ждёт доставки на телефоны. По `PER_USER` на человека, только живые
   * телефоны с push-адресом и только то, что собрано после регистрации телефона.
   */
  private pending(limit: number): Promise<Row[]> {
    return this.prisma.withContext(null, [], (tx) =>
      tx.$queryRaw<Row[]>`
        SELECT id, user_id, kind, text_ru, text_uz, locale, tokens FROM (
          SELECT o.id, o.user_id, o.kind, o.text_ru, o.text_uz, u.locale::text AS locale, o.created_at,
                 array_agg(DISTINCT d.push_token) AS tokens,
                 row_number() OVER (PARTITION BY o.user_id ORDER BY o.created_at) AS rn
            FROM notification_outbox o
            JOIN user_account u ON u.id = o.user_id AND u.is_active
            JOIN device d ON d.user_id = o.user_id
                         AND d.push_token IS NOT NULL
                         AND d.revoked_at IS NULL
                         AND o.created_at >= d.created_at
           WHERE o.push_sent_at IS NULL
             AND o.push_attempts < ${MAX_ATTEMPTS}
           GROUP BY o.id, u.locale
        ) q
         WHERE q.rn <= ${PER_USER}
         ORDER BY q.created_at
         LIMIT ${limit}`,
    );
  }

  private mark(id: bigint, ok: boolean, error: string | null) {
    return this.prisma.withContext(null, [], (tx) =>
      ok
        ? tx.$executeRaw`UPDATE notification_outbox SET push_sent_at = now(), push_attempts = push_attempts + 1, push_error = NULL WHERE id = ${id}`
        : tx.$executeRaw`UPDATE notification_outbox SET push_attempts = push_attempts + 1, push_error = ${(error ?? '').slice(0, 500)} WHERE id = ${id}`,
    );
  }
}
