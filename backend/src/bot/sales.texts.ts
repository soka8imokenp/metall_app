/**
 * Слова раздела «Продажи» в боте.
 *
 * То же правило, что в финансах и на складе (решение заказчика 02.10): сначала
 * сказано, что происходит и зачем, потом вопрос, а где можно ошибиться —
 * пример. У продаж это важнее прочего: менеджер обещает клиенту цену и срок, и
 * ошибка здесь стоит денег не на складе, а в договоре.
 */
import { bullets, fields } from './section.js';
import type { OrderStatusName } from '../sales/write.service.js';

/**
 * Статус заказа человеку и что он значит на самом деле.
 *
 * `help` — не украшение: «зарезервирован» и «комплектуется» различаются тем,
 * доступен ли товар другим заказам, и менеджер должен это понимать до того,
 * как нажмёт кнопку.
 */
export const STATUS: Record<
  OrderStatusName,
  { ru: string; uz: string; mark: string; helpRu: string; helpUz: string }
> = {
  draft: {
    ru: 'Черновик',
    uz: 'Qoralama',
    mark: '📝',
    helpRu: 'Заказ записан, но клиенту ничего не обещано и товар не отложен.',
    helpUz: 'Buyurtma yozildi, lekin mijozga hech nima va’da qilinmagan.',
  },
  confirmed: {
    ru: 'Подтверждён',
    uz: 'Tasdiqlangan',
    mark: '✅',
    helpRu: 'С клиентом договорились. Отсюда можно резервировать и отгружать.',
    helpUz: 'Mijoz bilan kelishildi. Bu yerdan zahiralash va jo‘natish mumkin.',
  },
  reserved: {
    ru: 'Зарезервирован',
    uz: 'Zahiralangan',
    mark: '🔒',
    helpRu: 'Товар отложен под этот заказ: другим заказам он больше не свободен.',
    helpUz: 'Tovar shu buyurtma uchun ajratildi: boshqalarga erkin emas.',
  },
  in_production: {
    ru: 'В производстве',
    uz: 'Ishlab chiqarishda',
    mark: '🏭',
    helpRu: 'Товар делают в цеху. Отгрузка — когда он будет готов.',
    helpUz: 'Tovar tsexda tayyorlanmoqda. Tayyor bo‘lgach jo‘natiladi.',
  },
  picking: {
    ru: 'Комплектуется',
    uz: 'Yig‘ilmoqda',
    mark: '📦',
    helpRu: 'Собирают на складе. Дальше — накладная и машина.',
    helpUz: 'Omborda yig‘ilmoqda. Keyin — yuk xati va mashina.',
  },
  shipped: {
    ru: 'Отгружен',
    uz: 'Jo‘natilgan',
    mark: '🚚',
    helpRu: 'Товар уехал клиенту. Этот статус ставит накладная, а не кнопка.',
    helpUz: 'Tovar mijozga ketdi. Bu holatni yuk xati qo‘yadi, tugma emas.',
  },
  closed: {
    ru: 'Закрыт',
    uz: 'Yopilgan',
    mark: '🏁',
    helpRu: 'По заказу больше нечего ждать: уехало и оплачено.',
    helpUz: 'Buyurtma bo‘yicha kutadigan narsa qolmadi.',
  },
  cancelled: {
    ru: 'Отменён',
    uz: 'Bekor qilingan',
    mark: '🚫',
    helpRu: 'Заказ больше не обещание. В отчётах по продажам его нет.',
    helpUz: 'Buyurtma endi va’da emas. Sotuv hisobotlarida yo‘q.',
  },
};

/** Оплата и отгрузка — отдельные стороны заказа, и обе видны в карточке. */
export const PAID: Record<string, { ru: string; uz: string }> = {
  unpaid: { ru: 'не оплачен', uz: 'to‘lanmagan' },
  partial: { ru: 'оплачен частично', uz: 'qisman to‘langan' },
  paid: { ru: 'оплачен', uz: 'to‘langan' },
};

