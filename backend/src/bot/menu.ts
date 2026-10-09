/**
 * Разделы бота и кнопки, которые человек видит.
 *
 * Меню собирается из прав, а не рисуется статично: один и тот же человек часто
 * и кладовщик, и отгружает — набор кнопок у него свой. Разделы взяты из ТЗ 11
 * один к одному, чтобы при приёмке их можно было сверить по списку.
 *
 * `soon` — то, что в разделе появится; этот список видит человек, открывший
 * ещё не сделанный раздел. Пустой раздел, который молча ничего не делает, хуже
 * отсутствующего: человек решит, что бот сломан. У готового раздела список
 * обязан быть пустым: иначе он однажды соврёт на приёмке — это держит тест
 * «список незаконченного не врёт».
 */
import type { ButtonStyle, InlineButton, InlineKeyboard } from './telegram.api.js';

export interface Section {
  key: string;
  emoji: string;
  ru: string;
  uz: string;
  /** Право, без которого раздела нет вовсе. */
  permission: string;
  /**
   * Раздел уже работает: кнопка открывает его экраны, а не рассказ о планах.
   * Признак, а не проверка «есть ли обработчик»: так в одном списке видно, что
   * из ТЗ 11 сделано, и приёмка сверяется по нему.
   */
  live?: boolean;
  soonRu: string[];
  soonUz: string[];
}

export const SECTIONS: Section[] = [
  {
    key: 'finance',
    emoji: '💵',
    ru: 'Финансы',
    uz: 'Moliya',
    permission: 'finance.view',
    live: true,
    soonRu: [],
    soonUz: [],
  },
  {
    key: 'warehouse',
    emoji: '📦',
    ru: 'Склад',
    uz: 'Ombor',
    permission: 'warehouse.view',
    live: true,
    // Подтверждение приёмки по заданию ждёт модуль производства: пока заданий
    // нет, подтверждать нечего. Это единственный остаток по ТЗ 11.3.
    soonRu: [],
    soonUz: [],
  },
  {
    key: 'sales',
    emoji: '🛒',
    ru: 'Продажи',
    uz: 'Sotuv',
    permission: 'sales.view',
    live: true,
    soonRu: [],
    soonUz: [],
  },
  {
    key: 'production',
    emoji: '🏭',
    ru: 'Производство',
    uz: 'Ishlab chiqarish',
    permission: 'production.view',
    live: true,
    // Переделка в боте не заводится: дочерний заказ планируют за столом, с
    // нормами и сроком перед глазами, а не на ходу в цеху.
    soonRu: [],
    soonUz: [],
  },
  {
    key: 'documents',
    emoji: '📄',
    ru: 'Документы',
    uz: 'Hujjatlar',
    permission: 'documents.view',
    live: true,
    soonRu: [],
    soonUz: [],
  },
  {
    key: 'dashboard',
    emoji: '📊',
    ru: 'Сводка',
    uz: 'Xulosa',
    permission: 'dashboard.view',
    live: true,
    soonRu: [],
    soonUz: [],
  },
];

/**
 * Роли, которым бот нужен (решение клиента 02.10): два руководителя, финансист,
 * кладовщик и менеджер. Остальные работают в самой системе — у них компьютер и
 * рабочее место, а бот сделан для тех, кому веб неудобен или кто в цеху и в поле.
 *
 * ТЗ 11 перечисляет шесть профилей, среди них «Производство» и «Документы».
 * Клиент сузил список словами, профили не отменяя: начальник производства
 * заходит в систему. Поэтому это список ролей, а не прав — права остаются
 * основанием для кнопок внутри бота.
 */
export const BOT_ROLES = [
  'admin',
  'director',
  'accountant',
  'warehouse_keeper',
  'sales_manager',
] as const;

/** Пускать ли человека с такими ролями в бота. */
export function botAllowed(roleCodes: Iterable<string>): boolean {
  const allowed = new Set<string>(BOT_ROLES);
  for (const code of roleCodes) if (allowed.has(code)) return true;
  return false;
}

