import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { diff, writeAudit } from '../common/audit.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Техкарты производства с версиями (ТЗ 4.1).
 *
 * Карта — это норма: из каких этапов состоит работа, сколько времени занимает
 * каждый и сколько материала уходит на единицу продукции. По ней в следующем
 * заходе развернутся этапы заказа, а позже посчитается себестоимость.
 *
 * Два правила держат всю эту службу:
 *
 * 1. **Действующую карту не правят — поднимают версию.** Заказ помнит
 *    `techCardVersion`, по которой его считали. Если менять норму на месте,
 *    вчерашняя себестоимость поедет задним числом, и объяснить расхождение
 *    будет нечем. Поэтому правка действующей карты отбивается, а «Новая
 *    версия» делает копию в черновике — её и правят.
 * 2. **На номенклатуре действует ровно одна карта.** Две активные означали бы,
 *    что при заведении заказа система выбирает норму сама и молча. Ввод новой
 *    в работу уводит прежнюю в архив.
 *
 * Удаления карт нет вовсе: на карту ссылаются заказы, и стереть норму значит
 * оставить заказ без объяснения, откуда взялись его этапы.
 *
 * **Нормы задаются на одну единицу продукции.** `output_qty` в модели оставлен
 * равным 1 и в этом заходе не редактируется: пока заказчик не сказал, что
 * нормирует партией («на 100 п.м.»), две трактовки одного поля — это способ
 * однажды посчитать расход в сто раз меньше. Записано в вопросах заказчику.
 */

export type TechCardStatusName = 'draft' | 'active' | 'archived';

/** Что производят, а не покупают: карту заводят только на это. */
const PRODUCIBLE = ['finished', 'semi'];

const MAX_STAGES = 50;
const MAX_MATERIALS = 100;

export type StageInput = {
  seq: number;
  nameRu: string;
  nameUz: string;
  workCenterCode?: string;
  normDurationMin: number;
  isParallel?: boolean;
  wastePercent?: string;
};

export type MaterialInput = {
  itemCode: string;
  qtyPerUnit: string;
  stageSeq?: number;
  isAutoWriteoff?: boolean;
};

export type CreateCardInput = {
  companyUid?: string;
  itemCode: string;
  nameRu: string;
  nameUz: string;
  stages?: StageInput[];
  materials?: MaterialInput[];
};

export type UpdateCardInput = {
  nameRu?: string;
  nameUz?: string;
  stages?: StageInput[];
  materials?: MaterialInput[];
};

export type CardBrief = {
  uid: string;
  itemCode: string;
  version: number;
  status: TechCardStatusName;
  nameRu: string;
  nameUz: string;
  stagesCount: number;
  materialsCount: number;
  totalDurationMin: number;
};

type CardRow = {
  id: bigint;
  uid: string;
  company_id: bigint;
  item_id: bigint;
  item_code: string;
  version: number;
  status: TechCardStatusName;
  name_ru: string;
  name_uz: string;
};

/**
 * Действующая карта номенклатуры. Отдельной функцией, а не методом службы:
 * ею пользуется заведение производственного заказа, и тащить ради одного
 * запроса ссылку на службу — значит связать два модуля зря.
 */
export async function activeCardFor(
  tx: Tx,
  companyId: bigint,
  itemId: bigint,
): Promise<{ id: bigint; version: number } | null> {
  const rows = await tx.$queryRaw<{ id: bigint; version: number }[]>`
    SELECT id, version FROM tech_card
     WHERE company_id = ${companyId} AND item_id = ${itemId} AND status = 'active'
     ORDER BY version DESC LIMIT 1`;
  return rows[0] ?? null;
}