export const SHIPPED: Record<string, { ru: string; uz: string }> = {
  none: { ru: 'не отгружен', uz: 'jo‘natilmagan' },
  partial: { ru: 'отгружен частично', uz: 'qisman jo‘natilgan' },
  full: { ru: 'отгружен полностью', uz: 'to‘liq jo‘natilgan' },
};

/** Что делает смена статуса: человек читает это до нажатия, а не после. */
export const MOVE_HELP: Partial<Record<OrderStatusName, { ru: string; uz: string }>> = {
  confirmed: {
    ru: 'Заказ станет обещанием клиенту: он попадёт в план продаж и в отчёты.',
    uz: 'Buyurtma mijozga va’da bo‘ladi: sotuv rejasiga va hisobotlarga tushadi.',
  },
  reserved: {
    ru: 'Товар отложится под этот заказ и станет недоступен другим заказам.',
    uz: 'Tovar shu buyurtma uchun ajratiladi va boshqalarga yopiladi.',
  },
  in_production: {
    ru: 'Заказ уйдёт в цех: товар будут делать, а не брать со склада.',
    uz: 'Buyurtma tsexga ketadi: tovar omborda emas, ishlab chiqariladi.',
  },
  picking: {
    ru: 'Складу сигнал собирать заказ. Остаток пока не меняется.',
    uz: 'Omborga yig‘ish signali. Qoldiq hozircha o‘zgarmaydi.',
  },
  closed: {
    ru: 'Заказ закроется: считаем, что ждать по нему больше нечего.',
    uz: 'Buyurtma yopiladi: endi kutadigan narsa yo‘q deb hisoblanadi.',
  },
  cancelled: {
    ru: 'Заказ перестанет быть обещанием и уйдёт из отчётов по продажам. Обратно не вернуть.',
    uz: 'Buyurtma va’da bo‘lmay qoladi va hisobotlardan chiqadi. Qaytarib bo‘lmaydi.',
  },
};

