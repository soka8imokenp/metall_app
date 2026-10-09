import type { AppModule } from '../context/AppContext';

/**
 * Каталог статей «Справки» (задача Отабека от 07.10).
 *
 * Заказчик отказался принимать инструкции отдельными PDF и Word: сотрудник,
 * который чего-то не понял, заходит в раздел «Справка» и читает там. Поэтому
 * инструкции живут внутри системы, а не рядом с ней.
 *
 * Здесь только опись: что за статья, к какому разделу относится и кому
 * показывается. Сам текст — в `content/<язык>/<slug>.md` и собирается в бандл
 * фронта (`content.ts`). Разделение не ради красоты: опись — обычные данные,
 * её проверяет тест без сборки и без браузера, а текст правится без правки
 * кода.
 *
 * Тип темы выведен из `AppModule`, а не выписан рядом списком: появится новый
 * раздел — опись перестанет компилироваться, пока его не разберут здесь. Это
 * и есть сторож от «добавили модуль, справку забыли».
 */
export type HelpTopic = AppModule | 'general';

/**
 * Кому статья.
 *
 * `staff` — сотруднику: показывается тому, кому открыт соответствующий раздел.
 * `admin` — администратору: показывается только тем, у кого есть право на
 * «Настройки». Разделение требует заказчик: учётки, ключи обмена, бэкап и
 * выкатка рядового кладовщика не касаются, а в списке статей сбивали бы.
 */
export type HelpAudience = 'staff' | 'admin';

export interface HelpArticle {
  /** Латиницей: слаг уходит в имя файла статьи и в адрес кнопки «?». */
  slug: string;
  topic: HelpTopic;
  audience: HelpAudience;
  /** Заголовок статьи на русском и узбекском. */
  ru: string;
  uz: string;
  /** Одна строка под заголовком в списке; по ней же идёт поиск. */
  ruLead: string;
  uzLead: string;
}

