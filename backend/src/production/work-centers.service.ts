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
import { writeAudit } from '../common/audit.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Справочник участков (ТЗ 4.1, Э8).
 *
 * До этого захода рабочие центры жили только в посеве: завести новый станок
 * или поставить ставку часа было нельзя — а без ставки прямые затраты заказа
 * считаются нулём (Э6). Теперь это обычный справочник с правом на запись.
 *
 * Решения:
 *
 * - **участок адресуется кодом, а не uid.** Кода у него нет случайно: код —
 *   это то, чем участок называют в цеху, и он уникален в компании;
 * - **удаления нет, только архив.** На участок ссылаются этапы заказов и
 *   техкарты: удалить его значит стереть историю работы;
 * - **в архив не уходит занятый участок.** Пока на нём есть незакрытый этап,
 *   «закрыть» значило бы спрятать то, что прямо сейчас работает.
 */

export type WorkCenterRow = {
  code: string;
  nameRu: string;
  nameUz: string;
  capacityPerShift: string;
  costPerHour: string;
  isActive: boolean;
  /** Сколько незакрытых этапов на нём висит: по ним его и не архивируют. */
  openStages: number;
};

export type WorkCenterInput = {
  code: string;
  nameRu: string;
  nameUz: string;
  capacityPerShift?: string;
  costPerHour?: string;
  isActive?: boolean;
};

const qty = (v: unknown) => Number(v ?? 0).toFixed(6);
const money = (v: unknown) => Number(v ?? 0).toFixed(4);