@Injectable()
export class TechCardsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: { status?: TechCardStatusName; itemCode?: string; limit: number }) {
    this.requireView();
    return this.prisma.withTenant(async (tx) => {
      const status = params.status ?? null;
      const itemCode = params.itemCode?.trim() || null;
      const rows = await tx.$queryRaw<
        {
          uid: string;
          item_code: string;
          item_name_ru: string;
          item_name_uz: string;
          unit: string;
          version: number;
          status: TechCardStatusName;
          name_ru: string;
          name_uz: string;
          stages: number;
          materials: number;
          minutes: number;
          created_at: Date;
        }[]
      >`
        SELECT tc.uid::text AS uid, i.code AS item_code, i.name_ru AS item_name_ru,
               i.name_uz AS item_name_uz, u.code AS unit, tc.version,
               tc.status::text AS status, tc.name_ru, tc.name_uz, tc.created_at,
               (SELECT count(*)::int FROM tech_card_stage s WHERE s.tech_card_id = tc.id) AS stages,
               (SELECT count(*)::int FROM tech_card_material m WHERE m.tech_card_id = tc.id)
                 AS materials,
               (SELECT coalesce(sum(s.norm_duration_min), 0)::int FROM tech_card_stage s
                 WHERE s.tech_card_id = tc.id) AS minutes
          FROM tech_card tc
          JOIN item i ON i.id = tc.item_id
          JOIN unit u ON u.id = tc.output_unit_id
         WHERE (${status}::text IS NULL OR tc.status::text = ${status}::text)
           AND (${itemCode}::text IS NULL OR i.code = ${itemCode}::text)
         ORDER BY i.code, tc.version DESC
         LIMIT ${params.limit}`;

      return {
        rows: rows.map((c) => ({
          uid: c.uid,
          itemCode: c.item_code,
          itemNameRu: c.item_name_ru,
          itemNameUz: c.item_name_uz,
          unit: c.unit,
          version: c.version,
          status: c.status,
          nameRu: c.name_ru,
          nameUz: c.name_uz,
          stagesCount: c.stages,
          materialsCount: c.materials,
          totalDurationMin: c.minutes,
          createdAt: c.created_at.toISOString(),
        })),
      };
    });
  }

  async one(uid: string) {
    this.requireView();
    return this.prisma.withTenant(async (tx) => {
      const card = await this.cardRow(tx, uid);

      const stages = await tx.$queryRaw<
        {
          seq: number;
          name_ru: string;
          name_uz: string;
          norm_duration_min: number;
          is_parallel: boolean;
          waste_percent: string;
          wc_code: string | null;
          wc_name_ru: string | null;
          wc_name_uz: string | null;
        }[]
      >`
        SELECT s.seq, s.name_ru, s.name_uz, s.norm_duration_min, s.is_parallel,
               s.waste_percent::text AS waste_percent,
               w.code AS wc_code, w.name_ru AS wc_name_ru, w.name_uz AS wc_name_uz
          FROM tech_card_stage s
          LEFT JOIN work_center w ON w.id = s.work_center_id
         WHERE s.tech_card_id = ${card.id}
         ORDER BY s.seq`;

      const materials = await tx.$queryRaw<
        {
          item_code: string;
          item_name_ru: string;
          item_name_uz: string;
          unit: string;
          qty_per_unit: string;
          stage_seq: number | null;
          is_auto_writeoff: boolean;
        }[]
      >`
        SELECT i.code AS item_code, i.name_ru AS item_name_ru, i.name_uz AS item_name_uz,
               u.code AS unit, m.qty_per_unit::text AS qty_per_unit,
               s.seq AS stage_seq, m.is_auto_writeoff
          FROM tech_card_material m
          JOIN item i ON i.id = m.item_id
          JOIN unit u ON u.id = m.unit_id
          LEFT JOIN tech_card_stage s ON s.id = m.stage_id
         WHERE m.tech_card_id = ${card.id}
         ORDER BY s.seq NULLS FIRST, i.code`;

      const head = await tx.$queryRaw<
        {
          item_name_ru: string;
          item_name_uz: string;
          unit: string;
          created_at: Date;
          valid_from: Date | null;
        }[]
      >`
        SELECT i.name_ru AS item_name_ru, i.name_uz AS item_name_uz, u.code AS unit,
               tc.created_at, tc.valid_from
          FROM tech_card tc JOIN item i ON i.id = tc.item_id JOIN unit u ON u.id = tc.output_unit_id
         WHERE tc.id = ${card.id}`;

      /** Сколько версий у этой номенклатуры и какая из них сейчас действует. */
      const siblings = await tx.$queryRaw<
        { uid: string; version: number; status: TechCardStatusName }[]
      >`
        SELECT uid::text AS uid, version, status::text AS status FROM tech_card
         WHERE company_id = ${card.company_id} AND item_id = ${card.item_id}
         ORDER BY version DESC`;

      return {
        uid: card.uid,
        itemCode: card.item_code,
        itemNameRu: head[0].item_name_ru,
        itemNameUz: head[0].item_name_uz,
        unit: head[0].unit,
        version: card.version,
        status: card.status,
        nameRu: card.name_ru,
        nameUz: card.name_uz,
        createdAt: head[0].created_at.toISOString(),
        /** С какого момента карта стала нормой: ставится при вводе в работу. */
        validFrom: head[0].valid_from ? head[0].valid_from.toISOString() : null,
        /** Править можно только черновик — остальное уже служило нормой. */
        canEdit: card.status === 'draft',
        totalDurationMin: stages.reduce((sum, s) => sum + s.norm_duration_min, 0),
        stages: stages.map((s) => ({
          seq: s.seq,
          nameRu: s.name_ru,
          nameUz: s.name_uz,
          normDurationMin: s.norm_duration_min,
          isParallel: s.is_parallel,
          wastePercent: Number(s.waste_percent).toFixed(4),
          workCenterCode: s.wc_code,
          workCenterNameRu: s.wc_name_ru,
          workCenterNameUz: s.wc_name_uz,
        })),
        materials: materials.map((m) => ({
          itemCode: m.item_code,
          itemNameRu: m.item_name_ru,
          itemNameUz: m.item_name_uz,
          unit: m.unit,
          qtyPerUnit: Number(m.qty_per_unit).toFixed(6),
          stageSeq: m.stage_seq,
          isAutoWriteoff: m.is_auto_writeoff,
        })),
        versions: siblings,
      };
    });
  }

  async create(input: CreateCardInput): Promise<CardBrief> {
    const ctx = this.requireManage();

    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid, ctx.companyIds ?? []);
      const item = await this.producibleItem(tx, companyId, input.itemCode);
      const nameRu = this.text(input.nameRu, 'Название');
      const nameUz = this.text(input.nameUz, 'Nomi');

      await this.noOpenDraft(tx, companyId, item.id);

      const version = await this.nextVersion(tx, companyId, item.id);
      const made = await tx.$queryRaw<{ uid: string; id: bigint }[]>`
        INSERT INTO tech_card
          (uid, company_id, item_id, version, name_ru, name_uz, status, output_qty, output_unit_id)
        VALUES (gen_random_uuid(), ${companyId}, ${item.id}, ${version}, ${nameRu}, ${nameUz},
                'draft', 1, ${item.base_unit_id})
        RETURNING uid::text AS uid, id`;
      const uid = made[0].uid;

      if (input.stages || input.materials) {
        await this.replaceFilling(tx, companyId, made[0].id, item.id, {
          stages: input.stages,
          materials: input.materials,
        });
      }

      await writeAudit(tx, {
        companyId,
        entityType: 'tech_card',
        entityId: uid,
        action: 'create',
        changes: {
          itemCode: { from: null, to: item.code },
          version: { from: null, to: version },
          nameRu: { from: null, to: nameRu },
        },
      });

      return this.brief(tx, uid);
    });
  }

  async update(uid: string, patch: UpdateCardInput): Promise<CardBrief> {
    this.requireManage();

    return this.prisma.withTenant(async (tx) => {
      const card = await this.cardRow(tx, uid);
      this.mustBeDraft(card);

      const nameRu = patch.nameRu === undefined ? null : this.text(patch.nameRu, 'Название');
      const nameUz = patch.nameUz === undefined ? null : this.text(patch.nameUz, 'Nomi');

      await tx.$executeRaw`
        UPDATE tech_card
           SET name_ru = COALESCE(${nameRu}, name_ru),
               name_uz = COALESCE(${nameUz}, name_uz)
         WHERE id = ${card.id}`;

      const filled =
        patch.stages !== undefined || patch.materials !== undefined
          ? await this.replaceFilling(tx, card.company_id, card.id, card.item_id, patch)
          : null;

      await writeAudit(tx, {
        companyId: card.company_id,
        entityType: 'tech_card',
        entityId: uid,
        action: 'update',
        changes: {
          ...diff(
            { nameRu: card.name_ru, nameUz: card.name_uz },
            { nameRu: nameRu ?? undefined, nameUz: nameUz ?? undefined },
          ),
          itemCode: { from: null, to: card.item_code },
          version: { from: null, to: card.version },
          // Этапы и материалы в журнал строками не кладём: в журнале ищут
          // «кто и когда менял норму», а сама норма лежит в самой карте.
          ...(filled
            ? { stages: { from: null, to: filled.stages }, materials: { from: null, to: filled.materials } }
            : {}),
        },
      });

      return this.brief(tx, uid);
    });
  }

  /**
   * Новая версия: копия действующей карты в черновике.
   *
   * Копируем содержимое, а не отправляем человека заводить карту заново —
   * обычно правят один норматив из десяти, и перепечатывание остальных девяти
   * само по себе источник ошибок.
   */
  async newVersion(uid: string): Promise<CardBrief> {
    this.requireManage();

    return this.prisma.withTenant(async (tx) => {
      const card = await this.cardRow(tx, uid);
      if (card.status === 'draft') {
        throw new ConflictException(say(
          'Это и так черновик: правьте его, версия поднимается только у действующей карты', 'Bu allaqachon qoralama: uni tahrirlang, versiya faqat amaldagi kartada ko‘tariladi'));
      }

      await this.noOpenDraft(tx, card.company_id, card.item_id);

      const version = await this.nextVersion(tx, card.company_id, card.item_id);
      const made = await tx.$queryRaw<{ uid: string; id: bigint }[]>`
        INSERT INTO tech_card
          (uid, company_id, item_id, version, name_ru, name_uz, status, output_qty, output_unit_id)
        SELECT gen_random_uuid(), company_id, item_id, ${version}, name_ru, name_uz,
               'draft', output_qty, output_unit_id
          FROM tech_card WHERE id = ${card.id}
        RETURNING uid::text AS uid, id`;

      // Этапы копируются первыми: материал ссылается на этап, и сопоставление
      // идёт по номеру — он в карте уникален.
      await tx.$executeRaw`
        INSERT INTO tech_card_stage
          (tech_card_id, seq, name_ru, name_uz, work_center_id, norm_duration_min,
           is_parallel, waste_percent)
        SELECT ${made[0].id}, seq, name_ru, name_uz, work_center_id, norm_duration_min,
               is_parallel, waste_percent
          FROM tech_card_stage WHERE tech_card_id = ${card.id}`;

      await tx.$executeRaw`
        INSERT INTO tech_card_material
          (tech_card_id, stage_id, item_id, qty_per_unit, unit_id, is_auto_writeoff)
        SELECT ${made[0].id}, new_stage.id, m.item_id, m.qty_per_unit, m.unit_id, m.is_auto_writeoff
          FROM tech_card_material m
          LEFT JOIN tech_card_stage old_stage ON old_stage.id = m.stage_id
          LEFT JOIN tech_card_stage new_stage
                 ON new_stage.tech_card_id = ${made[0].id} AND new_stage.seq = old_stage.seq
         WHERE m.tech_card_id = ${card.id}`;

      await writeAudit(tx, {
        companyId: card.company_id,
        entityType: 'tech_card',
        entityId: made[0].uid,
        action: 'version',
        changes: {
          itemCode: { from: null, to: card.item_code },
          version: { from: card.version, to: version },
        },
      });

      return this.brief(tx, made[0].uid);
    });
  }

  /** Ввести карту в работу. Прежняя действующая уходит в архив. */
  async activate(uid: string): Promise<CardBrief> {
    this.requireManage();

    return this.prisma.withTenant(async (tx) => {
      const card = await this.cardRow(tx, uid);
      if (card.status !== 'draft') {
        throw new ConflictException(say(
          card.status === 'active'
            ? 'Карта уже в работе'
            : 'Карта в архиве: поднимите версию у действующей', card.status === 'active' ? 'Karta allaqachon ishda' : 'Karta arxivda: amaldagi kartada versiyani ko‘taring'));
      }

      const stages = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM tech_card_stage WHERE tech_card_id = ${card.id}`;
      if (Number(stages[0].n) === 0) {
        throw new ConflictException(say(
          'В карте нет ни одного этапа: нормировать нечего. Добавьте этапы и вводите в работу', 'Kartada birorta bosqich yo‘q: me’yorlash uchun narsa yo‘q. Bosqich qo‘shib, ishga tushiring'));
      }

      const previous = await tx.$queryRaw<{ uid: string; version: number }[]>`
        UPDATE tech_card SET status = 'archived'
         WHERE company_id = ${card.company_id} AND item_id = ${card.item_id}
           AND status = 'active' AND id <> ${card.id}
        RETURNING uid::text AS uid, version`;

      await tx.$executeRaw`
        UPDATE tech_card SET status = 'active', valid_from = now() WHERE id = ${card.id}`;

      await writeAudit(tx, {
        companyId: card.company_id,
        entityType: 'tech_card',
        entityId: uid,
        action: 'activate',
        changes: {
          itemCode: { from: null, to: card.item_code },
          status: { from: 'draft', to: 'active' },
          ...(previous[0]
            ? { previousVersion: { from: previous[0].version, to: 'в архиве' } }
            : {}),
        },
      });

      return this.brief(tx, uid);
    });
  }

  /** Архив вместо удаления: на карту ссылаются заказы. */
  async archive(uid: string): Promise<CardBrief> {
    this.requireManage();

    return this.prisma.withTenant(async (tx) => {
      const card = await this.cardRow(tx, uid);
      if (card.status === 'archived') throw new ConflictException(say('Карта уже в архиве', 'Karta allaqachon arxivda'));

      await tx.$executeRaw`UPDATE tech_card SET status = 'archived' WHERE id = ${card.id}`;

      await writeAudit(tx, {
        companyId: card.company_id,
        entityType: 'tech_card',
        entityId: uid,
        action: 'archive',
        changes: {
          itemCode: { from: null, to: card.item_code },
          status: { from: card.status, to: 'archived' },
        },
      });

      return this.brief(tx, uid);
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Этапы и материалы заменяются целиком, а не по строке.
   *
   * Правка нормы — это правка целого: убрали этап, перенумеровали остальные,
   * сдвинули материал. Отдельные маршруты на строку заставили бы экран
   * выстраивать порядок вызовов, и половина правки доезжала бы при обрыве.
   */
  private async replaceFilling(
    tx: Tx,
    companyId: bigint,
    cardId: bigint,
    itemId: bigint,
    patch: { stages?: StageInput[]; materials?: MaterialInput[] },
  ): Promise<{ stages: number; materials: number }> {
    // Состав, который должен получиться: не присланное берём из карты как есть.
    const stages = patch.stages ?? (await this.currentStages(tx, cardId));
    const materials = patch.materials ?? (await this.currentMaterials(tx, cardId));

    if (stages.length > MAX_STAGES) {
      throw new UnprocessableEntityException(say(`Этапов в карте не больше ${MAX_STAGES}`, `Kartada bosqichlar ${MAX_STAGES} dan oshmasin`));
    }
    if (materials.length > MAX_MATERIALS) {
      throw new UnprocessableEntityException(say(`Материалов в карте не больше ${MAX_MATERIALS}`, `Kartada materiallar ${MAX_MATERIALS} dan oshmasin`));
    }

    // Номера этапов — порядок работы, а не произвольные метки. Дыра в
    // нумерации означает, что этап потеряли при правке.
    const seqs = stages.map((s) => s.seq).sort((a, b) => a - b);
    for (let i = 0; i < seqs.length; i += 1) {
      if (seqs[i] !== i + 1) {
        throw new UnprocessableEntityException(say(
          `Этапы нумеруются подряд с 1: пришло ${seqs.join(', ') || '(пусто)'}`, `Bosqichlar 1 dan ketma-ket raqamlanadi: kelgani ${seqs.join(', ') || '(bo‘sh)'}`));
      }
    }

    await tx.$executeRaw`DELETE FROM tech_card_material WHERE tech_card_id = ${cardId}`;
    await tx.$executeRaw`DELETE FROM tech_card_stage WHERE tech_card_id = ${cardId}`;

    const stageIdBySeq = new Map<number, bigint>();
    for (const raw of stages) {
      const workCenterId = raw.workCenterCode
        ? await this.workCenterId(tx, companyId, raw.workCenterCode)
        : null;
      const minutes = this.minutes(raw.normDurationMin);
      const waste = this.percent(raw.wastePercent);
      const made = await tx.$queryRaw<{ id: bigint }[]>`
        INSERT INTO tech_card_stage
          (tech_card_id, seq, name_ru, name_uz, work_center_id, norm_duration_min,
           is_parallel, waste_percent)
        VALUES (${cardId}, ${raw.seq}, ${this.text(raw.nameRu, 'Название этапа')},
                ${this.text(raw.nameUz, 'Bosqich nomi')}, ${workCenterId}, ${minutes},
                ${raw.isParallel ?? false}, ${waste}::numeric)
        RETURNING id`;
      stageIdBySeq.set(raw.seq, made[0].id);
    }

    for (const raw of materials) {
      const item = await this.materialItem(tx, companyId, raw.itemCode, itemId);
      const qty = this.qty(raw.qtyPerUnit);
      let stageId: bigint | null = null;
      if (raw.stageSeq !== undefined && raw.stageSeq !== null) {
        stageId = stageIdBySeq.get(raw.stageSeq) ?? null;
        if (stageId === null) {
          throw new UnprocessableEntityException(say(
            `Материал ${raw.itemCode} привязан к этапу ${raw.stageSeq}, а такого этапа в карте нет`, `${raw.itemCode} materiali ${raw.stageSeq}-bosqichga bog‘langan, ammo kartada bunday bosqich yo‘q`));
        }
      }
      await tx.$executeRaw`
        INSERT INTO tech_card_material
          (tech_card_id, stage_id, item_id, qty_per_unit, unit_id, is_auto_writeoff)
        VALUES (${cardId}, ${stageId}, ${item.id}, ${qty}::numeric, ${item.base_unit_id},
                ${raw.isAutoWriteoff ?? true})`;
    }

    return { stages: stages.length, materials: materials.length };
  }

  private async currentStages(tx: Tx, cardId: bigint): Promise<StageInput[]> {
    const rows = await tx.$queryRaw<
      {
        seq: number;
        name_ru: string;
        name_uz: string;
        code: string | null;
        norm_duration_min: number;
        is_parallel: boolean;
        waste_percent: string;
      }[]
    >`
      SELECT s.seq, s.name_ru, s.name_uz, w.code, s.norm_duration_min, s.is_parallel,
             s.waste_percent::text AS waste_percent
        FROM tech_card_stage s LEFT JOIN work_center w ON w.id = s.work_center_id
       WHERE s.tech_card_id = ${cardId} ORDER BY s.seq`;
    return rows.map((s) => ({
      seq: s.seq,
      nameRu: s.name_ru,
      nameUz: s.name_uz,
      workCenterCode: s.code ?? undefined,
      normDurationMin: s.norm_duration_min,
      isParallel: s.is_parallel,
      wastePercent: s.waste_percent,
    }));
  }

  private async currentMaterials(tx: Tx, cardId: bigint): Promise<MaterialInput[]> {
    const rows = await tx.$queryRaw<
      { code: string; qty_per_unit: string; seq: number | null; is_auto_writeoff: boolean }[]
    >`
      SELECT i.code, m.qty_per_unit::text AS qty_per_unit, s.seq, m.is_auto_writeoff
        FROM tech_card_material m
        JOIN item i ON i.id = m.item_id
        LEFT JOIN tech_card_stage s ON s.id = m.stage_id
       WHERE m.tech_card_id = ${cardId}`;
    return rows.map((m) => ({
      itemCode: m.code,
      qtyPerUnit: m.qty_per_unit,
      stageSeq: m.seq ?? undefined,
      isAutoWriteoff: m.is_auto_writeoff,
    }));
  }

  private requireView() {
    const ctx = currentContext();
    if (!ctx?.permissions.has('production.view')) {
      throw new ForbiddenException(MSG.noRight('production.view'));
    }
    return ctx;
  }

  private requireManage() {
    const ctx = currentContext();
    if (!ctx?.permissions.has('production.manage')) {
      throw new ForbiddenException(MSG.noRight('production.manage'));
    }
    return ctx;
  }

  private mustBeDraft(card: CardRow) {
    if (card.status === 'draft') return;
    throw new ConflictException(say(
      card.status === 'active'
        ? `Карта ${card.item_code} v${card.version} в работе: правка поедет в уже заведённые ` +
          'заказы. Поднимите версию — нажмите «Новая версия» и правьте копию'
        : `Карта ${card.item_code} v${card.version} в архиве: править её нечего, ` +
          'поднимите версию у действующей', card.status === 'active' ? `${card.item_code} v${card.version} kartasi ishda: tahrir allaqachon kiritilgan ` + 'buyurtmalarga ham ketadi. Versiyani ko‘taring — «Yangi versiya» ni bosib, nusxani tahrirlang' : `${card.item_code} v${card.version} kartasi arxivda: uni tahrirlashga hojat yo‘q, ` + 'amaldagi kartada versiyani ko‘taring'));
  }

  private async cardRow(tx: Tx, uid: string): Promise<CardRow> {
    if (!/^[0-9a-f-]{36}$/i.test(uid)) throw new NotFoundException(MSG.techCardNotFound());
    const rows = await tx.$queryRaw<CardRow[]>`
      SELECT tc.id, tc.uid::text AS uid, tc.company_id, tc.item_id, i.code AS item_code,
             tc.version, tc.status::text AS status, tc.name_ru, tc.name_uz
        FROM tech_card tc JOIN item i ON i.id = tc.item_id
       WHERE tc.uid = ${uid}::uuid`;
    if (!rows[0]) throw new NotFoundException(MSG.techCardNotFound());
    return rows[0];
  }

  private async brief(tx: Tx, uid: string): Promise<CardBrief> {
    const rows = await tx.$queryRaw<
      {
        uid: string;
        item_code: string;
        version: number;
        status: TechCardStatusName;
        name_ru: string;
        name_uz: string;
        stages: number;
        materials: number;
        minutes: number;
      }[]
    >`
      SELECT tc.uid::text AS uid, i.code AS item_code, tc.version, tc.status::text AS status,
             tc.name_ru, tc.name_uz,
             (SELECT count(*)::int FROM tech_card_stage s WHERE s.tech_card_id = tc.id) AS stages,
             (SELECT count(*)::int FROM tech_card_material m WHERE m.tech_card_id = tc.id)
               AS materials,
             (SELECT coalesce(sum(s.norm_duration_min), 0)::int FROM tech_card_stage s
               WHERE s.tech_card_id = tc.id) AS minutes
        FROM tech_card tc JOIN item i ON i.id = tc.item_id
       WHERE tc.uid = ${uid}::uuid`;
    const r = rows[0]!;
    return {
      uid: r.uid,
      itemCode: r.item_code,
      version: r.version,
      status: r.status,
      nameRu: r.name_ru,
      nameUz: r.name_uz,
      stagesCount: r.stages,
      materialsCount: r.materials,
      totalDurationMin: r.minutes,
    };
  }

  /**
   * Незаконченный черновик на номенклатуре может быть только один.
   *
   * Иначе «Новая версия», нажатая дважды, оставляет в справочнике хвост
   * полуготовых карт, и на вопрос «где я правил норму» ответа нет. Правило
   * одно и для заведения, и для поднятия версии — разные ответы на одно и то
   * же действие объяснить нельзя.
   */
  private async noOpenDraft(tx: Tx, companyId: bigint, itemId: bigint): Promise<void> {
    const open = await tx.$queryRaw<{ version: number }[]>`
      SELECT version FROM tech_card
       WHERE company_id = ${companyId} AND item_id = ${itemId} AND status = 'draft'
       ORDER BY version DESC LIMIT 1`;
    if (open[0]) {
      throw new ConflictException(say(
        `По этой номенклатуре уже есть незаконченный черновик (версия ${open[0].version}): ` +
          'доработайте его и введите в работу или заархивируйте', `Bu nomenklatura bo‘yicha tugallanmagan qoralama bor (versiya ${open[0].version}): ` + 'uni tugatib ishga tushiring yoki arxivga oling'));
    }
  }

  private async nextVersion(tx: Tx, companyId: bigint, itemId: bigint): Promise<number> {
    // Блокировка на номенклатуру: два одновременных заведения получили бы одну
    // версию, а на `(company_id, item_id, version)` стоит уникальный индекс.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`${companyId}:tech-card:${itemId}`}))`;
    const rows = await tx.$queryRaw<{ next: number }[]>`
      SELECT coalesce(max(version), 0) + 1 AS next FROM tech_card
       WHERE company_id = ${companyId} AND item_id = ${itemId}`;
    return rows[0].next;
  }

  private async resolveCompany(
    tx: Tx,
    companyUid: string | undefined,
    allowed: readonly bigint[],
  ): Promise<bigint> {
    if (!companyUid) {
      if (allowed.length === 1) return allowed[0];
      throw new BadRequestException(
        MSG.pickCompany(),
      );
    }
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM company WHERE uid = ${companyUid}::uuid`;
    const id = rows[0]?.id;
    if (!id || !allowed.some((a) => a === id)) {
      throw new UnprocessableEntityException(MSG.companyUnavailable());
    }
    return id;
  }

  private async producibleItem(tx: Tx, companyId: bigint, code: string) {
    const rows = await tx.$queryRaw<
      { id: bigint; code: string; item_type: string; base_unit_id: bigint; is_active: boolean }[]
    >`
      SELECT id, code, item_type::text AS item_type, base_unit_id, is_active
        FROM item WHERE company_id = ${companyId} AND code = ${String(code).trim()}`;
    const item = rows[0];
    if (!item) throw new UnprocessableEntityException(MSG.itemNotFound(code));
    if (!item.is_active) {
      throw new UnprocessableEntityException(MSG.itemArchived(code));
    }
    if (!PRODUCIBLE.includes(item.item_type)) {
      throw new UnprocessableEntityException(say(
        `Номенклатуру ${code} завод не производит (тип «${item.item_type}»): ` +
          'карту заводят на готовую продукцию или полуфабрикат', `${code} nomenklaturasini zavod ishlab chiqarmaydi (turi «${item.item_type}»): ` + 'karta tayyor mahsulot yoki yarim tayyor mahsulotga kiritiladi'));
    }
    return item;
  }

  private async materialItem(tx: Tx, companyId: bigint, code: string, cardItemId: bigint) {
    const rows = await tx.$queryRaw<
      { id: bigint; base_unit_id: bigint; is_active: boolean }[]
    >`
      SELECT id, base_unit_id, is_active FROM item
       WHERE company_id = ${companyId} AND code = ${String(code).trim()}`;
    const item = rows[0];
    if (!item) throw new UnprocessableEntityException(MSG.materialNotFound(code));
    if (!item.is_active) throw new UnprocessableEntityException(MSG.materialArchived(code));
    if (item.id === cardItemId) {
      throw new UnprocessableEntityException(say(
        `${code} — это и есть продукция карты: сама из себя она не делается`, `${code} — bu kartaning o‘z mahsuloti: o‘zidan o‘zi tayyorlanmaydi`));
    }
    return item;
  }

  private async workCenterId(tx: Tx, companyId: bigint, code: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM work_center
       WHERE company_id = ${companyId} AND code = ${String(code).trim()} AND is_active`;
    if (!rows[0]) {
      throw new UnprocessableEntityException(say(`Рабочий центр ${code} не найден или выключен`, `${code} ish markazi topilmadi yoki o‘chirilgan`));
    }
    return rows[0].id;
  }

  private text(raw: string, what: string): string {
    const value = String(raw ?? '').trim();
    if (value === '') throw new UnprocessableEntityException(say(`${what}: пустая строка не годится`, `${what}: bo‘sh satr to‘g‘ri kelmaydi`));
    if (value.length > 200) throw new UnprocessableEntityException(say(`${what} длиннее 200 знаков`, `${what} 200 belgidan uzun`));
    return value;
  }

  private minutes(raw: number): number {
    if (!Number.isInteger(raw) || raw < 0 || raw > 100_000) {
      throw new UnprocessableEntityException(say(
        'Норма времени этапа — целое число минут от 0 до 100 000', 'Bosqich vaqt me’yori — 0 dan 100 000 gacha butun daqiqa'));
    }
    return raw;
  }

  private percent(raw: string | undefined): string {
    if (raw === undefined || raw === '') return '0';
    const value = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new UnprocessableEntityException(say('Процент отхода — число от 0 до 100', 'Chiqindi foizi — 0 dan 100 gacha son'));
    }
    return value.toFixed(4);
  }

  private qty(raw: string): string {
    const value = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      throw new UnprocessableEntityException(say('Норма расхода должна быть числом больше нуля', 'Sarf me’yori noldan katta son bo‘lishi kerak'));
    }
    if (value > 1e9) throw new UnprocessableEntityException(say('Норма расхода слишком велика', 'Sarf me’yori juda katta'));
    return value.toFixed(6);
  }
}
