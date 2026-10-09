import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { say } from '../common/say.js';
import { MSG_SYSTEM_NOT_FOUND } from './systems.service.js';

/**
 * Карта соответствий внешних и наших идентификаторов (ТЗ 12).
 *
 * Обязательна, и это не предосторожность на будущее: коды номенклатуры в 1С и
 * в системе не совпадут никогда. Без карты каждый обмен заводил бы ту же
 * позицию заново — и склад посчитал бы один швеллер дважды.
 *
 * Уникальность стоит в обе стороны, и оба индекса нужны. Только «чужой → наш» —
 * и наша позиция получит два чужих кода, то есть ровно тот дубль, от которого
 * карта и заводится. Только «наш → чужой» — и один чужой код ляжет на две наши
 * позиции, а это уже расхождение остатков.
 *
 * `upsert` сознательно не «перезаписывает молча»: смена уже проставленного
 * соответствия — это отдельное действие, и оно пишется в журнал действий.
 */
@Injectable()
export class ExchangeMappingService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: { systemUid?: string; entityType?: string; search?: string; limit: number }) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT r.uid, r.entity_type, r.external_id, r.internal_uid,
                r.created_at, r.updated_at,
                s.uid AS system_uid, s.code AS system_code, s.name AS system_name,
                co.uid AS company_uid, co.code AS company_code
           FROM external_ref r
           JOIN external_system s ON s.id = r.system_id
           JOIN company co ON co.id = r.company_id
          WHERE ($1::text IS NULL OR s.uid = $1::uuid)
            AND ($2::text IS NULL OR r.entity_type = $2::text)
            AND ($3::text = '' OR r.external_id ILIKE '%' || $3::text || '%'
                 OR r.internal_uid::text ILIKE '%' || $3::text || '%')
          ORDER BY s.code, r.entity_type, r.external_id
          LIMIT $4`,
        params.systemUid ?? null,
        params.entityType ?? null,
        params.search?.trim() ?? '',
        params.limit,
      );
      const total = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM external_ref r
           JOIN external_system s ON s.id = r.system_id
          WHERE ($1::text IS NULL OR s.uid = $1::uuid)
            AND ($2::text IS NULL OR r.entity_type = $2::text)`,
        params.systemUid ?? null,
        params.entityType ?? null,
      );
      return {
        total: Number(total[0]?.n ?? 0),
        rows: rows.map((r) => ({
          uid: r.uid,
          entityType: r.entity_type,
          externalId: r.external_id,
          internalUid: r.internal_uid,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          system: { uid: r.system_uid, code: r.system_code, name: r.system_name },
          company: { uid: r.company_uid, code: r.company_code },
        })),
      };
    });
  }

  /**
   * Проставить соответствие. Повторный обмен с тем же внешним кодом не плодит
   * строк: пара уже есть — возвращаем её, а не вторую такую же.
   *
   * А вот попытка привязать тот же внешний код к **другому** нашему объекту
   * (или наоборот) — это отказ, а не тихая перезапись. Тихая перезапись здесь
   * означала бы, что обмен молча перевёл историю одной позиции на другую.
   */
  async put(input: {
    systemUid: string;
    entityType: string;
    externalId: string;
    internalUid: string;
  }) {
    return this.prisma.withTenant(async (tx) => {
      const sys = await this.system(tx, input.systemUid);
      const entityType = input.entityType.trim();
      const externalId = input.externalId.trim();

      const had = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT uid, external_id, internal_uid FROM external_ref
          WHERE system_id = $1 AND entity_type = $2
            AND (external_id = $3 OR internal_uid = $4::uuid)`,
        sys.id,
        entityType,
        externalId,
        input.internalUid,
      );
      const clash = had.find(
        (r) => r.external_id !== externalId || r.internal_uid !== input.internalUid,
      );
      if (clash) {
        throw new ConflictException(
          say(
            `Соответствие занято: «${clash.external_id}» ↔ ${clash.internal_uid}. ` +
              'Снимите прежнее, прежде чем ставить новое',
            `Moslik band: «${clash.external_id}» ↔ ${clash.internal_uid}. ` +
              'Yangisini qo‘yishdan oldin avvalgisini olib tashlang',
          ),
        );
      }
      if (had[0]) {
        return { uid: had[0].uid, created: false };
      }

      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO external_ref
           (company_id, system_id, entity_type, external_id, internal_uid)
         VALUES ($1, $2, $3, $4, $5::uuid) RETURNING uid`,
        sys.company_id,
        sys.id,
        entityType,
        externalId,
        input.internalUid,
      );
      return { uid: rows[0]!.uid, created: true };
    });
  }

  async remove(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: bigint }[]>(
        `DELETE FROM external_ref WHERE uid = $1::uuid RETURNING id`,
        uid,
      );
      if (!rows[0]) {
        throw new NotFoundException(say('Соответствие не найдено', 'Moslik topilmadi'));
      }
      return { uid, deleted: true as const };
    });
  }

  private async system(tx: Tx, uid: string) {
    const rows = await tx.$queryRawUnsafe<{ id: bigint; company_id: bigint }[]>(
      // Проверка компании своя: на `external_system` RLS нет намеренно
      // (миграция 20261006190000_exchange_rls_fix).
      `SELECT id, company_id FROM external_system
        WHERE uid = $1::uuid AND company_id = ANY (app.current_company_ids())`,
      uid,
    );
    if (!rows[0]) throw new NotFoundException(MSG_SYSTEM_NOT_FOUND());
    return rows[0];
  }
}
