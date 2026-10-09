import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { say } from '../common/say.js';
import { writeAudit } from '../common/audit.js';
import { MSG_SYSTEM_NOT_FOUND } from './systems.service.js';
import { eventName } from './journal.service.js';

/**
 * Подписки внешних систем на события (ТЗ 12).
 *
 * Подписка — это пара «событие + адрес». Событие берётся из журнала действий
 * (см. `exchange/events.ts`), адрес указывает тот, кто заводит подключение.
 *
 * Адрес проверяется на схему: только `http` и `https`. Не придирка — `file://`
 * и `ftp://` в этом поле означали бы, что наш сервер по чужой настройке полезет
 * читать свой же диск.
 */
@Injectable()
export class ExchangeSubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(systemUid: string) {
    return this.prisma.withTenant(async (tx) => {
      await this.system(tx, systemUid);
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT w.uid, w.event, w.url, w.is_active, w.created_at,
                (SELECT count(*) FROM exchange_message m
                  WHERE m.system_id = w.system_id AND m.event = w.event
                    AND m.direction = 'out') AS sent
           FROM webhook_subscription w
           JOIN external_system s ON s.id = w.system_id
          WHERE s.uid = $1::uuid
          ORDER BY w.event`,
        systemUid,
      );
      return {
        rows: rows.map((r) => ({
          uid: r.uid,
          event: r.event,
          ...eventName(r.event),
          url: r.url,
          isActive: r.is_active,
          createdAt: r.created_at,
          sent: Number(r.sent ?? 0),
        })),
      };
    });
  }

  /**
   * Заведение или правка подписки. По паре «система + событие» она одна:
   * второй адрес на то же событие у той же системы означал бы, что обмен уходит
   * дважды, и на той стороне появились бы дубли.
   */
  async put(
    systemUid: string,
    input: { event: string; url: string; isActive?: boolean },
  ) {
    const url = input.url.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new UnprocessableEntityException(
        say('Адрес не разобран как ссылка', 'Manzil havola sifatida o‘qilmadi'),
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new UnprocessableEntityException(
        say(
          'Адрес подписки — только http или https',
          'Obuna manzili faqat http yoki https bo‘lishi mumkin',
        ),
      );
    }
    const event = input.event.trim();
    if (!/^[a-z_]+\.[a-z_.]+$/.test(event)) {
      throw new UnprocessableEntityException(
        say(
          'Код события — вида «сущность.действие», латиницей',
          'Hodisa kodi «obyekt.harakat» ko‘rinishida, lotin harflarida',
        ),
      );
    }

    return this.prisma.withTenant(async (tx) => {
      const sys = await this.system(tx, systemUid);
      const rows = await tx.$queryRawUnsafe<{ uid: string; url: string }[]>(
        `INSERT INTO webhook_subscription (company_id, system_id, event, url, is_active)
         VALUES ($1, $2, $3, $4, coalesce($5::boolean, true))
         ON CONFLICT (system_id, event) DO UPDATE
           SET url = excluded.url,
               is_active = coalesce($5::boolean, webhook_subscription.is_active)
         RETURNING uid, url`,
        sys.company_id,
        sys.id,
        event,
        url,
        input.isActive ?? null,
      );
      await writeAudit(tx, {
        companyId: sys.company_id,
        entityType: 'webhook_subscription',
        entityId: rows[0]!.uid,
        action: 'set',
        changes: { event: { from: null, to: event }, url: { from: null, to: url } },
      });
      return { uid: rows[0]!.uid, event, url };
    });
  }

  async remove(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: bigint }[]>(
        `DELETE FROM webhook_subscription WHERE uid = $1::uuid RETURNING id`,
        uid,
      );
      if (!rows[0]) {
        throw new NotFoundException(say('Подписка не найдена', 'Obuna topilmadi'));
      }
      return { uid, deleted: true as const };
    });
  }

  private async system(tx: Tx, uid: string) {
    const rows = await tx.$queryRawUnsafe<{ id: bigint; company_id: bigint }[]>(
      // Проверка компании своя: на `external_system` RLS нет намеренно
      // (миграция 20261006190000_exchange_rls_fix). Без неё по чужому uid можно
      // было бы подписать свой адрес на события соседней компании.
      `SELECT id, company_id FROM external_system
        WHERE uid = $1::uuid AND company_id = ANY (app.current_company_ids())`,
      uid,
    );
    if (!rows[0]) throw new NotFoundException(MSG_SYSTEM_NOT_FOUND());
    return rows[0];
  }
}