export const CB = {
  lang: (code: string) => `l:${code}`,
  section: (key: string) => `m:${key}`,
  menu: 'm',
  settings: 's',
  settingsLang: 's:l',
  whoAmI: 's:who',
  /** «Как пользоваться»: меню дел и один путь по кнопке. */
  howTo: 's:how',
  howToOne: (key: string) => `s:howto:${key}`,
  logout: 's:out',
  notifications: 'n',
  // Группа поводов: «деньги и документы» или «работа». Префикс `n:g:` длиннее
  // кода повода, поэтому разбор идёт сначала по нему, а не по `n:`.
  notificationGroup: (group: string) => `n:g:${group}`,
  notificationToggle: (kind: string) => `n:${kind}`,
  admin: 'a',
  adminLinked: 'a:who',
  adminAsRole: (code: string) => `a:r:${code}`,
  adminRoles: 'a:r',

  /**
   * Финансы. Коды короткие не из любви к краткости: в `callback_data`
   * шестьдесят четыре знака на всё, а uuid операции занимает тридцать шесть.
   * Версия операции едет в кнопке действия намеренно — это та версия, которую
   * человек видел на экране подтверждения, и по ней служба отличит второе
   * нажатие от настоящего второго решения.
   */
  fin: 'f',
  finNew: (type: 'income' | 'expense') => `f:n:${type === 'income' ? 'i' : 'e'}`,
  finList: 'f:l',
  finWaiting: 'f:w',
  finDebts: 'f:d',
  finOverdue: 'f:d1',
  finPlan: 'f:pf',
  finOp: (uid: string) => `f:o:${uid}`,
  finAsk: (code: string, uid: string, version: number) => `f:q:${code}:${uid}:${version}`,
  finDo: (code: string, uid: string, version: number) => `f:y:${code}:${uid}:${version}`,
  /** Повторить последнюю свою запись: тот же расход в следующем месяце. */
  finRepeat: 'f:rp',
  /** Оплата по заказу: кнопка живёт в продажах, разговор ведут финансы. */
  finPay: (uid: string) => `f:pay:${uid}`,
  /** Фото чека к операции. */
  finPhoto: (uid: string) => `f:ph:${uid}`,
  finPick: (value: string) => `f:k:${value}`,
  finSkip: 'f:k:-',
  finSave: 'f:go',
  /** «Я не понял» на проверке и возврат с объяснения. */
  finExplain: 'f:ex',
  finConfirm: 'f:cf',
  finBack: 'f:bk',
  finCancel: 'f:x',

  /**
   * Склад. Коды типов движения — одной буквой: в `callback_data` шестьдесят
   * четыре знака, а `issue_to_production` съел бы пятую часть на одно слово.
   */
  wh: 'w',
  whNew: (code: string) => `w:n:${code}`,
  whReturns: 'w:r',
  whStock: 'w:s',
  whMoves: 'w:m',
  whMove: (uid: string) => `w:o:${uid}`,
  whNeeds: 'w:d',
  whSheets: 'w:i',
  whSheet: (uid: string) => `w:h:${uid}`,
  whLine: (uid: string) => `w:c:${uid}`,
  whAsk: (what: string, uid: string) => `w:q:${what}:${uid}`,
  whDo: (what: string, uid: string) => `w:y:${what}:${uid}`,
  /** Фото к движению: как правило, снимок при списании. */
  whPhoto: (uid: string) => `w:ph:${uid}`,
  whPick: (value: string) => `w:k:${value}`,
  whSkip: 'w:k:-',
  whSave: 'w:go',
  whExplain: 'w:ex',
  whConfirm: 'w:cf',
  whBack: 'w:bk',
  whCancel: 'w:x',

  /**
   * Продажи. Буква раздела — `o` (от «заказ»): `s` уже занята настройками.
   * Статус, в который переводят заказ, тоже едет буквой: `in_production` в
   * кнопке вместе с uuid не умещается в шестьдесят четыре знака.
   */
  sal: 'o',
  salStage: (stage: string) => `o:s:${stage}`,
  salSearch: 'o:f',
  salNew: 'o:n',
  salOrder: (uid: string) => `o:c:${uid}`,
  salAvail: (uid: string) => `o:a:${uid}`,
  salShip: (uid: string) => `o:t:${uid}`,
  salAsk: (code: string, uid: string) => `o:q:${code}:${uid}`,
  salDo: (code: string, uid: string) => `o:y:${code}:${uid}`,
  salPick: (value: string) => `o:k:${value}`,
  salSkip: 'o:k:-',
  salMore: 'o:k:+',
  salSave: 'o:go',
  salExplain: 'o:ex',
  salConfirm: 'o:cf',
  salShipGo: 'o:tgo',
  salBack: 'o:bk',
  salCancel: 'o:x',

  /**
   * Документы. Действие маршрута едет буквой: `pending_approval` и uuid вместе
   * в шестьдесят четыре знака не помещаются.
   */
  doc: 'd',
  /** Выписать документ из заказа: кнопка в продажах, разговор в документах. */
  docNew: (uid: string) => `d:ns:${uid}`,
  docType: (uid: string) => `d:nt:${uid}`,
  docNewGo: 'd:ngo',
  docTab: (key: string) => `d:s:${key}`,
  docSearch: 'd:f',
  docOne: (uid: string) => `d:c:${uid}`,
  docPdf: (uid: string) => `d:p:${uid}`,
  docDocx: (uid: string) => `d:w:${uid}`,
  docAsk: (code: string, uid: string) => `d:q:${code}:${uid}`,
  docDo: (code: string, uid: string) => `d:y:${code}:${uid}`,
  docCancel: 'd:x',

  /**
   * Сводка руководителя. Буква `c` — от «chief»: `s` занята настройками, `d`
   * документами. Срок в кнопке своей буквой, чтобы выбранный период жил в
   * разговоре и не сбрасывался на каждом экране.
   */
  chief: 'c',
  chiefPeriod: (code: string) => `c:p:${code}`,
  chiefCompare: 'c:cc',
  chiefWaiting: 'c:w',
  chiefAlarms: 'c:a',

  /**
   * Производство. Буква `p` свободна. Номер этапа едет в кнопке рядом с uuid
   * заказа: вместе это сорок с небольшим знаков, в шестьдесят четыре влезает.
   */
  prod: 'p',
  prodMine: 'p:me',
  prodShop: 'p:sh',
  prodDeviations: 'p:dv',
  prodSearch: 'p:f',
  prodState: (key: string) => `p:s:${key}`,
  prodOrder: (uid: string) => `p:c:${uid}`,
  prodStages: (uid: string) => `p:g:${uid}`,
  prodStage: (uid: string, seq: number) => `p:t:${uid}:${seq}`,
  /** Отметка цеха: заказ, этап и буква отметки, у паузы — ещё причина. */
  prodMark: (uid: string, seq: number, mark: string) => `p:k:${uid}:${seq}:${mark}`,
  prodAsk: (code: string, uid: string) => `p:q:${code}:${uid}`,
  prodDo: (code: string, uid: string) => `p:y:${code}:${uid}`,
  prodOut: (uid: string) => `p:o:${uid}`,
  prodDefect: (uid: string) => `p:b:${uid}`,
  /**
   * Снимок к заданию: фото брака и замера из цеха (ТЗ 4.1, 4.6).
   *
   * Две буквы, а не одна: `p:p:` уже занят выбором из списка. С `p:ph:` они не
   * путаются — у выбора после `p:p` стоит двоеточие, здесь `h`.
   */
  prodPhoto: (uid: string) => `p:ph:${uid}`,
  prodPick: (value: string) => `p:p:${value}`,
  prodSave: 'p:go',
  prodExplain: 'p:ex',
  prodConfirm: 'p:cf',
  prodCancel: 'p:x',

  /**
   * Курс валют. Буква `r` свободна, и экран один — разделом он не стал
   * намеренно: это не рабочее место, а справка на один взгляд.
   */
  rates: 'r',
  ratesSync: 'r:s',
} as const;

