/**
 * Слова раздела «Финансы» в боте.
 *
 * Правило для всего файла — решение заказчика 02.10: бота открывают люди,
 * которые системой не пользуются и компьютером не владеют. Значит, на каждом
 * экране сначала сказано, что здесь происходит и зачем, а где можно ошибиться
 * — дан пример. Один экран задаёт один вопрос: два вопроса подряд человек
 * читает как один и отвечает на второй.
 *
 * Отдельно от `texts.ts`, потому что это самый большой раздел бота, и общий
 * файл слов превратился бы в простыню, где каркас не найти.
 */

import { bullets, fields } from './section.js';

/** Как называется статус человеку, а не базе. */
export const STATUS: Record<string, { ru: string; uz: string; mark: string }> = {
  draft: { ru: 'черновик', uz: 'qoralama', mark: '📝' },
  pending_approval: { ru: 'на согласовании', uz: 'tasdiqlashda', mark: '⏳' },
  approved: { ru: 'утверждена', uz: 'tasdiqlangan', mark: '👍' },
  posted: { ru: 'проведена', uz: 'o‘tkazilgan', mark: '✅' },
  rejected: { ru: 'отклонена', uz: 'rad etilgan', mark: '⛔' },
  reversed: { ru: 'сторнирована', uz: 'storno qilingan', mark: '↩️' },
};

/**
 * Что статус значит и что с операцией будет дальше. Это не украшение: «на
 * согласовании» человеку в возрасте не говорит ничего, а «деньги ещё не ушли,
 * ждём решения руководителя» — говорит всё.
 */
export const STATUS_HELP: Record<string, { ru: string; uz: string }> = {
  draft: {
    ru: 'Это черновик. Деньги никуда не ушли. Дальше заявку нужно отправить на согласование.',
    uz: 'Bu qoralama. Pul hech qayerga ketmadi. Keyin arizani tasdiqlashga yuborish kerak.',
  },
  pending_approval: {
    ru: 'Заявка отправлена и ждёт решения руководителя. Деньги пока на месте.',
    uz: 'Ariza yuborilgan, rahbar qarorini kutmoqda. Pul hozircha joyida.',
  },
  approved: {
    ru: 'Руководитель согласовал. Деньги ещё не списаны — осталось провести операцию.',
    uz: 'Rahbar tasdiqladi. Pul hali yechilmagan — operatsiyani o‘tkazish qoldi.',
  },
  posted: {
    ru: 'Деньги прошли. Сумма попала в остатки и в отчёты. Отменить можно только сторно.',
    uz: 'Pul o‘tdi. Summa qoldiq va hisobotlarga tushdi. Faqat storno bilan bekor qilinadi.',
  },
  rejected: {
    ru: 'Заявку отклонили, деньги не прошли. Если платёж всё же нужен, заведите новую.',
    uz: 'Ariza rad etilgan, pul o‘tmadi. Agar to‘lov kerak bo‘lsa, yangisini kiriting.',
  },
  reversed: {
    ru: 'Операцию отменили обратной записью. Обе остались в истории — так и должно быть.',
    uz: 'Operatsiya teskari yozuv bilan bekor qilindi. Ikkisi ham tarixda qoldi — shunday bo‘lishi kerak.',
  },
};

/** Подтверждение перед действием: что именно случится и что обратного пути нет. */
export const ACTION: Record<
  string,
  {
    ru: string;
    uz: string;
    askRu: string;
    askUz: string;
    doneRu: string;
    doneUz: string;
  }