export const HELP_ARTICLES: HelpArticle[] = [
  // ——— Общее: то, с чего начинается рабочий день у любой роли ———
  {
    slug: 'vhod',
    topic: 'general',
    audience: 'staff',
    ru: 'Вход в систему',
    uz: 'Tizimga kirish',
    ruLead: 'Адрес, логин и пароль, что делать, если вход не проходит',
    uzLead: 'Manzil, login va parol, kirish bo‘lmasa nima qilish kerak',
  },
  {
    slug: 'smena-parolya',
    topic: 'general',
    audience: 'staff',
    ru: 'Обязательная смена пароля',
    uz: 'Parolni majburiy o‘zgartirish',
    ruLead: 'Первый вход: система требует придумать свой пароль',
    uzLead: 'Birinchi kirish: tizim o‘z parolingizni so‘raydi',
  },
  {
    slug: 'rabochee-mesto',
    topic: 'general',
    audience: 'staff',
    ru: 'Компания, язык, тема и поиск',
    uz: 'Kompaniya, til, mavzu va qidiruv',
    ruLead: 'Переключение бизнеса, русский и узбекский, светлая и тёмная тема, общий поиск',
    uzLead: 'Biznesni almashtirish, rus va o‘zbek tili, yorug‘ va tungi mavzu, umumiy qidiruv',
  },
  {
    slug: 'telegram',
    topic: 'general',
    audience: 'staff',
    ru: 'Привязка Telegram',
    uz: 'Telegramni ulash',
    ruLead: 'Код привязки у администратора, уведомления в бот',
    uzLead: 'Ulanish kodi administratorda, botdagi xabarlar',
  },

  // ——— Дашборд ———
  // В брифе заказчика дашборда нет, но кнопка «?» стоит в шапке **каждого**
  // раздела, и на дашборде она без статьи вела бы в пустоту.
  {
    slug: 'dashboard-pokazateli',
    topic: 'dashboard',
    audience: 'staff',
    ru: 'Показатели на дашборде',
    uz: 'Boshqaruv panelidagi ko‘rsatkichlar',
    ruLead: 'Что считает каждая плитка, за какой период, почему числа расходятся',
    uzLead: 'Har bir plitka nimani hisoblaydi, qaysi davr uchun, raqamlar nega farq qiladi',
  },

  // ——— Продажи ———
  {
    slug: 'prodazhi-zakaz',
    topic: 'sales',
    audience: 'staff',
    ru: 'Заказ покупателя',
    uz: 'Xaridor buyurtmasi',
    ruLead: 'Завести заказ, добавить строки, резерв, отгрузка и ТТН',
    uzLead: 'Buyurtma yaratish, satrlar, zaxira, yuklash va yuk xati',
  },
  {
    slug: 'prodazhi-prays',
    topic: 'sales',
    audience: 'staff',
    ru: 'Прайс-листы и цены',
    uz: 'Narxnoma va narxlar',
    ruLead: 'Где лежат цены, как они попадают в заказ, ручная цена',
    uzLead: 'Narxlar qayerda, buyurtmaga qanday tushadi, qo‘lda narx',
  },

  // ——— CRM ———
  {
    slug: 'crm-zayavka',
    topic: 'crm',
    audience: 'staff',
    ru: 'Заявка клиента и сделка',
    uz: 'Mijoz murojaati va bitim',
    ruLead: 'Принять обращение, завести клиента, провести сделку по воронке',
    uzLead: 'Murojaatni qabul qilish, mijoz yaratish, bitimni voronka bo‘yicha olib borish',
  },

  // ——— Склад ———
  {
    slug: 'sklad-prihod',
    topic: 'warehouse',
    audience: 'staff',
    ru: 'Приход на склад',
    uz: 'Omborga kirim',
    ruLead: 'Принять товар от поставщика: партия, количество, цена',
    uzLead: 'Yetkazib beruvchidan qabul qilish: partiya, miqdor, narx',
  },
  {
    slug: 'sklad-otgruzka',
    topic: 'warehouse',
    audience: 'staff',
    ru: 'Отгрузка со склада',
    uz: 'Ombordan jo‘natma',
    ruLead: 'Выдать товар покупателю и списать его со склада',
    uzLead: 'Tovarni xaridorga berish va ombordan chiqarish',
  },
  {
    slug: 'sklad-peremeshchenie',
    topic: 'warehouse',
    audience: 'staff',
    ru: 'Перемещение между складами',
    uz: 'Omborlar orasida ko‘chirish',
    ruLead: 'Переложить товар с одного склада или ячейки на другую',
    uzLead: 'Tovarni bir ombordan yoki yacheykadan boshqasiga o‘tkazish',
  },
  {
    slug: 'sklad-spisanie',
    topic: 'warehouse',
    audience: 'staff',
    ru: 'Списание',
    uz: 'Hisobdan chiqarish',
    ruLead: 'Снять товар с остатка с указанием причины',
    uzLead: 'Qoldiqdan chiqarish, sababini ko‘rsatib',
  },
  {
    slug: 'sklad-inventarizatsiya',
    topic: 'warehouse',
    audience: 'staff',
    ru: 'Инвентаризация',
    uz: 'Inventarizatsiya',
    ruLead: 'Лист пересчёта, фактические количества, расхождения и утверждение',
    uzLead: 'Qayta hisob varaqasi, haqiqiy miqdor, farqlar va tasdiqlash',
  },
  {
    slug: 'sklad-serii',
    topic: 'warehouse',
    audience: 'staff',
    ru: 'Партии и серийные номера',
    uz: 'Partiyalar va seriya raqamlari',
    ruLead: 'Откуда берётся номер партии, когда нужен серийный номер, как найти историю',
    uzLead: 'Partiya raqami qayerdan, seriya raqami qachon kerak, tarixni qanday topish',
  },
  {
    slug: 'sklad-etiketki',
    topic: 'warehouse',
    audience: 'staff',
    ru: 'Этикетки, штрихкоды и сканер',
    uz: 'Etiketkalar, shtrixkodlar va skaner',
    ruLead: 'Напечатать этикетку на партию, найти позицию сканером',
    uzLead: 'Partiyaga etiketka chiqarish, skaner bilan pozitsiyani topish',
  },

  // ——— Производство ———
  {
    slug: 'proizvodstvo-zadanie',
    topic: 'production',
    audience: 'staff',
    ru: 'Цеховое задание',
    uz: 'Tsex topshirig‘i',
    ruLead: 'Завести заказ цеха, выбрать техкарту, выдать материал',
    uzLead: 'Tsex buyurtmasini yaratish, texkarta tanlash, material berish',
  },
  {
    slug: 'proizvodstvo-etapy',
    topic: 'production',
    audience: 'staff',
    ru: 'Этапы работ',
    uz: 'Ish bosqichlari',
    ruLead: 'Начать и закрыть свой этап, участок и смена',
    uzLead: 'O‘z bosqichini boshlash va yopish, uchastka va smena',
  },
  {
    slug: 'proizvodstvo-vypusk',
    topic: 'production',
    audience: 'staff',
    ru: 'Выпуск, брак и переделка',
    uz: 'Chiqarish, brak va qayta ishlash',
    ruLead: 'Записать годное, брак и переделку, отклонения',
    uzLead: 'Yaroqli, brak va qayta ishlashni yozish, chetlanishlar',
  },
  {
    slug: 'proizvodstvo-vlozheniya',
    topic: 'production',
    audience: 'staff',
    ru: 'Вложения и фото',
    uz: 'Ilovalar va suratlar',
    ruLead: 'Приложить фото и файл к заказу цеха или к этапу',
    uzLead: 'Tsex buyurtmasi yoki bosqichga surat va fayl ilova qilish',
  },

  // ——— Финансы ———
  {
    slug: 'finansy-operatsiya',
    topic: 'finance',
    audience: 'staff',
    ru: 'Финансовая операция',
    uz: 'Moliyaviy operatsiya',
    ruLead: 'Записать приход или расход денег, касса и счёт, валюта',
    uzLead: 'Pul kirimi yoki chiqimini yozish, kassa va hisob, valyuta',
  },
  {
    slug: 'finansy-zadolzhennost',
    topic: 'finance',
    audience: 'staff',
    ru: 'Задолженность',
    uz: 'Qarzdorlik',
    ruLead: 'Кто сколько должен, сроки и просрочка',
    uzLead: 'Kim qancha qarz, muddatlar va kechikish',
  },
  {
    slug: 'finansy-plan-fakt',
    topic: 'finance',
    audience: 'staff',
    ru: 'План-факт бюджета',
    uz: 'Byudjet reja-fakt',
    ruLead: 'Сравнить план и факт по статьям, превышение',
    uzLead: 'Moddalar bo‘yicha reja va faktni solishtirish, oshib ketish',
  },
  {
    slug: 'finansy-otchety',
    topic: 'finance',
    audience: 'staff',
    ru: 'Восемь отчётов и выгрузка',
    uz: 'Sakkiz hisobot va yuklab olish',
    ruLead: 'Какие отчёты есть, за какой период, выгрузка в Excel, CSV и PDF',
    uzLead: 'Qanday hisobotlar bor, qaysi davr uchun, Excel, CSV va PDF',
  },

  // ——— Документы ———
  {
    slug: 'dokumenty-shablony',
    topic: 'documents',
    audience: 'staff',
    ru: 'Шаблоны документов',
    uz: 'Hujjat shablonlari',
    ruLead: 'Сформировать документ по шаблону, подстановки, печать',
    uzLead: 'Shablon bo‘yicha hujjat yaratish, o‘rniga qo‘yish, chop etish',
  },
  {
    slug: 'dokumenty-tipy',
    topic: 'documents',
    audience: 'staff',
    ru: 'Типы документов',
    uz: 'Hujjat turlari',
    ruLead: 'Чем счёт отличается от накладной, нумерация и реестр',
    uzLead: 'Hisob yuk xatidan nimasi bilan farq qiladi, raqamlash va reestr',
  },
  {
    slug: 'dokumenty-marshrut',
    topic: 'documents',
    audience: 'staff',
    ru: 'Маршрут согласования',
    uz: 'Kelishuv marshruti',
    ruLead: 'Кто согласует документ, как отправить и как увидеть отказ',
    uzLead: 'Hujjatni kim kelishadi, qanday yuborish va rad etishni ko‘rish',
  },

  // ——— Администратору: только тем, у кого есть «Настройки» ———
  {
    slug: 'admin-uchetki',
    topic: 'admin',
    audience: 'admin',
    ru: 'Учётки и роли',
    uz: 'Hisoblar va rollar',
    ruLead: 'Завести человека, выдать роль в компании, выключить учётку',
    uzLead: 'Odam yaratish, kompaniyada rol berish, hisobni o‘chirish',
  },
  {
    slug: 'admin-parol',
    topic: 'admin',
    audience: 'admin',
    ru: 'Сброс пароля и обязательная смена',
    uz: 'Parolni tiklash va majburiy o‘zgartirish',
    ruLead: 'Выдать временный пароль, заявки на сброс, что видит человек',
    uzLead: 'Vaqtinchalik parol berish, tiklash arizalari, odam nimani ko‘radi',
  },
  {
    slug: 'admin-obmen-klyuch',
    topic: 'admin',
    audience: 'admin',
    ru: 'Подключение внешней системы',
    uz: 'Tashqi tizimni ulash',
    ruLead: 'Код системы, ключ доступа, секрет подписи, адрес для входящих',
    uzLead: 'Tizim kodi, kirish kaliti, imzo siri, kiruvchi so‘rov manzili',
  },
  {
    slug: 'admin-zhurnal-obmenov',
    topic: 'admin',
    audience: 'admin',
    ru: 'Журнал обменов и повтор',
    uz: 'Almashinuv jurnali va qayta yuborish',
    ruLead: 'Что ушло и что пришло, тела запроса и ответа, повторная отправка',
    uzLead: 'Nima ketdi va nima keldi, so‘rov va javob tanasi, qayta yuborish',
  },
  {
    slug: 'admin-spravochnik-fayl',
    topic: 'admin',
    audience: 'admin',
    ru: 'Загрузка справочника файлом',
    uz: 'Ma’lumotnomani fayl bilan yuklash',
    ruLead: 'Выгрузить номенклатуру, поправить в файле, залить обратно с проверкой',
    uzLead: 'Nomenklaturani yuklab olish, faylda tuzatish, tekshirib qaytarish',
  },
  {
    slug: 'admin-bekap',
    topic: 'admin',
    audience: 'admin',
    ru: 'Бэкап базы',
    uz: 'Bazaning zaxira nusxasi',
    ruLead: 'Что копируется, как часто и как проверить, что копия живая',
    uzLead: 'Nima nusxalanadi, qanchalik tez-tez va nusxa tirikligini tekshirish',
  },
  {
    slug: 'admin-vykatka',
    topic: 'admin',
    audience: 'admin',
    ru: 'Выкатка версии',
    uz: 'Versiyani chiqarish',
    ruLead: 'Номер версии в панели, полоса «обновление», что делать после выкатки',
    uzLead: 'Paneldagi versiya raqami, «yangilanish» chizig‘i, chiqarishdan keyin',
  },
];

