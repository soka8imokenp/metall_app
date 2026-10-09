import { say } from '../common/say.js';

/**
 * Возрастная структура долга — одна на дебиторку и кредиторку (ТЗ 6.9).
 *
 * Корзины считаются по **дням просрочки**, а не по возрасту документа. Долг,
 * которому пятьдесят дней при отсрочке в шестьдесят, — это не «долг 31–60», а
 * условие работы: платить по нему ещё рано. Корзина по возрасту документа
 * красила бы такую строку как проблемную, и в отчёте, по которому звонят
 * должникам, это самая дорогая ошибка.
 *
 * Границы — 30/60/90: так их называют и в банке, и в бухгалтерии, и спорить об
 * этом с заказчиком не придётся. Корзины не пересекаются и покрывают весь
 * долг: сумма пяти колонок обязана сойтись с колонкой «Долг», и на это стоит
 * проверка — иначе возрастная структура живёт рядом с долгом, а не внутри него.
 *
 * Выражения подставляются куском SQL, а не параметрами: это имена колонок, а
 * колонка параметром не бывает. Зовут их только свои службы, с литералами в
 * коде, — наружу эта строка не уходит.
 */
export interface AgingExpressions {
  /** Сумма непогашенного по строке: `o.amount_total - o.paid_amount` и т.п. */
  amount: string;
  /** Дата, до которой договорились заплатить. NULL означает «срок не назначен». */
  due: string;
}

/**
 * Список выражений для `SELECT`: пять корзин, итог просрочки, глубина и
 * старейший срок. Имена колонок фиксированы — их читает служба отчётов.
 */
export function agingSelect({ amount, due }: AgingExpressions): string {
  const bucket = (from: number, to: number | null) =>
    to === null
      ? `coalesce(sum(${amount}) FILTER (WHERE current_date - ${due} > ${from}), 0)`
      : `coalesce(sum(${amount}) FILTER (WHERE current_date - ${due} BETWEEN ${from} AND ${to}), 0)`;

  return `
    -- Срок не назначен — это не просрочка: платить пока не обещали.
    coalesce(sum(${amount}) FILTER (WHERE ${due} IS NULL OR ${due} >= current_date), 0) AS not_overdue,
    ${bucket(1, 30)}  AS bucket_30,
    ${bucket(31, 60)} AS bucket_60,
    ${bucket(61, 90)} AS bucket_90,
    ${bucket(91, null)} AS bucket_over,
    coalesce(sum(${amount}) FILTER (WHERE ${due} < current_date), 0) AS overdue,
    -- Глубина просрочки — только по тому, что ещё не закрыто. Погашенный
    -- документ остаётся в выборке с нулём (его гасит разнесение оплат), и без
    -- этого условия он продолжал бы тянуть просрочку за собой: долг закрыт
    -- полгода назад, а в отчёте по контрагенту всё те же «132 дня».
    max(current_date - ${due}) FILTER (WHERE ${due} < current_date AND ${amount} > 0)::int
      AS max_overdue_days,
    min(${due}) FILTER (WHERE ${due} < current_date AND ${amount} > 0) AS oldest_due`;
}

/** Строка возрастной структуры, как её отдаёт `agingSelect`. */
export interface AgingRow {
  not_overdue: string;
  bucket_30: string;
  bucket_60: string;
  bucket_90: string;
  bucket_over: string;
  overdue: string;
  max_overdue_days: number | null;
  oldest_due: Date | null;
}

/**
 * Подписи корзин на языке запроса. Функция, а не константа: константа
 * посчиталась бы один раз при загрузке модуля — вне запроса и всегда
 * по-русски.
 */
export const agingTitles = () => [
  { title: say('Не просрочено', 'Muddati o‘tmagan'), numeric: true, width: 18 },
  { title: say('1–30 дней', '1–30 kun'), numeric: true, width: 16 },
  { title: say('31–60 дней', '31–60 kun'), numeric: true, width: 16 },
  { title: say('61–90 дней', '61–90 kun'), numeric: true, width: 16 },
  { title: say('Свыше 90 дней', '90 kundan ortiq'), numeric: true, width: 18 },
];
