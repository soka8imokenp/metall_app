/**
 * Поля, которые шаблон может подставить (ТЗ 7.2).
 *
 * Это и есть то, с чем администратор сопоставляет плейсхолдеры: список
 * открыт на экране, теги вычитываются из загруженного файла, и незнакомые
 * названы поимённо. Сопоставлять «на глаз» было бы не с чем.
 *
 * Имена плоские, хотя и с точкой: `{company.inn}` — это ключ `company.inn`,
 * а не путь в объекте. Так вышло не от лени: `easy-template-x` разбирает
 * `{doc.number}` как тег с таким именем и по вложенному объекту его не ищет —
 * проверено на живом файле. Точка здесь читается человеком, а не движком.
 */

import { say } from '../common/say.js';

export type FieldKind = 'text' | 'loop' | 'condition';

export interface TemplateField {
  name: string;
  kind: FieldKind;
  titleRu: string;
  titleUz: string;
}

export const TEMPLATE_FIELDS: TemplateField[] = [
  { name: 'doc.number', kind: 'text', titleRu: 'Номер документа' , titleUz: 'Hujjat raqami' },
  { name: 'doc.date', kind: 'text', titleRu: 'Дата документа' , titleUz: 'Hujjat sanasi' },
  { name: 'doc.type', kind: 'text', titleRu: 'Название типа' , titleUz: 'Tur nomi' },
  { name: 'doc.basis', kind: 'text', titleRu: 'Основание (заказ, сделка, платёж)' , titleUz: 'Asos (buyurtma, bitim, to‘lov)' },

  { name: 'company.name', kind: 'text', titleRu: 'Наша компания' , titleUz: 'Bizning kompaniya' },
  { name: 'company.inn', kind: 'text', titleRu: 'Наш ИНН' , titleUz: 'Bizning STIR' },
  { name: 'company.address', kind: 'text', titleRu: 'Наш юридический адрес' , titleUz: 'Bizning yuridik manzil' },
  { name: 'company.bank', kind: 'text', titleRu: 'Наши банковские реквизиты' , titleUz: 'Bizning bank rekvizitlari' },

  { name: 'partner.name', kind: 'text', titleRu: 'Контрагент' , titleUz: 'Kontragent' },
  { name: 'partner.inn', kind: 'text', titleRu: 'ИНН контрагента' , titleUz: 'Kontragent STIR' },
  { name: 'partner.address', kind: 'text', titleRu: 'Адрес контрагента' , titleUz: 'Kontragent manzili' },
  { name: 'partner.bank', kind: 'text', titleRu: 'Банковские реквизиты контрагента' , titleUz: 'Kontragent bank rekvizitlari' },

  { name: 'payment.dueDate', kind: 'text', titleRu: 'Срок оплаты' , titleUz: 'To‘lov muddati' },
  { name: 'payment.delayDays', kind: 'text', titleRu: 'Отсрочка, дней' , titleUz: 'Kechiktirish, kun' },
  { name: 'delivery.date', kind: 'text', titleRu: 'Дата поставки' , titleUz: 'Yetkazib berish sanasi' },
  { name: 'transport.vehicle', kind: 'text', titleRu: 'Транспорт' , titleUz: 'Transport' },
  { name: 'transport.driver', kind: 'text', titleRu: 'Водитель' , titleUz: 'Haydovchi' },
  { name: 'transport.netWeight', kind: 'text', titleRu: 'Вес нетто, т' , titleUz: 'Sof vazn, t' },
  { name: 'transport.grossWeight', kind: 'text', titleRu: 'Вес брутто, т' , titleUz: 'Brutto vazn, t' },

  { name: 'amount.net', kind: 'text', titleRu: 'Сумма без НДС' , titleUz: 'QQS siz summa' },
  { name: 'amount.vat', kind: 'text', titleRu: 'Сумма НДС' , titleUz: 'QQS summasi' },
  { name: 'amount.total', kind: 'text', titleRu: 'Всего к оплате' , titleUz: 'To‘lovga jami' },
  { name: 'amount.words', kind: 'text', titleRu: 'Сумма прописью' , titleUz: 'Summa so‘z bilan' },
  { name: 'currency', kind: 'text', titleRu: 'Валюта' , titleUz: 'Valyuta' },
  { name: 'linesCount', kind: 'text', titleRu: 'Число строк' , titleUz: 'Satrlar soni' },

  { name: 'lines', kind: 'loop', titleRu: 'Строки документа (повтор строки таблицы)' , titleUz: 'Hujjat satrlari (jadval satri takrorlanadi)' },
  { name: 'hasVat', kind: 'condition', titleRu: 'Есть НДС' , titleUz: 'QQS bor' },
  { name: 'noVat', kind: 'condition', titleRu: 'НДС нет' , titleUz: 'QQS yo‘q' },
  { name: 'hasPartner', kind: 'condition', titleRu: 'Контрагент указан' , titleUz: 'Kontragent ko‘rsatilgan' },
  { name: 'hasLines', kind: 'condition', titleRu: 'Есть табличная часть' , titleUz: 'Jadval qismi bor' },
  { name: 'hasTransport', kind: 'condition', titleRu: 'Заполнен транспорт' , titleUz: 'Transport to‘ldirilgan' },
];

/** Поля внутри `{#lines}…{/lines}`. */
export const LINE_FIELDS: TemplateField[] = [
  { name: 'seq', kind: 'text', titleRu: 'Номер строки' , titleUz: 'Satr raqami' },
  { name: 'code', kind: 'text', titleRu: 'Код позиции' , titleUz: 'Pozitsiya kodi' },
  { name: 'name', kind: 'text', titleRu: 'Наименование' , titleUz: 'Nomi' },
  { name: 'qty', kind: 'text', titleRu: 'Количество' , titleUz: 'Soni' },
  { name: 'unit', kind: 'text', titleRu: 'Единица' , titleUz: 'Birlik' },
  { name: 'price', kind: 'text', titleRu: 'Цена' , titleUz: 'Narxi' },
  { name: 'vatRate', kind: 'text', titleRu: 'Ставка НДС' , titleUz: 'QQS stavkasi' },
  { name: 'net', kind: 'text', titleRu: 'Сумма без НДС' , titleUz: 'QQS siz summa' },
  { name: 'vat', kind: 'text', titleRu: 'НДС' , titleUz: 'QQS' },
  { name: 'total', kind: 'text', titleRu: 'Всего по строке' , titleUz: 'Satr bo‘yicha jami' },
];

const ALL = new Set([...TEMPLATE_FIELDS, ...LINE_FIELDS].map((f) => f.name));

export const isKnownField = (name: string) => ALL.has(name);

/**
 * Каталог полей наружу: с подписью на языке запроса.
 *
 * Экран сопоставления тегов показывал `titleRu`, и под узбекским интерфейсом
 * весь список полей оставался русским. Пару `ru`/`uz` клиенту отдавать незачем
 * — язык известен здесь (ТЗ 13.4).
 */
const titled = (f: TemplateField) => ({
  name: f.name,
  kind: f.kind,
  title: say(f.titleRu, f.titleUz),
});

export const fieldsCatalogue = () => ({
  document: TEMPLATE_FIELDS.map(titled),
  line: LINE_FIELDS.map(titled),
});