@Injectable()
export class WorkCentersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<WorkCenterRow[]> {
    this.require('production.view');
    return this.prisma.withTenant(async (tx) => this.rows(tx));
  }

  async save(input: WorkCenterInput, code?: string): Promise<WorkCenterRow[]> {
    const ctx = this.require('production.manage');
    const next = String(input.code ?? '').trim();
    if (!next) {
      throw new UnprocessableEntityException(say('У участка должен быть код: им его называют в цеху', 'Uchastkaning kodi bo‘lishi kerak: sexda uni shu kod bilan ataydi'));
    }
    const capacity = Number(input.capacityPerShift ?? 0);
    const rate = Number(input.costPerHour ?? 0);
    if (!Number.isFinite(capacity) || capacity < 0) {
      throw new UnprocessableEntityException(say('Сменная мощность — число не меньше нуля', 'Smena quvvati — noldan kichik bo‘lmagan son'));
    }
    if (!Number.isFinite(rate) || rate < 0) {
      throw new UnprocessableEntityException(say('Стоимость часа — число не меньше нуля', 'Soat qiymati — noldan kichik bo‘lmagan son'));
    }

    return this.prisma.withTenant(async (tx) => {
      const companyId = this.company();
      const twin = await tx.$queryRaw<{ code: string }[]>`
        SELECT code FROM work_center
         WHERE company_id = ${companyId} AND code = ${next}
           AND (${code ?? null}::text IS NULL OR code <> ${code ?? null})`;
      if (twin.length > 0) {
        throw new ConflictException(say(`Участок с кодом ${next} уже заведён`, `${next} kodli uchastka allaqachon kiritilgan`));
      }

      if (code) {
        const was = await this.one(tx, companyId, code);
        // Закрывают участок только тогда, когда на нём нечего закрывать.
        if (was.is_active && input.isActive === false) {
          const open = await this.openStages(tx, was.id);
          if (open > 0) {
            throw new ConflictException(say(
              `На участке ${was.code} ещё ${open} незакрытых этапов: сначала закройте работу`, `${was.code} uchastkasida yana ${open} yopilmagan bosqich bor: avval ishni yoping`));
          }
        }
        await tx.$executeRaw`
          UPDATE work_center
             SET code = ${next}, name_ru = ${input.nameRu}, name_uz = ${input.nameUz},
                 capacity_per_shift = ${qty(capacity)}::numeric,
                 cost_per_hour = ${money(rate)}::numeric,
                 is_active = ${input.isActive ?? was.is_active}
           WHERE id = ${was.id}`;
        await writeAudit(tx, {
          companyId,
          entityType: 'work_center',
          entityId: next,
          action: 'work_center.update',
          changes: {
            code: { from: was.code, to: next },
            capacityPerShift: { from: qty(was.capacity_per_shift), to: qty(capacity) },
            costPerHour: { from: money(was.cost_per_hour), to: money(rate) },
            isActive: {
              from: was.is_active ? 'да' : 'нет',
              to: (input.isActive ?? was.is_active) ? 'да' : 'нет',
            },
          },
        });
      } else {
        await tx.$executeRaw`
          INSERT INTO work_center
            (company_id, code, name_ru, name_uz, capacity_per_shift, cost_per_hour, is_active)
          VALUES (${companyId}, ${next}, ${input.nameRu}, ${input.nameUz},
                  ${qty(capacity)}::numeric, ${money(rate)}::numeric, ${input.isActive ?? true})`;
        await writeAudit(tx, {
          companyId,
          entityType: 'work_center',
          entityId: next,
          action: 'work_center.create',
          changes: {
            code: { from: null, to: next },
            nameRu: { from: null, to: input.nameRu },
            costPerHour: { from: null, to: money(rate) },
          },
        });
      }

      void ctx;
      return this.rows(tx);
    });
  }

  // --- внутреннее ----------------------------------------------------------

  private require(permission: string) {
    const ctx = currentContext();
    if (!ctx?.permissions.has(permission)) {
      throw new ForbiddenException(say(`Нет права «${permission}»`, MSG.noRight(permission)));
    }
    return ctx;
  }

  private company(): bigint {
    const ids = currentContext()?.companyIds ?? [];
    if (ids.length !== 1) {
      throw new BadRequestException(
        MSG.pickCompany(),
      );
    }
    return ids[0];
  }

  private async one(tx: Tx, companyId: bigint, code: string) {
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        code: string;
        capacity_per_shift: string;
        cost_per_hour: string;
        is_active: boolean;
      }[]
    >`
      SELECT id, code, capacity_per_shift::text, cost_per_hour::text, is_active
        FROM work_center WHERE company_id = ${companyId} AND code = ${code}`;
    if (!rows[0]) throw new NotFoundException(MSG.workCenterNotFound(code));
    return rows[0];
  }

  private async openStages(tx: Tx, id: bigint): Promise<number> {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM production_stage s
        JOIN production_order o ON o.id = s.production_order_id
       WHERE s.work_center_id = ${id}
         AND s.status IN ('pending', 'running', 'paused')
         AND o.status IN ('planned', 'in_progress', 'paused')`;
    return Number(rows[0]?.n ?? 0);
  }

  private async rows(tx: Tx): Promise<WorkCenterRow[]> {
    const rows = await tx.$queryRaw<
      {
        code: string;
        name_ru: string;
        name_uz: string;
        capacity: string;
        rate: string;
        is_active: boolean;
        open_stages: bigint;
      }[]
    >`
      SELECT w.code, w.name_ru, w.name_uz,
             w.capacity_per_shift::text AS capacity, w.cost_per_hour::text AS rate, w.is_active,
             (SELECT count(*)::bigint FROM production_stage s
                JOIN production_order o ON o.id = s.production_order_id
               WHERE s.work_center_id = w.id
                 AND s.status IN ('pending', 'running', 'paused')
                 AND o.status IN ('planned', 'in_progress', 'paused')) AS open_stages
        FROM work_center w
       ORDER BY w.is_active DESC, w.code`;
    return rows.map((r) => ({
      code: r.code,
      nameRu: r.name_ru,
      nameUz: r.name_uz,
      capacityPerShift: qty(r.capacity),
      costPerHour: money(r.rate),
      isActive: r.is_active,
      openStages: Number(r.open_stages),
    }));
  }
}
