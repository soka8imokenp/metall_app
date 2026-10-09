/**
 * Слова раздела «Производство» в боте (ТЗ 11.4).
 *
 * Раздел видят те, у кого есть право на производство: руководитель, админ и
 * кладовщик (ему оно выдано, чтобы видеть, подо что он выдаёт материал).
 * Поэтому объяснения написаны не для цеха, а для того, кто смотрит со
 * стороны: что означает статус, почему заказ стоит и чем кончится нажатие.
 *
 * Каждое действие, которое меняет данные, объяснено до нажатия. Выпуск
 * отдельно: он кладёт продукцию на склад настоящим движением, и отменить его
 * производство не может — это должно быть сказано словами, а не подразумеваться.
 */
import { bullets, fields } from './section.js';

export type ProdStatus =
  | 'draft'
  | 'planned'
  | 'in_progress'
  | 'paused'
  | 'produced'
  | 'closed'
  | 'cancelled';

/** Статус заказа человеку: где он сейчас и чего от него ждать. */
export const STATUS: Record<
  ProdStatus,
  { ru: string; uz: string; mark: string; helpRu: string; helpUz: string }
> = {
  draft: {
    ru: 'Черновик',
    uz: 'Qoralama',
    mark: '📝',
    helpRu: 'Цех заказа ещё не видит. Его планируют и правят.',
    helpUz: 'Sex buyurtmani hali ko‘rmaydi. Uni rejalashtirishadi va tuzatishadi.',
  },
  planned: {
    ru: 'Запланирован',
    uz: 'Rejalashtirilgan',
    mark: '🗓',
    helpRu: 'Работа расписана, но не начата. Править такой заказ уже нельзя.',
    helpUz: 'Ish rejalashtirilgan, lekin boshlanmagan. Bunday buyurtmani tuzatib bo‘lmaydi.',
  },
  in_progress: {
    ru: 'В работе',
    uz: 'Ishda',
    mark: '⚙️',
    helpRu: 'Цех работает. Отметки по этапам и выпуск идут по этому заказу.',
    helpUz: 'Sex ishlamoqda. Bosqich belgilari va chiqarish shu buyurtma bo‘yicha boradi.',
  },
  paused: {
    ru: 'Приостановлен',
    uz: 'To‘xtatilgan',
    mark: '⏸',
    helpRu: 'Работа стоит. Причина записана и попадёт в журнал простоев.',
    helpUz: 'Ish to‘xtagan. Sabab yozilgan va to‘xtashlar jurnaliga tushadi.',
  },
  produced: {
    ru: 'Выпущен',
    uz: 'Chiqarilgan',
    mark: '✅',
    helpRu: 'Продукция сдана. Остаётся закрыть заказ — тогда посчитается себестоимость.',
    helpUz: 'Mahsulot topshirilgan. Buyurtmani yopish qoldi — shunda tannarx hisoblanadi.',
  },
  closed: {
    ru: 'Закрыт',
    uz: 'Yopilgan',
    mark: '🔒',
    helpRu: 'Заказ закончен, себестоимость посчитана. Менять в нём уже нечего.',
    helpUz: 'Buyurtma tugagan, tannarx hisoblangan. Unda o‘zgartiradigan narsa yo‘q.',
  },
  cancelled: {
    ru: 'Отменён',
    uz: 'Bekor qilingan',
    mark: '🚫',
    helpRu: 'Заказ снят с работы. Причина записана в журнале.',
    helpUz: 'Buyurtma ishdan olingan. Sabab jurnalda yozilgan.',
  },
};

/** Состояние этапа: словами цеха, а не кодом из базы. */
export const STAGE: Record<string, { ru: string; uz: string; mark: string }> = {
  pending: { ru: 'не начат', uz: 'boshlanmagan', mark: '○' },
  running: { ru: 'идёт', uz: 'ketmoqda', mark: '▶️' },
  paused: { ru: 'пауза', uz: 'pauza', mark: '⏸' },
  done: { ru: 'закончен', uz: 'tugagan', mark: '✅' },
  skipped: { ru: 'пропущен', uz: 'o‘tkazib yuborilgan', mark: '➖' },
};

