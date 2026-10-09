import { ForbiddenException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { requireContext } from '../common/request-context.js';
import type { CellValue } from '../common/xlsx.js';
import type { ReportTable } from '../common/report.js';
import { isUz, say } from '../common/say.js';
import { nameCol } from '../common/name.js';
import { FinanceService } from './finance.service.js';
import { DEBT_EXPR, UNPAID_ORDERS_WHERE } from './receivables.js';
import {
  SUPPLY_DUE_EXPR,
  SUPPLY_OPEN_EXPR,
  SUPPLY_PAID_WHERE,
  SUPPLY_WHERE,
} from './payables.js';
import { agingSelect, agingTitles, type AgingRow } from './aging.js';

/**
 * Отчёты финансов из ТЗ 6.9. Порядок — как в самой таблице ТЗ.
 *
 * KPI менеджеров из той таблицы здесь нет и не появится до разговора с
 * заказчиком: правила расчёта не предоставлены (та же причина, по которой
 * открыт §6.8). Показатель, формулу которого никто не утверждал, нельзя
 * рисовать в отчёте — по нему начнут платить бонусы.
 */
/**
 * Отчёты, предмет которых — прибыль. Их закрывает право
 * `finance.profit.view`, а не `finance.view`.
 *
 * Сводный отчёт в списке не стоит: он не закрывается, а урезается — деньги,
 * задолженность и бюджет в нём остаются.
 */
export const PROFIT_REPORT_KINDS: readonly string[] = ['pnl', 'margin'];

/** Право на прибыль: оно же закрывает маржу и раздел «Результат» в сводке. */
export const PROFIT_PERMISSION = 'finance.profit.view';

export const FINANCE_REPORT_KINDS = [
  'cashflow',
  'balances',
  'receivables',
  'payables',
  'plan-fact',
  'pnl',
  'margin',
  'summary',
] as const;
export type FinanceReportKind = (typeof FINANCE_REPORT_KINDS)[number];

/** Разрезы отчёта по марже (ТЗ 6.7): «по заказу, товару, клиенту, менеджеру». */
export const MARGIN_BREAKDOWNS = ['order', 'item', 'partner', 'manager'] as const;
export type MarginBreakdown = (typeof MARGIN_BREAKDOWNS)[number];

/** Форма отчёта общая на все модули — `common/report.ts`. */
export type { ReportColumn } from '../common/report.js';

export interface FinanceReport extends ReportTable {
  kind: FinanceReportKind;
  /** Числа для подвала и для сводного отчёта: их считает сервер, а не экран. */
  totals: Record<string, number>;
}

const TZ = 'Asia/Tashkent';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const num = (v: unknown) => Number(v ?? 0);
/** Деньги в базе — `decimal(20,4)`; хвост float в отчёте читается поломкой. */
const money = (v: unknown) => Number(num(v).toFixed(2));

/**
 * Возрастная структура строки: пять корзин и просрочка, сложенные так, чтобы
 * сходиться с показанным долгом.
 *
 * Корзины приходят из базы отдельными суммами и в точных числах делят долг
 * ровно. Округли каждую сама по себе — и пять колонок перестают складываться
 * в шестую на копейку. В отчёте, по которому звонят должникам, это первое,
 * что проверяют сложением.
 *
 * Поэтому округляются корзины просрочки, а «не просрочено» берётся остатком:
 * это и есть его определение — всё, по чему срок ещё не наступил. Копейка
 * округления оседает там, где она ничего не значит, а не в колонке, по
 * которой выставляют претензию.
 */
function aging(row: AgingRow, debt: number) {
  const b30 = money(row.bucket_30);
  const b60 = money(row.bucket_60);
  const b90 = money(row.bucket_90);
  const bOver = money(row.bucket_over);
  const overdue = Number((b30 + b60 + b90 + bOver).toFixed(2));
  return { notOverdue: Number((debt - overdue).toFixed(2)), b30, b60, b90, bOver, overdue };
}

/**
 * Итог колонки.
 *
 * Складываются уже округлённые значения строк, а не исходные из базы. Иначе
 * подвал не сходится с тем, что человек сложит в колонке глазами или формулой
 * в Excel: на тысяче строк копейки округления набирают заметную разницу, и
 * объяснить её в отчёте о деньгах нечем. Правило простое — в отчёте итог это
 * сумма показанного, а не сумма того, из чего показанное посчитали.
 */
const total = (values: number[]) => Number(values.reduce((s, v) => s + v, 0).toFixed(2));
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Колонки долга — одни и те же у дебиторки и кредиторки.
 *
 * Отличается только подпись второй колонки: там контрагент, тут поставщик.
 * Всё остальное — тот же вопрос «сколько должны и насколько просрочено»,
 * поэтому и колонки те же, и их номера совпадают: проверка, написанная на
 * один отчёт, читает второй без поправок.
 *
 * Колонок ровно столько, сколько влезает в карточку на 1440. Таблица отчёта
 * намеренно живёт без боковой прокрутки (см. `ReportTable`): уехавший вправо
 * край не виден, и по нему не звонят. Поэтому то, что выводится из соседних
 * колонок, в таблицу не берётся — лимит долга и его превышение видны на
 * вкладке «Дебиторка», отсрочка в карточке контрагента, а дата старейшего
 * долга — это те же дни просрочки, уже показанные последней колонкой.
 *
 * По той же причине нет и колонки «Просрочено»: это долг минус соседняя
 * «Не просрочено», а итогом по отчёту она стоит в подзаголовке.
 */
const DEBT_COLUMNS = (partner: string) => [
  { title: say('Компания', 'Kompaniya'), width: 12 },
  { title: partner, width: 36 },
  { title: say('Долг', 'Qarz'), numeric: true, width: 20 },
  ...agingTitles(),
  { title: say('Просрочка, дней', 'Kechikish, kun'), numeric: true, width: 14 },
];

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

function shiftDays(d: string, delta: number): string {
  const at = new Date(`${d}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + delta);
  return at.toISOString().slice(0, 10);
}

/** Рентабельность по выручке. Выручки нет — делить не на что, и ноль соврал бы. */
const rate = (margin: number, revenue: number) =>
  revenue === 0 ? null : Number(((margin / revenue) * 100).toFixed(1));

const activityName = (): Record<string, string> => ({
  operating: say('Операционная', 'Operatsion'),
  investing: say('Инвестиционная', 'Investitsion'),
  financing: say('Финансовая', 'Moliyaviy'),
});

const accountKindName = (): Record<string, string> => ({
  cash: say('Касса', 'Kassa'),
  bank: say('Банк', 'Bank'),
});

const budgetStatusName = (): Record<string, string> => ({
  ok: say('В норме', 'Me’yorda'),
  warn: say('У порога', 'Chegarada'),
  over: say('Перерасход', 'Ortiqcha sarf'),
});

/**
 * Отчёты раздела «Финансы» и выгрузка (ТЗ 6.9).
 *
 * Отчёт здесь — таблица: заголовки колонок и строки значений, ровно та же
 * форма, что на складе, в производстве и в CRM. Ни экран, ни выгрузка не
 * решают, что в какой колонке: иначе в Excel уезжает одно, а на экране
 * показано другое, и спорить об этом придётся с заказчиком.
 *
 * Числа в строках — числа, а не подписанные строки: из-за этого в Excel по
 * колонке берётся сумма. Формат («1 234 567,89 сум») собирается там, где
 * показывают.
 *
 * **Себестоимость не считается здесь заново.** Она берётся такой, какой её
 * зафиксировал тракт `warehouse/costing.ts` в момент расхода: `cost_total`
 * заказа и его строк. Так требует ТЗ 6.7 — «значение фиксируется на момент
 * отгрузки, изменение цены партий задним числом не должно переписывать уже
 * посчитанную маржу». Пересчёт по нынешним партиям менял бы маржу закрытого
 * месяца, и объяснить это заказчику было бы нечем.
 *
 * Разрез по компаниям нигде не задаётся запросом: его целиком держат RLS и
 * заголовок `X-Company-Id`. Свой фильтр по компании в этих запросах был бы
 * вторым замком на той же двери — и однажды разошёлся бы с первым.
 */
@Injectable()
export class FinanceReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
  ) {}

  async build(params: {
    kind: FinanceReportKind;
    from?: string;
    to?: string;
    by?: MarginBreakdown;
    limit: number;
  }): Promise<FinanceReport> {
    const period = this.period(params.from, params.to);

    // Прибыль проверяется здесь, а не в контроллере: через `build` идут и
    // ответ, и выгрузка файлом, и сводка, которая зовёт построители сама.
    // Поставь проверку на маршруте — и её придётся повторить трижды, а забытый
    // третий раз отдал бы файл с прибылью тому, кому отказали на экране.
    if (PROFIT_REPORT_KINDS.includes(params.kind) && !this.canSeeProfit()) {
      throw new ForbiddenException(
        say(
          'Отчёт о прибыли закрыт: нет права на финансовый результат',
          'Foyda hisoboti yopiq: moliyaviy natija huquqi yo‘q',
        ),
      );
    }

    // План-факт собирается из общей службы, а не своим запросом: второй счёт
    // плана разошёлся бы с тем, что показано на вкладке.
    if (params.kind === 'plan-fact') return this.planFact(period, params.limit);
    if (params.kind === 'summary') return this.summary(period);

    return this.prisma.withTenant(async (tx) => {
      switch (params.kind) {
        case 'cashflow':
          return this.cashflow(tx, period, params.limit);
        case 'balances':
          return this.balances(tx, period, params.limit);
        case 'receivables':
          return this.receivables(tx, params.limit);
        case 'payables':
          return this.payables(tx, params.limit);
        case 'pnl':
          return this.pnl(tx, period);
        case 'margin':
          return this.margin(tx, period, params.by ?? 'order', params.limit);
        default:
          // Сюда не попасть: вид проверен списком ещё в контроллере, а два
          // оставшихся обработаны выше. Ветка нужна, чтобы новый вид в списке
          // спотыкался здесь явно, а не отдавал в бою пустой ответ.
          throw new UnprocessableEntityException(
            say('Неизвестный отчёт', 'Noma’lum hisobot'),
          );
      }
    });
  }

  /**
   * Видит ли спрашивающий финансовый результат.
   *
   * Права берутся из контекста запроса, а не приходят параметром. Параметр
   * однажды забыли бы передать — и отчёт посчитался бы «как для учредителя»,
   * причём именно в том месте, где об этом никто бы не узнал.
   */
  private canSeeProfit() {
    return requireContext().permissions.has(PROFIT_PERMISSION);
  }

  /**
   * Период отчёта. Границы — календарные дни в местном времени: человек
   * спрашивает «за сентябрь», а не «с полуночи UTC». По умолчанию — 90 дней:
   * финансовый отчёт смотрят на горизонте квартала, а не недели.
   */
  private period(from?: string, to?: string) {
    const end = to ?? today();
    const start = from ?? shiftDays(end, -90);
    if (!DAY.test(start) || !DAY.test(end)) {
      throw new UnprocessableEntityException(
        say(
          'Период отчёта: даты в формате ГГГГ-ММ-ДД',
          'Hisobot davri: sanalar YYYY-MM-DD ko‘rinishida',
        ),
      );
    }
    if (start > end) {
      throw new UnprocessableEntityException(
        say(
          'Период отчёта: дата «с» позже даты «по»',
          'Hisobot davri: «dan» sanasi «gacha» sanasidan keyin',
        ),
      );
    }
    return { start, end, text: `${start} — ${end}` };
  }

  private cut<T>(rows: T[], limit: number) {
    return { rows: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit };
  }

  /** Начало периода в метке времени: одно выражение на все запросы. */
  private since(period: { start: string }) {
    return Prisma.sql`(${period.start}::date::timestamp AT TIME ZONE ${TZ})`;
  }

  /** Конец периода — начало следующего дня: иначе последний день выпадает. */
  private until(period: { end: string }) {
    return Prisma.sql`((${period.end}::date + 1)::timestamp AT TIME ZONE ${TZ})`;
  }

  // -------------------------------------------------------------------------
  // ДДС (ТЗ 6.9: «поступления/выбытия по статьям, периодам, счетам»)
  // -------------------------------------------------------------------------

  /**
   * Движение денег: строка на месяц, статью и счёт — все три разреза, которые
   * названы в ТЗ, сразу, а не три разных отчёта.
   *
   * Переводы между своими счетами и покупка валюты сюда не входят: деньги не
   * пришли и не ушли, они переложены, и в притоке посчитались бы дважды. То же
   * правило, что в шапке раздела (`FinanceService.flow`) — второго определения
   * притока в системе нет.
   *
   * Непроведённое не берётся: заявка на оплату это намерение, и показывать её
   * выбытием значит показать деньги, которые ещё на счёте.
   */
  private async cashflow(
    tx: Tx,
    period: { start: string; end: string; text: string },
    limit: number,
  ): Promise<FinanceReport> {
    const rows = await tx.$queryRaw<Record<string, string | null>[]>`
      SELECT to_char(o.occurred_at AT TIME ZONE ${TZ}, 'YYYY-MM') AS month,
             ${nameCol('c')} AS item,
             c.activity::text AS activity,
             co.code          AS company,
             a.code           AS account_code,
             ${nameCol('a')}  AS account_name,
             coalesce(sum(o.amount_base) FILTER (WHERE o.operation_type = 'income'), 0)::text  AS inflow,
             coalesce(sum(o.amount_base) FILTER (WHERE o.operation_type = 'expense'), 0)::text AS outflow,
             count(*)::text AS ops
        FROM finance_operation o
        JOIN company co ON co.id = o.company_id
        JOIN account a  ON a.id = o.account_id
        LEFT JOIN cashflow_item c ON c.id = o.cashflow_item_id
       WHERE o.status = 'posted'
         AND o.operation_type IN ('income', 'expense')
         AND o.occurred_at >= ${this.since(period)}
         AND o.occurred_at <  ${this.until(period)}
       GROUP BY 1, 2, 3, 4, 5, 6
       ORDER BY 1 DESC,
                coalesce(sum(o.amount_base), 0) DESC`;

    const inflow = total(rows.map((r) => money(r.inflow)));
    const outflow = total(rows.map((r) => money(r.outflow)));
    const ops = rows.reduce((s, r) => s + num(r.ops), 0);

    const cut = this.cut(rows, limit);
    return {
      kind: 'cashflow',
      title: say('Отчёт о движении денежных средств', 'Pul oqimi hisoboti'),
      subtitle:
        `${period.text}, ${say('поступления', 'tushum')} ${money(inflow)}, ` +
        `${say('выбытия', 'chiqim')} ${money(outflow)}, ` +
        `${say('строк', 'qatorlar')} ${cut.total}`,
      columns: [
        { title: say('Месяц', 'Oy'), width: 10 },
        { title: say('Статья', 'Modda'), width: 34 },
        { title: say('Вид деятельности', 'Faoliyat turi'), width: 18 },
        { title: say('Компания', 'Kompaniya'), width: 12 },
        { title: say('Счёт', 'Hisob'), width: 8 },
        { title: say('Название счёта', 'Hisob nomi'), width: 26 },
        { title: say('Поступления', 'Tushum'), numeric: true, width: 20 },
        { title: say('Выбытия', 'Chiqim'), numeric: true, width: 20 },
        { title: say('Нетто', 'Sof oqim'), numeric: true, width: 20 },
        { title: say('Операций', 'Operatsiyalar'), numeric: true, width: 12 },
      ],
      rows: cut.rows.map((r) => [
        r.month,
        // Статья не проставлена — так и пишем. Пустая ячейка в отчёте о ДДС
        // читается как ошибка выгрузки, а это сознательно не заполненное поле.
        r.item ?? say('Без статьи', 'Moddasiz'),
        activityName()[r.activity!] ?? r.activity,
        r.company,
        r.account_code,
        r.account_name,
        money(r.inflow),
        money(r.outflow),
        money(num(r.inflow) - num(r.outflow)),
        num(r.ops),
      ]),
      total: cut.total,
      truncated: cut.truncated,
      totals: { inflow, outflow, net: money(inflow - outflow), ops },
    };
  }

  // -------------------------------------------------------------------------
  // Остатки по кассам и счетам (ТЗ 6.9: «на дату, по компаниям и валютам»)
  // -------------------------------------------------------------------------

  /**
   * Остаток на дату.
   *
   * Сальдо — сумма проводок, а не хранимое поле: поле пришлось бы держать в
   * согласии с журналом вручную, и однажды оно бы с ним разошлось. То же
   * решение, что в шапке раздела.
   *
   * Только кассы и расчётные счета: вопрос ТЗ назван «по кассам и счетам», а
   * сальдо 4010 — это дебиторка, и у неё свой отчёт со своей возрастной
   * структурой. Сложить их в одну таблицу значило бы получить «итого», который
   * не означает ничего.
   *
   * Валюта счёта и валюта сальдо — **разные колонки**, и это не придирка:
   * проводка пишется в учётной валюте компании, поэтому у долларового счёта в
   * колонке «Остаток» стоят сумы. Назвать одну валюту и промолчать о второй
   * значит дать прочитать остаток валютного счёта как доллары.
   */
  private async balances(
    tx: Tx,
    period: { end: string },
    limit: number,
  ): Promise<FinanceReport> {
    const rows = await tx.$queryRaw<Record<string, string | null>[]>`
      SELECT co.code AS company, a.code, ${nameCol('a')} AS name, a.kind::text AS kind,
             cur.code AS currency, co.base_currency,
             coalesce(sum(e.debit - e.credit), 0)::text AS saldo,
             count(e.id)::text AS entries
        FROM account a
        JOIN company co   ON co.id = a.company_id
        JOIN currency cur ON cur.id = a.currency_id
        LEFT JOIN finance_entry e
               ON e.account_id = a.id
              AND e.occurred_at < ${this.until(period)}
       WHERE a.is_active AND a.kind IN ('cash', 'bank')
       GROUP BY co.code, a.code, a.name_ru, a.name_uz, a.kind, cur.code, co.base_currency
       ORDER BY co.code, cur.code, a.code`;

    const saldo = total(rows.map((r) => money(r.saldo)));
    const cut = this.cut(rows, limit);

    return {
      kind: 'balances',
      title: say('Остатки по кассам и счетам', 'Kassa va hisoblardagi qoldiqlar'),
      subtitle:
        `${say('на', '')} ${period.end}, ${say('счетов', 'hisoblar')} ${cut.total}, ` +
        `${say('итого', 'jami')} ${money(saldo)}`,
      columns: [
        { title: say('Компания', 'Kompaniya'), width: 12 },
        { title: say('Код', 'Kod'), width: 8 },
        { title: say('Счёт', 'Hisob'), width: 30 },
        { title: say('Тип', 'Turi'), width: 10 },
        { title: say('Валюта счёта', 'Hisob valyutasi'), width: 14 },
        { title: say('Остаток на дату', 'Sanadagi qoldiq'), numeric: true, width: 22 },
        { title: say('Учётная валюта', 'Hisob yuritish valyutasi'), width: 18 },
        { title: say('Проводок', 'Provodkalar'), numeric: true, width: 12 },
      ],
      rows: cut.rows.map((r) => [
        r.company,
        r.code,
        r.name,
        accountKindName()[r.kind!] ?? r.kind,
        r.currency,
        money(r.saldo),
        r.base_currency,
        num(r.entries),
      ]),
      total: cut.total,
      truncated: cut.truncated,
      totals: { saldo, accounts: cut.total },
    };
  }

  // -------------------------------------------------------------------------
  // Дебиторская и кредиторская задолженность (ТЗ 6.9, возрастная структура)
  // -------------------------------------------------------------------------

  /**
   * Дебиторка по покупателям с возрастной структурой.
   *
   * Долг берётся теми же выражениями, что список на вкладке и карточка клиента
   * (`receivables.ts`): второй счёт тех же денег разошёлся бы с первым, и на
   * вопрос «сколько должен» система начала бы давать два ответа.
   */
  private async receivables(tx: Tx, limit: number): Promise<FinanceReport> {
    const rows = await tx.$queryRaw<(Record<string, string | null> & AgingRow)[]>`
      SELECT co.code AS company, ${nameCol('p')} AS partner,
             count(o.id)::text AS orders,
             ${Prisma.raw(DEBT_EXPR)} AS debt,
             ${Prisma.raw(agingSelect({ amount: '(o.amount_total - o.paid_amount)', due: 'o.payment_due_date' }))},
             p.debt_limit::text AS debt_limit
        FROM sales_order o
        JOIN partner p ON p.id = o.partner_id
        JOIN company co ON co.id = o.company_id
       WHERE ${Prisma.raw(UNPAID_ORDERS_WHERE)}
       GROUP BY co.code, p.id, p.name_ru, p.name_uz, p.debt_limit
      HAVING ${Prisma.raw(DEBT_EXPR)} > 0
       ORDER BY ${Prisma.raw(DEBT_EXPR)} DESC`;

    const debt = total(rows.map((r) => money(r.debt)));
    const overdue = total(rows.map((r) => aging(r, money(r.debt)).overdue));
    const cut = this.cut(rows, limit);

    return {
      kind: 'receivables',
      title: say('Дебиторская задолженность', 'Debitorlik qarzi'),
      subtitle:
        `${say('на', '')} ${today()}, ${say('контрагентов', 'kontragentlar')} ${cut.total}, ` +
        `${say('долг', 'qarz')} ${money(debt)}, ${say('просрочено', 'muddati o‘tgan')} ${money(overdue)}`,
      columns: DEBT_COLUMNS(say('Контрагент', 'Kontragent')),
      rows: cut.rows.map((r) => {
        const sum = money(r.debt);
        const age = aging(r, sum);
        return [
          r.company,
          r.partner,
          sum,
          age.notOverdue,
          age.b30,
          age.b60,
          age.b90,
          age.bOver,
          r.max_overdue_days ?? 0,
        ] as CellValue[];
      }),
      total: cut.total,
      truncated: cut.truncated,
      totals: { debt, overdue, partners: cut.total },
    };
  }

  /**
   * Кредиторка по поставщикам с возрастной структурой.
   *
   * Источник долга и разнесение оплат — в `payables.ts`, там же объяснено,
   * почему это приходы минус оплаты, а не сальдо счёта 6010.
   *
   * Переплата поставщику в таблицу не попадает: это аванс, а не долг со знаком
   * минус. Вычесть её из чужого долга было бы ещё хуже — на экране появился бы
   * заниженный итог, которому никакая строка не соответствует. Поэтому аванс
   * назван отдельным числом в подзаголовке и в `totals`.
   */
  private async payables(tx: Tx, limit: number): Promise<FinanceReport> {
    const rows = await tx.$queryRaw<(Record<string, string | null> & AgingRow)[]>`
      WITH got AS (
        SELECT m.id, m.partner_id, m.moved_at::date AS doc_date, m.cost_total AS amount
          FROM stock_move m
         WHERE ${Prisma.raw(SUPPLY_WHERE)}
      ),
      paid AS (
        SELECT o.partner_id, coalesce(sum(o.amount_base), 0) AS paid
          FROM finance_operation o
          JOIN account ca ON ca.id = o.counter_account_id
         WHERE ${Prisma.raw(SUPPLY_PAID_WHERE)}
         GROUP BY o.partner_id
      ),
      ranked AS (
        SELECT g.partner_id, g.doc_date, g.amount,
               sum(g.amount) OVER (PARTITION BY g.partner_id
                                   ORDER BY g.doc_date, g.id
                                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
          FROM got g
      ),
      open AS (
        SELECT r.partner_id, r.doc_date,
               ${Prisma.raw(SUPPLY_OPEN_EXPR)} AS debt,
               ${Prisma.raw(SUPPLY_DUE_EXPR)}  AS due,
               pt.payment_delay_days
          FROM ranked r
          JOIN partner pt ON pt.id = r.partner_id
          LEFT JOIN paid p ON p.partner_id = r.partner_id
      )
      SELECT co.code AS company, ${nameCol('p')} AS partner,
             count(*) FILTER (WHERE o.debt > 0)::text AS docs,
             coalesce(sum(o.debt), 0)::text AS debt,
             ${Prisma.raw(agingSelect({ amount: 'o.debt', due: 'o.due' }))},
             min(o.doc_date) FILTER (WHERE o.debt > 0) AS oldest_doc,
             max(o.payment_delay_days)::text AS delay
        FROM open o
        JOIN partner p  ON p.id = o.partner_id
        JOIN company co ON co.id = p.company_id
       GROUP BY co.code, p.id, p.name_ru, p.name_uz
      HAVING coalesce(sum(o.debt), 0) > 0
       ORDER BY coalesce(sum(o.debt), 0) DESC`;

    // Аванс считается отдельным запросом по тем же двум множествам: внутри
    // разнесения его нет — там долг обрезан нулём, и переплату видно только
    // снаружи, как превышение оплат над приходами.
    const advanceRows = await tx.$queryRaw<{ advance: string }[]>`
      WITH got AS (
        SELECT m.partner_id, coalesce(sum(m.cost_total), 0) AS amount
          FROM stock_move m
         WHERE ${Prisma.raw(SUPPLY_WHERE)}
         GROUP BY m.partner_id
      ),
      paid AS (
        SELECT o.partner_id, coalesce(sum(o.amount_base), 0) AS amount
          FROM finance_operation o
          JOIN account ca ON ca.id = o.counter_account_id
         WHERE ${Prisma.raw(SUPPLY_PAID_WHERE)}
         GROUP BY o.partner_id
      )
      SELECT coalesce(sum(greatest(coalesce(p.amount, 0) - coalesce(g.amount, 0), 0)), 0)::text AS advance
        FROM paid p
        LEFT JOIN got g ON g.partner_id = p.partner_id`;

    const debt = total(rows.map((r) => money(r.debt)));
    const overdue = total(rows.map((r) => aging(r, money(r.debt)).overdue));
    const advance = money(advanceRows[0]?.advance);
    const cut = this.cut(rows, limit);

    return {
      kind: 'payables',
      title: say('Кредиторская задолженность', 'Kreditorlik qarzi'),
      subtitle:
        `${say('на', '')} ${today()}, ${say('поставщиков', 'yetkazib beruvchilar')} ${cut.total}, ` +
        `${say('долг', 'qarz')} ${money(debt)}, ${say('просрочено', 'muddati o‘tgan')} ${money(overdue)}` +
        (advance > 0
          ? `, ${say('выдано авансом', 'avans berilgan')} ${money(advance)}`
          : ''),
      columns: DEBT_COLUMNS(say('Поставщик', 'Yetkazib beruvchi')),
      rows: cut.rows.map((r) => {
        const sum = money(r.debt);
        const age = aging(r, sum);
        return [
          r.company,
          r.partner,
          sum,
          age.notOverdue,
          age.b30,
          age.b60,
          age.b90,
          age.bOver,
          r.max_overdue_days ?? 0,
        ] as CellValue[];
      }),
      total: cut.total,
      truncated: cut.truncated,
      totals: { debt, overdue, advance, partners: cut.total },
    };
  }

  // -------------------------------------------------------------------------
  // План-факт (ТЗ 6.9: «по статьям и подразделениям»)
  // -------------------------------------------------------------------------

  /**
   * План-факт таблицей. Считает его общая служба — та же, что отдаёт вкладку:
   * свой запрос здесь означал бы второй план, расходящийся с показанным.
   */
  private async planFact(
    period: { start: string; end: string; text: string },
    limit: number,
  ): Promise<FinanceReport> {
    const data = await this.finance.planFact({ from: period.start, to: period.end });
    const cut = this.cut(data.rows, limit);
    const uz = isUz();

    return {
      kind: 'plan-fact',
      title: say('План-факт бюджета', 'Byudjet reja-fakti'),
      subtitle:
        `${period.text}, ${say('бюджетов', 'byudjetlar')} ${cut.total}, ` +
        `${say('план', 'reja')} ${data.totals.plan}, ${say('факт', 'fakt')} ${data.totals.fact}`,
      columns: [
        { title: say('Компания', 'Kompaniya'), width: 12 },
        { title: say('Статья', 'Modda'), width: 34 },
        { title: say('Подразделение', 'Bo‘linma'), width: 26 },
        { title: say('Период', 'Davr'), width: 16 },
        { title: say('План', 'Reja'), numeric: true, width: 20 },
        { title: say('Факт', 'Fakt'), numeric: true, width: 20 },
        { title: say('Отклонение', 'Chetlanish'), numeric: true, width: 20 },
        { title: say('Использовано, %', 'Sarflangan, %'), numeric: true, width: 16 },
        { title: say('Состояние', 'Holat'), width: 16 },
        { title: say('Ответственный', 'Mas’ul'), width: 26 },
      ],
      rows: cut.rows.map((r) => [
        r.company.code,
        uz ? r.itemNameUz : r.itemName,
        r.department ? (uz ? r.department.nameUz : r.department.nameRu) : null,
        r.period,
        money(r.plan),
        money(r.fact),
        money(r.deviation),
        r.usedPercent === null ? null : Number(r.usedPercent),
        budgetStatusName()[r.status] ?? r.status,
        r.responsible?.fullName ?? null,
      ]),
      total: cut.total,
      truncated: cut.truncated,
      totals: {
        plan: money(data.totals.plan),
        fact: money(data.totals.fact),
        deviation: money(data.totals.deviation),
        warn: data.totals.warn,
        over: data.totals.over,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Прибыли и убытки (ТЗ 6.9: «выручка, себестоимость, расходы, прибыль»)
  // -------------------------------------------------------------------------

  /**
   * Выручка и себестоимость периода.
   *
   * Выручка признаётся **отгрузкой**, а не заказом и не оплатой:
   * управленческий отчёт отвечает на вопрос «сколько заработали», а не
   * «сколько получили на счёт». Датой признания считается день, когда заказ
   * уехал полностью.
   *
   * Берутся только полностью отгруженные заказы. У частичной отгрузки выручка
   * в заказе уже полная, а себестоимость накоплена лишь по уехавшему — такая
   * строка показала бы прибыль, которой нет. Отменённые не в счёт: они не
   * отгружались.
   */
  private async revenue(tx: Tx, period: { start: string; end: string }) {
    const rows = await tx.$queryRaw<{ net: string; cost: string; orders: string }[]>`
      WITH done AS (
        SELECT o.id, o.amount_net, o.cost_total,
               (SELECT max(s.shipped_at) FROM shipment s WHERE s.sales_order_id = o.id) AS done_at
          FROM sales_order o
         WHERE o.shipment_status = 'full' AND o.status <> 'cancelled'
      )
      SELECT coalesce(sum(amount_net), 0)::text  AS net,
             coalesce(sum(cost_total), 0)::text  AS cost,
             count(*)::text                      AS orders
        FROM done
       WHERE done_at >= ${this.since(period)} AND done_at < ${this.until(period)}`;
    return {
      net: num(rows[0]?.net),
      cost: num(rows[0]?.cost),
      orders: num(rows[0]?.orders),
    };
  }

  /**
   * Расходы периода по статьям ДДС.
   *
   * Расход — проведённая операция, у которой корреспондирующий счёт имеет вид
   * «расходы». Оплата поставщику (корсчёт вида `payable`) сюда **не** входит:
   * это погашение долга за товар, а сам товар попадёт в отчёт себестоимостью,
   * когда уедет. Считать и то и другое значило бы посчитать закупку дважды.
   * Налоги (корсчёт вида `vat`) — тоже не операционный расход, у них свой счёт.
   */
  private async expenses(tx: Tx, period: { start: string; end: string }) {
    return tx.$queryRaw<{ item: string | null; amount: string }[]>`
      SELECT ${nameCol('c')} AS item, coalesce(sum(o.amount_base), 0)::text AS amount
        FROM finance_operation o
        JOIN account ca ON ca.id = o.counter_account_id
        LEFT JOIN cashflow_item c ON c.id = o.cashflow_item_id
       WHERE o.status = 'posted' AND ca.kind = 'expense'
         AND o.occurred_at >= ${this.since(period)}
         AND o.occurred_at <  ${this.until(period)}
       GROUP BY 1
       ORDER BY coalesce(sum(o.amount_base), 0) DESC`;
  }

  private async pnl(
    tx: Tx,
    period: { start: string; end: string; text: string },
  ): Promise<FinanceReport> {
    const sales = await this.revenue(tx, period);
    const byItem = await this.expenses(tx, period);

    // Числа округляются один раз, и дальше считаются друг из друга: иначе
    // «валовая прибыль» в отчёте не равна разности двух строк над ней, а это
    // первое, что в отчёте проверяют вычитанием.
    const revenue = money(sales.net);
    const cost = money(sales.cost);
    const gross = money(revenue - cost);
    const expenses = total(byItem.map((r) => money(r.amount)));
    const operating = money(gross - expenses);

    const share = (v: number) => (revenue === 0 ? null : Number(((v / revenue) * 100).toFixed(1)));

    const section = {
      revenue: say('Выручка', 'Tushum'),
      cost: say('Себестоимость', 'Tannarx'),
      gross: say('Валовая прибыль', 'Yalpi foyda'),
      expenses: say('Расходы', 'Xarajatlar'),
      profit: say('Прибыль', 'Foyda'),
    };

    const rows: CellValue[][] = [
      [section.revenue, say('Выручка', 'Tushum'), revenue, share(revenue)],
      [section.cost, say('Себестоимость', 'Tannarx'), cost, share(cost)],
      [section.gross, say('Валовая прибыль', 'Yalpi foyda'), gross, share(gross)],
      ...byItem.map(
        (r) =>
          [
            section.expenses,
            r.item ?? say('Прочие расходы', 'Boshqa xarajatlar'),
            money(r.amount),
            share(num(r.amount)),
          ] as CellValue[],
      ),
      [section.expenses, say('Расходы всего', 'Jami xarajatlar'), expenses, share(expenses)],
      [section.profit, say('Операционная прибыль', 'Operatsion foyda'), operating, share(operating)],
    ];

    return {
      kind: 'pnl',
      title: say('Прибыли и убытки (управленческий)', 'Foyda va zararlar (boshqaruv)'),
      subtitle:
        `${period.text}, ${say('отгружено заказов', 'yuklangan buyurtmalar')} ${sales.orders}, ` +
        `${say('выручка признаётся отгрузкой', 'tushum yuklash bo‘yicha tan olinadi')}`,
      columns: [
        { title: say('Раздел', 'Bo‘lim'), width: 22 },
        { title: say('Показатель', 'Ko‘rsatkich'), width: 36 },
        { title: say('Сумма', 'Summa'), numeric: true, width: 22 },
        { title: say('% от выручки', 'Tushumdan, %'), numeric: true, width: 16 },
      ],
      rows,
      total: rows.length,
      truncated: false,
      totals: { revenue, cost, gross, expenses, operating },
    };
  }

  // -------------------------------------------------------------------------
  // Маржа (ТЗ 6.7 и 6.9: «по заказу, товару, клиенту, менеджеру»)
  // -------------------------------------------------------------------------

  /**
   * Маржа в четырёх разрезах.
   *
   * Себестоимость — зафиксированная отгрузкой (`cost_total` заказа и строк), а
   * не посчитанная заново по нынешним партиям: ТЗ 6.7 прямо запрещает менять
   * уже посчитанную маржу задним числом.
   *
   * Как и в отчёте о прибыли, берутся только полностью отгруженные заказы:
   * у частичной отгрузки выручка полная, а себестоимость — только уехавшей
   * части, и маржа по такой строке завышена.
   *
   * Возвраты от клиента показаны в разрезе по клиентам **отдельными
   * колонками**, а не вычтены из маржи. Возврат в системе не связан с заказом
   * (`source_doc_type` у него пуст) и несёт только себестоимость — цены
   * возврата назвать нечем. Вычесть одну себестоимость значило бы поднять
   * маржу возвратом, то есть соврать в самую выгодную сторону.
   */
  private async margin(
    tx: Tx,
    period: { start: string; end: string; text: string },
    by: MarginBreakdown,
    limit: number,
  ): Promise<FinanceReport> {
    const done = Prisma.sql`
      done AS (
        SELECT o.id, o.number, o.amount_net, o.cost_total, o.margin_total,
               o.partner_id, o.manager_id,
               (SELECT max(s.shipped_at) FROM shipment s WHERE s.sales_order_id = o.id) AS done_at
          FROM sales_order o
         WHERE o.shipment_status = 'full' AND o.status <> 'cancelled'
      ),
      taken AS (
        SELECT * FROM done
         WHERE done_at >= ${this.since(period)} AND done_at < ${this.until(period)}
      )`;

    const scope = {
      order: say('по заказу', 'buyurtma bo‘yicha'),
      item: say('по товару', 'tovar bo‘yicha'),
      partner: say('по клиенту', 'mijoz bo‘yicha'),
      manager: say('по менеджеру', 'menejer bo‘yicha'),
    }[by];

    /**
     * Деньги строки: выручка, себестоимость, маржа и рентабельность.
     *
     * Маржа — разность уже округлённых выручки и себестоимости, а не
     * округление собственного `margin_total`. По величине это одно и то же
     * (`margin_total` и есть эта разность), но округли их порознь — и три
     * показанных числа в строке перестанут вычитаться друг из друга на
     * копейку. Первый, кто проверит отчёт калькулятором, после этого не
     * поверит и остальному.
     */
    const cells = (netRaw: unknown, costRaw: unknown): CellValue[] => {
      const net = money(netRaw);
      const cost = money(costRaw);
      const marg = money(net - cost);
      return [net, cost, marg, rate(marg, net)];
    };

    const sums = (list: Record<string, string | null>[], netKey: string, costKey: string) => ({
      revenue: total(list.map((r) => money(r[netKey]))),
      margin: total(list.map((r) => money(money(r[netKey]) - money(r[costKey])))),
    });

    const head = (cut: { total: number }, revenue: number, margin: number) => ({
      kind: 'margin' as const,
      title: say('Маржа', 'Marja'),
      subtitle:
        `${scope}, ${period.text}, ${say('строк', 'qatorlar')} ${cut.total}, ` +
        `${say('маржа', 'marja')} ${money(margin)} ` +
        `(${rate(margin, revenue) ?? 0}%), ` +
        `${say('только полностью отгруженные заказы', 'faqat to‘liq yuklangan buyurtmalar')}`,
      total: cut.total,
      truncated: false,
      totals: {
        revenue,
        cost: money(revenue - margin),
        margin,
        rate: rate(margin, revenue) ?? 0,
      },
    });

    if (by === 'order') {
      const rows = await tx.$queryRaw<Record<string, string | null>[]>`
        WITH ${done}
        SELECT t.number,
               to_char(t.done_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS shipped_on,
               ${nameCol('p')} AS partner, u.full_name AS manager,
               t.amount_net::text, t.cost_total::text, t.margin_total::text
          FROM taken t
          JOIN partner p ON p.id = t.partner_id
          LEFT JOIN user_account u ON u.id = t.manager_id
         ORDER BY t.margin_total DESC`;

      const { revenue, margin: marginSum } = sums(rows, 'amount_net', 'cost_total');
      const cut = this.cut(rows, limit);
      return {
        ...head(cut, revenue, marginSum),
        truncated: cut.truncated,
        columns: [
          { title: say('Заказ', 'Buyurtma'), width: 16 },
          { title: say('Дата отгрузки', 'Yuklash sanasi'), width: 14 },
          { title: say('Клиент', 'Mijoz'), width: 34 },
          { title: say('Менеджер', 'Menejer'), width: 26 },
          { title: say('Выручка', 'Tushum'), numeric: true, width: 20 },
          { title: say('Себестоимость', 'Tannarx'), numeric: true, width: 20 },
          { title: say('Маржа', 'Marja'), numeric: true, width: 20 },
          { title: say('Рентабельность, %', 'Rentabellik, %'), numeric: true, width: 16 },
        ],
        rows: cut.rows.map((r) => [
          r.number,
          r.shipped_on,
          r.partner,
          r.manager,
          ...cells(r.amount_net, r.cost_total),
        ]),
      };
    }

    if (by === 'item') {
      const rows = await tx.$queryRaw<Record<string, string | null>[]>`
        WITH ${done}
        SELECT i.code, ${nameCol('i')} AS item, un.code AS unit,
               coalesce(sum(l.qty), 0)::text        AS qty,
               coalesce(sum(l.amount_net), 0)::text AS net,
               coalesce(sum(l.cost_total), 0)::text AS cost
          FROM sales_order_line l
          JOIN taken t ON t.id = l.sales_order_id
          JOIN item i  ON i.id = l.item_id
          JOIN unit un ON un.id = l.unit_id
         GROUP BY i.code, i.name_ru, i.name_uz, un.code
         ORDER BY coalesce(sum(l.amount_net - l.cost_total), 0) DESC`;

      const { revenue, margin: marginSum } = sums(rows, 'net', 'cost');
      const cut = this.cut(rows, limit);
      return {
        ...head(cut, revenue, marginSum),
        truncated: cut.truncated,
        columns: [
          { title: say('Код', 'Kod'), width: 16 },
          { title: say('Номенклатура', 'Nomenklatura'), width: 40 },
          { title: say('Ед.', 'Birlik'), width: 6 },
          { title: say('Количество', 'Miqdor'), numeric: true, width: 14 },
          { title: say('Выручка', 'Tushum'), numeric: true, width: 20 },
          { title: say('Себестоимость', 'Tannarx'), numeric: true, width: 20 },
          { title: say('Маржа', 'Marja'), numeric: true, width: 20 },
          { title: say('Рентабельность, %', 'Rentabellik, %'), numeric: true, width: 16 },
        ],
        rows: cut.rows.map((r) => [
          r.code,
          r.item,
          r.unit,
          Number(num(r.qty).toFixed(6)),
          ...cells(r.net, r.cost),
        ]),
      };
    }

    if (by === 'partner') {
      const rows = await tx.$queryRaw<Record<string, string | null>[]>`
        WITH ${done},
        agg AS (
          SELECT partner_id, count(*) AS orders,
                 coalesce(sum(amount_net), 0)    AS net,
                 coalesce(sum(cost_total), 0)    AS cost,
                 coalesce(sum(margin_total), 0)  AS marg
            FROM taken GROUP BY partner_id
        ),
        ret AS (
          SELECT m.partner_id, count(*) AS n, coalesce(sum(m.cost_total), 0) AS amount
            FROM stock_move m
           WHERE m.operation_type = 'return_from_client' AND m.partner_id IS NOT NULL
             AND m.moved_at >= ${this.since(period)} AND m.moved_at < ${this.until(period)}
           GROUP BY m.partner_id
        )
        SELECT ${nameCol('p')} AS partner, a.orders::text, a.net::text, a.cost::text, a.marg::text,
               coalesce(r.n, 0)::text AS returns, coalesce(r.amount, 0)::text AS returned
          FROM agg a
          JOIN partner p ON p.id = a.partner_id
          LEFT JOIN ret r ON r.partner_id = a.partner_id
         ORDER BY a.marg DESC`;

      const { revenue, margin: marginSum } = sums(rows, 'net', 'cost');
      const cut = this.cut(rows, limit);
      return {
        ...head(cut, revenue, marginSum),
        truncated: cut.truncated,
        columns: [
          { title: say('Клиент', 'Mijoz'), width: 36 },
          { title: say('Заказов', 'Buyurtmalar'), numeric: true, width: 12 },
          { title: say('Выручка', 'Tushum'), numeric: true, width: 20 },
          { title: say('Себестоимость', 'Tannarx'), numeric: true, width: 20 },
          { title: say('Маржа', 'Marja'), numeric: true, width: 20 },
          { title: say('Рентабельность, %', 'Rentabellik, %'), numeric: true, width: 16 },
          { title: say('Возвратов', 'Qaytarishlar'), numeric: true, width: 12 },
          {
            title: say('Возвращено по себестоимости', 'Tannarx bo‘yicha qaytarilgan'),
            numeric: true,
            width: 22,
          },
        ],
        rows: cut.rows.map((r) => [
          r.partner,
          num(r.orders),
          ...cells(r.net, r.cost),
          num(r.returns),
          money(r.returned),
        ]),
      };
    }

    const rows = await tx.$queryRaw<Record<string, string | null>[]>`
      WITH ${done}
      SELECT u.full_name AS manager, count(*)::text AS orders,
             coalesce(sum(t.amount_net), 0)::text   AS net,
             coalesce(sum(t.cost_total), 0)::text   AS cost,
             coalesce(sum(t.margin_total), 0)::text AS marg
        FROM taken t
        LEFT JOIN user_account u ON u.id = t.manager_id
       GROUP BY u.full_name
       ORDER BY coalesce(sum(t.margin_total), 0) DESC`;

    const { revenue, margin: marginSum } = sums(rows, 'net', 'cost');
    const cut = this.cut(rows, limit);
    return {
      ...head(cut, revenue, marginSum),
      truncated: cut.truncated,
      columns: [
        { title: say('Менеджер', 'Menejer'), width: 30 },
        { title: say('Заказов', 'Buyurtmalar'), numeric: true, width: 12 },
        { title: say('Выручка', 'Tushum'), numeric: true, width: 20 },
        { title: say('Себестоимость', 'Tannarx'), numeric: true, width: 20 },
        { title: say('Маржа', 'Marja'), numeric: true, width: 20 },
        { title: say('Рентабельность, %', 'Rentabellik, %'), numeric: true, width: 16 },
      ],
      rows: cut.rows.map((r) => [
        // Менеджера нет — так и пишем: заказ без него существует, и прятать
        // его строку значило бы не досчитаться маржи в итоге.
        r.manager ?? say('Без менеджера', 'Menejersiz'),
        num(r.orders),
        ...cells(r.net, r.cost),
      ]),
    };
  }

  // -------------------------------------------------------------------------
  // Сводный управленческий отчёт (ТЗ 6.9: «ключевые цифры на одном листе»)
  // -------------------------------------------------------------------------

  /**
   * Сводка.
   *
   * Собирается вызовом тех же построителей, что и подробные отчёты, а не
   * своими запросами. Сводный отчёт, расходящийся с подробным, хуже
   * отсутствующего: по нему принимают решение и потом не могут объяснить, из
   * чего оно сложилось. На это стоит отдельная проверка.
   *
   * KPI менеджеров в сводке нет по той же причине, что и отдельного отчёта:
   * правил расчёта заказчик не давал.
   */
  private async summary(period: {
    start: string;
    end: string;
    text: string;
  }): Promise<FinanceReport> {
    // Период передаётся тем же именем полей, что принимает `build`: разойдись
    // имена — сводка молча посчиталась бы за период по умолчанию, и она
    // расходилась бы с подробным отчётом, оставаясь правдоподобной на вид.
    const over = { from: period.start, to: period.end, limit: 100_000 } as const;
    const profit = this.canSeeProfit();
    const flow = await this.build({ kind: 'cashflow', ...over });
    const balances = await this.build({ kind: 'balances', ...over });
    // Без права на результат отчёт о прибыли даже не считается: посчитать его
    // и потом вырезать строки означало бы держать прибыль в ответе, который
    // собирается рядом. Из `build` он сейчас и не вышел бы — отказ.
    const pnl = profit ? await this.build({ kind: 'pnl', ...over }) : null;
    const recv = await this.build({ kind: 'receivables', ...over });
    const pay = await this.build({ kind: 'payables', ...over });
    const plan = await this.build({ kind: 'plan-fact', ...over });

    const sums = say('сум', 'so‘m');
    const pieces = say('шт', 'dona');
    const percent = '%';

    const sectionMoney = say('Деньги', 'Pul');
    const sectionResult = say('Результат', 'Natija');
    const sectionDebts = say('Задолженность', 'Qarzdorlik');
    const sectionPlan = say('Бюджет', 'Byudjet');

    /**
     * Раздел «Результат» — весь, а не одна строка.
     *
     * Убрать только «Операционную прибыль» было бы видимостью защиты: валовая
     * прибыль это выручка минус себестоимость, и человек получает её
     * вычитанием двух оставленных строк. По той же причине уходит и
     * рентабельность: из неё и выручки прибыль восстанавливается умножением.
     */
    const resultRows: CellValue[][] = pnl
      ? [
          [sectionResult, say('Выручка', 'Tushum'), pnl.totals.revenue, sums],
          [sectionResult, say('Себестоимость', 'Tannarx'), pnl.totals.cost, sums],
          [sectionResult, say('Валовая прибыль', 'Yalpi foyda'), pnl.totals.gross, sums],
          [sectionResult, say('Расходы', 'Xarajatlar'), pnl.totals.expenses, sums],
          [
            sectionResult,
            say('Операционная прибыль', 'Operatsion foyda'),
            pnl.totals.operating,
            sums,
          ],
          [
            sectionResult,
            say('Рентабельность по выручке', 'Tushum bo‘yicha rentabellik'),
            rate(pnl.totals.operating, pnl.totals.revenue) ?? 0,
            percent,
          ],
        ]
      : [];

    const rows: CellValue[][] = [
      [sectionMoney, say('Остаток на счетах и в кассах', 'Hisob va kassadagi qoldiq'), balances.totals.saldo, sums],
      [sectionMoney, say('Поступления', 'Tushum'), flow.totals.inflow, sums],
      [sectionMoney, say('Выбытия', 'Chiqim'), flow.totals.outflow, sums],
      [sectionMoney, say('Чистый поток', 'Sof oqim'), flow.totals.net, sums],

      ...resultRows,

      [sectionDebts, say('Дебиторская задолженность', 'Debitorlik qarzi'), recv.totals.debt, sums],
      [sectionDebts, say('в том числе просрочено', 'shundan muddati o‘tgan'), recv.totals.overdue, sums],
      [sectionDebts, say('Кредиторская задолженность', 'Kreditorlik qarzi'), pay.totals.debt, sums],
      [sectionDebts, say('в том числе просрочено', 'shundan muddati o‘tgan'), pay.totals.overdue, sums],
      [sectionDebts, say('Выдано авансом поставщикам', 'Yetkazib beruvchilarga avans'), pay.totals.advance, sums],

      [sectionPlan, say('План', 'Reja'), plan.totals.plan, sums],
      [sectionPlan, say('Факт', 'Fakt'), plan.totals.fact, sums],
      [sectionPlan, say('Отклонение', 'Chetlanish'), plan.totals.deviation, sums],
      [sectionPlan, say('Бюджетов у порога', 'Chegaradagi byudjetlar'), plan.totals.warn, pieces],
      [sectionPlan, say('Бюджетов в перерасходе', 'Ortiqcha sarflangan byudjetlar'), plan.totals.over, pieces],
    ];

    return {
      kind: 'summary',
      title: say('Сводный управленческий отчёт', 'Yig‘ma boshqaruv hisoboti'),
      // Про скрытый раздел сказано вслух. Отчёт, который молча короче, читают
      // как полный: человек увидит двадцать показателей вместо двадцати шести
      // и решит, что это и есть всё.
      subtitle:
        `${period.text}, ${say('показателей', 'ko‘rsatkichlar')} ${rows.length}, ` +
        `${say('остатки и задолженность — на сегодня', 'qoldiq va qarzdorlik — bugungi holatga')}` +
        (pnl
          ? ''
          : `, ${say(
              'раздел «Результат» скрыт: нет права на финансовый результат',
              '«Natija» bo‘limi yashirilgan: moliyaviy natija huquqi yo‘q',
            )}`),
      columns: [
        { title: say('Раздел', 'Bo‘lim'), width: 20 },
        { title: say('Показатель', 'Ko‘rsatkich'), width: 40 },
        { title: say('Значение', 'Qiymat'), numeric: true, width: 24 },
        { title: say('Единица', 'Birlik'), width: 10 },
      ],
      rows,
      total: rows.length,
      truncated: false,
      // Прибыли нет и в числах подвала: там её читал бы кто угодно, кто
      // смотрит не на таблицу, а на ответ запроса.
      totals: {
        saldo: balances.totals.saldo,
        net: flow.totals.net,
        ...(pnl ? { operating: pnl.totals.operating } : {}),
        receivables: recv.totals.debt,
        payables: pay.totals.debt,
      },
    };
  }
}
