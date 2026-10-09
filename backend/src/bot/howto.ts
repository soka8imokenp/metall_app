/**
 * «Как пользоваться» — короткие пути к делам этого человека.
 *
 * Зачем экран нужен: пользователи бота — люди, которые системой не
 * пользовались никогда. Кнопки они видят, но не знают, с какой начать, чтобы
 * сделать дело, за которым пришли. Список команд этому не помогает — человек
 * пришёл не за командами, а за «как записать приход».
 *
 * Почему это меню из кнопок, а не одна простыня: подпись панели в Telegram —
 * 1024 знака, и у администратора все пути в неё не влезают (хвост молча
 * обрезается). Да и читать двенадцать путей подряд человек не станет. Поэтому
 * экран — кнопка на дело, а путь показывается по одному.
 *
 * Строка появляется только у того, у кого есть право на это дело: путь,
 * который отобьётся на первом же нажатии, обманывает дважды — человек
 * попробует и решит, что бот сломан.
 *
 * Подписи кнопок в путях — те же, что человек видит на экране. Переименуют
 * кнопку, а здесь забудут — человек будет искать слово, которого на экране
 * нет; это держит тест «подсказка ведёт по настоящим кнопкам».
 */
export interface HowToPath {
  /** Короткий код для кнопки: едет в `callback_data`, поэтому без пробелов. */
  key: string;
  /** Без этого права путь человеку не показывается. */
  permission: string;
  /** Подпись кнопки: дело словами человека, а не названием раздела. */
  ru: string;
  uz: string;
  /** Сам путь нажатий, от первой кнопки до последней. */
  pathRu: string;
  pathUz: string;
  /** Что получится в конце. Человек должен знать это до того, как начнёт. */
  outRu: string;
  outUz: string;
}

