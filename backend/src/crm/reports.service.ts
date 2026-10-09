import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import type { CellValue } from '../common/xlsx.js';
import type { ReportTable } from '../common/report.js';
import { isUz, say } from '../common/say.js';

/** Отчёты CRM из ТЗ 8: «отчёты по менеджерам, источникам, конверсии и причинам отказов». */
export const CRM_REPORT_KINDS = ['funnel', 'managers', 'sources', 'marks', 'lost-reasons'] as const;
export type CrmReportKind = (typeof CRM_REPORT_KINDS)[number];

export interface CrmReport extends ReportTable {
  kind: CrmReportKind;
  /** Числа для плашек над таблицей: их считает сервер, а не экран. */
  totals: Record<string, number>;
}

const TZ = 'Asia/Tashkent';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

function shiftDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const num = (v: unknown) => Number(v ?? 0);

/**
 * Отчёты CRM (ТЗ 8, «отчёты по менеджерам, источникам, конверсии и причинам
 * отказов»).
 *
 * Главное решение этапа — **что считать конверсией**. Текущая стадия сделки
 * говорит, где она лежит сейчас, и по ней конверсию посчитать нельзя: сделка,
 * дошедшая до договора и проигранная, из стадии «расчёт» уже ушла, и в
 * числителе её не видно. Поэтому воронка строится по следу переходов
 * `deal_stage_event`, который пишется с Э3: «дошла до стадии» значит «есть
 * событие перехода в неё», даже если сейчас сделка стоит дальше или закрыта.
 *
 * Второе решение — **когорта**. Отчёт берёт сделки, заведённые в периоде, и
 * смотрит, куда они дошли к сегодняшнему дню. Считать иначе — по дате самого
 * перехода — значит сравнивать разные сделки в числителе и знаменателе:
 * в марте до договора дошли те, кого завели в январе, и конверсия марта
 * получилась бы из чужих сделок.
 *
 * Цена честности названа прямо в подзаголовке отчёта: у свежей когорты
 * конверсия занижена — сделки ещё идут. Прятать это нельзя, по этим числам
 * принимают решения о рекламе.
 */
