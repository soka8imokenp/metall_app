/**
 * Метки визита и разбор их по источникам справочника.
 *
 * Здесь только чистые функции: правила приходят из базы, решение считается без
 * неё. Так разбор проверяется тестом без стенда и повторяется одинаково и при
 * приёме заявки, и в отчёте.
 */

/** Что знает о визите страница сайта. Всё необязательно: меток может не быть. */
export type Marks = {
  visitorId?: string | null;
  landing?: string | null;
  referrer?: string | null;
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  content?: string | null;
  term?: string | null;
  clickId?: string | null;
  analyticsId?: string | null;
  formCode?: string | null;
  firstAt?: string | null;
  firstSource?: string | null;
  firstMedium?: string | null;
  firstCampaign?: string | null;
  firstLanding?: string | null;
  firstReferrer?: string | null;
};

export type SourceRule = {
  id: bigint | string;
  sourceId: bigint | string;
  priority: number;
  matchMedium: string | null;
  matchSource: string | null;
  matchReferrer: string | null;
  matchHasClick: boolean | null;
  matchHasMarks: boolean | null;
  matchHasReferrer: boolean | null;
};

/** Одно касание: то, по чему выбирается источник. */
export type Touch = {
  source: string | null;
  medium: string | null;
  referrer: string | null;
  clickId: string | null;
};

const low = (v: string | null | undefined) => (v ? v.trim().toLowerCase() : '');

/**
 * Обрезаем и чистим: с чужой страницы приходит что угодно, вплоть до всего
 * тела письма в поле `utm_term`. Длина — предел хранения, а не вкус.
 */
export const clean = (v: unknown, max = 400): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/** Есть ли метки вообще: по ним отличают прямой заход от перехода. */
export const hasMarks = (t: Touch) => Boolean(t.source || t.medium || t.clickId);

/**
 * Первое подходящее правило. Пустое условие — «любой», поэтому правило со
 * всеми пустыми условиями подходит всегда и стоит последним по приоритету.
 */
export function pickRule(rules: SourceRule[], t: Touch): SourceRule | undefined {
  const marks = hasMarks(t);
  const ref = low(t.referrer);
  return [...rules]
    .sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)))
    .find((r) => {
      if (r.matchMedium && low(r.matchMedium) !== low(t.medium)) return false;
      if (r.matchSource && low(r.matchSource) !== low(t.source)) return false;
      if (r.matchReferrer && !ref.includes(low(r.matchReferrer))) return false;
      if (r.matchHasClick !== null && r.matchHasClick !== Boolean(t.clickId)) return false;
      if (r.matchHasMarks !== null && r.matchHasMarks !== marks) return false;
      if (r.matchHasReferrer !== null && r.matchHasReferrer !== Boolean(ref)) return false;
      return true;
    });
}

/**
 * Телефон приводим к цифрам с плюсом: с сайта он приходит как набрали —
 * «+998 (90) 123-45-67», «90 1234567», «998901234567». В CRM это один человек,
 * и искать его должны находить одинаково.
 */
export function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 9) return `+998${digits}`;
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
  return `+${digits}`;
}
