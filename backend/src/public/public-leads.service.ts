import { Injectable, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { clean, normalizePhone, pickRule, type Marks, type SourceRule, type Touch } from './marks.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Приём заявок с сайта заказчика.
 *
 * Это единственный маршрут системы, открытый наружу без входа, и писать он
 * умеет ровно одно — обращение. Пускает ключ сайта: по нему заявка попадает в
 * нужную компанию. Секрета у ключа нет намеренно — форму отправляет браузер
 * посетителя, и любой секрет лежал бы в исходном коде страницы.
 *
 * Отсюда и защита: ограничение частоты, список разрешённых адресов страниц и
 * ловушка для ботов. Заголовок `Origin` подделывается вне браузера, поэтому
 * список адресов — это гигиена против чужих форм, а не преграда роботу;
 * роботов держит частота и ловушка.
 */
@Injectable()
export class PublicLeadsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Счётчики частоты: окно в минуту, в памяти процесса. */
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

  async intake(input: {
    key: string;
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    comment?: string | null;
    trap?: string | null;
    marks?: Marks;
  }, meta: { origin?: string; ip?: string }) {
    const site = await this.prisma.withContext(null, [], async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        { id: bigint; company_id: bigint; origins: string[] }[]
      >(
        `SELECT id, company_id, origins FROM site_key WHERE code = $1 AND is_active`,
        input.key,
      );
      return rows[0] ?? null;
    });
    if (!site) throw new ForbiddenException(say('Ключ сайта не распознан', 'Sayt kaliti aniqlanmadi'));

    // Частота: сначала по адресу отправителя, потом по ключу. Разные пределы —
    // один посетитель шлёт одну-две заявки, сайт целиком заметно больше.
    if (meta.ip && this.tooOften(`ip:${meta.ip}`, 10)) {
      throw new ForbiddenException(MSG.tooOften());
    }
    if (this.tooOften(`key:${input.key}`, 120)) {
      throw new ForbiddenException(MSG.tooOften());
    }

    if (site.origins.length && meta.origin) {
      const ok = site.origins.some((o) => o.trim() && meta.origin!.startsWith(o.trim()));
      if (!ok) throw new ForbiddenException(say('Эта страница не указана у ключа сайта', 'Bu sahifa sayt kalitida ko‘rsatilmagan'));
    }

    // Ловушка: поле скрыто стилем, человек его не видит. Заполнено — это робот.
    // Отвечаем как при успехе: робот не должен узнать, что его отличили.
    if (clean(input.trap)) return { accepted: true };

    const name = clean(input.name, 200);
    const phone = normalizePhone(clean(input.phone, 50));
    const email = clean(input.email, 200);
    if (!phone && !email) {
      throw new UnprocessableEntityException(say('Нужен телефон или почта: иначе перезвонить некому', 'Telefon yoki pochta kerak: aks holda qayta qo‘ng‘iroq qiladigan joy yo‘q'));
    }

    const m = input.marks ?? {};
    const last: Touch = {
      source: clean(m.source, 120),
      medium: clean(m.medium, 120),
      referrer: clean(m.referrer, 500),
      clickId: clean(m.clickId, 200),
    };
    const first: Touch = {
      source: clean(m.firstSource, 120) ?? last.source,
      medium: clean(m.firstMedium, 120) ?? last.medium,
      referrer: clean(m.firstReferrer, 500) ?? last.referrer,
      clickId: last.clickId,
    };

    await this.prisma.withContext(null, [site.company_id], async (tx) => {
      const rules = await this.rules(tx);
      const lastSource = pickRule(rules, last)?.sourceId ?? null;
      const firstSource = pickRule(rules, first)?.sourceId ?? null;

      await tx.$queryRawUnsafe(
        `INSERT INTO lead (uid, company_id, source_id, name, phone, email, comment, status,
                           visitor_id, landing_url, referrer,
                           utm_source, utm_medium, utm_campaign, utm_content, utm_term,
                           click_id, analytics_id, form_code,
                           first_at, first_source, first_medium, first_campaign,
                           first_landing_url, first_referrer, first_source_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'new'::"LeadStatus",
                 $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                 $18::timestamptz, $19, $20, $21, $22, $23, $24)`,
        site.company_id,
        lastSource,
        name ?? (phone ?? email),
        phone,
        email,
        clean(input.comment, 2000),
        clean(m.visitorId, 120),
        clean(m.landing, 500),
        last.referrer,
        last.source,
        last.medium,
        clean(m.campaign, 200),
        clean(m.content, 200),
        clean(m.term, 300),
        last.clickId,
        clean(m.analyticsId, 120),
        clean(m.formCode, 60),
        clean(m.firstAt, 40),
        first.source,
        first.medium,
        clean(m.firstCampaign, 200) ?? clean(m.campaign, 200),
        clean(m.firstLanding, 500) ?? clean(m.landing, 500),
        first.referrer,
        firstSource,
      );
    });

    await this.prisma.withContext(null, [], async (tx) => {
      await tx.$queryRawUnsafe(
        `UPDATE site_key SET used_count = used_count + 1, last_used_at = now() WHERE id = $1`,
        site.id,
      );
    });

    return { accepted: true };
  }

  /** Правила компании: читаются на каждую заявку — их единицы, а правка должна действовать сразу. */
  private async rules(tx: Tx): Promise<SourceRule[]> {
    const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT id, source_id, priority, match_medium, match_source, match_referrer,
              match_has_click, match_has_marks, match_has_referrer
         FROM lead_source_rule WHERE is_active ORDER BY priority, id`,
    );
    return rows.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      priority: Number(r.priority),
      matchMedium: r.match_medium,
      matchSource: r.match_source,
      matchReferrer: r.match_referrer,
      matchHasClick: r.match_has_click,
      matchHasMarks: r.match_has_marks,
      matchHasReferrer: r.match_has_referrer,
    }));
  }
}