/**
 * Какая статья открывается кнопкой «?» в заголовке раздела.
 *
 * Статей у раздела несколько, а кнопка одна — ведёт на первую статью темы.
 * Порядок в описи и есть порядок в списке: первая статья темы — та, с которой
 * человеку и надо начинать.
 */
export const articleForTopic = (topic: HelpTopic): HelpArticle | null =>
  HELP_ARTICLES.find((a) => a.topic === topic) ?? null;

export const articleBySlug = (slug: string): HelpArticle | null =>
  HELP_ARTICLES.find((a) => a.slug === slug) ?? null;

/**
 * Порядок тем в списке статей. Общее — первым: с него начинают.
 *
 * Записан номерами в таблице по всем темам, а не массивом: массив молча
 * потерял бы новый раздел, а `Record<HelpTopic, number>` без него не
 * компилируется. У самой «Справки» статей нет — порядок ей всё равно нужен,
 * иначе таблица перестанет быть полной.
 */
const TOPIC_RANK: Record<HelpTopic, number> = {
  general: 0,
  dashboard: 1,
  sales: 2,
  warehouse: 3,
  production: 4,
  finance: 5,
  documents: 6,
  crm: 7,
  admin: 8,
  help: 9,
};

export const TOPIC_ORDER: HelpTopic[] = (Object.keys(TOPIC_RANK) as HelpTopic[]).sort(
  (a, b) => TOPIC_RANK[a] - TOPIC_RANK[b],
);

/** Подписи тем в списке. Берутся из словаря интерфейса, кроме «Общего». */
export const TOPIC_TITLE: Record<HelpTopic, { ru: string; uz: string }> = {
  general: { ru: 'Общее', uz: 'Umumiy' },
  dashboard: { ru: 'Дашборд', uz: 'Boshqaruv paneli' },
  sales: { ru: 'Продажи', uz: 'Sotuvlar' },
  warehouse: { ru: 'Склад', uz: 'Omborxona' },
  production: { ru: 'Производство', uz: 'Ishlab chiqarish' },
  finance: { ru: 'Финансы', uz: 'Moliya' },
  documents: { ru: 'Документы', uz: 'Hujjatlar' },
  crm: { ru: 'CRM', uz: 'CRM' },
  admin: { ru: 'Настройки и администрирование', uz: 'Sozlamalar va administratorlik' },
  help: { ru: 'Справка', uz: 'Yordam' },
};