/** Разделы, доступные человеку с такими правами. */
export function allowedSections(permissions: Iterable<string>): Section[] {
  const has = new Set(permissions);
  return SECTIONS.filter((s) => has.has(s.permission));
}

/**
 * Цвета кнопок (просьба клиента 02.10): разделы синие, «Настройки» зелёная.
 * Красит сам Telegram по полю `style` — Bot API 9.4. Выход красим красным:
 * это единственное действие в боте, которое отнимает доступ.
 */
export const BLUE: ButtonStyle = 'primary';
export const GREEN: ButtonStyle = 'success';
export const RED: ButtonStyle = 'danger';

/**
 * Главное меню: разделы по два в ряд, снизу «Настройки» и — администратору —
 * «Админ». Два столбца, потому что на телефоне кнопка в один столбец уезжает
 * вниз и до «Настроек» приходится листать.
 *
 * Тематический значок в подписи остаётся: цвет говорит, что кнопка главная,
 * значок — о чём она. Одно другое не заменяет.
 */
export function mainMenu(permissions: Iterable<string>, isUz: boolean): InlineKeyboard {
  const has = new Set(permissions);
  const rows: InlineKeyboard = [];
  const tiles: InlineButton[] = allowedSections(has).map((s) => ({
    text: `${s.emoji} ${isUz ? s.uz : s.ru}`,
    data: CB.section(s.key),
    style: BLUE,
  }));
  for (let i = 0; i < tiles.length; i += 2) rows.push(tiles.slice(i, i + 2));

  // Курс валют — кнопка для всех, а не только для финансов (решение клиента
  // 03.10.2026): официальный курс ЦБ нужен и кладовщику, и менеджеру, и
  // данных компании в нём нет.
  rows.push([
    {
      text: `💱 ${isUz ? 'Valyuta kursi' : 'Курс валют'}`,
      data: CB.rates,
      style: BLUE,
    },
  ]);

  const bottom: InlineButton[] = [
    {
      text: `⚙️ ${isUz ? 'Sozlamalar' : 'Настройки'}`,
      data: CB.settings,
      style: GREEN,
    },
  ];
  if (has.has('admin.users')) {
    bottom.push({
      text: `🛠 ${isUz ? 'Boshqaruv' : 'Админ'}`,
      data: CB.admin,
      style: BLUE,
    });
  }
  rows.push(bottom);
  return rows;
}

export function backRow(isUz: boolean): InlineButton[] {
  return [{ text: isUz ? '⬅️ Menyu' : '⬅️ Меню', data: CB.menu, style: BLUE }];
}

/** Возврат в раздел финансов — ряд, который есть на каждом его экране. */
export function finRow(isUz: boolean): InlineButton[] {
  return [
    { text: isUz ? '⬅️ Moliya' : '⬅️ Финансы', data: CB.fin, style: BLUE },
    { text: isUz ? '⬅️ Menyu' : '⬅️ Меню', data: CB.menu, style: BLUE },
  ];
}
