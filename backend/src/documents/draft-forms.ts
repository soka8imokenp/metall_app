import { buildDocx, type DocxBlock } from './docx-build.js';

/**
 * Черновые печатные формы (ТЗ 7.2).
 *
 * Это наши заготовки, а не бумаги заказчика. Нужны они по одной причине:
 * без опубликованного шаблона кнопка «Скачать DOCX» не работает, а образцы
 * МЕТАЛЛ АЗИЯ ещё не прислала. Придут — загрузятся как файлы, и код здесь
 * не изменится: в этом и смысл шаблонов.
 *
 * Поэтому и оформления тут нет — ни логотипа, ни рамок с печатью. Верстать
 * счёт за заказчика бессмысленно: он всё равно пришлёт свой.
 */

type Lang = 'ru' | 'uz';

const W = {
  ru: {
    from: 'Поставщик',
    to: 'Покупатель',
    inn: 'ИНН',
    basis: 'Основание',
    head: ['№', 'Наименование', 'Кол-во', 'Ед.', 'Цена', 'Сумма без НДС', 'НДС', 'Всего'],
    net: 'Итого без НДС',
    vat: 'НДС',
    total: 'Всего к оплате',
    totalAct: 'Всего',
    words: 'Сумма прописью',
    due: 'Срок оплаты',
    delivery: 'Дата поставки',
    vehicle: 'Транспорт',
    driver: 'Водитель',
    weight: 'Вес нетто / брутто, т',
    signFrom: 'Поставщик _______________',
    signTo: 'Покупатель _______________',
    handed: 'Отпустил _______________',
    received: 'Получил _______________',
    noVatNote: 'Без НДС',
    actNote:
      'Работы (услуги) выполнены полностью и в срок. Заказчик претензий по объёму, ' +
      'качеству и срокам не имеет.',
    specNote: 'Спецификация является неотъемлемой частью договора.',
    validity: 'Цены действительны до',
  },
  uz: {
    from: 'Yetkazib beruvchi',
    to: 'Xaridor',
    inn: 'STIR',
    basis: 'Asos',
    head: ['№', 'Nomi', 'Soni', 'Birlik', 'Narxi', 'QQS siz summa', 'QQS', 'Jami'],
    net: 'QQS siz jami',
    vat: 'QQS',
    total: 'To‘lovga jami',
    totalAct: 'Jami',
    words: 'Summa so‘z bilan',
    due: 'To‘lov muddati',
    delivery: 'Yetkazib berish sanasi',
    vehicle: 'Transport',
    driver: 'Haydovchi',
    weight: 'Sof / brutto vazni, t',
    signFrom: 'Yetkazib beruvchi _______________',
    signTo: 'Xaridor _______________',
    handed: 'Topshirdi _______________',
    received: 'Qabul qildi _______________',
    noVatNote: 'QQS siz',
    actNote:
      'Ishlar (xizmatlar) to‘liq va muddatida bajarildi. Buyurtmachining hajm, sifat va ' +
      'muddat bo‘yicha e’tirozi yo‘q.',
    specNote: 'Spetsifikatsiya shartnomaning ajralmas qismidir.',
    validity: 'Narxlar amal qilish muddati',
  },
} as const;

/** Шапка «кто кому» — одинаковая во всех четырёх формах. */
const parties = (l: Lang): DocxBlock[] => {
  const w = W[l];
  return [
    { kind: 'p', text: `${w.from}: {company.name}, ${w.inn} {company.inn}` },
    { kind: 'p', text: '{company.address}' },
    { kind: 'p', text: '{company.bank}' },
    { kind: 'p', text: '' },
    { kind: 'p', text: `{#hasPartner}${w.to}: {partner.name}, ${w.inn} {partner.inn}{/hasPartner}` },
    { kind: 'p', text: '{#hasPartner}{partner.address}{/hasPartner}' },
    { kind: 'p', text: '' },
  ];
};

/**
 * Табличная часть.
 *
 * `{#lines}` и `{/lines}` стоят в первой и последней ячейке строки — так
 * `easy-template-x` повторяет всю строку таблицы, а не отдельную ячейку.
 */
const linesTable = (l: Lang): DocxBlock => ({
  kind: 'table',
  head: true,
  // Доли колонок и кегль подобраны по собранному PDF, а не на глаз: поровну
  // восемь колонок дают «Наименование» в четыре строки, а основным кеглем
  // «160 050 079,99» переносится посередине разряда — на счёте это читается
  // как другое число.
  widths: [2, 10, 5, 3, 7, 7, 6, 7],
  size: 8,
  rows: [
    [...W[l].head],
    [
      '{#lines}{seq}',
      '{name}',
      '{qty}',
      '{unit}',
      '{price}',
      '{net}',
      '{vat}',
      '{total}{/lines}',
    ],
  ],
});

