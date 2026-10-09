/**
 * Слова раздела «Склад» в боте.
 *
 * То же правило, что и в финансах (решение заказчика 02.10): сначала сказано,
 * что здесь происходит и зачем, потом вопрос; где можно ошибиться — пример.
 * Кладовщик работает в цеху с телефоном в руке, читать ему некогда — поэтому
 * объяснение короткое, одна-две строки, и всегда по делу.
 */
import { bullets, fields } from './section.js';
import type { MoveKind } from './warehouse.flow.js';

/** Как называется движение человеку и что оно делает с остатком. */
export const KIND: Record<
  MoveKind,
  { ru: string; uz: string; mark: string; aboutRu: string; aboutUz: string }
> = {
  receipt: {
    ru: 'Приход',
    uz: 'Kirim',
    mark: '📥',
    aboutRu: 'Привезли товар — он появляется на складе.',
    aboutUz: 'Tovar keltirildi — u omborda paydo bo‘ladi.',
  },
  write_off: {
    ru: 'Списание',
    uz: 'Hisobdan chiqarish',
    mark: '📤',
    aboutRu: 'Товара больше нет: брак, порча, недостача. Остаток уменьшится.',
    aboutUz: 'Tovar yo‘q: brak, buzilish, kamomad. Qoldiq kamayadi.',
  },
  transfer: {
    ru: 'Перемещение',
    uz: 'Ko‘chirish',
    mark: '🔀',
    aboutRu: 'Товар переложили в другое место. Всего на складах столько же.',
    aboutUz: 'Tovar boshqa joyga o‘tkazildi. Omborlarda umumiy miqdor o‘zgarmaydi.',
  },
  issue_to_production: {
    ru: 'Выдача в цех',
    uz: 'Tsexga berish',
    mark: '🏭',
    aboutRu: 'Материал ушёл в работу. Со склада он списывается.',
    aboutUz: 'Material ishga ketdi. Ombordan hisobdan chiqadi.',
  },
  return_from_production: {
    ru: 'Возврат из цеха',
    uz: 'Tsexdan qaytdi',
    mark: '↩️',
    aboutRu: 'Материал не понадобился и вернулся на склад.',
    aboutUz: 'Material kerak bo‘lmadi va omborga qaytdi.',
  },
  return_from_client: {
    ru: 'Возврат от клиента',
    uz: 'Mijozdan qaytdi',
    mark: '↩️',
    aboutRu: 'Клиент вернул товар. Он снова на складе.',
    aboutUz: 'Mijoz tovarni qaytardi. U yana omborda.',
  },
  surplus: {
    ru: 'Излишек',
    uz: 'Ortiqcha',
    mark: '➕',
    aboutRu:
      'Нашли товар, которого по учёту нет. Остаток вырастет без прихода — ' +
      'поэтому нужна причина.',
    aboutUz: 'Hisobda yo‘q tovar topildi. Qoldiq kirimsiz oshadi — shuning uchun sabab kerak.',
  },
};