> = {
  submit: {
    ru: '📤 Отправить на согласование',
    uz: '📤 Tasdiqlashga yuborish',
    askRu:
      'Отправить заявку руководителю?\n\nОн увидит сумму и за что платим и примет решение. ' +
      'После отправки сумму уже не поменять — только отклонить и завести новую.',
    askUz:
      'Arizani rahbarga yuborasizmi?\n\nU summani va nima uchun to‘lanishini ko‘radi va qaror qabul qiladi. ' +
      'Yuborilgandan keyin summa o‘zgarmaydi — faqat rad etib, yangisini kiritish mumkin.',
    doneRu: 'Отправлено. Теперь ждём решения руководителя.',
    doneUz: 'Yuborildi. Endi rahbar qarorini kutamiz.',
  },
  approve: {
    ru: '✅ Согласовать',
    uz: '✅ Tasdiqlash',
    askRu:
      'Согласовать платёж?\n\nВы подтверждаете, что платить нужно. Деньги спишутся не сейчас, ' +
      'а когда бухгалтер проведёт операцию.',
    askUz:
      'To‘lovni tasdiqlaysizmi?\n\nSiz to‘lov kerakligini tasdiqlaysiz. Pul hozir emas, ' +
      'buxgalter operatsiyani o‘tkazganda yechiladi.',
    doneRu: 'Согласовано. Осталось провести — это делает тот, у кого есть право проводить.',
    doneUz: 'Tasdiqlandi. O‘tkazish qoldi — buni o‘tkazish huquqi bor xodim qiladi.',
  },
  reject: {
    ru: '⛔ Отклонить',
    uz: '⛔ Rad etish',
    askRu:
      'Отклонить заявку?\n\nДеньги не пройдут, заявка закроется. Вернуть её потом нельзя — ' +
      'если платёж всё же нужен, придётся заводить новую.',
    askUz:
      'Arizani rad etasizmi?\n\nPul o‘tmaydi, ariza yopiladi. Keyin qaytarib bo‘lmaydi — ' +
      'agar to‘lov kerak bo‘lsa, yangisini kiritishga to‘g‘ri keladi.',
    doneRu: 'Отклонено. Деньги не прошли.',
    doneUz: 'Rad etildi. Pul o‘tmadi.',
  },
  post: {
    ru: '💸 Провести',
    uz: '💸 O‘tkazish',
    askRu:
      '⚠️ Провести операцию?\n\nЭто и есть само движение денег: сумма уйдёт со счёта и попадёт ' +
      'в остатки и отчёты. Отменить можно будет только сторно — обратной записью, и обе ' +
      'останутся в истории.',
    askUz:
      '⚠️ Operatsiyani o‘tkazasizmi?\n\nBu pulning haqiqiy harakati: summa hisobdan chiqadi va ' +
      'qoldiq hamda hisobotlarga tushadi. Keyin faqat storno bilan bekor qilinadi, ikkisi ham ' +
      'tarixda qoladi.',
    doneRu: 'Проведено. Деньги прошли, сумма учтена.',
    doneUz: 'O‘tkazildi. Pul o‘tdi, summa hisobga olindi.',
  },
  reverse: {
    ru: '↩️ Сторно',
    uz: '↩️ Storno',
    askRu:
      '⚠️ Сделать сторно?\n\nПоявится вторая операция на ту же сумму, но в обратную сторону — ' +
      'деньги вернутся на счёт. Первая операция останется в истории со отметкой «сторнирована»: ' +
      'в деньгах ничего не прячут, видно и платёж, и его отмену.',
    askUz:
      '⚠️ Storno qilasizmi?\n\nShu summada teskari yo‘nalishdagi ikkinchi operatsiya paydo bo‘ladi — ' +
      'pul hisobga qaytadi. Birinchisi «storno qilingan» belgisi bilan tarixda qoladi: pulda hech ' +
      'nima yashirilmaydi, to‘lov ham, uning bekor qilinishi ham ko‘rinadi.',
    doneRu: 'Сторно сделано. Деньги вернулись на счёт.',
    doneUz: 'Storno bajarildi. Pul hisobga qaytdi.',
  },
};