export const HOWTO: HowToPath[] = [
  {
    key: 'prod-mark',
    permission: 'production.work',
    ru: '🏭 Отметить свой этап',
    uz: '🏭 O‘z bosqichimni belgilash',
    pathRu: '🏭 Производство → 🧰 Мои задания → этап → ▶️ Начал',
    pathUz: '🏭 Ishlab chiqarish → 🧰 Topshiriqlarim → bosqich → ▶️ Boshladim',
    outRu: 'С этой минуты пойдёт время этапа. «Пауза» спросит причину — она попадёт в журнал простоев.',
    outUz: 'Shu daqiqadan bosqich vaqti ketadi. «Pauza» sabab so‘raydi — u to‘xtashlar jurnaliga tushadi.',
  },
  {
    key: 'prod-out',
    permission: 'production.manage',
    ru: '📦 Записать выпуск',
    uz: '📦 Chiqarishni yozish',
    pathRu: '🏭 Производство → ⚙️ В работе → заказ → 📦 Записать выпуск → сколько → склад → ✅ Записать',
    pathUz: '🏭 Ishlab chiqarish → ⚙️ Ishda → buyurtma → 📦 Chiqarishni yozish → qancha → ombor → ✅ Yozish',
    outRu: 'Продукция ляжет на склад настоящим приходом, партией с номером заказа. Убрать её оттуда производство не может.',
    outUz: 'Mahsulot omborga haqiqiy kirim bilan, buyurtma raqamli partiya bilan tushadi. Uni ishlab chiqarish ola olmaydi.',
  },
  {
    key: 'wh-in',
    permission: 'warehouse.move',
    ru: '📥 Принять товар на склад',
    uz: '📥 Tovarni omborga qabul qilish',
    pathRu: '📦 Склад → 📥 Приход → товар → сколько → ✅ Записать',
    pathUz: '📦 Ombor → 📥 Kirim → tovar → qancha → ✅ Yozish',
    outRu: 'Остаток на складе вырастет сразу, и это увидят все в системе.',
    outUz: 'Ombor qoldig‘i shu zahoti ko‘payadi, buni tizimda hamma ko‘radi.',
  },
  {
    key: 'wh-out',
    permission: 'warehouse.move',
    ru: '📤 Списать товар',
    uz: '📤 Tovarni hisobdan chiqarish',
    pathRu: '📦 Склад → 📤 Списание → товар → сколько → причина → ✅ Записать',
    pathUz: '📦 Ombor → 📤 Chiqim → tovar → qancha → sabab → ✅ Yozish',
    outRu: 'Остаток уменьшится. Причину спрашиваю обязательно — её потом ищут в отчётах.',
    outUz: 'Qoldiq kamayadi. Sabab majburiy — keyin hisobotlarda izlanadi.',
  },
  {
    key: 'wh-stock',
    permission: 'warehouse.view',
    ru: '🔍 Посмотреть, сколько лежит',
    uz: '🔍 Qancha borligini ko‘rish',
    pathRu: '📦 Склад → 🔍 Остаток → напишите название товара',
    pathUz: '📦 Ombor → 🔍 Qoldiq → tovar nomini yozing',
    outRu: 'Ничего не записывается: это только просмотр.',
    outUz: 'Hech nima yozilmaydi: bu faqat ko‘rish.',
  },
  {
    key: 'fin-out',
    permission: 'finance.post',
    ru: '➖ Записать расход денег',
    uz: '➖ Pul xarajatini yozish',
    pathRu: '💵 Финансы → ➖ Расход → сумма → статья → откуда платим → ✅ Записать',
    pathUz: '💵 Moliya → ➖ Xarajat → summa → modda → qayerdan → ✅ Yozish',
    outRu: 'Получится заявка. Деньги со счёта не уйдут, пока её не согласуют и не проведут.',
    outUz: 'Ariza chiqadi. Tasdiqlanib o‘tkazilmaguncha pul hisobdan chiqmaydi.',
  },
  {
    key: 'fin-post',
    permission: 'finance.post',
    ru: '✅ Провести согласованный платёж',
    uz: '✅ Tasdiqlangan to‘lovni o‘tkazish',
    pathRu: '💵 Финансы → ⏳ Ждут решения → выбрать запись → ✅ Провести',
    pathUz: '💵 Moliya → ⏳ Qarorni kutmoqda → yozuvni tanlash → ✅ O‘tkazish',
    outRu: 'Вот здесь деньги и двигаются. Отменить можно только сторно, запись останется видна.',
    outUz: 'Pul aynan shunda qimirlaydi. Bekor qilish faqat storno, yozuv ko‘rinib qoladi.',
  },
  {
    key: 'fin-approve',
    permission: 'finance.approve',
    ru: '🕓 Согласовать чужую заявку',
    uz: '🕓 Birovning arizasini tasdiqlash',
    pathRu: '💵 Финансы → ⏳ Ждут решения → выбрать → ✅ Согласовать или ↩️ Вернуть',
    pathUz: '💵 Moliya → ⏳ Qarorni kutmoqda → tanlash → ✅ Tasdiqlash yoki ↩️ Qaytarish',
    outRu: 'Согласование — ещё не деньги: после него платёж отдельно проводят.',
    outUz: 'Tasdiq — hali pul emas: keyin to‘lov alohida o‘tkaziladi.',
  },
  {
    key: 'sal-new',
    permission: 'sales.edit',
    ru: '➕ Завести заказ клиента',
    uz: '➕ Mijoz buyurtmasini kiritish',
    pathRu: '🛒 Продажи → ➕ Новый заказ → клиент → товар → сколько → цена → ✅ Записать',
    pathUz: '🛒 Sotuv → ➕ Yangi buyurtma → mijoz → tovar → qancha → narx → ✅ Yozish',
    outRu: 'Получится черновик. Клиенту он ничего не обещает, пока заказ не подтвердят.',
    outUz: 'Qoralama chiqadi. Tasdiqlanmaguncha mijozga hech nima va’da qilmaydi.',
  },
  {
    key: 'sal-ship',
    permission: 'sales.edit',
    ru: '🚚 Отгрузить заказ',
    uz: '🚚 Buyurtmani jo‘natish',
    pathRu: '🛒 Продажи → 🔍 Найти заказ → 🚚 Отгрузить → сколько → партия → машина и водитель',
    pathUz:
      '🛒 Sotuv → 🔍 Buyurtmani topish → 🚚 Jo‘natish → qancha → partiya → mashina va haydovchi',
    outRu: 'Товар уйдёт со склада, и номер партии попадёт в накладную и сертификат.',
    outUz: 'Tovar ombordan chiqadi, partiya raqami yuk xatiga va sertifikatga tushadi.',
  },
  {
    key: 'sal-pay',
    permission: 'finance.post',
    ru: '💰 Отметить, что клиент заплатил',
    uz: '💰 Mijoz to‘laganini belgilash',
    pathRu: '🛒 Продажи → 💰 Не оплачены → заказ → 💵 Принять оплату → сумма → ✅ Записать',
    pathUz: '🛒 Sotuv → 💰 To‘lanmagan → buyurtma → 💵 To‘lovni qabul qilish → summa → ✅ Yozish',
    outRu: 'Долг клиента уменьшится после того, как запись проведут.',
    outUz: 'Yozuv o‘tkazilgandan keyin mijoz qarzi kamayadi.',
  },
  {
    key: 'doc-new',
    permission: 'documents.edit',
    ru: '📄 Выписать счёт по заказу',
    uz: '📄 Buyurtma bo‘yicha hisob yozish',
    pathRu: '🛒 Продажи → заказ → 📄 Выписать документ → Счёт → ✅ Выписать',
    pathUz: '🛒 Sotuv → buyurtma → 📄 Hujjat yozish → Hisob → ✅ Yozish',
    outRu: 'Придёт черновик документа и файл PDF — его можно сразу переслать клиенту.',
    outUz: 'Hujjat qoralamasi va PDF fayl keladi — mijozga darhol yuborish mumkin.',
  },
  {
    key: 'doc-ok',
    permission: 'documents.approve',
    ru: '✅ Утвердить документ',
    uz: '✅ Hujjatni tasdiqlash',
    pathRu: '📄 Документы → 🕓 Ждут решения → документ → ✅ Утвердить',
    pathUz: '📄 Hujjatlar → 🕓 Qarorni kutmoqda → hujjat → ✅ Tasdiqlash',
    outRu: 'Утверждённый документ правят только новой редакцией — старая остаётся в истории.',
    outUz: 'Tasdiqlangan hujjat faqat yangi tahrir bilan o‘zgaradi — eskisi tarixda qoladi.',
  },
  {
    key: 'chief',
    permission: 'dashboard.view',
    ru: '📊 Посмотреть, как идут дела',
    uz: '📊 Ishlar qanday ketayotganini ko‘rish',
    pathRu: '📊 Сводка → выбрать срок → ⚠️ На что смотреть',
    pathUz: '📊 Xulosa → muddatni tanlash → ⚠️ Nimaga e’tibor berish',
    outRu: 'Только просмотр. Красным — просроченное, жёлтым — то, что ждёт решения.',
    outUz: 'Faqat ko‘rish. Qizil — muddati o‘tgan, sariq — qaror kutayotgan.',
  },
];

/** Пути, которые этому человеку вообще доступны. */
export function howToFor(permissions: Iterable<string>): HowToPath[] {
  const has = new Set(permissions);
  return HOWTO.filter((p) => has.has(p.permission));
}

/** Путь по коду кнопки — и только если право на него есть. */
export function howToOne(permissions: Iterable<string>, key: string): HowToPath | undefined {
  return howToFor(permissions).find((p) => p.key === key);
}
