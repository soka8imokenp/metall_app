/** Числа в API — строки с точностью (`"12.500000"`). Форматируем, не считаем. */
const nf = (frac: number) =>
  new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: frac });

export function num(v: string | number | null | undefined, frac = 2): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return nf(frac).format(n).replace(/ /g, ' ');
}

/** Деньги: до миллиарда — полностью, выше — «1,84 млрд», чтобы влезло в карточку. */
export function money(v: string | number | null | undefined, currency = 'UZS'): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const cur = currency === 'UZS' ? 'сум' : currency;
  if (abs >= 1e9) return `${nf(2).format(n / 1e9).replace(/ /g, ' ')} млрд ${cur}`;
  if (abs >= 1e6) return `${nf(1).format(n / 1e6).replace(/ /g, ' ')} млн ${cur}`;
  return `${nf(0).format(n).replace(/ /g, ' ')} ${cur}`;
}

export function dateShort(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function dateTime(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Единицы измерения в API — латиницей (`t`, `pm`); человеку показываем по-русски. */
const UNITS: Record<string, string> = { t: 'т', pm: 'п.м.', pcs: 'шт', kg: 'кг', m: 'м', m2: 'м²', m3: 'м³', l: 'л' };
export const unit = (u?: string | null) => (u ? UNITS[u] ?? u : '');

/** Сумма для крупной цифры: число отдельно, разряд и валюта отдельно — чтобы влезло в полколонки. */
export function moneyParts(v: string | number | null | undefined): [string, string] {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return ['—', ''];
  const a = Math.abs(n);
  if (a >= 1e9) return [num(n / 1e9, 2), 'млрд сум'];
  if (a >= 1e6) return [num(n / 1e6, 1), 'млн сум'];
  return [num(n, 0), 'сум'];
}

/**
 * Короткое имя трубы: «Ø426×7» крупно, остальное (марка стали, ГОСТ, вид
 * изоляции) — мелкой строкой. Длинное «Труба стальная 426×7 мм
 * электросварная прямошовная, 09Г2С-15, ГОСТ 10705-80» на телефоне читается
 * плохо, а размер — то, по чему трубу ищут глазами.
 */
export function itemTitle(name: string | null | undefined): { head: string; sub: string; pipe: boolean } {
  const s = (name ?? '').trim();
  const m = s.match(/(\d+)\s*[×xх]\s*(\d+(?:[.,]\d+)?)\s*(?:мм|mm)/i) ?? s.match(/(\d+)\s*\/\s*(\d+)\s*(?:мм|mm)/i);
  if (!m || m.index === undefined) return { head: s, sub: '', pipe: false };
  const sep = m[0].includes('/') ? '/' : '×';
  const head = `Ø${m[1]}${sep}${m[2]}`;
  const before = s
    .slice(0, m.index)
    .replace(/^(Труба|Po‘lat quvur|Quvur)\s*/i, '')
    .replace(/стальная\s*/i, '')
    .replace(/электросварная|прямошовная|elektr payvandlangan|to‘g‘ri chokli|quvur/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[,\s]+$/, '')
    .trim();
  const after = s.slice(m.index + m[0].length).split(',').map((x) => x.trim()).filter(Boolean);
  // «электросварная прямошовная» — общий случай, не нужен в строке; оставляем марку, ГОСТ и вид изоляции
  const rest = after.filter((x) => !/электросвар|прямошов|payvand|chokli/i.test(x));
  return { head, sub: [before, ...rest].filter(Boolean).join(' · '), pipe: true };
}