const totals = (l: Lang, totalWord: string): DocxBlock[] => {
  const w = W[l];
  return [
    { kind: 'p', text: '' },
    { kind: 'p', text: `${w.net}: {amount.net} {currency}` },
    { kind: 'p', text: `{#hasVat}${w.vat}: {amount.vat} {currency}{/hasVat}` },
    { kind: 'p', text: `{#noVat}${w.noVatNote}{/noVat}` },
    { kind: 'p', text: `${totalWord}: {amount.total} {currency}`, bold: true },
    { kind: 'p', text: `${w.words}: {amount.words}` },
  ];
};

const invoice = (l: Lang): DocxBlock[] => {
  const w = W[l];
  return [
    { kind: 'p', text: '{doc.type} № {doc.number} — {doc.date}', bold: true, size: 14 },
    { kind: 'p', text: '' },
    ...parties(l),
    { kind: 'p', text: `${w.basis}: {doc.basis}` },
    { kind: 'p', text: '' },
    linesTable(l),
    ...totals(l, w.total),
    { kind: 'p', text: `${w.due}: {payment.dueDate}` },
    { kind: 'p', text: '' },
    { kind: 'p', text: w.signFrom },
  ];
};

const waybill = (l: Lang): DocxBlock[] => {
  const w = W[l];
  return [
    { kind: 'p', text: '{doc.type} № {doc.number} — {doc.date}', bold: true, size: 14 },
    { kind: 'p', text: '' },
    ...parties(l),
    { kind: 'p', text: `${w.basis}: {doc.basis}` },
    { kind: 'p', text: `${w.delivery}: {delivery.date}` },
    {
      kind: 'p',
      text:
        `{#hasTransport}${w.vehicle}: {transport.vehicle}. ${w.driver}: {transport.driver}. ` +
        `${w.weight}: {transport.netWeight} / {transport.grossWeight}{/hasTransport}`,
    },
    { kind: 'p', text: '' },
    linesTable(l),
    ...totals(l, w.totalAct),
    { kind: 'p', text: '' },
    { kind: 'p', text: `${w.handed}        ${w.received}` },
  ];
};

const act = (l: Lang): DocxBlock[] => {
  const w = W[l];
  return [
    { kind: 'p', text: '{doc.type} № {doc.number} — {doc.date}', bold: true, size: 14 },
    { kind: 'p', text: '' },
    ...parties(l),
    { kind: 'p', text: `${w.basis}: {doc.basis}` },
    { kind: 'p', text: '' },
    linesTable(l),
    ...totals(l, w.totalAct),
    { kind: 'p', text: '' },
    { kind: 'p', text: w.actNote },
    { kind: 'p', text: '' },
    { kind: 'p', text: `${w.signFrom}        ${w.signTo}` },
  ];
};

const spec = (l: Lang): DocxBlock[] => {
  const w = W[l];
  return [
    { kind: 'p', text: '{doc.type} № {doc.number} — {doc.date}', bold: true, size: 14 },
    { kind: 'p', text: '' },
    ...parties(l),
    { kind: 'p', text: `${w.basis}: {doc.basis}` },
    { kind: 'p', text: '' },
    linesTable(l),
    ...totals(l, w.totalAct),
    { kind: 'p', text: `${w.validity}: {payment.dueDate}` },
    { kind: 'p', text: '' },
    { kind: 'p', text: w.specNote },
    { kind: 'p', text: '' },
    { kind: 'p', text: `${w.signFrom}        ${w.signTo}` },
  ];
};

/**
 * Черновик на тип документа и язык.
 *
 * Типа нет в этом списке — шаблона нет, и это не ошибка: договор набирают
 * прозой, подставлять в него таблицу позиций незачем, а КП в справочнике
 * типов пока не заведено.
 */
const FORMS: Record<string, (l: Lang) => DocxBlock[]> = {
  INV: invoice,
  TTN: waybill,
  ACT: act,
  SPEC: spec,
};

export const DRAFT_FORM_CODES = Object.keys(FORMS);

export const hasDraftForm = (typeCode: string) => typeCode in FORMS;

export async function draftForm(typeCode: string, locale: Lang) {
  const build = FORMS[typeCode];
  if (!build) throw new Error(`Черновой формы для типа ${typeCode} нет`);
  return buildDocx(build(locale));
}

export const draftFormFileName = (typeCode: string, locale: Lang) =>
  `${typeCode.toLowerCase()}-${locale}-черновик.docx`;