/** Отметка по этапу: что нажимает цех. */
export const MARK: Record<string, { ru: string; uz: string; mark: string }> = {
  start: { ru: 'Начал', uz: 'Boshladim', mark: '▶️' },
  pause: { ru: 'Пауза', uz: 'Pauza', mark: '⏸' },
  resume: { ru: 'Продолжил', uz: 'Davom etdim', mark: '▶️' },
  finish: { ru: 'Закончил', uz: 'Tugatdim', mark: '✅' },
};

/** Вид отклонения — тот же список, что на экране в браузере. */
export const DEVIATION: Record<string, { ru: string; uz: string }> = {
  downtime: { ru: 'Простой', uz: 'To‘xtash' },
  overuse: { ru: 'Перерасход', uz: 'Ortiqcha sarf' },
  defect: { ru: 'Брак', uz: 'Brak' },
  delay: { ru: 'Срыв срока', uz: 'Muddat buzilishi' },
};

/** Состояния списка заказов: ими и спрашивают «что в цеху». */
export const STATE = [
  { key: 'active', ru: 'В работе', uz: 'Ishda', mark: '⚙️' },
  { key: 'planned', ru: 'Запланированы', uz: 'Rejalashtirilgan', mark: '🗓' },
  { key: 'done', ru: 'Выпущены', uz: 'Chiqarilgan', mark: '✅' },
  { key: 'all', ru: 'Все заказы', uz: 'Barcha buyurtmalar', mark: '📋' },
];

const ru = <T>(isUz: boolean, r: T, u: T): T => (isUz ? u : r);