export const F = {
  home: (uz: boolean, canWrite: boolean) =>
    uz
      ? '<b>💵 Moliya</b>\n\nBu yerda pul. Nima qilish mumkin:\n' +
        bullets([
          'xarajat yoki tushumni yozish',
          'tasdiqlashga yuborish, tasdiqlash va o‘tkazish',
          'mijozlar qarzini ko‘rish',
          'reja va faktni solishtirish',
        ]) +
        '\n\n' +
        (canWrite
          ? '<blockquote>Yangi yozuv — «Xarajat» yoki «Tushum».\n' +
            'Qadam-baqadam so‘rayman: bir ekranda bitta savol.</blockquote>'
          : '<blockquote>Sizda ko‘rish huquqi bor.\n' +
            'Yangi yozuv kiritish huquqi berilmagan.</blockquote>')
      : '<b>💵 Финансы</b>\n\nЗдесь деньги. Что можно сделать:\n' +
        bullets([
          'записать расход или поступление',
          'отправить на согласование, согласовать и провести',
          'посмотреть долги клиентов',
          'сверить план с фактом',
        ]) +
        '\n\n' +
        (canWrite
          ? '<blockquote>Новая запись — «Расход» или «Поступление».\n' +
            'Спрошу по шагам: на каждом экране один вопрос.</blockquote>'
          : '<blockquote>Вам открыт просмотр.\n' + 'Права заводить записи не выдано.</blockquote>'),

  /** Шапка шага: человек видит, сколько осталось, и не бросает на середине. */
  step: (uz: boolean, n: number, total: number, title: string) =>
    uz ? `<b>Qadam ${n}/${total} · ${title}</b>` : `<b>Шаг ${n} из ${total} · ${title}</b>`,

  /** Название последнего шага: он есть в строке «дальше» наравне с вопросами. */
  checkTitle: (uz: boolean) => (uz ? 'Tekshirish' : 'Проверка'),

  /**
   * «Я не понял» на экране проверки: то же самое словами.
   *
   * Перечень полей и объяснение — разные вещи. Человек, которому бот заменил
   * систему, из строки «Статья: Топливо» не узнаёт, уйдут ли деньги сейчас.
   * Здесь сказано ровно это: что запишется, что при этом не случится и чего
   * ждать дальше.
   */
  explain: (
    uz: boolean,
    o: { expense: boolean; amount: string; account: string; order?: string | null },
  ) => {
    const head = uz ? '<b>Oddiy so‘zlar bilan</b>' : '<b>Простыми словами</b>';
    const body = uz
      ? `Hozircha hech nima yozilmagan. «✅ Yozish»ni bossangiz, men ${
          o.expense ? 'xarajat' : 'tushum'
        } arizasini yarataman: <b>${o.amount}</b>, hisob «${o.account}».\n\n` +
        `Pul hozir ${o.expense ? 'hisobdan chiqmaydi' : 'hisobga tushmaydi'}: avval arizani ` +
        'mas’ul odam tasdiqlaydi, keyin «O‘tkazish» bosiladi — pul shundan keyin qimirlaydi.' +
        (o.order
          ? `\n\n<b>${o.order}</b> buyurtma bo‘yicha mijoz qarzi yozuv o‘tkazilgandan keyin kamayadi.`
          : '')
      : `Пока ничего не записано. Нажмёте «✅ Записать» — я создам заявку на ${
          o.expense ? 'расход' : 'поступление'
        }: <b>${o.amount}</b>, счёт «${o.account}».\n\n` +
        `Деньги сейчас ${o.expense ? 'со счёта не уйдут' : 'на счёт не придут'}: сначала заявку ` +
        'согласует тот, кто за это отвечает, потом её проводят — двигаются деньги только там.' +
        (o.order
          ? `\n\nДолг клиента по заказу <b>${o.order}</b> уменьшится, когда запись проведут.`
          : '');
    const tail = uz
      ? '<blockquote>Summa, modda yoki hisob xato bo‘lsa — ⬅️ Orqaga, qaytadan so‘rayman.\n' +
        'Umuman kerak bo‘lmasa — ❌ Bekor qilish: hech nima qolmaydi.</blockquote>'
      : '<blockquote>Сумма, статья или счёт не те — ⬅️ Назад, спрошу заново.\n' +
        'Не нужно вовсе — ❌ Отменить: ничего не останется.</blockquote>';
    return `${head}\n\n${body}\n\n${tail}`;
  },

  askCompany: (uz: boolean) =>
    uz
      ? 'Qaysi kompaniya uchun?\n\nYozuv shu kompaniya kitobiga tushadi. Xato tanlasangiz, ' +
        'keyin uni boshqa joyda qidirishga to‘g‘ri keladi.'
      : 'По какой компании?\n\nЗапись попадёт в книгу этой компании. Выберете не ту — потом будете ' +
        'искать её не там, где она лежит.',
  companyTitle: (uz: boolean) => (uz ? 'Kompaniya' : 'Компания'),

  askAmount: (uz: boolean, expense: boolean) =>
    uz
      ? (expense ? 'Qancha to‘lanadi?' : 'Qancha pul keldi?') +
        '\n\nFaqat bitta son yozing.\n\n' +
        '<blockquote>Masalan: <code>1500000</code> — bir yarim million so‘m.\n' +
        'Tiyinlar vergul bilan: <code>1500000,50</code></blockquote>'
      : (expense ? 'Сколько платим?' : 'Сколько денег пришло?') +
        '\n\nНапишите одно число.\n\n' +
        '<blockquote>Например: <code>1500000</code> — это полтора миллиона сумов.\n' +
        'Копейки через запятую: <code>1500000,50</code></blockquote>',
  amountTitle: (uz: boolean) => (uz ? 'Summa' : 'Сумма'),
  badAmount: (uz: boolean) =>
    uz
      ? 'Bu summaga o‘xshamaydi. Faqat son yozing, masalan <code>250000</code>. ' +
        'Tiyin kerak bo‘lsa — vergul bilan: <code>250000,50</code>'
      : 'Это не похоже на сумму. Напишите только число, например <code>250000</code>. ' +
        'Если нужны копейки — через запятую: <code>250000,50</code>',

  // --- фото чека -------------------------------------------------------
  // Бумажный чек теряется в кармане к вечеру. Снять его телефоном человек
  // умеет, поэтому фото — единственный способ приложить бумагу к записи,
  // не заходя в систему.

  askPhoto: (uz: boolean, number: string) =>
    uz
      ? `<b>${number}</b> yozuviga chek rasmini yuboring.\n\n` +
        'Shunchaki suratga olib, shu chatga yuboring. Rasm yozuvga biriktiriladi va ' +
        'buxgalter uni tizimda ko‘radi.\n\n' +
        '<blockquote>Chek to‘liq tushsin: summa va sana ko‘rinib turishi kerak.\n' +
        'Rasm o‘rniga PDF yuborsangiz ham bo‘ladi.\n' +
        'Summani rasmdan o‘zim o‘qiy olmayman — u yozuvda qanday bo‘lsa, shunday qoladi.</blockquote>'
      : `Пришлите фото чека к записи <b>${number}</b>.\n\n` +
        'Просто сфотографируйте и отправьте снимок в этот чат. Фото ляжет к записи, и ' +
        'бухгалтер увидит его в системе.\n\n' +
        '<blockquote>Снимите чек целиком: сумма и дата должны быть видны.\n' +
        'Можно прислать и PDF вместо фотографии.\n' +
        'Сумму с фотографии я не читаю — в записи останется та, которую вы указали.</blockquote>',

  photoWait: (uz: boolean) =>
    uz
      ? 'Men rasm kutyapman, matn emas. Chekni suratga olib yuboring yoki «Bekor qilish»ni bosing.'
      : 'Я жду снимок, а не текст. Сфотографируйте чек и пришлите, или нажмите «Отменить».',

  photoSaved: (uz: boolean, number: string, count: number) =>
    uz
      ? `Rasm <b>${number}</b> yozuviga biriktirildi. Jami rasm: ${count}.`
      : `Фото приложено к записи <b>${number}</b>. Всего файлов: ${count}.`,

  photoLine: (uz: boolean, count: number) =>
    uz ? `Biriktirilgan fayllar: ${count}` : `Приложено файлов: ${count}`,

  // --- повтор прошлой записи -------------------------------------------

  repeatTitle: (uz: boolean) => (uz ? 'Takrorlash' : 'Повтор'),

  askRepeatAmount: (uz: boolean, number: string, lines: string[]) =>
    uz
      ? `<b>${number}</b> yozuvini takrorlaymiz.\n${fields(lines)}\n\n` +
        'Qancha bo‘ldi bu marta?\n\n' +
        '<blockquote>O‘sha summa bo‘lsa — pastdagi tugmani bosing. ' +
        'Boshqa bo‘lsa — sonni yozing.\n' +
        'Modda yoki hisobni o‘zgartirish kerak bo‘lsa, bu yozuv mos emas: ' +
        '«Xarajat» yoki «Tushum» dan yangisini kiriting.</blockquote>'
      : `Повторяем запись <b>${number}</b>.\n${fields(lines)}\n\n` +
        'Сколько на этот раз?\n\n' +
        '<blockquote>Если сумма та же — нажмите кнопку ниже. Если другая — ' +
        'напишите число.\n' +
        'Нужно сменить статью или счёт — эта запись не подходит: заведите новую ' +
        'через «Расход» или «Поступление».</blockquote>',

  sameAmount: (uz: boolean, amount: string) =>
    uz ? `🔁 O‘sha summa — ${amount}` : `🔁 Та же сумма — ${amount}`,

  nothingToRepeat: (uz: boolean) =>
    uz
      ? 'Takrorlash uchun yozuv yo‘q: siz hali hech nima kiritmagansiz.'
      : 'Повторять пока нечего: своих записей у вас ещё нет.',

  // --- оплата по заказу ------------------------------------------------
  // Отдельные слова, потому что это другой разговор: человек пришёл не
  // «завести поступление», а «клиент заплатил по заказу». Остаток и номер
  // заказа он должен видеть на том же экране, где пишет сумму, иначе будет
  // сверять их в другом месте и ошибётся.

  payTitle: (uz: boolean) => (uz ? 'Buyurtma to‘lovi' : 'Оплата по заказу'),

  askPayAmount: (uz: boolean, number: string, remaining: string) =>
    uz
      ? `<b>${number}</b> buyurtmasi bo‘yicha qancha pul keldi?\n\n` +
        `To‘lanmagan qoldiq: <b>${remaining}</b>. Shu summadan ko‘p yozib bo‘lmaydi.\n\n` +
        '<blockquote>Bir son yozing. Masalan: <code>5000000</code>\n' +
        'Mijoz bo‘lib-bo‘lib to‘lasa, hozir kelgan summani yozing — qolgani ' +
        'qoldiqda ko‘rinib turadi.</blockquote>'
      : `Сколько денег пришло по заказу <b>${number}</b>?\n\n` +
        `Неоплаченный остаток: <b>${remaining}</b>. Больше этой суммы записать нельзя.\n\n` +
        '<blockquote>Напишите одно число. Например: <code>5000000</code>\n' +
        'Если клиент платит частями, напишите то, что пришло сейчас, — остальное ' +
        'останется в остатке по заказу.</blockquote>',

  payTooMuch: (uz: boolean, remaining: string) =>
    uz
      ? `Bu summa qoldiqdan ko‘p. Buyurtma bo‘yicha <b>${remaining}</b> to‘lanmagan. ` +
        'Kelgan summani yozing yoki qoldiqni to‘liq yozing.'
      : `Эта сумма больше остатка. По заказу не оплачено <b>${remaining}</b>. ` +
        'Напишите пришедшую сумму или весь остаток.',

  payNothing: (uz: boolean, number: string, pending: string) =>
    uz
      ? `<b>${number}</b> buyurtmasi bo‘yicha to‘lashga hech nima qolmadi.\n\n` +
        (pending
          ? `Qoldiq allaqachon band: <b>${pending}</b> tasdiqlashni kutmoqda. ` +
            'Avval o‘sha to‘lov o‘tkazilsin yoki rad etilsin.'
          : 'Buyurtma to‘liq to‘langan.')
      : `По заказу <b>${number}</b> платить нечего.\n\n` +
        (pending
          ? `Остаток уже занят: <b>${pending}</b> ждёт согласования. Сначала этот платёж ` +
            'нужно провести или отклонить.'
          : 'Заказ оплачен полностью.'),

  payNoAccount: (uz: boolean, currency: string) =>
    uz
      ? `Kompaniyada ${currency} dagi kassa yoki hisob raqam yo‘q, shuning uchun bu buyurtma ` +
        'to‘lovini bot qabul qila olmaydi. Buni moliyachi tizimda kiritadi.'
      : `В компании нет кассы или счёта в ${currency}, поэтому платёж по этому заказу бот ` +
        'принять не может. Его заведёт финансист в самой системе.',

  payBack: (uz: boolean) => (uz ? '⬅️ Buyurtmaga' : '⬅️ К заказу'),

  savedPay: (uz: boolean, number: string, order: string) =>
    uz
      ? `Yozildi: <b>${number}</b> — <b>${order}</b> buyurtmasi to‘lovi, qoralama.\n\n` +
        'Mijoz qarzi hozir kamaymadi: bu faqat ariza. Qarz to‘lov o‘tkazilganda kamayadi — ' +
        'tasdiqlashga yuboring.'
      : `Записано: <b>${number}</b> — платёж по заказу <b>${order}</b>, черновик.\n\n` +
        'Долг клиента сейчас не уменьшился: это пока заявка. Долг уменьшится, когда платёж ' +
        'проведут, — отправьте его на согласование.',

  payOrder: (uz: boolean) => (uz ? 'Buyurtma bo‘yicha' : 'По заказу'),
  payLeft: (uz: boolean) => (uz ? 'To‘lovdan keyin qoladi' : 'Останется по заказу'),

  askItem: (uz: boolean, expense: boolean) =>
    uz
      ? (expense ? 'Nima uchun to‘lanadi?' : 'Pul nima uchun keldi?') +
        '\n\nBu modda bo‘yicha pul byudjetning kerakli satriga tushadi va oy oxirida ' +
        '«pul qayerga ketdi» degan savolga javob bo‘ladi.'
      : (expense ? 'За что платим?' : 'За что пришли деньги?') +
        '\n\nПо этой статье расход попадёт в нужную строку бюджета, и в конце месяца будет видно, ' +
        'куда ушли деньги.',
  itemTitle: (uz: boolean) => (uz ? 'Modda' : 'Статья'),

  askAccount: (uz: boolean, expense: boolean) =>
    uz
      ? (expense ? 'Qayerdan to‘lanadi?' : 'Pul qayerga keldi?') +
        '\n\nKassa — qo‘ldagi naqd pul. Hisob raqam — bankdagi pul.'
      : (expense ? 'Откуда платим?' : 'Куда пришли деньги?') +
        '\n\nКасса — это наличные на руках. Расчётный счёт — деньги в банке.',
  accountTitle: (uz: boolean) => (uz ? 'Hisob' : 'Счёт'),

  askPartner: (uz: boolean, expense: boolean) =>
    uz
      ? (expense ? 'Kimga to‘lanadi?' : 'Pul kimdan keldi?') +
        '\n\nRo‘yxatdan tanlang yoki nomini yozing — men qidiraman. ' +
        'Agar aniq firma yo‘q bo‘lsa (masalan, soliq), «O‘tkazib yuborish»ni bosing.'
      : (expense ? 'Кому платим?' : 'От кого деньги?') +
        '\n\nВыберите из списка или напишите название — я найду. ' +
        'Если конкретной фирмы нет (например, налог), нажмите «Пропустить».',
  partnerTitle: (uz: boolean) => (uz ? 'Kim bilan' : 'Контрагент'),
  partnerNotFound: (uz: boolean, query: string) =>
    uz
      ? `«${query}» bo‘yicha hech kim topilmadi. Boshqacha yozib ko‘ring yoki o‘tkazib yuboring.`
      : `По «${query}» никого не нашёл. Попробуйте написать иначе или пропустите этот шаг.`,

  askDate: (uz: boolean) =>
    uz
      ? 'Bu qachon bo‘ldi?\n\nOdatda — bugun. Boshqa kun bo‘lsa, sanani yozing: ' +
        '<code>28.09.2026</code>'
      : 'Когда это было?\n\nОбычно — сегодня. Если другой день, напишите дату: ' +
        '<code>28.09.2026</code>',
  dateTitle: (uz: boolean) => (uz ? 'Sana' : 'Дата'),
  badDate: (uz: boolean) =>
    uz
      ? 'Sanani tushunmadim. Shunday yozing: <code>28.09.2026</code>'
      : 'Не понял дату. Напишите так: <code>28.09.2026</code>',
  futureDate: (uz: boolean) =>
    uz
      ? 'Sana kelajakda. Bo‘lib o‘tgan pul harakati bugundan keyin bo‘lishi mumkin emas.'
      : 'Дата в будущем. Движение денег, которое уже случилось, не может быть позже сегодня.',

  askComment: (uz: boolean) =>
    uz
      ? 'Izoh qo‘shasizmi?\n\nO‘zingiz va buxgalter uchun qisqa eslatma. ' +
        'Masalan: <i>oktyabr uchun avans</i>. Kerak bo‘lmasa — o‘tkazib yuboring.'
      : 'Добавить примечание?\n\nКороткая заметка для себя и бухгалтера. ' +
        'Например: <i>аванс за октябрь</i>. Не нужно — пропустите.',
  commentTitle: (uz: boolean) => (uz ? 'Izoh' : 'Примечание'),

  /** Последний экран перед записью: всё, что человек ввёл, одним списком. */
  confirm: (uz: boolean, lines: string[]) =>
    uz
      ? `<b>Tekshirib oling</b>\n\n${fields(lines)}\n\n` +
        'Pul hozir hech qayerga ketmaydi: yozuv qoralama bo‘lib qoladi, uni yana yuborish va ' +
        'o‘tkazish kerak.'
      : `<b>Проверьте</b>\n\n${fields(lines)}\n\n` +
        'Деньги сейчас никуда не уходят: запись станет черновиком, его ещё нужно отправить и провести.',

  saved: (uz: boolean, number: string) =>
    uz
      ? `Yozildi: <b>${number}</b> — qoralama.\n\nPul hali harakatlanmadi. Keyingi qadam — ` +
        'tasdiqlashga yuborish.'
      : `Записано: <b>${number}</b> — черновик.\n\nДеньги пока не двинулись. Следующий шаг — ` +
        'отправить на согласование.',
  cancelled: (uz: boolean) =>
    uz ? 'Bekor qildim, hech nima yozilmadi.' : 'Отменил, ничего не записано.',

  listTitle: (uz: boolean, mine: boolean, lines: string[]) =>
    (uz
      ? mine
        ? '<b>Qarorni kutayotganlar</b>\n\n'
        : '<b>Oxirgi operatsiyalar</b>\n\n'
      : mine
        ? '<b>Ждут решения</b>\n\n'
        : '<b>Последние операции</b>\n\n') +
    (lines.length === 0
      ? uz
        ? 'Bo‘sh.'
        : 'Пусто.'
      : `<blockquote>${lines.join('\n')}</blockquote>\n\n` +
        (uz ? 'Ochish uchun tugmani bosing.' : 'Нажмите кнопку, чтобы открыть.')),

  /**
   * Карточка: заголовок строкой, поля пунктами, объяснение отдельным абзацем.
   * Заголовок точку не получает — он не пункт списка, а имя того, что открыто.
   */
  card: (uz: boolean, lines: string[], help: string) => {
    const [head, ...rest] = lines;
    return `${head}\n\n${fields(rest)}\n\n${help}`;
  },

  debts: (uz: boolean, overdueOnly: boolean, lines: string[], total: string, overdue: string) =>
    uz
      ? `<b>💰 ${overdueOnly ? 'Muddati o‘tgan qarzlar' : 'Mijozlar qarzi'}</b>\n\n` +
        (lines.length === 0
          ? 'Qarz yo‘q.'
          : `<blockquote>${lines.join('\n')}</blockquote>\nJami: <b>${total}</b>, ` +
            `shundan muddati o‘tgan: <b>${overdue}</b>`)
      : `<b>💰 ${overdueOnly ? 'Просроченные долги' : 'Долги клиентов'}</b>\n\n` +
        (lines.length === 0
          ? 'Долгов нет.'
          : `<blockquote>${lines.join('\n')}</blockquote>\nВсего: <b>${total}</b>, ` +
            `из них просрочено: <b>${overdue}</b>`),

  planFact: (uz: boolean, lines: string[]) =>
    uz
      ? '<b>📊 Reja va fakt</b>\n\nOyga qancha pul rejalashtirilgan va qancha sarflangan.\n' +
        (lines.length === 0
          ? 'Byudjet kiritilmagan.'
          : `<blockquote>${lines.join('\n')}</blockquote>`)
      : '<b>📊 План и факт</b>\n\nСколько денег заложено на период и сколько уже потрачено.\n' +
        (lines.length === 0
          ? 'Бюджеты не заведены.'
          : `<blockquote>${lines.join('\n')}</blockquote>`),

  noRight: (uz: boolean) =>
    uz
      ? 'Bu amalni bajarish huquqi sizga berilmagan. Administrator rol bersin.'
      : 'Права на это действие вам не выдано. Попросите администратора.',
  stale: (uz: boolean) =>
    uz
      ? 'Bu tugma o‘tgan qadamdan qolgan. Hozirgi savol quyida.'
      : 'Эта кнопка осталась с прошлого шага. Текущий вопрос ниже.',
  /** Отказ сервера показываем словами сервера: они уже человеческие. */
  refused: (uz: boolean, message: string) =>
    uz ? `Bo‘lmadi: ${message}` : `Не получилось: ${message}`,
  noRate: (uz: boolean, code: string) =>
    uz
      ? `${code} uchun kurs kiritilmagan. Valyutadagi yozuvni moliyachi tizimda kiritadi.`
      : `Курса для ${code} в системе нет. Валютную запись заведёт финансист в самой системе.`,
  noCounter: (uz: boolean) =>
    uz
      ? 'Kompaniyada daromad yoki xarajat hisobi sozlanmagan. Buni administrator tuzatadi.'
      : 'В компании не настроен счёт доходов или расходов. Это поправит администратор.',
  gotIt: (uz: boolean) => (uz ? 'Qabul qildim' : 'Принял'),
} as const;
