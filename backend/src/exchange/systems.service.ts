import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';
import { writeAudit } from '../common/audit.js';

/**
 * Справочник внешних систем и их ключей (ТЗ 12).
 *
 * Сделано по образцу ключей сайта (`crm/site-keys.service.ts`): тот же
 * `withTenant` с сырым SQL, тот же набор полей, та же пара «выключить и завести
 * новый» вместо смены ключа. Второго способа держать подключение в системе
 * нет и не будет.
 *
 * Чем отличается от ключа сайта: ключ внешней системы — настоящий секрет. Он
 * не уходит в исходный код чужой страницы, его знают только два сервера.
 * Поэтому:
 *
 *   - в базе лежит `sha256` ключа, а не сам ключ;
 *   - наружу ключ отдаётся **один раз** — в ответе на заведение и на «новый
 *     ключ». Дальше видно только шесть последних знаков: по ним человек узнаёт,
 *     тот ли ключ прописан у него в чужой системе;
 *   - секрет подписи не отдаётся вообще никогда, даже хвостом. Экран знает
 *     только, задан он или нет.
 *
 * Почему sha256, а не bcrypt, которым хранятся пароли людей: по ключу нужен
 * **поиск** — входящий запрос приносит ключ и больше ничего, и по нему надо
 * найти систему. Bcrypt найти строку по значению не даёт, он умеет только
 * сверить с известной. Перебор здесь не грозит: ключ — 24 знака из 18
 * случайных байт, это не пароль, который человек придумал сам.
 */