export const P = {
  home: (uz: boolean) =>
    [
      `<b>🏭 ${ru(uz, 'Производство', 'Ishlab chiqarish')}</b>`,
      '',
      ru(uz, 'Здесь цех. Что можно сделать:', 'Bu yerda sex. Nima qilish mumkin:'),
      bullets(
        ru(
          uz,
          [
            'посмотреть заказы цеха и как они идут',
            'отметить свой этап: начал, пауза, закончил',
            'записать выпуск и брак',
            'запустить, приостановить и выпустить заказ',
            'увидеть простои и из-за чего они',
          ],
          [
            'sex buyurtmalarini va ular qanday ketayotganini ko‘rish',
            'o‘z bosqichingizni belgilash: boshladim, pauza, tugatdim',
            'chiqarish va brakni yozish',
            'buyurtmani ishga tushirish, to‘xtatish va chiqarish',
            'to‘xtashlarni va ular sababini ko‘rish',
          ],
        ),
      ),
      '',
      `<i>${ru(
        uz,
        'Что вам доступно, зависит от прав: смотреть может каждый, кто сюда зашёл.',
        'Nima mavjudligi huquqlarga bog‘liq: bu yerga kirgan har kim ko‘ra oladi.',
      )}</i>`,
    ].join('\n'),

  list: (uz: boolean, title: string, lines: string[]) =>
    lines.length === 0
      ? `${title}\n\n${ru(uz, 'Здесь пока пусто.', 'Bu yerda hozircha bo‘sh.')}`
      : `${title}\n\n${lines.join('\n')}`,

  askSearch: (uz: boolean) =>
    ru(
      uz,
      'Напишите номер заказа или название продукции. Например: ПР-00038 или «труба».',
      'Buyurtma raqamini yoki mahsulot nomini yozing. Masalan: ПР-00038 yoki «quvur».',
    ),

  searchEmpty: (uz: boolean, what: string) =>
    ru(uz, `По «${what}» заказов не нашёл.`, `«${what}» bo‘yicha buyurtma topilmadi.`),

  card: (uz: boolean, lines: string[], blocks: string[], help: string, why: string | null) =>
    [fields(lines), ...blocks, '', help, ...(why ? ['', why] : [])].join('\n'),

  why: (uz: boolean, reason: string) =>
    `<i>${ru(uz, 'Причина остановки', 'To‘xtash sababi')}: ${reason}</i>`,

  nothingToDo: (uz: boolean) =>
    ru(uz, 'Делать с этим заказом сейчас нечего.', 'Bu buyurtma bilan hozir qiladigan ish yo‘q.'),

  /** Что произойдёт по кнопке статуса. Объяснение до нажатия, а не после. */
  ask: (uz: boolean, number: string, to: ProdStatus) => {
    const what: Record<ProdStatus, { ru: string; uz: string }> = {
      planned: {
        ru: 'Заказ увидит цех, и править его будет нельзя.',
        uz: 'Buyurtmani sex ko‘radi va uni tuzatib bo‘lmaydi.',
      },
      in_progress: {
        ru: 'Цех начнёт работу: по заказу пойдут отметки этапов и выпуск.',
        uz: 'Sex ishni boshlaydi: bosqich belgilari va chiqarish boshlanadi.',
      },
      paused: {
        ru: 'Работа встанет. Причину спрошу — она попадёт в журнал простоев.',
        uz: 'Ish to‘xtaydi. Sababni so‘rayman — u to‘xtashlar jurnaliga tushadi.',
      },
      produced: {
        ru: 'Заказ станет выпущенным. Для этого все этапы должны быть закрыты, а годное — записано.',
        uz: 'Buyurtma chiqarilgan bo‘ladi. Buning uchun barcha bosqichlar yopilgan va yaroqli mahsulot yozilgan bo‘lishi kerak.',
      },
      closed: {
        ru: 'Заказ закроется, и система посчитает его себестоимость.',
        uz: 'Buyurtma yopiladi va tizim uning tannarxini hisoblaydi.',
      },
      cancelled: {
        ru: 'Заказ снимут с работы. Причину спрошу — без неё отмену не записывают.',
        uz: 'Buyurtma ishdan olinadi. Sababni so‘rayman — usiz bekor qilish yozilmaydi.',
      },
      draft: { ru: '', uz: '' },
    };
    return [
      `<b>${number}</b> → ${STATUS[to].mark} ${ru(uz, STATUS[to].ru, STATUS[to].uz)}`,
      '',
      ru(uz, what[to].ru, what[to].uz),
    ].join('\n');
  },

  askReason: (uz: boolean, number: string, to: ProdStatus) =>
    [
      `<b>${number}</b> → ${STATUS[to].mark} ${ru(uz, STATUS[to].ru, STATUS[to].uz)}`,
      '',
      to === 'paused'
        ? ru(
            uz,
            'Напишите, почему работа встала. Эту строку увидит цех, и она попадёт в журнал простоев.',
            'Ish nega to‘xtaganini yozing. Bu qatorni sex ko‘radi va u to‘xtashlar jurnaliga tushadi.',
          )
        : ru(
            uz,
            'Напишите, почему заказ снимают. Через месяц спросят — ответ должен быть в журнале.',
            'Buyurtma nega olinayotganini yozing. Bir oydan keyin so‘rashadi — javob jurnalda bo‘lishi kerak.',
          ),
    ].join('\n'),

  shortReason: (uz: boolean) =>
    ru(
      uz,
      '⚠️ Слишком коротко. Напишите причину так, чтобы её понял тот, кто прочитает её через месяц.',
      '⚠️ Juda qisqa. Sababni bir oydan keyin o‘qiydigan odam tushunadigan qilib yozing.',
    ),

  statusDone: (uz: boolean, number: string, to: ProdStatus) =>
    ru(
      uz,
      `✅ ${number}: ${STATUS[to].ru.toLowerCase()}.`,
      `✅ ${number}: ${STATUS[to].uz.toLowerCase()}.`,
    ),

  // --- этапы ---------------------------------------------------------------

  stages: (uz: boolean, number: string, lines: string[]) =>
    [
      `<b>${ru(uz, 'Этапы заказа', 'Buyurtma bosqichlari')} ${number}</b>`,
      '',
      lines.length === 0
        ? ru(
            uz,
            'Этапов нет. Их разворачивают из техкарты в системе.',
            'Bosqichlar yo‘q. Ular tizimda texkartadan yoziladi.',
          )
        : lines.join('\n'),
    ].join('\n'),

  stage: (uz: boolean, lines: string[], help: string) => `${fields(lines)}\n\n${help}`,

  stageHelp: (uz: boolean, status: string) => {
    const help: Record<string, { ru: string; uz: string }> = {
      pending: {
        ru: 'Этап ещё не начинали. Нажмите «Начал», когда встанете к работе: с этой минуты пойдёт время.',
        uz: 'Bosqich hali boshlanmagan. Ishga turganda «Boshladim» ni bosing: shu daqiqadan vaqt ketadi.',
      },
      running: {
        ru: 'Время идёт. «Пауза» остановит его и спросит причину, «Закончил» закроет этап.',
        uz: 'Vaqt ketmoqda. «Pauza» uni to‘xtatadi va sabab so‘raydi, «Tugatdim» bosqichni yopadi.',
      },
      paused: {
        ru: 'Этап стоит. Простой считается с минуты паузы — нажмите «Продолжил», когда вернётесь.',
        uz: 'Bosqich to‘xtagan. To‘xtash pauza daqiqasidan hisoblanadi — qaytganingizda «Davom etdim» ni bosing.',
      },
      done: {
        ru: 'Этап закрыт. Время работы записано, менять его нельзя.',
        uz: 'Bosqich yopilgan. Ish vaqti yozilgan, uni o‘zgartirib bo‘lmaydi.',
      },
    };
    return `<i>${ru(uz, help[status]?.ru ?? '', help[status]?.uz ?? '')}</i>`;
  },

  askPauseReason: (uz: boolean, stage: string) =>
    [
      `⏸ <b>${stage}</b>`,
      '',
      ru(
        uz,
        'Почему встали? Выберите причину — из неё складывается журнал простоев.',
        'Nega to‘xtadingiz? Sababni tanlang — undan to‘xtashlar jurnali yig‘iladi.',
      ),
    ].join('\n'),

  marked: (uz: boolean, kind: string) =>
    ru(uz, `✅ Отметил: ${MARK[kind].ru.toLowerCase()}.`, `✅ Belgiladim: ${MARK[kind].uz.toLowerCase()}.`),

  mine: (uz: boolean, lines: string[]) =>
    [
      `<b>🧰 ${ru(uz, 'Мои задания', 'Mening topshiriqlarim')}</b>`,
      '',
      lines.length === 0
        ? ru(
            uz,
            'Заданий на вас сейчас нет. Этапы назначает начальник производства.',
            'Hozir sizga topshiriq yo‘q. Bosqichlarni ishlab chiqarish boshlig‘i tayinlaydi.',
          )
        : lines.join('\n'),
    ].join('\n'),

  // --- выпуск --------------------------------------------------------------

  outStart: (uz: boolean, number: string, planned: string, made: string) =>
    [
      `<b>📦 ${ru(uz, 'Выпуск по заказу', 'Buyurtma bo‘yicha chiqarish')} ${number}</b>`,
      '',
      fields([
        `${ru(uz, 'План', 'Reja')}: ${planned}`,
        `${ru(uz, 'Уже принято годного', 'Qabul qilingan yaroqli')}: ${made}`,
      ]),
      '',
      ru(
        uz,
        'Сколько годного принимаем сейчас? Напишите число.',
        'Hozir qancha yaroqli mahsulot qabul qilinmoqda? Raqam yozing.',
      ),
    ].join('\n'),

  defStart: (uz: boolean, number: string) =>
    [
      `<b>🔻 ${ru(uz, 'Брак по заказу', 'Buyurtma bo‘yicha brak')} ${number}</b>`,
      '',
      ru(
        uz,
        'Сколько ушло в брак? Напишите число. На склад брак не попадёт — его либо переделывают, либо списывают.',
        'Qancha brakka ketdi? Raqam yozing. Brak omborga tushmaydi — uni yo qayta ishlashadi, yo hisobdan chiqarishadi.',
      ),
    ].join('\n'),

  badQty: (uz: boolean) =>
    ru(
      uz,
      '⚠️ Не понял число. Напишите только количество: 12 или 12,5.',
      '⚠️ Raqamni tushunmadim. Faqat miqdorni yozing: 12 yoki 12,5.',
    ),

  askWarehouse: (uz: boolean) =>
    ru(
      uz,
      'На какой склад кладём продукцию?',
      'Mahsulotni qaysi omborga qo‘yamiz?',
    ),

  askLocation: (uz: boolean, warehouse: string) =>
    ru(uz, `В какую ячейку склада ${warehouse}?`, `${warehouse} omborining qaysi yacheykasiga?`),

  askDefectReason: (uz: boolean) =>
    ru(
      uz,
      'Из-за чего брак? Выберите причину — без неё это просто цифра.',
      'Brak nima sababdan? Sababni tanlang — usiz bu shunchaki raqam.',
    ),

  outConfirm: (uz: boolean, lines: string[]) =>
    [
      `<b>${ru(uz, 'Проверьте: записываю выпуск', 'Tekshiring: chiqarishni yozyapman')}</b>`,
      '',
      fields(lines),
      '',
      ru(
        uz,
        'После «Записать» продукция окажется на складе настоящим приходом, и производство её оттуда не уберёт: ошибку исправляет склад своим движением.',
        '«Yozish» dan keyin mahsulot omborga haqiqiy kirim bilan tushadi va ishlab chiqarish uni u yerdan olmaydi: xatoni ombor o‘z harakati bilan tuzatadi.',
      ),
    ].join('\n'),

  defConfirm: (uz: boolean, lines: string[]) =>
    [
      `<b>${ru(uz, 'Проверьте: записываю брак', 'Tekshiring: brakni yozyapman')}</b>`,
      '',
      fields(lines),
      '',
      ru(
        uz,
        'После «Записать» брак встанет строкой в журнал отклонений и уменьшит годный выпуск заказа. Отменить запись нельзя.',
        '«Yozish» dan keyin brak chetlanishlar jurnaliga qator bo‘lib tushadi va buyurtmaning yaroqli chiqishini kamaytiradi. Yozuvni bekor qilib bo‘lmaydi.',
      ),
    ].join('\n'),

  outExplain: (uz: boolean) =>
    [
      `<b>${ru(uz, 'Другими словами', 'Boshqacha aytganda')}</b>`,
      '',
      bullets(
        ru(
          uz,
          [
            'это приход продукции на склад: остаток вырастет, и его увидят продажи',
            'партия назовётся номером заказа — по ней потом найдут, из какого сырья сделано',
            'заказ запомнит, сколько годного принято; план от этого не меняется',
            'ничего ещё не записано: пока вы не нажали «Записать», в системе ничего не произошло',
          ],
          [
            'bu mahsulotning omborga kirimi: qoldiq ko‘payadi va uni sotuv ko‘radi',
            'partiya buyurtma raqami bilan nomlanadi — keyin undan qaysi xomashyodan ekani topiladi',
            'buyurtma qancha yaroqli qabul qilinganini eslab qoladi; reja o‘zgarmaydi',
            'hali hech narsa yozilmagan: «Yozish» ni bosmaguningizcha tizimda hech nima bo‘lmagan',
          ],
        ),
      ),
    ].join('\n'),

  defExplain: (uz: boolean) =>
    [
      `<b>${ru(uz, 'Другими словами', 'Boshqacha aytganda')}</b>`,
      '',
      bullets(
        ru(
          uz,
          [
            'брак на склад не кладут: остаток от этого не растёт',
            'причина попадёт в журнал отклонений — по ней считают потери цеха',
            'этот брак потом можно отдать в переделку дочерним заказом в системе',
            'пока вы не нажали «Записать», ничего не произошло',
          ],
          [
            'brak omborga qo‘yilmaydi: qoldiq ko‘paymaydi',
            'sabab chetlanishlar jurnaliga tushadi — undan sex yo‘qotishlari hisoblanadi',
            'bu brakni keyin tizimda farzand buyurtma bilan qayta ishlashga berish mumkin',
            '«Yozish» ni bosmaguningizcha hech nima bo‘lmagan',
          ],
        ),
      ),
    ].join('\n'),

  outDone: (uz: boolean, qty: string, number: string) =>
    ru(
      uz,
      `✅ Записал выпуск ${qty} по заказу ${number}. Продукция на складе.`,
      `✅ ${number} bo‘yicha ${qty} chiqarish yozildi. Mahsulot omborda.`,
    ),

  defDone: (uz: boolean, qty: string, number: string) =>
    ru(
      uz,
      `✅ Записал брак ${qty} по заказу ${number}.`,
      `✅ ${number} bo‘yicha ${qty} brak yozildi.`,
    ),

  // --- цех и отклонения ----------------------------------------------------

  /** Почему процента загрузки нет: смен нет — или компаний в ответе несколько. */
  noLoad: (uz: boolean, manyCompanies: boolean) =>
    manyCompanies
      ? ru(
          uz,
          'загрузку не считаю: вы видите две компании сразу, а смены у каждой свои',
          'yuklanishni hisoblamayman: siz ikkita kompaniyani birga ko‘ryapsiz, smenalar esa har birida o‘ziniki',
        )
      : ru(
          uz,
          'смены не заведены — загрузку не считаю',
          'smenalar kiritilmagan — yuklanishni hisoblamayman',
        ),

  shop: (uz: boolean, lines: string[], centers: string[]) =>
    [
      `<b>🏭 ${ru(uz, 'Что в цеху сейчас', 'Hozir sexda nima bor')}</b>`,
      '',
      fields(lines),
      ...(centers.length > 0
        ? ['', `<b>${ru(uz, 'Участки', 'Uchastkalar')}</b>`, centers.join('\n')]
        : []),
    ].join('\n'),

  deviations: (uz: boolean, totals: string[], lines: string[]) =>
    [
      `<b>⚠️ ${ru(uz, 'Отклонения за 30 дней', '30 kunlik chetlanishlar')}</b>`,
      '',
      ru(
        uz,
        'Здесь всё, что пошло не по плану: простои, перерасход материала, брак и срывы сроков.',
        'Bu yerda rejadan chetga chiqqan hamma narsa: to‘xtashlar, ortiqcha sarf, brak va muddat buzilishi.',
      ),
      ...(totals.length > 0 ? ['', fields(totals)] : []),
      '',
      lines.length === 0
        ? ru(uz, 'За этот срок отклонений нет.', 'Bu muddatda chetlanish yo‘q.')
        : lines.join('\n'),
    ].join('\n'),

  // --- общее ---------------------------------------------------------------

  noRight: (uz: boolean) =>
    ru(
      uz,
      'Такого права у вас нет. Это делает начальник производства.',
      'Sizda bunday huquq yo‘q. Buni ishlab chiqarish boshlig‘i qiladi.',
    ),

  stale: (uz: boolean) =>
    ru(
      uz,
      'Это сообщение устарело — откройте раздел заново.',
      'Bu xabar eskirgan — bo‘limni qaytadan oching.',
    ),

  cancelled: (uz: boolean) =>
    ru(uz, 'Отменил, ничего не записал.', 'Bekor qildim, hech nima yozmadim.'),

  refused: (uz: boolean, message: string) =>
    ru(uz, `⚠️ Система не пропустила: ${message}`, `⚠️ Tizim o‘tkazmadi: ${message}`),

  /**
   * Снимок к заданию (ТЗ 4.1, 4.6).
   *
   * Что снимать, сказано словами: иначе приходит фото стана вообще, а спор
   * через месяц идёт о конкретной раковине на конкретной трубе. Мастер стоит у
   * стана с телефоном — для него это самый дешёвый способ оставить
   * доказательство, а для системы единственный, который не требует компьютера.
   */
  askPhoto: (uz: boolean, what: string) =>
    ru(
      uz,
      `Пришлите фото к заданию: <b>${what}</b>\n\n` +
        'Сфотографируйте и отправьте снимок в этот чат — фото ляжет к заданию и будет ' +
        'видно в карточке.\n\n' +
        '<blockquote>Что снимать: сам дефект или замер, вместе с биркой и номером ' +
        'заказа.\nЧерез месяц на вопрос «из-за чего забраковали» ответит только ' +
        'этот снимок.</blockquote>',
      `Topshiriqqa rasm yuboring: <b>${what}</b>\n\n` +
        'Suratga olib, shu chatga yuboring — rasm topshiriqqa biriktiriladi va ' +
        'kartochkada ko‘rinadi.\n\n' +
        '<blockquote>Nimani olish kerak: nuqsonning o‘zi yoki o‘lchov, yorliq va ' +
        'buyurtma raqami bilan birga.\nBir oydan keyin «nega brakka chiqarildi» ' +
        'degan savolga faqat shu rasm javob beradi.</blockquote>',
    ),

  photoWait: (uz: boolean) =>
    ru(
      uz,
      'Я жду снимок, а не текст. Сфотографируйте и пришлите, или нажмите «Отменить».',
      'Men rasm kutyapman, matn emas. Suratga olib yuboring yoki «Bekor qilish»ni bosing.',
    ),

  photoSaved: (uz: boolean, count: number) =>
    ru(
      uz,
      `Фото приложено к заданию. Всего файлов: ${count}.`,
      `Rasm topshiriqqa biriktirildi. Jami fayl: ${count}.`,
    ),

  photoLine: (uz: boolean, count: number) =>
    ru(uz, `Приложено файлов: ${count}`, `Biriktirilgan fayllar: ${count}`),
};
