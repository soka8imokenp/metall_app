import {
  ForbiddenException,
  Injectable,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';
import { hashKey } from './systems.service.js';
import { cut } from './events.js';

/**
 * Приём входящих вебхуков (ТЗ 12).
 *
 * Второй и последний маршрут системы, открытый без входа (первый — заявки с
 * сайта, `public/public-leads.service.ts`), и устроен он по тому же образцу:
 * ключ в запросе, ограничение частоты в памяти процесса, ответ без данных о
 * системе. Разница в том, что здесь ключ — настоящий секрет, и к нему
 * добавлены две вещи, которых у заявок с сайта быть не могло:
 *
 *   - **подпись.** Если у подключения задан секрет, тело должно быть подписано
 *     HMAC-SHA256 по тем самым байтам, что пришли. Поэтому тело разбирается из
 *     сырого буфера, а не из уже распарсенного JSON: `JSON.parse` и обратно
 *     даёт другие байты, и подпись не сойдётся никогда;
 *   - **идемпотентность.** Повтор сообщения с тем же внешним идентификатором не
 *     создаёт второй записи. Это не удобство, а требование: чужая очередь
 *     повторяет доставку, когда наш ответ не дошёл, хотя обмен уже принят.
 *
 * Чего здесь сознательно нет: разбора содержимого под конкретную систему.
 * Сообщение принимается, кладётся в журнал и считается принятым. Что с ним
 * делать дальше, решает коннектор, и коннектора нет — по 1С, REGOS, банку и
 * телефонии нет ни доступа, ни документации (ТЗ 12). Каркас при этом работает:
 * обмен виден, не теряется и не удваивается.
 */
@Injectable()
export class ExchangeInboundService {
  constructor(private readonly prisma: PrismaService) {}

  /** Счётчики частоты: окно в минуту, в памяти процесса — как у заявок с сайта. */
  private readonly hits = new Map<string, { n: number; until: number }>();

  private tooOften(key: string, limit: number): boolean {
    const now = Date.now();
    const cur = this.hits.get(key);
    if (!cur || cur.until < now) {
      this.hits.set(key, { n: 1, until: now + 60_000 });
      if (this.hits.size > 5000) {
        for (const [k, v] of this.hits) if (v.until < now) this.hits.delete(k);
      }
      return false;
    }
    cur.n += 1;
    return cur.n > limit;
  }

  async intake(
    code: string,
    bytes: Buffer | null,
    meta: {
      key?: string;
      signature?: string;
      messageId?: string;
      event?: string;
      ip?: string;
    },
  ): Promise<{ accepted: true; duplicate: boolean; uid: string }> {
    if (!bytes || bytes.length === 0) throw new UnprocessableEntityException(MSG.emptyBody());
    /**
     * Предел тела назван здесь, а не только в express: `raw()` при превышении
     * обрывает запрос, и чужая система видит сетевую ошибку вместо причины.
     * Предел express поднят на знак выше — чтобы сюда доходило и объясняло себя.
     */
    if (bytes.length > BODY_MAX) {
      throw new PayloadTooLargeException(
        say(
          `Тело запроса больше ${Math.round(BODY_MAX / 1024)} КБ`,
          `So‘rov tanasi ${Math.round(BODY_MAX / 1024)} KB dan katta`,
        ),
      );
    }
    // В локальную переменную, а не `meta.key` внутри замыкания: поле объекта
    // TypeScript через колбэк не сужает, и внутри оно снова «может быть пусто».
    const givenKey = meta.key;
    if (!givenKey) throw new ForbiddenException(KEY_BAD());

    const system = await this.prisma.withContext(null, [], async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        {
          id: bigint;
          company_id: bigint;
          code: string;
          signing_secret: string | null;
          allowed_ips: string[];
        }[]
      >(
        `SELECT id, company_id, code, signing_secret, allowed_ips
           FROM external_system WHERE key_hash = $1 AND is_active`,
        hashKey(givenKey),
      );
      return rows[0] ?? null;
    });
    // Ключ не тот или подключение выключено — ответ один и тот же: чужой
    // системе незачем знать, существует ли код подключения вообще.
    if (!system || system.code !== code.trim().toLowerCase()) {
      throw new ForbiddenException(KEY_BAD());
    }

    if (meta.ip && this.tooOften(`ip:${meta.ip}`, 300)) {
      throw new ForbiddenException(MSG.tooOften());
    }
    if (this.tooOften(`sys:${system.code}`, 600)) {
      throw new ForbiddenException(MSG.tooOften());
    }

    // Список адресов — там, где он задан. Пустой список означает «откуда
    // угодно», и это осознанный выбор того, кто заводил подключение.
    if (system.allowed_ips.length && meta.ip) {
      if (!system.allowed_ips.some((a) => a.trim() === meta.ip)) {
        throw new ForbiddenException(
          say(
            'Этот адрес не указан у подключения',
            'Bu manzil ulanishda ko‘rsatilmagan',
          ),
        );
      }
    }

    if (system.signing_secret) {
      if (!meta.signature || !signatureOk(bytes, meta.signature, system.signing_secret)) {
        throw new ForbiddenException(
          say('Подпись запроса не сошлась', 'So‘rov imzosi to‘g‘ri kelmadi'),
        );
      }
    }

    const text = bytes.toString('utf8');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new UnprocessableEntityException(
        say('Тело запроса — не JSON', 'So‘rov tanasi JSON emas'),
      );
    }

    /**
     * Внешний идентификатор сообщения: из заголовка или из тела. Заголовок
     * главнее — его ставит тот, кто отправляет, а поле в теле могло приехать
     * из прикладных данных и означать что-то своё.
     */
    const externalId =
      clean(meta.messageId) ?? clean(parsed.messageId) ?? clean(parsed.id) ?? null;
    const event = clean(meta.event) ?? clean(parsed.event) ?? 'inbound';

    return this.prisma.withContext(null, [system.company_id], async (tx) => {
      /**
       * Идемпотентность держит уникальный индекс в базе, а не проверка «есть
       * ли такая строка» перед вставкой: две доставки приходят одновременно,
       * обе проверяют, обе не находят и обе вставляют. Проверку обходит гонка,
       * индекс — нет.
       */
      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO exchange_message
           (company_id, system_id, direction, event, external_id, status,
            request_body, processed_at)
         VALUES ($1, $2, 'in', $3, $4, 'done', $5, now())
         ON CONFLICT (system_id, direction, external_id)
           WHERE external_id IS NOT NULL
           DO NOTHING
         RETURNING uid`,
        system.company_id,
        system.id,
        event,
        externalId,
        cut(text),
      );

      if (!rows[0]) {
        // Повтор. Отвечаем успехом и отдаём uid уже принятого сообщения: для
        // отправителя это та же удача, иначе его очередь будет повторять вечно.
        const had = await tx.$queryRawUnsafe<{ uid: string }[]>(
          `SELECT uid FROM exchange_message
            WHERE system_id = $1 AND direction = 'in' AND external_id = $2`,
          system.id,
          externalId,
        );
        return { accepted: true as const, duplicate: true, uid: had[0]!.uid };
      }

      await tx.$queryRawUnsafe(
        `UPDATE external_system SET used_count = used_count + 1, last_used_at = now()
          WHERE id = $1`,
        system.id,
      );
      return { accepted: true as const, duplicate: false, uid: rows[0].uid };
    });
  }
}

/** 1 МиБ. Вебхук — это событие, а не файл: файлы идут импортом. */
export const BODY_MAX = 1024 * 1024;

const KEY_BAD = () => say('Ключ подключения не распознан', 'Ulanish kaliti aniqlanmadi');

const clean = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s ? s.slice(0, 200) : null;
};

/**
 * Сверка подписи постоянным по времени сравнением: обычное `===` на строках
 * отвечает тем быстрее, чем раньше расходятся байты, и по времени ответа
 * подпись подбирается знак за знаком.
 */
function signatureOk(bytes: Buffer, given: string, secret: string): boolean {
  const want = createHmac('sha256', secret).update(bytes).digest('hex');
  const got = given.trim().replace(/^sha256=/i, '').toLowerCase();
  const a = Buffer.from(want, 'utf8');
  const b = Buffer.from(got, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