export const W = {
  home: (uz: boolean) =>
    uz
      ? '<b>📦 Ombor</b>\n\nBu yerda tovar. Nima qilish mumkin:\n' +
        bullets([
          'qoldiqni ko‘rish — qancha va qayerda yotgani',
          'kirimni yozish — tovar keldi',
          'chiqimni yozish — tovar ketdi yoki buzildi',
          'bir ombordan boshqasiga ko‘chirish',
          'javonni qayta hisoblash',
        ]) +
        '\n\n<blockquote>Har bir amalni qadam-baqadam so‘rayman: ' +
        'bir ekranda bitta savol.</blockquote>'
      : '<b>📦 Склад</b>\n\nЗдесь товар. Что можно сделать:\n' +
        bullets([
          'посмотреть остаток — сколько и где лежит',
          'записать приход — товар привезли',
          'записать списание — товар ушёл или испортился',
          'переместить с одного склада на другой',
          'пересчитать полку',
        ]) +
        '\n\n<blockquote>Каждое действие спрошу по шагам: ' +
        'на одном экране один вопрос.</blockquote>',

  returns: (uz: boolean) =>
    uz
      ? '<b>↩️ Qaytishlar</b>\n\nTovar qayerdan qaytdi?'
      : '<b>↩️ Возвраты</b>\n\nОткуда вернулся товар?',

  kindHead: (uz: boolean, kind: MoveKind) =>
    `<b>${KIND[kind].mark} ${uz ? KIND[kind].uz : KIND[kind].ru}</b>\n` +
    (uz ? KIND[kind].aboutUz : KIND[kind].aboutRu),

  step: (uz: boolean, n: number, total: number, title: string) =>
    uz ? `<b>Qadam ${n}/${total} · ${title}</b>` : `<b>Шаг ${n} из ${total} · ${title}</b>`,

  askCompany: (uz: boolean) => (uz ? 'Qaysi kompaniya ombori?' : 'Склад какой компании?'),
  /** Последний шаг тоже назван: он стоит в строке «дальше» рядом с вопросами. */
  checkTitle: (uz: boolean) => (uz ? 'Tekshirish' : 'Проверка'),

  /**
   * «Я не понял» на проверке: то же самое словами.
   *
   * Складское движение страшнее денежной заявки: остаток меняется сразу, без
   * согласования. Человек должен узнать об этом до нажатия, а не после — и
   * заодно узнать, что ошибку правят отменой движения, а не стиранием.
   */
  explain: (uz: boolean, o: { kind: string; item: string; qty: string; place: string }) => {
    const head = uz ? '<b>Oddiy so‘zlar bilan</b>' : '<b>Простыми словами</b>';
    const body = uz
      ? `Hozircha hech nima yozilmagan. «✅ Yozish»ni bossangiz, men harakatni yozaman: ` +
        `<b>${o.kind}</b> — ${o.item}, ${o.qty}.\n\n` +
        `«${o.place}» qoldig‘i shu zahoti o‘zgaradi: ombor hisobi shu yozuvlardan chiqadi, ` +
        'tizimdagi hamma yangi sonni ko‘radi.'
      : `Пока ничего не записано. Нажмёте «✅ Записать» — я запишу движение: ` +
        `<b>${o.kind}</b> — ${o.item}, ${o.qty}.\n\n` +
        `Остаток «${o.place}» изменится сразу: склад считают по этим записям, и новое число ` +
        'увидят все, кто работает в системе.';
    const tail = uz
      ? '<blockquote>Xato yozuv o‘chirilmaydi — harakat bekor qilinadi, ikkisi ham ko‘rinib qoladi.\n' +
        'Tovar yoki miqdor xato bo‘lsa — ⬅️ Orqaga. Umuman kerak bo‘lmasa — ❌ Bekor qilish.</blockquote>'
      : '<blockquote>Ошибку не стирают — движение отменяют, и видно обе записи: и её, и отмену.\n' +
        'Товар или количество не те — ⬅️ Назад. Не нужно вовсе — ❌ Отменить.</blockquote>';
    return `${head}\n\n${body}\n\n${tail}`;
  },

  companyTitle: (uz: boolean) => (uz ? 'Kompaniya' : 'Компания'),

  askItem: (uz: boolean) =>
    uz
      ? 'Qaysi tovar?\n\nQuyidagilardan tanlang — oxirgi ishlaganlaringiz, — ' +
        'yoki nomini yoki kodini yozing, men topaman.\n\n' +
        '<blockquote>Masalan: <code>truba</code> yoki <code>ТР-108</code></blockquote>'
      : 'Какой товар?\n\nВыберите из списка — это то, с чем работали последним, — ' +
        'или напишите название или код, я найду.\n\n' +
        '<blockquote>Например: <code>труба</code> или <code>ТР-108</code></blockquote>',
  itemTitle: (uz: boolean) => (uz ? 'Tovar' : 'Товар'),
  itemNotFound: (uz: boolean, query: string) =>
    uz
      ? `«${query}» bo‘yicha hech nima topilmadi. Boshqacha yozib ko‘ring — nom qismi yoki kod.`
      : `По «${query}» ничего не нашёл. Попробуйте иначе — часть названия или код.`,

  askQty: (uz: boolean, unit: string) =>
    uz
      ? `Qancha? O‘lchov: <b>${unit}</b>.\n\nFaqat son yozing. Kasr bo‘lsa — vergul bilan: ` +
        '<code>12,5</code>'
      : `Сколько? Единица: <b>${unit}</b>.\n\nНапишите только число. Дробное — через запятую: ` +
        '<code>12,5</code>',
  qtyTitle: (uz: boolean) => (uz ? 'Miqdor' : 'Количество'),
  badQty: (uz: boolean) =>
    uz
      ? 'Bu miqdorga o‘xshamaydi. Faqat son yozing, masalan <code>12,5</code>'
      : 'Это не похоже на количество. Напишите только число, например <code>12,5</code>',

  askSerial: (uz: boolean) =>
    uz
      ? 'Bu tovar donalab hisoblanadi: har bir dona o‘z raqamiga ega.\n\n' +
        'Raqamni yozing — bitta harakat bitta dona uchun.'
      : 'Этот товар учитывается штучно: у каждой штуки свой номер.\n\n' +
        'Напишите номер — одно движение на одну штуку.',
  serialTitle: (uz: boolean) => (uz ? 'Raqam' : 'Номер'),

  askBatch: (uz: boolean, receipt: boolean) =>
    uz
      ? 'Bu tovar partiyalar bo‘yicha hisoblanadi.\n\n' +
        (receipt
          ? 'Yangi partiya raqamini yozing yoki ro‘yxatdan tanlang.'
          : 'Ro‘yxatdan partiyani tanlang yoki raqamini yozing. ' +
            'Yangi partiyani faqat kirim ochadi.')
      : 'Этот товар учитывается партиями.\n\n' +
        (receipt
          ? 'Напишите номер новой партии или выберите из списка.'
          : 'Выберите партию из списка или напишите её номер. ' +
            'Новую партию открывает только приход.'),
  batchTitle: (uz: boolean) => (uz ? 'Partiya' : 'Партия'),

  askWarehouse: (uz: boolean, from: boolean) =>
    uz
      ? from
        ? 'Qaysi ombordan olinadi?'
        : 'Qaysi omborga qo‘yiladi?'
      : from
        ? 'С какого склада берём?'
        : 'На какой склад кладём?',
  warehouseTitle: (uz: boolean, from: boolean) =>
    uz ? (from ? 'Qayerdan' : 'Qayerga') : from ? 'Откуда' : 'Куда',

  askLocation: (uz: boolean, from: boolean, warehouse: string) =>
    uz
      ? `<b>${warehouse}</b> omborida qaysi joy?\n\nJoy — tovar yotgan aniq javon yoki maydon. ` +
        'Xato joy — keyin topib bo‘lmaydi.'
      : `Какое место на складе <b>${warehouse}</b>?\n\nМесто — это та самая полка или площадка, ` +
        'где товар лежит. Ошибётесь — потом не найдут.',
  locationTitle: (uz: boolean) => (uz ? 'Joy' : 'Место'),

  askCost: (uz: boolean, unit: string) =>
    uz
      ? `1 ${unit} uchun narx qancha?\n\nBu narx tovar tannarxiga kiradi va keyin foydani ` +
        'hisoblashda ishlatiladi. Bilmasangiz — «Bilmayman»ni bosing, moliyachi aniqlaydi.'
      : `Сколько стоит 1 ${unit}?\n\nЭта цена войдёт в себестоимость товара, по ней потом ` +
        'считают прибыль. Не знаете — нажмите «Не знаю», финансист уточнит.',
  costTitle: (uz: boolean) => (uz ? 'Narx' : 'Цена'),
  badCost: (uz: boolean) =>
    uz
      ? 'Bu narxga o‘xshamaydi. Son yozing, masalan <code>8500000</code>'
      : 'Это не похоже на цену. Напишите число, например <code>8500000</code>',

  askReason: (uz: boolean) =>
    uz
      ? 'Sabab nima?\n\nSabab hisobotda qoladi: oy oxirida nega qoldiq kamayganini ' +
        'shu bo‘yicha tushuntiradilar.'
      : 'По какой причине?\n\nПричина останется в отчёте: по ней в конце месяца объясняют, ' +
        'почему остаток уменьшился.',
  reasonTitle: (uz: boolean) => (uz ? 'Sabab' : 'Причина'),

  askPartner: (uz: boolean, role: 'supplier' | 'client', need: boolean) =>
    uz
      ? (role === 'supplier' ? 'Kim keltirdi?' : 'Kim qaytardi?') +
        (need
          ? '\n\nBuni ko‘rsatish shart: aks holda tovar qayerdan kelganini keyin aytib bo‘lmaydi.'
          : '\n\nRo‘yxatdan tanlang yoki nomini yozing. Bilmasangiz — o‘tkazib yuboring.')
      : (role === 'supplier' ? 'Кто привёз?' : 'Кто вернул?') +
        (need
          ? '\n\nУказать обязательно: иначе потом не ответить, откуда взялся товар.'
          : '\n\nВыберите из списка или напишите название. Не знаете — пропустите.'),
  partnerTitle: (uz: boolean) => (uz ? 'Kim bilan' : 'Контрагент'),
  /**
   * Новая партия без поставщика — партия без происхождения: ни сертификат к
   * ней привязать, ни претензию по металлу предъявить. Поэтому на приходе,
   * который открывает партию, контрагент обязателен, хотя на обычном приходе
   * его можно пропустить.
   */
  partnerNeededNew: (uz: boolean) =>
    uz
      ? 'Bu kirim yangi partiyani ochadi. Kim keltirganini ko‘rsatish shart: aks holda ' +
        'partiyaning kelib chiqishi yo‘qoladi — sertifikatni ham biriktirib bo‘lmaydi.'
      : 'Этот приход открывает новую партию. Поставщика указать обязательно: иначе ' +
        'происхождение партии потеряно — к ней не привязать ни сертификат, ни претензию.',
  partnerNotFound: (uz: boolean, query: string) =>
    uz
      ? `«${query}» topilmadi. Boshqacha yozib ko‘ring.`
      : `«${query}» не нашёл. Попробуйте написать иначе.`,

  askComment: (uz: boolean) =>
    uz
      ? 'Izoh qo‘shasizmi?\n\nQisqa eslatma: masalan, <i>mashina raqami</i> yoki ' +
        '<i>qabul qilgan kishi</i>. Kerak bo‘lmasa — o‘tkazib yuboring.'
      : 'Добавить примечание?\n\nКороткая заметка: например, <i>номер машины</i> или ' +
        '<i>кто принимал</i>. Не нужно — пропустите.',
  commentTitle: (uz: boolean) => (uz ? 'Izoh' : 'Примечание'),

  confirm: (uz: boolean, lines: string[]) =>
    uz
      ? `<b>Tekshirib oling</b>\n\n${fields(lines)}\n\n` +
        '«Yozish»ni bossangiz, qoldiq shu zahoti o‘zgaradi. Xato bo‘lsa — harakatni ' +
        'bekor qilish mumkin, lekin ikkisi ham tarixda qoladi.'
      : `<b>Проверьте</b>\n\n${fields(lines)}\n\n` +
        'Нажмёте «Записать» — остаток изменится сразу. Ошибётесь — движение можно отменить, ' +
        'но в истории останутся оба.',

  saved: (uz: boolean, title: string) =>
    uz
      ? `Yozildi: <b>${title}</b>. Qoldiq o‘zgardi.`
      : `Записано: <b>${title}</b>. Остаток изменился.`,
  cancelled: (uz: boolean) =>
    uz ? 'Bekor qildim, hech nima yozilmadi.' : 'Отменил, ничего не записано.',

  stockAsk: (uz: boolean) =>
    uz
      ? '<b>🔍 Qoldiq</b>\n\nTovar nomini yoki kodini yozing — qancha va qayerda yotganini ' +
        'ko‘rsataman.\n\n<blockquote>Masalan: <code>truba</code>, <code>ТР-108</code></blockquote>'
      : '<b>🔍 Остаток</b>\n\nНапишите название или код товара — покажу, сколько и где лежит.' +
        '\n\n<blockquote>Например: <code>труба</code>, <code>ТР-108</code></blockquote>',
  stockFound: (uz: boolean, query: string, lines: string[]) =>
    uz
      ? `<b>🔍 «${query}» bo‘yicha qoldiq</b>\n<blockquote>${lines.join('\n')}</blockquote>\n\n` +
        '«Erkin» — buyurtmalarga band qilinmagan, olish mumkin bo‘lgan miqdor.'
      : `<b>🔍 Остаток по «${query}»</b>\n<blockquote>${lines.join('\n')}</blockquote>\n\n` +
        '«Свободно» — это сколько можно взять: без того, что уже обещано по заказам.',
  stockEmpty: (uz: boolean, query: string) =>
    uz
      ? `«${query}» bo‘yicha qoldiq yo‘q. Boshqacha yozib ko‘ring.`
      : `По «${query}» остатка нет. Попробуйте написать иначе.`,

  moves: (uz: boolean, lines: string[]) =>
    uz
      ? '<b>📋 Oxirgi harakatlar</b>\n\n' +
        (lines.length === 0 ? 'Bo‘sh.' : `<blockquote>${lines.join('\n')}</blockquote>`)
      : '<b>📋 Последние движения</b>\n\n' +
        (lines.length === 0 ? 'Пусто.' : `<blockquote>${lines.join('\n')}</blockquote>`),
  /** Карточка движения: что это было — строкой, поля пунктами, объяснение ниже. */
  moveCard: (uz: boolean, lines: string[], note: string) => {
    const [head, ...rest] = lines;
    return `${head}\n\n${fields(rest)}\n\n${note}`;
  },
  moveCanReverse: (uz: boolean) =>
    uz
      ? 'Bu harakatni bekor qilish mumkin: teskari harakat yoziladi, qoldiq avvalgi holga qaytadi.'
      : 'Это движение можно отменить: запишется обратное, остаток вернётся как было.',
  moveCannotReverse: (uz: boolean) =>
    uz
      ? 'Bu harakatni bekor qilib bo‘lmaydi: unda hujjat bor yoki u allaqachon bekor qilingan.'
      : 'Это движение отменить нельзя: на нём документ или оно уже отменено.',
  askReverse: (uz: boolean) =>
    uz
      ? '⚠️ Harakatni bekor qilasizmi?\n\nTeskari harakat yoziladi va qoldiq avvalgi holga ' +
        'qaytadi. Ikkisi ham tarixda qoladi — omborda hech nima yashirilmaydi.'
      : '⚠️ Отменить движение?\n\nЗапишется обратное движение, и остаток вернётся как было. ' +
        'В истории останутся оба — на складе ничего не прячут.',
  reversed: (uz: boolean) =>
    uz ? 'Bekor qilindi. Qoldiq avvalgi holga qaytdi.' : 'Отменено. Остаток вернулся как был.',

  needs: (uz: boolean, lines: string[]) =>
    uz
      ? '<b>📉 Nima yetishmaydi</b>\n\nKritik darajadan past yoki pastga tushmoqda.\n' +
        (lines.length === 0 ? 'Hammasi joyida.' : `<blockquote>${lines.join('\n')}</blockquote>`)
      : '<b>📉 Чего не хватает</b>\n\nНиже критического уровня или подходит к нему.\n' +
        (lines.length === 0 ? 'Всё в порядке.' : `<blockquote>${lines.join('\n')}</blockquote>`),

  sheets: (uz: boolean, lines: string[]) =>
    uz
      ? '<b>🧮 Qayta hisoblash</b>\n\nQayta hisoblash — javondagi tovarni hisobdagi bilan ' +
        'solishtirish.\n' +
        (lines.length === 0
          ? 'Ochiq varaq yo‘q. Yangisini tizimda ochadilar.'
          : `<blockquote>${lines.join('\n')}</blockquote>`)
      : '<b>🧮 Пересчёт</b>\n\nПересчёт — это сверка того, что лежит на полке, с тем, что ' +
        'в учёте.\n' +
        (lines.length === 0
          ? 'Открытых листов нет. Новый лист открывают в системе.'
          : `<blockquote>${lines.join('\n')}</blockquote>`),
  sheet: (uz: boolean, head: string, lines: string[]) =>
    `${head}\n<blockquote>${lines.join('\n')}</blockquote>`,
  sheetHead: (uz: boolean, number: string, warehouse: string, counted: number, total: number) =>
    uz
      ? `<b>🧮 ${number}</b> · ${warehouse}\nHisoblangan: ${counted} / ${total}`
      : `<b>🧮 ${number}</b> · ${warehouse}\nПосчитано: ${counted} из ${total}`,
  askCount: (uz: boolean, title: string, unit: string, expected = '') =>
    uz
      ? `<b>${title}</b>\n\nJavonda nechta bor? O‘lchov: <b>${unit}</b>.\n\n` +
        'Hisobdagi miqdorni ko‘rsatmayman — ko‘rsatsam, uni ko‘chirib yozish oson bo‘lardi, ' +
        'qayta hisoblashning ma’nosi esa shundan yo‘qoladi.'
      : `<b>${title}</b>\n\nСколько лежит на полке? Единица: <b>${unit}</b>.\n\n` +
        `По учёту должно быть ${expected}.`,
  counted: (uz: boolean, diff: string | null) =>
    uz
      ? `Yozdim.${diff ? ` Farq: <b>${diff}</b>` : ' Farq yo‘q.'}`
      : `Записал.${diff ? ` Расхождение: <b>${diff}</b>` : ' Расхождений нет.'}`,
  sheetDone: (uz: boolean) =>
    uz
      ? 'Hamma satrlar hisoblandi. Varaqni yopish mumkin — keyin uni tasdiqlaydilar, ' +
        'va shundan keyingina qoldiq o‘zgaradi.'
      : 'Все строки посчитаны. Лист можно закрыть — дальше его утверждают, и только тогда ' +
        'остаток меняется.',
  askFinish: (uz: boolean) =>
    uz
      ? 'Varaqni yopasizmi?\n\nYopilgandan keyin hisoblash mumkin emas. Qoldiq hali ' +
        'o‘zgarmaydi — buni tasdiqlash qiladi.'
      : 'Закрыть лист?\n\nПосле закрытия считать больше нельзя. Остаток пока не меняется — ' +
        'это делает утверждение.',
  askApprove: (uz: boolean) =>
    uz
      ? '⚠️ Varaqni tasdiqlaysizmi?\n\nFarqlar qoldiqqa yoziladi: kamomad hisobdan chiqadi, ' +
        'ortiqcha kirim qiladi. Buni qaytarib bo‘lmaydi.'
      : '⚠️ Утвердить лист?\n\nРасхождения запишутся в остаток: недостача спишется, излишек ' +
        'придёт. Обратно это не отменить.',

  // --- фотография к движению -------------------------------------------
  // Списание уводит товар в никуда, и через месяц спор «а что там было»
  // решается только снимком. Кладовщик стоит у штабеля с телефоном — для него
  // это самый дешёвый способ оставить доказательство.

  askPhoto: (uz: boolean, what: string) =>
    uz
      ? `Shu harakatga rasm yuboring: <b>${what}</b>\n\n` +
        'Suratga olib, shu chatga yuboring — rasm harakatga biriktiriladi va tizimda ko‘rinadi.\n\n' +
        '<blockquote>Nimani olish kerak: tovarning o‘zi va nuqsoni ko‘rinsin, ' +
        'yorliq va partiya raqami bilan birga.\n' +
        'Bir oydan keyin «u yerda nima bo‘lgan» degan savolga faqat shu rasm javob beradi.</blockquote>'
      : `Пришлите фото к движению: <b>${what}</b>\n\n` +
        'Сфотографируйте и отправьте снимок в этот чат — фото ляжет к движению и будет ' +
        'видно в системе.\n\n' +
        '<blockquote>Что снимать: сам товар и то, из-за чего его списывают, ' +
        'вместе с биркой и номером партии.\n' +
        'Через месяц на вопрос «что там было» ответит только этот снимок.</blockquote>',

  photoWait: (uz: boolean) =>
    uz
      ? 'Men rasm kutyapman, matn emas. Suratga olib yuboring yoki «Bekor qilish»ni bosing.'
      : 'Я жду снимок, а не текст. Сфотографируйте и пришлите, или нажмите «Отменить».',

  photoSaved: (uz: boolean, count: number) =>
    uz
      ? `Rasm harakatga biriktirildi. Jami fayl: ${count}.`
      : `Фото приложено к движению. Всего файлов: ${count}.`,

  photoLine: (uz: boolean, count: number) =>
    uz ? `Biriktirilgan fayllar: ${count}` : `Приложено файлов: ${count}`,

  noRight: (uz: boolean) =>
    uz
      ? 'Bu amalni bajarish huquqi sizga berilmagan. Administrator rol bersin.'
      : 'Права на это действие вам не выдано. Попросите администратора.',
  stale: (uz: boolean) =>
    uz
      ? 'Bu tugma o‘tgan qadamdan qolgan. Hozirgi savol quyida.'
      : 'Эта кнопка осталась с прошлого шага. Текущий вопрос ниже.',
  refused: (uz: boolean, message: string) =>
    uz ? `Bo‘lmadi: ${message}` : `Не получилось: ${message}`,
} as const;
