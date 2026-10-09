import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Ключи сайта и правила разбора меток.
 *
 * Ключ — это адрес, по которому заявка с чужой страницы попадает в нужную
 * компанию. Он публичный: уходит в исходный код страницы, и прятать его
 * бессмысленно. Поэтому ключ можно выключить и завести новый — это и есть
 * способ «сменить пароль», если с сайта полезли роботы.
 */
@Injectable()
export class SiteKeysService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT k.uid, k.code, k.name, k.origins, k.is_active, k.created_at,
                k.last_used_at, k.used_count,
                co.uid AS company_uid, co.code AS company_code,
                co.name_ru AS company_name_ru, co.name_uz AS company_name_uz
           FROM site_key k JOIN company co ON co.id = k.company_id
          WHERE k.company_id = ANY (app.current_company_ids())
          ORDER BY co.code, k.created_at DESC`,
      );
      return { rows: rows.map(keyView) };
    });
  }

  async create(input: { companyUid?: string; name: string; origins?: string[] }) {
    const uid = await this.prisma.withTenant(async (tx) => {
      const companyId = await this.companyId(tx, input.companyUid);
      // 24 знака из случайных байт: ключ лежит на виду, угадывать его не
      // должно быть смысла даже перебором.
      const code = randomBytes(18).toString('base64url');
      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO site_key (company_id, code, name, origins)
         VALUES ($1, $2, $3, $4::text[]) RETURNING uid`,
        companyId,
        code,
        input.name.trim(),
        cleanOrigins(input.origins),
      );
      return rows[0]!.uid;
    });
    return this.one(uid);
  }

  async update(uid: string, input: { name?: string; origins?: string[]; isActive?: boolean }) {
    await this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: bigint }[]>(
        `SELECT id FROM site_key WHERE uid = $1::uuid`,
        uid,
      );
      if (!rows[0]) throw new NotFoundException(say('Ключ сайта не найден', 'Sayt kaliti topilmadi'));
      await tx.$queryRawUnsafe(
        `UPDATE site_key
            SET name = coalesce($2, name),
                origins = coalesce($3::text[], origins),
                is_active = coalesce($4::boolean, is_active)
          WHERE id = $1`,
        rows[0].id,
        input.name?.trim() ?? null,
        input.origins ? cleanOrigins(input.origins) : null,
        input.isActive ?? null,
      );
    });
    return this.one(uid);
  }

  async one(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT k.uid, k.code, k.name, k.origins, k.is_active, k.created_at,
                k.last_used_at, k.used_count,
                co.uid AS company_uid, co.code AS company_code,
                co.name_ru AS company_name_ru, co.name_uz AS company_name_uz
           FROM site_key k JOIN company co ON co.id = k.company_id
          WHERE k.uid = $1::uuid`,
        uid,
      );
      if (!rows[0]) throw new NotFoundException(say('Ключ сайта не найден', 'Sayt kaliti topilmadi'));
      return keyView(rows[0]);
    });
  }

  /** Правила разбора меток — чтобы на экране было видно, почему источник такой. */
  async rules() {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT r.uid, r.priority, r.name, r.match_medium, r.match_source, r.match_referrer,
                r.match_has_click, r.match_has_marks, r.match_has_referrer, r.is_active,
                s.uid AS source_uid, app_loc(s.name_ru, s.name_uz) AS source_name,
                co.uid AS company_uid, co.code AS company_code
           FROM lead_source_rule r
           JOIN lead_source s ON s.id = r.source_id
           JOIN company co ON co.id = r.company_id
          ORDER BY co.code, r.priority, r.id`,
      );
      return {
        rows: rows.map((r) => ({
          uid: r.uid,
          priority: Number(r.priority),
          name: r.name,
          isActive: r.is_active,
          match: {
            medium: r.match_medium,
            source: r.match_source,
            referrer: r.match_referrer,
            hasClick: r.match_has_click,
            hasMarks: r.match_has_marks,
            hasReferrer: r.match_has_referrer,
          },
          source: { uid: r.source_uid, name: r.source_name },
          company: { uid: r.company_uid, code: r.company_code },
        })),
      };
    });
  }

  private async companyId(tx: Tx, companyUid: string | undefined): Promise<bigint> {
    const ids = currentContext()?.companyIds ?? [];
    if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
    if (!companyUid) {
      if (ids.length > 1) {
        throw new UnprocessableEntityException(say('Выбраны обе компании: укажите, чей это сайт', 'Ikkala kompaniya tanlangan: bu kimning sayti ekanini ko‘rsating'));
      }
      return ids[0]!;
    }
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM company WHERE uid = ${companyUid}::uuid`;
    const id = rows[0]?.id;
    if (id === undefined || !ids.includes(id)) throw new NotFoundException(MSG.companyNotFound());
    return id;
  }
}

/** Адрес страницы — только схема и домен: путь и хвост запроса здесь лишние. */
const cleanOrigins = (list: string[] | undefined): string[] =>
  (list ?? [])
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .slice(0, 10);

const keyView = (r: Record<string, any>) => ({
  uid: r.uid,
  code: r.code,
  name: r.name,
  origins: r.origins ?? [],
  isActive: r.is_active,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  usedCount: Number(r.used_count ?? 0),
  company: {
    uid: r.company_uid,
    code: r.company_code,
    nameRu: r.company_name_ru,
    nameUz: r.company_name_uz,
  },
});
