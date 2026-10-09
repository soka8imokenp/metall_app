/**
 * Слова раздела «Сводка» в боте — рабочее место руководителя (ТЗ 11.1).
 *
 * Руководитель открывает бота за двумя вещами: как идут дела и что без него
 * стоит. Поэтому здесь нет меню из меню: цифры приходят сразу, а объяснение
 * короткое — что это за число и с чем оно сравнивается (решение заказчика
 * 02.10: у важных пунктов короткое «что это и зачем»).
 */

/** Сроки, за которые смотрят дела. Те же, что на экране в браузере. */
export const PERIOD: { code: string; api: '7d' | '30d' | '3m'; ru: string; uz: string }[] = [
  { code: '7', api: '7d', ru: '7 дней', uz: '7 kun' },
  { code: '30', api: '30d', ru: '30 дней', uz: '30 kun' },
  { code: '90', api: '3m', ru: '3 месяца', uz: '3 oy' },
];

/**
 * Название показателя для сравнения компаний.
 *
 * У службы заголовок уже содержит компанию («Выручка завода Plant»), а в
 * сравнении компания стоит в строке рядом с числом, и в шапке её имя было бы
 * второй раз и не про ту половину экрана.
 */
export const COMPARE_TITLE: Record<string, { ru: string; uz: string }> = {
  revenue: { ru: 'Выручка', uz: 'Tushum' },
  shipped_tons: { ru: 'Отгрузки', uz: 'Jo‘natmalar' },
};

export const C = {
  head: (uz: boolean, period: string) =>
    uz ? `<b>📊 Xulosa · ${period}</b>` : `<b>📊 Сводка · за ${period}</b>`,

  about: (uz: boolean, period: string) =>
    uz
      ? `Raqamlar — oxirgi ${period} uchun. Foiz — undan oldingi xuddi shunday ` +
        'muddat bilan solishtirish.'
      : `Цифры — за последние ${period}. Проценты — сравнение с таким же сроком до него.`,

  stamp: (uz: boolean, time: string) => (uz ? `Yangilandi ${time}` : `Обновлено ${time}`),

  up: (uz: boolean, percent: string, period: string) =>
    uz
      ? `oldingi ${period}ga nisbatan ${percent}% ko‘p`
      : `на ${percent}% больше, чем в прошлые ${period}`,
  down: (uz: boolean, percent: string, period: string) =>
    uz
      ? `oldingi ${period}ga nisbatan ${percent}% kam`
      : `на ${percent}% меньше, чем в прошлые ${period}`,
  flat: (uz: boolean) =>
    uz ? 'oldingi muddat bilan bir xil' : 'столько же, сколько в прошлый срок',
  noCompare: (uz: boolean) =>
    uz ? 'solishtirishga narsa yo‘q: bu bugungi holat' : 'сравнивать не с чем: это срез на сегодня',

  empty: (uz: boolean) =>
    uz
      ? 'Bu muddatda hali raqam yo‘q — sotuv ham, jo‘natma ham bo‘lmagan.'
      : 'За этот срок цифр пока нет — ни продаж, ни отгрузок.',

  // --- что ждёт решения ----------------------------------------------------

  waitingHead: (uz: boolean) =>
    uz ? '<b>🕓 Qarorni kutmoqda</b>' : '<b>🕓 Ждут вашего решения</b>',
  waitingAbout: (uz: boolean) =>
    uz
      ? 'Bu — sizning qaroringizsiz turgan ishlar. Qatorni bossangiz, kartochka ' +
        'tugmalari bilan ochiladi: o‘sha yerda tasdiqlaysiz yoki qaytarasiz.'
      : 'Это то, что стоит без вашего решения. Нажмёте строку — откроется карточка с ' +
        'кнопками: там и согласуете или вернёте.',
  waitingNone: (uz: boolean) =>
    uz
      ? 'Sizdan kutilayotgan qaror yo‘q — hammasi hal qilingan.'
      : 'Решений за вами нет — всё разобрано.',
  waitingNoRight: (uz: boolean) =>
    uz
      ? 'Tasdiqlash huquqi sizga berilmagan, shuning uchun bu ro‘yxat bo‘sh. ' +
        'Raqamlar va og‘ishlar ochiq.'
      : 'Права согласовывать вам не выдано, поэтому этот список пуст. Цифры и отклонения ' +
        'при этом открыты.',
  financeGroup: (uz: boolean) => (uz ? 'Pul operatsiyalari' : 'Операции с деньгами'),
  documentsGroup: (uz: boolean) => (uz ? 'Hujjatlar' : 'Документы'),

  // --- отклонения ----------------------------------------------------------

  alarmsHead: (uz: boolean) => (uz ? '<b>⚠️ Nimaga qarash kerak</b>' : '<b>⚠️ На что смотреть</b>'),
  alarmsAbout: (uz: boolean) =>
    uz
      ? '🔴 muddati o‘tgan · 🟡 qarorni kutmoqda · ℹ️ ishlar qanday ketmoqda'
      : '🔴 просрочено · 🟡 ждёт решения · ℹ️ как идут дела',
  alarmsNone: (uz: boolean) =>
    uz
      ? 'Og‘ish yo‘q: muddati o‘tgan to‘lov ham, kritik qoldiq ham yo‘q.'
      : 'Отклонений нет: ни просроченной оплаты, ни критических остатков.',

  compareHead: (uz: boolean, period: string) =>
    uz ? `<b>⚖️ Zavod va savdo uyi · ${period}</b>` : `<b>⚖️ Завод и торговый дом · ${period}</b>`,
  compareAbout: (uz: boolean) =>
    uz
      ? 'Bir xil ko‘rsatkichlar yonma-yon: kim oyni nima bilan yopayotgani ko‘rinadi. ' +
        'Pastda — har biriga xos narsalar: zavodda ishlab chiqarish va xomashyo, ' +
        'savdo uyida buyurtmalar ijrosi va tayyor mahsulot zaxirasi.'
      : 'Одни и те же показатели рядом: видно, кто чем закрывает период. ' +
        'Ниже — то, что есть только у одного: у завода выпуск и сырьё, ' +
        'у торгового дома исполнение заказов и запас готовой продукции.',
  compareOwn: (uz: boolean) => (uz ? 'Har biriga xos:' : 'Своё у каждого:'),
  compareAlone: (uz: boolean) =>
    uz
      ? 'Solishtirishga ikkinchi kompaniya yo‘q: sizga bittasi ochilgan.'
      : 'Сравнивать не с чем: вам открыта одна компания.',
  stale: (uz: boolean) =>
    uz
      ? 'Bu tugma o‘tgan qadamdan qolgan. Hozirgi ekran quyida.'
      : 'Эта кнопка осталась с прошлого шага. Текущий экран ниже.',
  refused: (uz: boolean, message: string) =>
    uz ? `Bo‘lmadi: ${message}` : `Не получилось: ${message}`,
} as const;