@Injectable()
export class CrmReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async build(params: {
    kind: CrmReportKind;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<CrmReport> {
    const to = params.to ?? today();
    // Девяносто дней, а не тридцать: цикл сделки по металлу длиннее месяца,
    // и на тридцати днях воронка показывала бы почти одни незакрытые сделки.
    const from = params.from ?? shiftDays(to, -90);
    if (!DAY.test(from) || !DAY.test(to)) {
      throw new UnprocessableEntityException(
        say('Период задаётся датами вида 2026-09-01', 'Davr 2026-09-01 ko‘rinishidagi sanalar bilan beriladi'),
      );
    }
    if (from > to) {
      throw new UnprocessableEntityException(
        say('Начало периода позже конца', 'Davr boshi oxiridan keyin'),
      );
    }
    const limit = params.limit ?? 1000;

    return this.prisma.withTenant(async (tx) => {
      switch (params.kind) {
        case 'funnel':
          return this.funnel(tx, from, to, limit);
        case 'managers':
          return this.managers(tx, from, to, limit);
        case 'sources':
          return this.sources(tx, from, to, limit);
        case 'marks':
          return this.marks(tx, from, to, limit);
        case 'lost-reasons':
        default:
          return this.lostReasons(tx, from, to, limit);
      }
    });
  }

  private period(from: string, to: string) {
    return `${from.split('-').reverse().join('.')} — ${to.split('-').reverse().join('.')}`;
  }

  private async funnel(tx: Tx, from: string, to: string, limit: number): Promise<CrmReport> {
    // Имя колонки, а не значение: название справочника отдаётся на языке
    // запроса, и в выгрузку уходит то же, что на экран.
    const NAME = isUz() ? 'name_uz' : 'name_ru';
    const rows = await tx.$queryRawUnsafe<
      { seq: number; code: string; name: string; is_final: boolean; reached: bigint; amount: string }[]
    >(
      `WITH cohort AS (
         SELECT d.id, d.amount
           FROM deal d
          WHERE d.created_at >= $1::date::timestamp AT TIME ZONE '${TZ}'
            AND d.created_at <  ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'
       )
       SELECT s.seq, s.code, s.${NAME} AS name, s.is_final,
              count(DISTINCT c.id)::bigint AS reached,
              coalesce(sum(DISTINCT c.amount), 0)::text AS amount
         FROM deal_stage s
         LEFT JOIN deal_stage_event e ON e.to_stage_id = s.id
         LEFT JOIN cohort c ON c.id = e.deal_id
        GROUP BY s.seq, s.code, s.${NAME}, s.is_final
        ORDER BY s.seq`,
      from,
      to,
    );

    // Стадии одинаковы у обеих компаний по названию и порядку, но лежат
    // отдельными строками: складываем их по номеру, чтобы холдинг видел общую
    // воронку, а не две половины.
    const merged = new Map<
      number,
      { code: string; name: string; isFinal: boolean; reached: number; amount: number }
    >();
    for (const r of rows) {
      const cur =
        merged.get(r.seq) ??
        { code: r.code, name: r.name, isFinal: r.is_final, reached: 0, amount: 0 };
      cur.reached += num(r.reached);
      cur.amount += num(r.amount);
      merged.set(r.seq, cur);
    }
    const stages = [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    const open = stages.filter((s) => !s.isFinal);
    const entered = open[0]?.reached ?? 0;

    const out: CellValue[][] = stages.map((s, i) => {
      const prev = i > 0 ? stages[i - 1]! : null;
      // «От прошлой стадии» у конечных стадий смысла не имеет: перед
      // «проиграна» в списке стоит «выиграна», и деление одной на другую даёт
      // 133% — число, которого не бывает. Отвалившиеся сделки уходят с разных
      // стадий, одной «прошлой» у них нет. Доля от начала воронки остаётся, и
      // по ней как раз читается итог.
      const fromPrev = s.isFinal ? null : prev ? pct(s.reached, prev.reached) : 100;
      return [s.name, s.reached, pct(s.reached, entered), fromPrev, Math.round(s.amount)];
    });

    // По коду стадии, а не по её названию: названия двуязычны и их правит
    // администратор справочника, а `won`/`lost` — то, на что опирается расчёт.
    const won = stages.find((s) => s.code === 'won')?.reached ?? 0;
    const lost = stages.find((s) => s.code === 'lost')?.reached ?? 0;

    return {
      kind: 'funnel',
      title: say('Воронка продаж и конверсия', 'Sotuv varonkasi va konversiya'),
      subtitle: say(
        `Сделки, заведённые ${this.period(from, to)}: куда они дошли к сегодняшнему дню. ` +
          `Считается по следу переходов, а не по текущей стадии. ` +
          `У свежих сделок конверсия занижена — они ещё идут.`,
        `${this.period(from, to)} oralig‘ida kiritilgan bitimlar: bugungi kunga qayergacha yetgani. ` +
          `O‘tishlar izi bo‘yicha hisoblanadi, hozirgi bosqich bo‘yicha emas. ` +
          `Yangi bitimlarda konversiya past ko‘rinadi — ular hali davom etmoqda.`,
      ),
      columns: [
        { title: say('Стадия', 'Bosqich'), width: 34 },
        { title: say('Дошло сделок', 'Yetgan bitimlar'), numeric: true, width: 14 },
        { title: say('От начала воронки, %', 'Varonka boshidan, %'), numeric: true, width: 20 },
        { title: say('От прошлой стадии, %', 'Oldingi bosqichdan, %'), numeric: true, width: 20 },
        { title: say('Сумма, UZS', 'Summa, UZS'), numeric: true, width: 18 },
      ],
      rows: out.slice(0, limit),
      total: out.length,
      truncated: out.length > limit,
      totals: {
        entered,
        won,
        lost,
        winRate: pct(won, won + lost),
      },
    };
  }

  private async managers(tx: Tx, from: string, to: string, limit: number): Promise<CrmReport> {
    const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT u.full_name,
              count(d.id)::bigint                                          AS deals,
              count(d.id) FILTER (WHERE d.status = 'won')::bigint          AS won,
              count(d.id) FILTER (WHERE d.status = 'lost')::bigint         AS lost,
              count(d.id) FILTER (WHERE d.status = 'open')::bigint         AS open,
              coalesce(sum(d.amount) FILTER (WHERE d.status = 'won'), 0)::text AS won_amount,
              coalesce(sum(d.amount) FILTER (WHERE d.status = 'open'), 0)::text AS open_amount
         FROM deal d
         JOIN user_account u ON u.id = d.manager_id
        WHERE d.created_at >= $1::date::timestamp AT TIME ZONE '${TZ}'
          AND d.created_at <  ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'
        GROUP BY u.full_name
        ORDER BY sum(d.amount) FILTER (WHERE d.status = 'won') DESC NULLS LAST, u.full_name`,
      from,
      to,
    );

    const out: CellValue[][] = rows.map((r: any) => {
      const won = num(r.won);
      const lost = num(r.lost);
      const wonAmount = num(r.won_amount);
      return [
        r.full_name,
        num(r.deals),
        won,
        lost,
        num(r.open),
        // Конверсия у менеджера считается по закрытым сделкам: незакрытые ещё
        // могут стать любыми, и включать их в знаменатель значит занижать
        // показатель тем, у кого много работы в ходу.
        pct(won, won + lost),
        Math.round(wonAmount),
        won > 0 ? Math.round(wonAmount / won) : 0,
        Math.round(num(r.open_amount)),
      ];
    });

    const sum = (i: number) => out.reduce((s, r) => s + Number(r[i] ?? 0), 0);

    return {
      kind: 'managers',
      title: say('Показатели менеджеров', 'Menejerlar ko‘rsatkichlari'),
      subtitle: say(
        `Сделки, заведённые ${this.period(from, to)}. Конверсия — доля заключённых ` +
          `среди закрытых: незакрытые ещё могут стать любыми.`,
        `${this.period(from, to)} oralig‘ida kiritilgan bitimlar. Konversiya — yopilganlar ` +
          `ichida tuzilganlar ulushi: yopilmaganlar hali har qanday bo‘lishi mumkin.`,
      ),
      columns: [
        { title: say('Менеджер', 'Menejer'), width: 28 },
        { title: say('Сделок', 'Bitimlar'), numeric: true, width: 10 },
        { title: say('Заключено', 'Tuzilgan'), numeric: true, width: 11 },
        { title: say('Не состоялось', 'Amalga oshmagan'), numeric: true, width: 14 },
        { title: say('В работе', 'Ishda'), numeric: true, width: 11 },
        { title: say('Конверсия, %', 'Konversiya, %'), numeric: true, width: 14 },
        { title: say('Сумма заключённых, UZS', 'Tuzilganlar summasi, UZS'), numeric: true, width: 23 },
        { title: say('Средняя заключённая, UZS', 'O‘rtacha tuzilgan, UZS'), numeric: true, width: 25 },
        { title: say('В работе, UZS', 'Ishda, UZS'), numeric: true, width: 18 },
      ],
      rows: out.slice(0, limit),
      total: out.length,
      truncated: out.length > limit,
      totals: {
        managers: out.length,
        deals: sum(1),
        won: sum(2),
        wonAmount: sum(6),
      },
    };
  }

  private async sources(tx: Tx, from: string, to: string, limit: number): Promise<CrmReport> {
    // Имя колонки, а не значение: название справочника отдаётся на языке
    // запроса, и в выгрузку уходит то же, что на экран.
    const NAME = isUz() ? 'name_uz' : 'name_ru';
    const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
      `WITH leads AS (
         SELECT s.${NAME} AS name,
                count(l.id)::bigint                                        AS leads,
                count(l.id) FILTER (WHERE l.status = 'converted')::bigint  AS converted,
                count(l.id) FILTER (WHERE l.status = 'rejected')::bigint   AS rejected
           FROM lead l
           JOIN lead_source s ON s.id = l.source_id
          WHERE l.created_at >= $1::date::timestamp AT TIME ZONE '${TZ}'
            AND l.created_at <  ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'
          GROUP BY s.${NAME}
       ),
       deals AS (
         SELECT s.${NAME} AS name,
                count(d.id)::bigint                                   AS deals,
                count(d.id) FILTER (WHERE d.status = 'won')::bigint   AS won,
                coalesce(sum(d.amount) FILTER (WHERE d.status = 'won'), 0)::text AS won_amount
           FROM deal d
           JOIN partner p ON p.id = d.partner_id
           JOIN lead_source s ON s.id = p.source_id
          WHERE d.created_at >= $1::date::timestamp AT TIME ZONE '${TZ}'
            AND d.created_at <  ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'
          GROUP BY s.${NAME}
       )
       SELECT coalesce(l.name, d.name) AS name,
              coalesce(l.leads, 0) AS leads, coalesce(l.converted, 0) AS converted,
              coalesce(l.rejected, 0) AS rejected,
              coalesce(d.deals, 0) AS deals, coalesce(d.won, 0) AS won,
              coalesce(d.won_amount, '0') AS won_amount
         FROM leads l
         FULL OUTER JOIN deals d ON d.name = l.name
        ORDER BY coalesce(d.won_amount, '0')::numeric DESC, coalesce(l.leads, 0) DESC`,
      from,
      to,
    );

    const out: CellValue[][] = rows.map((r: any) => [
      r.name,
      num(r.leads),
      num(r.converted),
      num(r.rejected),
      pct(num(r.converted), num(r.leads)),
      num(r.deals),
      num(r.won),
      Math.round(num(r.won_amount)),
    ]);

    const sum = (i: number) => out.reduce((s, r) => s + Number(r[i] ?? 0), 0);

    return {
      kind: 'sources',
      title: say('Источники обращений', 'Murojaat manbalari'),
      subtitle: say(
        `Обращения и сделки за ${this.period(from, to)}. Рекламу оплачивают по этим числам: ` +
          `обращения считаются по источнику заявки, сделки — по источнику карточки клиента.`,
        `${this.period(from, to)} uchun murojaatlar va bitimlar. Reklama shu raqamlar bo‘yicha ` +
          `to‘lanadi: murojaatlar ariza manbasi bo‘yicha, bitimlar mijoz kartasi manbasi bo‘yicha.`,
      ),
      columns: [
        { title: say('Источник', 'Manba'), width: 28 },
        { title: say('Обращений', 'Murojaatlar'), numeric: true, width: 12 },
        { title: say('Стали клиентами', 'Mijoz bo‘lgan'), numeric: true, width: 17 },
        { title: say('Отказов', 'Rad etilgan'), numeric: true, width: 11 },
        { title: say('Конверсия в клиента, %', 'Mijozga konversiya, %'), numeric: true, width: 22 },
        { title: say('Сделок', 'Bitimlar'), numeric: true, width: 10 },
        { title: say('Заключено', 'Tuzilgan'), numeric: true, width: 11 },
        { title: say('Сумма заключённых, UZS', 'Tuzilganlar summasi, UZS'), numeric: true, width: 23 },
      ],
      rows: out.slice(0, limit),
      total: out.length,
      truncated: out.length > limit,
      totals: {
        sources: out.length,
        leads: sum(1),
        converted: sum(2),
        wonAmount: sum(7),
      },
    };
  }

  /**
   * Метки сайта: что привело обращение и во что оно превратилось.
   *
   * Две колонки обращений не опечатка. По **последнему касанию** считают
   * рекламу: человек кликнул объявление и в тот же визит оставил заявку. По
   * **первому** считают SEO и контент: нашли в поиске, ушли думать, вернулись
   * через неделю прямым заходом — последнее касание запишет «прямой заход»,
   * и работа поиска пропадёт. Правда посередине, поэтому показываем обе.
   *
   * Деньги считаются по заключённым сделкам клиента, выросшего из обращения:
   * заявка → клиент → сделка. Сделки клиента, пришедшего другим путём, сюда
   * не попадают — связь идёт через само обращение, а не через справочник.
   */
  private async marks(tx: Tx, from: string, to: string, limit: number): Promise<CrmReport> {
    // Имя колонки, а не значение: название справочника отдаётся на языке
    // запроса, и в выгрузку уходит то же, что на экран.
    const NAME = isUz() ? 'name_uz' : 'name_ru';
    const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
      `WITH period AS (
         SELECT l.*
           FROM lead l
          WHERE l.created_at >= $1::date::timestamp AT TIME ZONE '${TZ}'
            AND l.created_at <  ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'
       ),
       last_touch AS (
         SELECT coalesce(nullif(l.utm_source, ''), '—')   AS src,
                coalesce(nullif(l.utm_medium, ''), '—')   AS med,
                coalesce(nullif(l.utm_campaign, ''), '—') AS camp,
                min(s.${NAME})                            AS source_name,
                count(*)::bigint                                                AS leads,
                count(*) FILTER (WHERE l.status = 'converted')::bigint          AS converted,
                count(d.id) FILTER (WHERE d.status = 'won')::bigint             AS won,
                coalesce(sum(d.amount) FILTER (WHERE d.status = 'won'), 0)::text AS won_amount
           FROM period l
           LEFT JOIN lead_source s ON s.id = l.source_id
           LEFT JOIN deal d ON d.partner_id = l.partner_id
          GROUP BY 1, 2, 3
       ),
       first_touch AS (
         SELECT coalesce(nullif(l.first_source, ''), '—')   AS src,
                coalesce(nullif(l.first_medium, ''), '—')   AS med,
                coalesce(nullif(l.first_campaign, ''), '—') AS camp,
                count(*)::bigint AS leads
           FROM period l
          GROUP BY 1, 2, 3
       )
       SELECT coalesce(lt.src, ft.src)   AS src,
              coalesce(lt.med, ft.med)   AS med,
              coalesce(lt.camp, ft.camp) AS camp,
              lt.source_name,
              coalesce(lt.leads, 0)      AS leads,
              coalesce(ft.leads, 0)      AS first_leads,
              coalesce(lt.converted, 0)  AS converted,
              coalesce(lt.won, 0)        AS won,
              coalesce(lt.won_amount, '0') AS won_amount
         FROM last_touch lt
         FULL OUTER JOIN first_touch ft
           ON ft.src = lt.src AND ft.med = lt.med AND ft.camp = lt.camp
        ORDER BY coalesce(lt.won_amount, '0')::numeric DESC,
                 coalesce(lt.leads, 0) DESC, coalesce(ft.leads, 0) DESC`,
      from,
      to,
    );

    const out: CellValue[][] = rows.map((r: any) => [
      r.source_name ?? '—',
      r.src,
      r.med,
      r.camp,
      num(r.leads),
      num(r.first_leads),
      num(r.converted),
      num(r.won),
      Math.round(num(r.won_amount)),
    ]);
    const sum = (i: number) => out.reduce((s, r) => s + Number(r[i] ?? 0), 0);

    return {
      kind: 'marks',
      title: say('Метки сайта: кампании и каналы', 'Sayt belgilari: kampaniyalar va kanallar'),
      subtitle: say(
        `Обращения за ${this.period(from, to)} по меткам визита. ` +
          'Последнее касание — визит, в котором оставили заявку; первое — визит, ' +
          'с которого этот посетитель узнал о вас. Прочерк значит «метки не было»: ' +
          'заявку завели руками или форма их не передала.',
        `${this.period(from, to)} uchun tashrif belgilari bo‘yicha murojaatlar. ` +
          'Oxirgi teginish — ariza qoldirilgan tashrif; birinchi — bu tashrifchi siz haqingizda ' +
          'bilib olgan tashrif. Chiziqcha «belgi bo‘lmagan» degani: arizani qo‘lda kiritgan ' +
          'yoki shakl ularni uzatmagan.',
      ),
      columns: [
        { title: say('Источник', 'Manba'), width: 20 },
        { title: 'utm_source', width: 16 },
        { title: 'utm_medium', width: 14 },
        { title: say('Кампания', 'Kampaniya'), width: 22 },
        { title: say('Обращений (последнее)', 'Murojaatlar (oxirgi)'), numeric: true, width: 14 },
        { title: say('Обращений (первое)', 'Murojaatlar (birinchi)'), numeric: true, width: 14 },
        { title: say('Стали клиентами', 'Mijoz bo‘lgan'), numeric: true, width: 14 },
        { title: say('Сделок заключено', 'Bitim tuzilgan'), numeric: true, width: 14 },
        { title: say('Сумма заключённых, UZS', 'Tuzilganlar summasi, UZS'), numeric: true, width: 23 },
      ],
      rows: out.slice(0, limit),
      total: out.length,
      truncated: out.length > limit,
      totals: {
        marks: out.length,
        leads: sum(4),
        firstLeads: sum(5),
        converted: sum(6),
        wonAmount: sum(8),
      },
    };
  }

  private async lostReasons(tx: Tx, from: string, to: string, limit: number): Promise<CrmReport> {
    // Имя колонки, а не значение: название справочника отдаётся на языке
    // запроса, и в выгрузку уходит то же, что на экран.
    const NAME = isUz() ? 'name_uz' : 'name_ru';
    const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT r.${NAME} AS name,
              count(d.id)::bigint AS deals,
              coalesce(sum(d.amount), 0)::text AS amount
         FROM deal d
         JOIN deal_lost_reason r ON r.id = d.lost_reason_id
        WHERE d.status = 'lost'
          AND coalesce(d.closed_at, d.created_at) >= $1::date::timestamp AT TIME ZONE '${TZ}'
          AND coalesce(d.closed_at, d.created_at) <  ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'
        GROUP BY r.${NAME}
        ORDER BY sum(d.amount) DESC`,
      from,
      to,
    );

    const totalDeals = rows.reduce((s, r: any) => s + num(r.deals), 0);
    const totalAmount = rows.reduce((s, r: any) => s + num(r.amount), 0);

    const out: CellValue[][] = rows.map((r: any) => [
      r.name,
      num(r.deals),
      pct(num(r.deals), totalDeals),
      Math.round(num(r.amount)),
      pct(num(r.amount), totalAmount),
    ]);

    return {
      kind: 'lost-reasons',
      title: say('Причины отказов', 'Rad etish sabablari'),
      subtitle: say(
        `Сделки, не состоявшиеся ${this.period(from, to)}. Причина берётся из справочника: ` +
          `из свободной строки отчёт собирался бы из опечаток.`,
        `${this.period(from, to)} oralig‘ida amalga oshmagan bitimlar. Sabab ma’lumotnomadan ` +
          `olinadi: erkin satrdan hisobot xato yozuvlardan yig‘ilgan bo‘lardi.`,
      ),
      columns: [
        { title: say('Причина', 'Sabab'), width: 34 },
        { title: say('Сделок', 'Bitimlar'), numeric: true, width: 10 },
        { title: say('Доля по числу, %', 'Son bo‘yicha ulush, %'), numeric: true, width: 17 },
        { title: say('Сумма, UZS', 'Summa, UZS'), numeric: true, width: 18 },
        { title: say('Доля по сумме, %', 'Summa bo‘yicha ulush, %'), numeric: true, width: 17 },
      ],
      rows: out.slice(0, limit),
      total: out.length,
      truncated: out.length > limit,
      totals: { reasons: out.length, deals: totalDeals, amount: Math.round(totalAmount) },
    };
  }
}
