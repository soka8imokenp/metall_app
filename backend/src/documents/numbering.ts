import { UnprocessableEntityException } from '@nestjs/common';
import { say } from '../common/say.js';

/**
 * Маска номера документа (ТЗ 7.3).
 *
 * Номер собирается из маски вида `СЧ-{YY}/{SEQ}`. Всё, что не в фигурных
 * скобках, попадает в номер как есть, — заказчик пишет свой префикс сам, на
 * своём языке, и менять под него код не нужно.
 *
 * Правила, которые держит этот файл, и причины, по которым они есть:
 *
 * 1. **`{SEQ}` обязателен и ровно один.** Без счётчика маска даёт всем
 *    документам один и тот же номер; два счётчика в одном номере означают, что
 *    непонятно, какой из них считает.
 * 2. **Незнакомую подстановку не пропускаем молча.** Опечатка `{YYY}` иначе
 *    ушла бы в номер текстом, и это увидели бы уже на бумаге.
 * 3. **Счётчик, который сбрасывается по периоду, обязан этот период
 *    показывать.** Иначе в январе выдаётся номер, который уже был выдан год
 *    назад: счётчик обнулился, а в номере этого не видно.
 */

/** Ширина счётчика по умолчанию: столько знаков в уже выданных номерах. */
const SEQ_WIDTH = 5;

const KNOWN = ['SEQ', 'YY', 'YYYY', 'MM', 'TYPE', 'COMPANY'] as const;

export const MASK_PLACEHOLDERS = KNOWN;

const TOKEN = /\{([A-Za-z]+)(?::(\d))?\}/g;

export type MaskParts = {
  /** Сколько знаков в счётчике: `{SEQ}` — пять, `{SEQ:3}` — три. */
  seqWidth: number;
  hasYear: boolean;
  hasMonth: boolean;
};

export function parseMask(raw: string): MaskParts {
  const mask = raw.trim();
  if (!mask) throw new UnprocessableEntityException(say('Маска номера не может быть пустой', 'Raqam maskasi bo‘sh bo‘lmaydi'));
  if (mask.length > 60) throw new UnprocessableEntityException(say('Маска номера длиннее 60 знаков', 'Raqam maskasi 60 belgidan uzun'));

  let seq = 0;
  let seqWidth = SEQ_WIDTH;
  let hasYear = false;
  let hasMonth = false;

  for (const m of mask.matchAll(TOKEN)) {
    const name = m[1]!.toUpperCase();
    if (!(KNOWN as readonly string[]).includes(name)) {
      throw new UnprocessableEntityException(say(
        `В маске есть подстановка {${m[1]}}, которой нет. Доступны: ${KNOWN.map((k) => `{${k}}`).join(', ')}`, `Maskada mavjud bo‘lmagan {${m[1]}} o‘rnini bosuvchi bor. Mavjudlari: ${KNOWN.map((k) => `{${k}}`).join(', ')}`));
    }
    if (name === 'SEQ') {
      seq += 1;
      if (m[2]) seqWidth = Number(m[2]);
    }
    if (name === 'YY' || name === 'YYYY') hasYear = true;
    if (name === 'MM') hasMonth = true;
  }

  // Фигурная скобка, не попавшая в разбор, — это опечатка в подстановке.
  // Пропустить её значит напечатать «{YYY}» на счёте.
  const left = mask.replace(TOKEN, '');
  if (left.includes('{') || left.includes('}')) {
    throw new UnprocessableEntityException(say(
      'В маске осталась незакрытая или незнакомая подстановка в фигурных скобках', 'Maskada yopilmagan yoki notanish o‘rin bosuvchi qolgan'));
  }

  if (seq === 0) {
    throw new UnprocessableEntityException(say(
      'В маске нет {SEQ}: без счётчика у всех документов будет один номер', 'Maskada {SEQ} yo‘q: hisoblagichsiz barcha hujjatlarda bitta raqam bo‘ladi'));
  }
  if (seq > 1) {
    throw new UnprocessableEntityException(say('{SEQ} в маске должен быть один', 'Maskada {SEQ} bitta bo‘lishi kerak'));
  }
  if (seqWidth < 1 || seqWidth > 9) {
    throw new UnprocessableEntityException(say('Ширина счётчика — от 1 до 9 знаков', 'Hisoblagich kengligi — 1 dan 9 belgigacha'));
  }

  return { seqWidth, hasYear, hasMonth };
}

/** Маска и область счётчика должны быть согласованы между собой. */
export function checkMaskWithScope(raw: string, scope: 'company' | 'company_period'): MaskParts {
  const parts = parseMask(raw);
  if (scope === 'company_period' && !parts.hasYear) {
    throw new UnprocessableEntityException(say(
      'Счётчик сбрасывается каждый период, а года в маске нет: ' +
        'в январе повторится номер прошлого года. Добавьте {YY} или {YYYY} ' +
        'либо выберите сквозной счётчик', 'Hisoblagich har davrda nolga tushadi, maskada esa yil yo‘q: ' + 'yanvarda o‘tgan yilning raqami takrorlanadi. {YY} yoki {YYYY} qo‘shing ' + 'yoki uzluksiz hisoblagichni tanlang'));
  }
  return parts;
}

/**
 * Ключ периода, по которому живёт счётчик.
 *
 * Считается по маске, а не по отдельной настройке: если в номере есть месяц,
 * счётчик обязан сбрасываться помесячно, иначе месяц в номере ничего не
 * значит. Сквозной счётчик живёт под пустым ключом.
 */
export function periodKey(mask: string, scope: 'company' | 'company_period', date: Date): string {
  if (scope === 'company') return '';
  const { hasMonth } = parseMask(mask);
  const y = date.getUTCFullYear();
  if (!hasMonth) return String(y);
  return `${y}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function renderNumber(
  mask: string,
  seq: number,
  ctx: { date: Date; typeCode: string; companyCode: string },
): string {
  const { seqWidth } = parseMask(mask);
  const y = ctx.date.getUTCFullYear();
  return mask.trim().replace(TOKEN, (_all, rawName: string) => {
    switch (rawName.toUpperCase()) {
      case 'SEQ':
        return String(seq).padStart(seqWidth, '0');
      case 'YY':
        return String(y).slice(-2);
      case 'YYYY':
        return String(y);
      case 'MM':
        return String(ctx.date.getUTCMonth() + 1).padStart(2, '0');
      case 'TYPE':
        return ctx.typeCode;
      case 'COMPANY':
        return ctx.companyCode;
      default:
        return '';
    }
  });
}
