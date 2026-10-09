/**
 * Все слова бота в одном месте, по-русски и по-узбекски.
 *
 * Язык человек выбирает первым экраном — до входа, когда система о нём ещё
 * ничего не знает. После входа выбор переносится в профиль, чтобы язык бота и
 * язык веба не расходились.
 */
export const T = {
  welcome: (uz: boolean) =>
    uz
      ? '<b>METALL ASIA</b>\nBoshqaruv tizimi\n\nTilni tanlang.'
      : '<b>METALL ASIA</b>\nЕдиная система управления\n\nВыберите язык.',
  askLogin: (uz: boolean) =>
    uz
      ? 'Tizimdagi <b>loginingizni</b> yuboring.\n\nXuddi saytdagidek. Xabaringizni men darhol o‘chiraman.'
      : 'Пришлите <b>логин</b> — тот же, что в системе.\n\nВаше сообщение я сразу удалю.',
  askPassword: (uz: boolean, login: string) =>
    uz
      ? `Login: <code>${login}</code>\n\nEndi <b>parolni</b> yuboring. Xabarni darhol o‘chiraman.`
      : `Логин: <code>${login}</code>\n\nТеперь пришлите <b>пароль</b>. Сообщение сразу удалю.`,
  badCredentials: (uz: boolean) =>
    uz
      ? 'Login yoki parol xato. Qaytadan urinib ko‘ring: loginni yuboring.'
      : 'Неверный логин или пароль. Попробуйте снова — пришлите логин.',
  locked: (uz: boolean) =>
    uz
      ? 'Hisob vaqtincha bloklandi. Administratorga murojaat qiling.'
      : 'Учётная запись временно заблокирована. Обратитесь к администратору.',
  takenAccount: (uz: boolean) =>
    uz
      ? 'Bu Telegram hisobi boshqa xodimga bog‘langan. Avval eski bog‘lanishni uzish kerak.'
      : 'Этот аккаунт Telegram уже привязан к другому человеку. Сначала отключите прежнюю привязку.',
  noRights: (uz: boolean) =>
    uz
      ? 'Sizda hech bir bo‘limga huquq yo‘q. Administrator rol bersin.'
      : 'Вам не выдано ни одного раздела. Попросите администратора назначить роль.',
  /**
   * Приветствие сразу говорит, на что смотреть. Список компаний и «выберите
   * раздел» из него убраны по слову клиента 02.10: разделы видно кнопками, а
   * место под текстом стоит дороже — там то, ради чего человек открыл бота.
   */
  hello: (uz: boolean, name: string, lines: string[]) => {
    const head = uz ? `Xush kelibsiz, <b>${name}</b>.` : `Здравствуйте, <b>${name}</b>.`;
    if (lines.length === 0) {
      return `${head}\n\n${uz ? 'Shoshilinch ish yo‘q.' : 'Срочного ничего нет.'}`;
    }
    const title = uz ? 'Nimaga e’tibor berish kerak' : 'На что обратить внимание';
    // Цитатой, а не обычным текстом (просьба клиента 02.10): в подписи к
    // картинке сводка иначе сливается с приветствием в одну простыню.
    return `${head}\n\n<b>${title}</b>\n<blockquote>${lines.join('\n')}</blockquote>`;
  },
  notForBot: (uz: boolean) =>
    uz
      ? 'Bot rahbarlar, moliyachi, omborchi va menejer uchun. Sizning rolingiz tizimning o‘zida ishlaydi — brauzerda oching.'
      : 'Бот сделан для руководителей, финансиста, кладовщика и менеджера. Ваша роль работает в самой системе — откройте её в браузере.',
  menuTitle: (uz: boolean) => (uz ? 'Asosiy menyu' : 'Главное меню'),
  sectionSoon: (uz: boolean, title: string, lines: string[]) =>
    uz
      ? `<b>${title}</b>\n\nBo‘lim tayyorlanmoqda. Bu yerda bo‘ladi:\n${lines
          .map((l) => `• ${l}`)
          .join('\n')}`
      : `<b>${title}</b>\n\nРаздел готовится. Здесь будет:\n${lines.map((l) => `• ${l}`).join('\n')}`,
  settings: (uz: boolean) => (uz ? '<b>Sozlamalar</b>' : '<b>Настройки</b>'),
  /**
   * Экран уведомлений объясняет, зачем они: человек, который системой не
   * пользуется, узнаёт о делах только отсюда. Поэтому «выключить» — осознанный
   * выбор, а не случайное нажатие.
   */
  notifications: (uz: boolean, lines: string[]) =>
    uz
      ? `<b>Xabarnomalar</b>\n\nBot ishlar haqida o‘zi yozadi — tizimga kirish shart emas.\n` +
        `Kerak bo‘lmaganini o‘chirib qo‘ying.\n<blockquote>${lines.join('\n')}</blockquote>`
      : `<b>Уведомления</b>\n\nБот сам пишет о делах — заходить в систему не нужно.\n` +
        `Выключите то, о чём писать не надо.\n<blockquote>${lines.join('\n')}</blockquote>`,
  /**
   * Указатель по группам. Поводов четырнадцать: одним списком это и в подпись
   * панели не влезает, и читать его человек не станет.
   */
  notifyGroups: (uz: boolean, lines: string[]) =>
    uz
      ? `<b>Xabarnomalar</b>\n\nBot ishlar haqida o‘zi yozadi.\nQaysi biri kerakligini ` +
        `guruh ichida tanlang.\n\n<blockquote>${lines.join('\n')}</blockquote>`
      : `<b>Уведомления</b>\n\nБот сам пишет о делах — заходить в систему не нужно.\n` +
        `Что именно присылать, выбирается внутри группы.\n\n` +
        `<blockquote>${lines.join('\n')}</blockquote>`,
  notifyGroupName: (uz: boolean, group: 'money' | 'work' | 'system') =>
    group === 'money'
      ? uz
        ? '💵 Pul va hujjatlar'
        : '💵 Деньги и документы'
      : group === 'system'
        ? uz
          ? '🛟 Tizim: zaxira nusxa'
          : '🛟 Система: резервная копия'
        : uz
          ? '📦 Ish: ombor va buyurtmalar'
          : '📦 Работа: склад и заказы',
  notifyGroupLine: (uz: boolean, name: string, on: number, total: number) =>
    uz ? `${name}: ${on} / ${total} yoqilgan` : `${name}: включено ${on} из ${total}`,
  notifyOn: (uz: boolean, name: string) => (uz ? `${name}: yoqildi` : `${name}: включено`),
  notifyOff: (uz: boolean, name: string) => (uz ? `${name}: o‘chirildi` : `${name}: выключено`),
  notifyNone: (uz: boolean) =>
    uz ? 'Sizning rolingiz uchun xabarnoma turlari yo‘q.' : 'Для вашей роли видов уведомлений нет.',
  openPanel: (uz: boolean) => (uz ? '📋 Panelni ochish' : '📋 Открыть панель'),
  langChanged: (uz: boolean) => (uz ? 'Til: o‘zbekcha' : 'Язык: русский'),
  whoAmI: (uz: boolean, name: string, login: string, roles: string, companies: string) =>
    uz
      ? `<b>${name}</b>\nLogin: <code>${login}</code>\nRollar: ${roles}\nKompaniyalar: ${companies}`
      : `<b>${name}</b>\nЛогин: <code>${login}</code>\nРоли: ${roles}\nКомпании: ${companies}`,
  loggedOut: (uz: boolean) =>
    uz
      ? 'Siz chiqdingiz. Qaytish uchun login va parolni yuboring.'
      : 'Вы вышли. Чтобы вернуться, пришлите логин и пароль.',
  adminTitle: (uz: boolean) =>
    uz
      ? '<b>Boshqaruv</b>\n\nBu yerda faqat ko‘rish: har qanday amal baribir sizning hisobingizdan yoziladi.'
      : '<b>Админ</b>\n\nЗдесь только просмотр: любое действие всё равно пишется от вашей учётной записи.',
  adminRoles: (uz: boolean) => (uz ? 'Qaysi rol ko‘zi bilan ko‘ramiz?' : 'Чьими глазами смотрим?'),
  adminAsRole: (uz: boolean, role: string) =>
    uz
      ? `<b>${role}</b> shunday menyuni ko‘radi. Tugmalar ko‘rsatish uchun, bosilmaydi.`
      : `Вот такое меню видит <b>${role}</b>. Кнопки для показа, они не нажимаются.`,
  adminLinked: (uz: boolean, lines: string[]) =>
    uz
      ? `<b>Telegram bog‘lanishlari</b>\n${lines.join('\n')}`
      : `<b>Кто подключён к боту</b>\n${lines.join('\n')}`,
  notAdmin: (uz: boolean) => (uz ? 'Bu bo‘lim sizga ochiq emas.' : 'Этот раздел вам не доступен.'),
  gone: (uz: boolean) =>
    uz ? 'Bu tugma eskirgan. /start bosing.' : 'Кнопка устарела — нажмите /start.',
  help: (uz: boolean, admin: boolean) =>
    (uz
      ? '<b>Komandalar</b>\n/start — panel\n/settings — sozlamalar\n/quit — chiqish\n/help — shu ro‘yxat'
      : '<b>Команды</b>\n/start — панель\n/settings — настройки\n/quit — выйти\n/help — этот список') +
    (admin ? (uz ? '\n/admin — boshqaruv' : '\n/admin — админ') : ''),
  /**
   * «Как пользоваться»: меню дел этого человека.
   *
   * Экран короткий намеренно. Подпись панели в Telegram — 1024 знака, и все
   * пути в неё не влезают; но дело не только в пределе: человек, который ищет
   * «как записать приход», не читает двенадцать путей подряд. Поэтому здесь
   * общие правила разговора, а сами пути — за кнопками, по одному.
   */
  howTo: (uz: boolean, hasPaths: boolean, admin: boolean) => {
    const head = uz
      ? '<b>Qanday foydalanish kerak</b>\n\nIshni tanlang — qaysi tugmalarni bosishni aytaman.'
      : '<b>Как пользоваться</b>\n\nВыберите дело — скажу, какие кнопки нажимать.';
    const none = uz
      ? 'Sizga hali biror bo‘lim berilmagan.'
      : 'Вам пока не выдано ни одного раздела.';
    const rules = uz
      ? '<blockquote>Xato bosdingiz — ⬅️ Orqaga, savolni qaytadan so‘rayman.\n' +
        'Fikringizdan qaytdingiz — ❌ Bekor qilish: hech nima yozilmaydi.\n' +
        'Pul va tovar faqat ✅ dan keyin qimirlaydi.\n' +
        'Tushunmasangiz — tekshirish ekranida «🤔 Tushunmadim» bor.\n' +
        'Tugmalar yo‘qolsa — /start bosing.</blockquote>'
      : '<blockquote>Нажали не то — ⬅️ Назад, спрошу этот вопрос заново.\n' +
        'Передумали — ❌ Отменить: ничего не запишется.\n' +
        'Деньги и товар двигаются только после ✅.\n' +
        'Непонятно — на экране проверки есть «🤔 Я не понял».\n' +
        'Кнопки пропали — нажмите /start.</blockquote>';
    // Команды живут здесь, а не на экране пути: /help открывает именно этот
    // экран, и человеку, который ищет «чем вернуть панель», листать некуда.
    const commands = uz
      ? '\n\n<b>Komandalar</b>\n/start — panel\n/settings — sozlamalar\n/quit — chiqish\n/help — yordam'
      : '\n\n<b>Команды</b>\n/start — панель\n/settings — настройки\n/quit — выйти\n/help — подсказка';
    const admins = admin ? (uz ? '\n/admin — boshqaruv' : '\n/admin — админ') : '';
    const body = hasPaths ? `${head}\n\n${rules}` : `${head}\n\n${none}\n\n${rules}`;
    return `${body}${commands}${admins}`;
  },

  /** Один путь: что нажимать и что получится. Команды — в конце, мелким. */
  howToOne: (uz: boolean, title: string, path: string, out: string) => {
    const label = uz ? 'Nima bosiladi' : 'Что нажимать';
    const result = uz ? 'Natija' : 'Что получится';
    return `<b>${title}</b>\n\n${label}:\n<blockquote>${path}</blockquote>\n\n${result}: ${out}`;
  },

  hint: (uz: boolean) =>
    uz
      ? 'Panelni ochish uchun /start bosing yoki tugmalardan foydalaning.'
      : 'Чтобы открыть панель, нажмите /start, или пользуйтесь кнопками.',
  /**
   * Фото пришло, а приложить его некуда: человек сфотографировал чек и просто
   * отправил в чат. Молчать нельзя — он будет думать, что бот принял.
   */
  photoNowhere: (uz: boolean) =>
    uz
      ? 'Rasm keldi, lekin uni nimaga biriktirishni bilmayman.\n\n' +
        'Avval kerakli yozuvni oching va «📷 Rasm» tugmasini bosing — keyin rasmni yuboring. ' +
        'Shunda rasm o‘sha yozuvga biriktiriladi va keyin ham topiladi.'
      : 'Фото пришло, но я не знаю, к чему его приложить.\n\n' +
        'Сначала откройте нужную запись и нажмите «📷 Фото» — после этого присылайте снимок. ' +
        'Тогда фото ляжет к этой записи, и его потом найдут.',
  photoFailed: (uz: boolean) =>
    uz
      ? 'Rasmni Telegramdan yuklab olib bo‘lmadi. Yana bir marta yuboring.'
      : 'Не получилось забрать фото из Telegram. Пришлите снимок ещё раз.',
  lostRight: (uz: boolean) =>
    uz ? 'Bu bo‘limga huquqingiz endi yo‘q.' : 'Права на этот раздел у вас больше нет.',
} as const;