@Injectable()
export class ExchangeSystemsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT s.uid, s.code, s.name, s.is_active, s.key_tail, s.allowed_ips, s.comment,
                s.created_at, s.last_used_at, s.used_count,
                s.signing_secret IS NOT NULL AS has_secret,
                co.uid AS company_uid, co.code AS company_code,
                co.name_ru AS company_name_ru, co.name_uz AS company_name_uz,
                (SELECT count(*) FROM webhook_subscription w
                  WHERE w.system_id = s.id AND w.is_active) AS subscriptions,
                (SELECT count(*) FROM exchange_message m
                  WHERE m.system_id = s.id AND m.status IN ('failed', 'dead')) AS problems
           FROM external_system s JOIN company co ON co.id = s.company_id
          WHERE s.company_id = ANY (app.current_company_ids())
          ORDER BY co.code, s.name`,
      );
      return { rows: rows.map(systemView) };
    });
  }

  /**
   * Заведение подключения. Ключ возвращается в этом ответе и больше никогда —
   * то же правило, что у кода привязки Telegram и у пароля человека.
   */
  async create(input: {
    companyUid?: string;
    code: string;
    name: string;
    allowedIps?: string[];
    comment?: string;
    withSecret?: boolean;
  }) {
    const key = newKey();
    const secret = input.withSecret ? randomBytes(24).toString('base64url') : null;
    const code = input.code.trim().toLowerCase();

    const uid = await this.prisma.withTenant(async (tx) => {
      const companyId = await this.companyId(tx, input.companyUid);
      const dup = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM external_system WHERE company_id = $1 AND code = $2`,
        companyId,
        code,
      );
      if (Number(dup[0]?.n ?? 0) > 0) {
        throw new ConflictException(
          say(
            `Подключение с кодом «${code}» в компании уже есть`,
            `Kompaniyada «${code}» kodli ulanish allaqachon bor`,
          ),
        );
      }
      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO external_system
           (company_id, code, name, key_hash, key_tail, signing_secret, allowed_ips, comment)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8) RETURNING uid`,
        companyId,
        code,
        input.name.trim(),
        hashKey(key),
        tail(key),
        secret,
        cleanIps(input.allowedIps),
        input.comment?.trim() || null,
      );
      const uid = rows[0]!.uid;
      // Заведение подключения — решение об обмене данными с чужой программой,
      // и в журнале оно должно остаться. Ни ключ, ни секрет в журнал не идут:
      // журнал читают люди, которым ключ не выдавали.
      await writeAudit(tx, {
        companyId,
        entityType: 'external_system',
        entityId: uid,
        action: 'create',
        changes: {
          code: { from: null, to: code },
          name: { from: null, to: input.name.trim() },
          hasSecret: { from: null, to: Boolean(secret) },
          allowedIps: { from: null, to: cleanIps(input.allowedIps).join(', ') || null },
        },
      });
      return uid;
    });

    const view = await this.one(uid);
    return { ...view, key, secret };
  }

  async update(
    uid: string,
    input: {
      name?: string;
      allowedIps?: string[];
      isActive?: boolean;
      comment?: string;
    },
  ) {
    await this.prisma.withTenant(async (tx) => {
      const before = await this.row(tx, uid);
      await tx.$queryRawUnsafe(
        `UPDATE external_system
            SET name = coalesce($2, name),
                allowed_ips = coalesce($3::text[], allowed_ips),
                is_active = coalesce($4::boolean, is_active),
                comment = coalesce($5, comment)
          WHERE id = $1`,
        before.id,
        input.name?.trim() ?? null,
        input.allowedIps ? cleanIps(input.allowedIps) : null,
        input.isActive ?? null,
        input.comment?.trim() ?? null,
      );
      await writeAudit(tx, {
        companyId: before.company_id,
        entityType: 'external_system',
        entityId: uid,
        action: 'update',
        changes: {
          ...(input.name !== undefined && input.name.trim() !== before.name
            ? { name: { from: before.name, to: input.name.trim() } }
            : {}),
          ...(input.isActive !== undefined && input.isActive !== before.is_active
            ? { isActive: { from: before.is_active, to: input.isActive } }
            : {}),
          ...(input.allowedIps !== undefined
            ? {
                allowedIps: {
                  from: (before.allowed_ips ?? []).join(', ') || null,
                  to: cleanIps(input.allowedIps).join(', ') || null,
                },
              }
            : {}),
        },
      });
    });
    return this.one(uid);
  }

  /**
   * Новый ключ вместо прежнего. Прежний перестаёт работать в тот же миг —
   * это и есть «сменить пароль» для подключения: обмен встанет, пока новый
   * ключ не прописали на той стороне, и это видно сразу, а не через неделю.
   */
  async rotateKey(uid: string, withSecret: boolean | undefined) {
    const key = newKey();
    const secret = withSecret ? randomBytes(24).toString('base64url') : null;
    await this.prisma.withTenant(async (tx) => {
      const before = await this.row(tx, uid);
      await tx.$queryRawUnsafe(
        `UPDATE external_system
            SET key_hash = $2, key_tail = $3,
                signing_secret = CASE WHEN $4::boolean THEN $5 ELSE signing_secret END
          WHERE id = $1`,
        before.id,
        hashKey(key),
        tail(key),
        secret !== null,
        secret,
      );
      await writeAudit(tx, {
        companyId: before.company_id,
        entityType: 'external_system',
        entityId: uid,
        action: 'key_issued',
        changes: {
          keyTail: { from: before.key_tail, to: tail(key) },
          ...(secret ? { hasSecret: { from: true, to: true } } : {}),
        },
      });
    });
    const view = await this.one(uid);
    return { ...view, key, secret };
  }

  async one(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT s.uid, s.code, s.name, s.is_active, s.key_tail, s.allowed_ips, s.comment,
                s.created_at, s.last_used_at, s.used_count,
                s.signing_secret IS NOT NULL AS has_secret,
                co.uid AS company_uid, co.code AS company_code,
                co.name_ru AS company_name_ru, co.name_uz AS company_name_uz,
                (SELECT count(*) FROM webhook_subscription w
                  WHERE w.system_id = s.id AND w.is_active) AS subscriptions,
                (SELECT count(*) FROM exchange_message m
                  WHERE m.system_id = s.id AND m.status IN ('failed', 'dead')) AS problems
           FROM external_system s JOIN company co ON co.id = s.company_id
          WHERE s.uid = $1::uuid
            AND s.company_id = ANY (app.current_company_ids())`,
        uid,
      );
      if (!rows[0]) throw new NotFoundException(MSG_SYSTEM_NOT_FOUND());
      return systemView(rows[0]);
    });
  }

  /**
   * Подключение по uid — и только своей компании. Проверка своя, потому что на
   * `external_system` нет RLS: его читают по ключу, когда компания ещё не
   * известна (см. миграцию 20261006190000_exchange_rls_fix). Без этой строки
   * чужой uid позволил бы перевыпустить ключ соседней компании.
   */
  private async row(tx: Tx, uid: string) {
    const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT id, company_id, name, is_active, allowed_ips, key_tail
         FROM external_system
        WHERE uid = $1::uuid AND company_id = ANY (app.current_company_ids())`,
      uid,
    );
    if (!rows[0]) throw new NotFoundException(MSG_SYSTEM_NOT_FOUND());
    return rows[0] as {
      id: bigint;
      company_id: bigint;
      name: string;
      is_active: boolean;
      allowed_ips: string[];
      key_tail: string;
    };
  }

  private async companyId(tx: Tx, companyUid: string | undefined): Promise<bigint> {
    const ids = currentContext()?.companyIds ?? [];
    if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
    if (!companyUid) {
      if (ids.length > 1) {
        throw new UnprocessableEntityException(
          say(
            'Выбраны обе компании: укажите, чья это система',
            'Ikkala kompaniya tanlangan: bu kimning tizimi ekanini ko‘rsating',
          ),
        );
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

export const MSG_SYSTEM_NOT_FOUND = () =>
  say('Подключение не найдено', 'Ulanish topilmadi');

/** 24 знака из 18 случайных байт — как у ключа сайта, и по той же причине. */
export const newKey = () => randomBytes(18).toString('base64url');

export const hashKey = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');

/** Хвост для узнавания. Шесть знаков: меньше — не узнать, больше — уже подсказка. */
const tail = (key: string) => key.slice(-6);

/**
 * Адрес отправителя — только то, что похоже на IPv4/IPv6 или на подсеть.
 * Десяти хватает: обмен идёт с сервера, а не из города.
 */
const cleanIps = (list: string[] | undefined): string[] =>
  (list ?? [])
    .map((o) => o.trim())
    .filter((o) => /^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(o))
    .slice(0, 10);

const systemView = (r: Record<string, any>) => ({
  uid: r.uid,
  code: r.code,
  name: r.name,
  isActive: r.is_active,
  /** Только хвост. Сам ключ уходил наружу один раз, при выдаче. */
  keyTail: r.key_tail,
  /** Задан ли секрет подписи. Значение не отдаётся никогда. */
  hasSecret: Boolean(r.has_secret),
  allowedIps: r.allowed_ips ?? [],
  comment: r.comment,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  usedCount: Number(r.used_count ?? 0),
  subscriptions: Number(r.subscriptions ?? 0),
  /** Сколько обменов стоит с ошибкой: по этому числу на экране видно беду. */
  problems: Number(r.problems ?? 0),
  company: {
    uid: r.company_uid,
    code: r.company_code,
    nameRu: r.company_name_ru,
    nameUz: r.company_name_uz,
  },
});