export const S = {
  home: (uz: boolean) =>
    uz
      ? '<b>🛒 Sotuv</b>\n\nBu yerda buyurtmalar. Nima qilish mumkin:\n' +
        bullets([
          'buyurtmalarni bosqichlar bo‘yicha ko‘rish va qidirish',
          'yangi buyurtma kiritish',
          'holatini o‘zgartirish — tasdiqlash, zaxiraga olish, bekor qilish',
          'mashinaga yuklab jo‘natish',
          'to‘lovni qabul qilish va hisob yozish',
        ]) +
        '\n\n<blockquote>Har bir amalni qadam-baqadam so‘rayman: ' +
        'bir ekranda bitta savol.</blockquote>'
      : '<b>🛒 Продажи</b>\n\nЗдесь заказы. Что можно сделать:\n' +
        bullets([
          'посмотреть заказы по этапам и найти нужный',
          'завести новый заказ',
          'сменить статус — подтвердить, зарезервировать, отменить',
          'отгрузить машину',
          'принять оплату и выписать счёт',
        ]) +
        '\n\n<blockquote>Каждое действие спрошу по шагам: ' +
        'на одном экране один вопрос.</blockquote>',

  listTitle: (uz: boolean, stage: string) => `<b>🛒 ${stage}</b>`,
  listEmpty: (uz: boolean) => (uz ? 'Bu ro‘yxat bo‘sh.' : 'Этот список пуст.'),
  list: (uz: boolean, title: string, lines: string[]) =>
    lines.length === 0
      ? `${title}\n\n${uz ? 'Bu ro‘yxat bo‘sh.' : 'Этот список пуст.'}`
      : `${title}\n<blockquote>${lines.join('\n')}</blockquote>`,

  askSearch: (uz: boolean) =>
    uz
      ? '<b>🔍 Buyurtma qidirish</b>\n\nRaqamini yoki mijoz nomini yozing.\n\n' +
        '<blockquote>Masalan: <code>ТД-000123</code> yoki <code>Denau</code></blockquote>'
      : '<b>🔍 Поиск заказа</b>\n\nНапишите номер или название клиента.\n\n' +
        '<blockquote>Например: <code>ТД-000123</code> или <code>Денау</code></blockquote>',
  searchEmpty: (uz: boolean, query: string) =>
    uz
      ? `«${query}» bo‘yicha buyurtma topilmadi. Raqamning bir qismini yozib ko‘ring.`
      : `По «${query}» заказов не нашёл. Попробуйте часть номера или название клиента.`,

  /**
   * Карточка заказа: номер и статус строкой, поля пунктами, позиции отдельным
   * блоком, объяснение статуса последним абзацем. Позиции не внутри полей —
   * список внутри списка читается как стена, и поле после него теряется.
   */
  card: (uz: boolean, lines: string[], items: string[], help: string, next: string) => {
    const [head, ...rest] = lines;
    const goods =
      items.length > 0
        ? `\n\n<b>${uz ? 'Tovar' : 'Товар в заказе'}</b>\n<blockquote>${items.join('\n')}</blockquote>`
        : '';
    return `${head}\n\n${fields(rest)}${goods}\n\n${help}${next ? `\n\n${next}` : ''}`;
  },
  cardLines: (uz: boolean) => (uz ? 'Buyurtmada' : 'В заказе'),
  nextNothing: (uz: boolean) =>
    uz ? 'Bu buyurtma bo‘yicha amal qolmadi.' : 'Действий по этому заказу больше нет.',

  availTitle: (uz: boolean) =>
    uz ? '<b>📦 Buyurtma uchun bor-yo‘g‘i</b>' : '<b>📦 Наличие под заказ</b>',
  avail: (uz: boolean, lines: string[], note: string) =>
    `${uz ? '<b>📦 Buyurtma uchun bor-yo‘g‘i</b>' : '<b>📦 Наличие под заказ</b>'}\n` +
    `<blockquote>${lines.join('\n')}</blockquote>\n${note}`,
  availOk: (uz: boolean) =>
    uz
      ? '«Erkin» — hozir omborda olish mumkin bo‘lgan miqdor. Hammasi yetadi.'
      : '«Свободно» — то, что можно забрать со склада сейчас. Хватает на всё.',
  availShort: (uz: boolean) =>
    uz
      ? '🔴 Yetmaydi: qizil qatorlarda omborda kam. Jo‘natish shu miqdorda rad etiladi — ' +
        'kirim kerak yoki kamroq jo‘natish kerak.'
      : '🔴 Не хватает: по красным строкам на складе меньше, чем обещано. Отгрузка на это ' +
        'количество не пройдёт — нужен приход или везти меньше.',

  // --- новый заказ ---------------------------------------------------------

  newHead: (uz: boolean) =>
    uz
      ? '<b>➕ Yangi buyurtma</b>\nMijozga va’da: nima, qancha va qancha pulga.'
      : '<b>➕ Новый заказ</b>\nОбещание клиенту: что, сколько и за какие деньги.',
  step: (uz: boolean, n: number, total: number, title: string) =>
    uz ? `<b>Qadam ${n}/${total} · ${title}</b>` : `<b>Шаг ${n} из ${total} · ${title}</b>`,

  /** Последний шаг назван: он стоит в строке «дальше» рядом с вопросами. */
  checkTitle: (uz: boolean) => (uz ? 'Tekshirish' : 'Проверка'),

  /**
   * «Я не понял» на проверке заказа: то же самое словами.
   *
   * Заказ отличается от денег и склада тем, что он обещание клиенту. Человек
   * должен знать, что черновик ещё ничего не обещает и что товар со склада при
   * записи не уходит, — иначе менеджер в поле считает заказ отгрузкой.
   */
  explain: (uz: boolean, o: { client: string; total: string; warehouse: string }) => {
    const head = uz ? '<b>Oddiy so‘zlar bilan</b>' : '<b>Простыми словами</b>';
    const body = uz
      ? `Hozircha hech nima yozilmagan. «✅ Yozish»ni bossangiz, <b>${o.client}</b> uchun ` +
        `qoralama buyurtma paydo bo‘ladi: <b>${o.total}</b>.\n\n` +
        'Qoralama mijozga hech narsa va’da qilmaydi: uni siz va tizimda ishlaydiganlar ko‘radi. ' +
        'Va’daga aylanishi uchun buyurtma alohida tugma bilan tasdiqlanadi.'
      : `Пока ничего не записано. Нажмёте «✅ Записать» — появится заказ-черновик для ` +
        `<b>${o.client}</b> на <b>${o.total}</b>.\n\n` +
        'Черновик клиенту ничего не обещает: его видите вы и те, кто работает в системе. ' +
        'Обещанием заказ становится, когда его подтвердят отдельной кнопкой.';
    const tail = uz
      ? `<blockquote>Tovar hozir «${o.warehouse}» omboridan chiqmaydi — jo‘natish alohida amal.\n` +
        'Qator yoki narx xato bo‘lsa — ⬅️ Orqaga. Umuman kerak bo‘lmasa — ❌ Bekor qilish.</blockquote>'
      : `<blockquote>Товар сейчас со склада «${o.warehouse}» не уходит — отгрузка отдельным действием.\n` +
        'Позиция или цена не те — ⬅️ Назад. Не нужно вовсе — ❌ Отменить.</blockquote>';
    return `${head}\n\n${body}\n\n${tail}`;
  },

  companyTitle: (uz: boolean) => (uz ? 'Kompaniya' : 'Компания'),
  askCompany: (uz: boolean) =>
    uz ? 'Qaysi kompaniya nomidan sotamiz?' : 'От какой компании продаём?',

  partnerTitle: (uz: boolean) => (uz ? 'Mijoz' : 'Клиент'),
  askPartner: (uz: boolean) =>
    uz
      ? 'Kim sotib oladi?\n\nRo‘yxatdan tanlang yoki nomini yozing — topaman.\n\n' +
        '<blockquote>Mijoz ro‘yxatda yo‘qmi — uni avval tizimda yaratish kerak: ' +
        'shartnoma va to‘lov muddati u yerda belgilanadi.</blockquote>'
      : 'Кто покупает?\n\nВыберите из списка или напишите название — найду.\n\n' +
        '<blockquote>Клиента нет в списке — его сначала заводят в системе: там договор ' +
        'и отсрочка платежа.</blockquote>',
  partnerNotFound: (uz: boolean, query: string) =>
    uz
      ? `«${query}» bo‘yicha mijoz topilmadi. Nomning bir qismini yozib ko‘ring.`
      : `По «${query}» клиента не нашёл. Попробуйте часть названия.`,

  itemTitle: (uz: boolean) => (uz ? 'Tovar' : 'Товар'),
  askItem: (uz: boolean) =>
    uz
      ? 'Qaysi tovar?\n\nRo‘yxatdan tanlang — oxirgi sotilganlar, — yoki nomini yoki kodini ' +
        'yozing.\n\n<blockquote>Masalan: <code>truba</code> yoki <code>ТР-108</code></blockquote>'
      : 'Какой товар?\n\nВыберите из списка — это то, что продавали последним, — или ' +
        'напишите название или код.\n\n' +
        '<blockquote>Например: <code>труба</code> или <code>ТР-108</code></blockquote>',
  itemNotFound: (uz: boolean, query: string) =>
    uz
      ? `«${query}» bo‘yicha tovar topilmadi. Boshqacha yozib ko‘ring — nom qismi yoki kod.`
      : `По «${query}» товара не нашёл. Попробуйте иначе — часть названия или код.`,

  qtyTitle: (uz: boolean) => (uz ? 'Miqdor' : 'Количество'),
  askQty: (uz: boolean, unit: string) =>
    uz
      ? `Qancha? O‘lchov: <b>${unit}</b>.\n\nFaqat son yozing. Kasr bo‘lsa — vergul bilan: ` +
        '<code>12,5</code>'
      : `Сколько? Единица: <b>${unit}</b>.\n\nНапишите только число. Дробное — через запятую: ` +
        '<code>12,5</code>',
  badQty: (uz: boolean) =>
    uz
      ? 'Bu miqdorga o‘xshamaydi. Faqat son yozing, masalan <code>12,5</code>'
      : 'Это не похоже на количество. Напишите только число, например <code>12,5</code>',

  /** Цена из прайса: человеку говорим, откуда она, и не спрашиваем лишнего. */
  priceFromList: (uz: boolean, price: string, source: string) =>
    uz
      ? `Narx tayyor: <b>${price}</b> (${source}). Qo‘lda o‘zgartirish kerak bo‘lsa — yozing.`
      : `Цена есть: <b>${price}</b> (${source}). Нужно другую — напишите её.`,
  priceSourcePartner: (uz: boolean) => (uz ? 'mijoz narxi' : 'цена клиента'),
  priceSourceList: (uz: boolean) => (uz ? 'narxlar ro‘yxati' : 'прайс'),

  priceTitle: (uz: boolean) => (uz ? 'Narx' : 'Цена'),
  askPrice: (uz: boolean, unit: string, cost: string | null) =>
    (uz
      ? `Birlik narxi qancha? O‘lchov: <b>${unit}</b>.\n\nNarxlar ro‘yxatida bu tovar uchun ` +
        'narx yo‘q, shuning uchun so‘rayapman.'
      : `Какая цена за единицу? Единица: <b>${unit}</b>.\n\nВ прайсе цены на этот товар нет, ` +
        'поэтому спрашиваю.') +
    (cost
      ? uz
        ? `\n\n<blockquote>Omborda turgan tovarning tannarxi: <b>${cost}</b>. Undan arzon ` +
          'sotish zarar — tizim bunga ruxsat bermasligi mumkin.</blockquote>'
        : `\n\n<blockquote>Себестоимость того, что лежит на складе: <b>${cost}</b>. Продать ` +
          'дешевле — работать в убыток, система может это не пропустить.</blockquote>'
      : ''),
  badPrice: (uz: boolean) =>
    uz
      ? 'Bu narxga o‘xshamaydi. Faqat son yozing, masalan <code>14500</code>'
      : 'Это не похоже на цену. Напишите только число, например <code>14500</code>',

  priceWhyTitle: (uz: boolean) => (uz ? 'Narx sababi' : 'Почему такая цена'),
  askPriceWhy: (uz: boolean) =>
    uz
      ? 'Narxni o‘zingiz aytdingiz — sababini yozing.\n\nBu buyurtmada qoladi: keyin ' +
        '«nega bunday narx» savoliga javob shu yozuv bo‘ladi.\n\n' +
        '<blockquote>Masalan: <code>katta hajm uchun chegirma, rahbar bilan kelishildi</code>' +
        '</blockquote>'
      : 'Цену назвали вы — напишите, почему.\n\nЭто останется в заказе: на вопрос «почему ' +
        'такая цена» потом отвечает именно эта запись.\n\n' +
        '<blockquote>Например: <code>скидка за объём, согласовано с руководителем</code>' +
        '</blockquote>',

  moreTitle: (uz: boolean) => (uz ? 'Yana tovar' : 'Ещё товар'),
  askMore: (uz: boolean, lines: string[]) =>
    uz
      ? `Buyurtmada hozir:\n<blockquote>${lines.join('\n')}</blockquote>\nYana tovar bormi?`
      : `В заказе сейчас:\n<blockquote>${lines.join('\n')}</blockquote>\nЕщё товар будет?`,

  warehouseTitle: (uz: boolean) => (uz ? 'Ombor' : 'Склад'),
  askWarehouse: (uz: boolean) =>
    uz
      ? 'Qaysi ombordan olib ketiladi?\n\n<blockquote>Buyurtma uchun bor-yo‘g‘i shu ombor ' +
        'bo‘yicha hisoblanadi va mashina ham shu yerdan yuklanadi.</blockquote>'
      : 'С какого склада повезём?\n\n<blockquote>По этому складу бот потом покажет наличие ' +
        'под заказ, и машину грузят с него же.</blockquote>',

  dueTitle: (uz: boolean) => (uz ? 'To‘lov muddati' : 'Срок оплаты'),
  askDue: (uz: boolean, suggestion: string, delay: number) =>
    uz
      ? `Mijoz qachon to‘laydi?\n\nShartnoma bo‘yicha muddat — <b>${delay}</b> kun, ya’ni ` +
        `<b>${suggestion}</b>. Boshqa kun bo‘lsa — yozing: <code>25.10</code>\n\n` +
        '<blockquote>Bu kundan keyin to‘lanmagan buyurtma qarzlar ro‘yxatida muddati ' +
        'o‘tgan bo‘lib ko‘rinadi.</blockquote>'
      : `Когда клиент заплатит?\n\nПо договору отсрочка <b>${delay}</b> дней — это ` +
        `<b>${suggestion}</b>. Другой день — напишите: <code>25.10</code>\n\n` +
        '<blockquote>После этого дня неоплаченный заказ попадёт в долги как ' +
        'просроченный.</blockquote>',
  badDay: (uz: boolean) =>
    uz
      ? 'Sanani <code>25.10</code> yoki <code>25.10.2026</code> shaklida yozing.'
      : 'Напишите дату как <code>25.10</code> или <code>25.10.2026</code>.',

  confirm: (uz: boolean, lines: string[]) =>
    uz
      ? `<b>Tekshirib oling</b>\n\n${fields(lines)}\n\n` +
        '«Yozish»ni bossangiz, buyurtma qoralama bo‘lib yoziladi. Tovar hali ajratilmaydi — ' +
        'buning uchun holatni o‘zgartirasiz.'
      : `<b>Проверьте</b>\n\n${fields(lines)}\n\n` +
        'Нажмёте «Записать» — заказ сохранится черновиком. Товар при этом ещё не ' +
        'откладывается: для этого потом меняют статус.',
  saved: (uz: boolean, number: string, total: string) =>
    uz
      ? `Buyurtma yozildi: <b>${number}</b> · ${total}. Hozir u qoralama.`
      : `Заказ записан: <b>${number}</b> · ${total}. Сейчас он черновик.`,

  // --- статус и отгрузка ---------------------------------------------------

  askStatus: (uz: boolean, number: string, target: string, help: string) =>
    uz
      ? `<b>${number}</b> buyurtmasini «${target}» holatiga o‘tkazamizmi?\n\n${help}`
      : `Перевести заказ <b>${number}</b> в «${target}»?\n\n${help}`,
  statusDone: (uz: boolean, target: string) =>
    uz ? `Holat o‘zgardi: <b>${target}</b>.` : `Статус изменён: <b>${target}</b>.`,

  shipHead: (uz: boolean, number: string) =>
    uz
      ? `<b>🚚 ${number} bo‘yicha jo‘natish</b>\nTovar aynan shu yerda ombordan chiqadi.`
      : `<b>🚚 Отгрузка по ${number}</b>\nИменно здесь товар уходит со склада.`,
  shipQtyTitle: (uz: boolean, n: number, total: number) =>
    uz ? `Qator ${n}/${total}` : `Строка ${n} из ${total}`,
  askShipQty: (uz: boolean, item: string, remaining: string, available: string) =>
    uz
      ? `<b>${item}</b>\n\nQancha ketadi?\n<blockquote>Va’da qilingan, hali ketmagan: ` +
        `<b>${remaining}</b>\nOmborda erkin: <b>${available}</b></blockquote>\n\n` +
        'Hammasini jo‘natsangiz — tugmani bosing. Kamroq bo‘lsa — sonni yozing.'
      : `<b>${item}</b>\n\nСколько уедет?\n<blockquote>Обещано и ещё не отгружено: ` +
        `<b>${remaining}</b>\nСвободно на складе: <b>${available}</b></blockquote>\n\n` +
        'Везёте всё — нажмите кнопку. Меньше — напишите число.',
  shipTooMuch: (uz: boolean, remaining: string) =>
    uz
      ? `Va’da qilinganidan ko‘p jo‘natib bo‘lmaydi: qoldi <b>${remaining}</b>.`
      : `Больше обещанного отгрузить нельзя: осталось <b>${remaining}</b>.`,
  askShipBatch: (uz: boolean, item: string) =>
    uz
      ? `<b>${item}</b>\n\nQaysi partiyadan olib ketiladi?\n\n<blockquote>Partiya — bu ` +
        'aynan shu yetkazib berish yoki quyma. Uning raqami yuk xatiga va mijozning ' +
        'sertifikatiga tushadi, shuning uchun tizim o‘zi tanlamaydi.\nOdatda eng oldin ' +
        'kelgani ketadi.</blockquote>'
      : `<b>${item}</b>\n\nИз какой партии везём?\n\n<blockquote>Партия — это конкретная ` +
        'поставка или плавка. Её номер попадёт в накладную и в сертификат клиенту, поэтому ' +
        'система не выбирает её за вас.\nОбычно везут то, что пришло раньше.</blockquote>',
  shipBatchTitle: (uz: boolean) => (uz ? 'Partiya' : 'Партия'),

  shipInfoTitle: (uz: boolean) => (uz ? 'Mashina va haydovchi' : 'Машина и водитель'),
  askShipInfo: (uz: boolean) =>
    uz
      ? 'Kim olib ketadi?\n\nMashina raqami va haydovchini bitta satrda yozing, vergul ' +
        'bilan.\n\n<blockquote>Masalan: <code>01A123BC, Ergashev</code>\nYuk xatida shu ' +
        'yoziladi. Bilmasangiz — o‘tkazib yuboring.</blockquote>'
      : 'Кто повезёт?\n\nНапишите номер машины и водителя одной строкой, через запятую.\n\n' +
        '<blockquote>Например: <code>01A123BC, Эргашев</code>\nЭто попадёт в накладную. ' +
        'Не знаете — пропустите.</blockquote>',
  shipConfirm: (uz: boolean, lines: string[]) =>
    uz
      ? `<b>Tekshirib oling</b>\n\n${fields(lines)}\n\n` +
        '«Jo‘natish»ni bossangiz, tovar shu zahoti ombordan chiqadi va qoldiq kamayadi. ' +
        'Dona raqamlarini tizim o‘zi tanlaydi — eng oldin kelgani ketadi.'
      : `<b>Проверьте</b>\n\n${fields(lines)}\n\n` +
        'Нажмёте «Отгрузить» — товар сразу уйдёт со склада и остаток уменьшится. Номера ' +
        'штучного товара система выберет сама: уезжает то, что пришло раньше.',
  shipped: (uz: boolean, number: string, order: string) =>
    uz
      ? `Yuk xati yozildi: <b>${number}</b>. ${order} holati yangilandi, qoldiq kamaydi.`
      : `Накладная записана: <b>${number}</b>. Статус ${order} обновлён, остаток уменьшился.`,
  shipNothing: (uz: boolean) =>
    uz
      ? 'Hamma qatorda nol — jo‘natadigan narsa yo‘q.'
      : 'Во всех строках ноль — отгружать нечего.',
  shipClosed: (uz: boolean) =>
    uz
      ? 'Bu holatda jo‘natib bo‘lmaydi: avval buyurtmani tasdiqlang.'
      : 'Из этого статуса отгружать нельзя: сначала подтвердите заказ.',

  cancelled: (uz: boolean) =>
    uz ? 'Bekor qildim, hech nima yozilmadi.' : 'Отменил, ничего не записано.',
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

/** Названия вкладок списка. Этапы те же, что на экране в браузере. */
export const STAGE: Record<string, { ru: string; uz: string; mark: string }> = {
  all: { ru: 'Все заказы', uz: 'Barcha buyurtmalar', mark: '🛒' },
  unpaid: { ru: 'Не оплачены', uz: 'To‘lanmagan', mark: '💰' },
  paid: { ru: 'Оплачены', uz: 'To‘langan', mark: '✅' },
  production: { ru: 'В производстве', uz: 'Ishlab chiqarishda', mark: '🏭' },
  shipped: { ru: 'Отгружены', uz: 'Jo‘natilgan', mark: '🚚' },
};
