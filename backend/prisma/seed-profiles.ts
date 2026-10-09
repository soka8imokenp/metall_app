/**
 * Два набора опознавательных данных для сида: рабочий и демонстрационный.
 *
 * Структура стенда — номенклатура, склады, движения, заказы — от профиля не
 * зависит и живёт в `seed.ts`. Здесь только то, по чему узнают живую фирму и
 * живого человека: названия, ИНН, банковские реквизиты, ФИО, почта, телефоны.
 *
 * Зачем разделение. Стенд на нашем домене — наша инфраструктура, а по договору
 * данные METALL ASIA лежат на сервере заказчика в Узбекистане: это требование
 * по персональным данным. Значит наружу уезжает профиль `demo`, и он не должен
 * содержать ни одной строки, по которой можно выйти на реальное лицо.
 *
 * Выбор профиля — переменная `SEED_PROFILE`, по умолчанию `dev`.
 * Правило удерживается проверкой `test/seed-profiles.spec.ts`, а не памятью.
 */
import { randomBytes } from 'node:crypto';

import { defaultPasswordFor } from '../src/common/default-password.js';

export type CompanyDef = {
  /** Код компании функциональный, на него завязан весь остальной сид. */
  code: 'trade' | 'plant';
  nameRu: string;
  nameUz: string;
  inn: string;
  legalAddress: string;
  bankDetails: { bank: string; account: string; mfo: string };
};

export type UserDef = {
  login: string;
  fullName: string;
  email: string;
  phone: string;
  role: string;
  /** Коды компаний: идентификаторы появятся только после вставки. */
  companies: ('trade' | 'plant')[];
  /**
   * Свой пароль учётки. Задан — он и стоит, пусто — общий пароль профиля.
   * В демо-профиле задан у всех: там пароль дефолтный, `<логин>123`, и
   * случайный пароль на каждый пересев ломает сам замысел — войти ролью, не
   * спрашивая пароль у нас (06.10, требование Отабека).
   */
  password?: string;
  /**
   * Поднять признак «пароль временный». Для дефолтного пароля обязателен: его
   * знает каждый, кому назвали логин, и пускать по нему дальше окна смены
   * пароля нельзя. Сторож — `test/stand-logins.spec.ts`.
   */
  mustChangePassword?: boolean;
};

export type PartnerDef = {
  company: 'trade' | 'plant';
  nameRu: string;
  nameUz: string;
  inn: string;
  isClient: boolean;
  isSupplier: boolean;
  /** Логин ответственного менеджера из этого же профиля или null. */
  manager: string | null;
  legalAddress: string;
};

/**
 * Функциональные ключи учётных записей. Сид расставляет ответственных по роли
 * («заказ оформил менеджер продаж»), а не по конкретному логину, — иначе смена
 * профиля ломала бы половину вставок на `undefined`.
 */
export type LoginKey =
  | 'admin' | 'director' | 'salesTrade1' | 'salesTrade2'
  | 'master' | 'salesPlant' | 'warehouse' | 'accountant';

export type SeedProfile = {
  name: 'dev' | 'demo';
  companies: CompanyDef[];
  users: UserDef[];
  logins: Record<LoginKey, string>;
  partners: PartnerDef[];
  leadNames: string[];
  contactName: (index: number) => string;
  contactPosition: string[];
  contactEmail: (index: number) => string;
  contactPhone: (index: number) => string;
  leadEmail: (index: number) => string;
  leadPhone: (index: number) => string;
  /** Пароль всем учётным записям прогона. */
  password: () => string;
};

// --- рабочий профиль --------------------------------------------------------
// Данные разработки: тот же набор, что стоял в сиде с самого начала. Стенд
// локальный, наружу не смотрит, пароль один и задаётся окружением.

// Названия юрлиц - со встречи у заказчика 07.10 (реплика 152): это две разные
// компании, а не «Trade» и «Plant» одного бренда. Оптовая торговля - ООО
// «Металл Азия», завод - ООО «Ташкентский изоляционный завод» (ТИЗ); написание
// сверено с сайтами клиента metallasia.uz и tiz.uz. Внутренние коды
// `trade`/`plant` оставлены как были: на них завязаны сид, тесты и прогоны,
// а на экране их не видно.
const devCompanies: CompanyDef[] = [
  {
    code: 'trade',
    nameRu: 'ООО «Металл Азия»',
    nameUz: '«Metall Asia» MChJ',
    inn: '306313737',
    legalAddress: 'г. Ташкент, Сергелийский район, ул. Янги Сергели, 12',
    bankDetails: { bank: 'АКБ «Асакабанк»', account: '20208000900123456001', mfo: '00443' },
  },
  {
    code: 'plant',
    nameRu: 'ООО «Ташкентский изоляционный завод»',
    nameUz: '«Toshkent izolyatsiya zavodi» MChJ',
    inn: '309881204',
    legalAddress: 'Ташкентская обл., Зангиатинский район, промзона «Эркин»',
    bankDetails: { bank: 'АКБ «Ипотека-банк»', account: '20208000700998877002', mfo: '00871' },
  },
];

const devUsers: UserDef[] = ([
  { login: 'admin', fullName: 'Администратор системы', role: 'admin', companies: ['trade', 'plant'] },
  { login: 's.radjabov', fullName: 'Раджабов Сухроб Аминджанович', role: 'director', companies: ['trade', 'plant'] },
  { login: 'd.karimov', fullName: 'Каримов Дилшод', role: 'sales_manager', companies: ['trade'] },
  { login: 'n.yusupova', fullName: 'Юсупова Нигора', role: 'sales_manager', companies: ['trade'] },
  { login: 'j.tashpulatov', fullName: 'Ташпулатов Жамик', role: 'production_master', companies: ['plant'] },
  { login: 'r.tursunov', fullName: 'Турсунов Рустам', role: 'production_worker', companies: ['plant'] },
  { login: 'b.ergashev', fullName: 'Эргашев Бекзод', role: 'sales_manager', companies: ['plant'] },
  { login: 'a.saidov', fullName: 'Саидов Азиз', role: 'warehouse_keeper', companies: ['trade', 'plant'] },
  { login: 'm.rahimova', fullName: 'Рахимова Малика', role: 'accountant', companies: ['trade', 'plant'] },
] satisfies Omit<UserDef, 'email' | 'phone'>[]).map((u, i) => ({
  ...u,
  email: `${u.login}@metall-asia.uz`,
  phone: `+9989${String(70_000_000 + i * 111_111).slice(0, 8)}`,
}));

const devPartners: PartnerDef[] = ([
  { company: 'trade', nameRu: 'ООО «Мурод Билдинг»', nameUz: '«Murod Building» MChJ', inn: '301442889', isClient: true, isSupplier: false, manager: 'd.karimov' },
  { company: 'trade', nameRu: 'ООО «Тошкент Иншоот Сервис»', nameUz: '«Toshkent Inshoot Servis» MChJ', inn: '302887431', isClient: true, isSupplier: false, manager: 'd.karimov' },
  { company: 'trade', nameRu: 'ООО «Сергели Курилиш»', nameUz: '«Sergeli Qurilish» MChJ', inn: '304551220', isClient: true, isSupplier: false, manager: 'n.yusupova' },
  { company: 'trade', nameRu: 'ООО «Мега Строй Групп»', nameUz: '«Mega Stroy Grupp» MChJ', inn: '305119764', isClient: true, isSupplier: false, manager: 'n.yusupova' },
  { company: 'trade', nameRu: 'ООО «Янги Авлод Курилиш»', nameUz: '«Yangi Avlod Qurilish» MChJ', inn: '307662014', isClient: true, isSupplier: false, manager: 'd.karimov' },
  { company: 'trade', nameRu: 'АО «Узметкомбинат»', nameUz: '«O‘zmetkombinat» AJ', inn: '200155832', isClient: false, isSupplier: true, manager: null },
  { company: 'trade', nameRu: 'ООО «Металл Трейд Импорт»', nameUz: '«Metall Trade Import» MChJ', inn: '308774119', isClient: false, isSupplier: true, manager: null },
  { company: 'plant', nameRu: 'АО «Тошиссиккуввати»', nameUz: '«Toshissiqquvvati» AJ', inn: '200331447', isClient: true, isSupplier: false, manager: 'b.ergashev' },
  { company: 'plant', nameRu: 'ГУП «Таштеплоэнерго»', nameUz: '«Toshteploenergo» DUK', inn: '201889305', isClient: true, isSupplier: false, manager: 'b.ergashev' },
  { company: 'plant', nameRu: 'ООО «Самарканд Иссиклик Тармоги»', nameUz: '«Samarqand Issiqlik Tarmog‘i» MChJ', inn: '303776215', isClient: true, isSupplier: false, manager: 'b.ergashev' },
  { company: 'plant', nameRu: 'АО «Навоийазот»', nameUz: '«Navoiyazot» AJ', inn: '200447719', isClient: true, isSupplier: false, manager: 'b.ergashev' },
  { company: 'plant', nameRu: 'ООО «Химпром Полимер»', nameUz: '«Himprom Polimer» MChJ', inn: '306998412', isClient: false, isSupplier: true, manager: null },
  { company: 'plant', nameRu: 'АО «Узметкомбинат»', nameUz: '«O‘zmetkombinat» AJ', inn: '200155832', isClient: false, isSupplier: true, manager: null },
] satisfies Omit<PartnerDef, 'legalAddress'>[]).map((p) => ({
  ...p,
  legalAddress: 'Республика Узбекистан, г. Ташкент',
}));

export const devProfile: SeedProfile = {
  name: 'dev',
  companies: devCompanies,
  users: devUsers,
  logins: {
    admin: 'admin',
    director: 's.radjabov',
    salesTrade1: 'd.karimov',
    salesTrade2: 'n.yusupova',
    master: 'j.tashpulatov',
    salesPlant: 'b.ergashev',
    warehouse: 'a.saidov',
    accountant: 'm.rahimova',
  },
  partners: devPartners,
  leadNames: [
    'Бектемир Курилиш', 'Олмазор Девелопмент', 'Чирчик Иссиклик', 'Фергана Строй',
    'Бухара Тепло', 'Андижан Курилиш Сервис', 'Хорезм Иншоот', 'Наманган Теплосети',
  ],
  contactName: () => '',
  contactPosition: ['Директор', 'Главный инженер', 'Снабженец', 'Главный бухгалтер'],
  contactEmail: (i) => `info${i + 1}@partner.uz`,
  contactPhone: (i) => `+9989${String(30_000_000 + i * 77_777).slice(0, 8)}`,
  leadEmail: (i) => `lead${i + 1}@mail.uz`,
  leadPhone: (i) => `+9989${String(20_000_000 + i * 123_457).slice(0, 8)}`,
  password: () => process.env.SEED_PASSWORD ?? 'metall-dev-2026',
};

/** Имена контактных лиц в рабочем профиле — выбор из списка, как было. */
const devContactNames = [
  'Алишер Рустамов', 'Дильноза Каримова', 'Шухрат Абдуллаев', 'Гулнора Тошева', 'Фаррух Юлдашев',
];
devProfile.contactName = (i) => devContactNames[i % devContactNames.length];

// --- демонстрационный профиль ----------------------------------------------
// Всё ненастоящее и подписано как ненастоящее. Названия фирм узнаваемы по
// форме, но ни одно не существует; ИНН с ведущим нулём в реестре невозможен;
// почта в домене `.invalid` (RFC 2606) не доставится никому даже по ошибке.

const demoCompanies: CompanyDef[] = [
  {
    code: 'trade',
    nameRu: 'ООО «Металл Азия» (демо)',
    nameUz: '«Metall Asia» MChJ (demo)',
    inn: '000000001',
    legalAddress: 'Демонстрационные данные, адрес не настоящий',
    bankDetails: { bank: 'Демо-банк', account: '00000000000000000001', mfo: '00000' },
  },
  {
    code: 'plant',
    nameRu: 'ООО «Ташкентский изоляционный завод» (демо)',
    nameUz: '«Toshkent izolyatsiya zavodi» MChJ (demo)',
    inn: '000000002',
    legalAddress: 'Демонстрационные данные, адрес не настоящий',
    bankDetails: { bank: 'Демо-банк', account: '00000000000000000002', mfo: '00000' },
  },
];

// Учётные записи названы должностью, а не человеком: придумывать ФИО значит
// снова положить на стенд то, что выглядит как персональные данные.
//
// Вход по ролям (06.10, требование Отабека: «у каждой роли свой вход»).
// Логин — название роли, пароль — название роли плюс `123`, и этот пароль
// **дефолтный**: по нему входят первый раз и сразу меняют. Точек в логинах
// нет: логин называют голосом, и «эс-эй-эль-и-эс точка трейд один» вместо
// «sales» диктовать невозможно.
//
// Девять учёток, по одной на роль, плюс вторая на «Собственника»: собственников
// двое живых людей, и у них разный доступ к компаниям — без второй учётки этот
// разрез не показать. Прежний демо-список людей (`sales2`, `sales_plant`, `accountant`) и
// учётка `user` с правами администратора убраны: вход «клиент видит всё»
// перестал быть нужен, как только у каждой роли появился свой.
//
// Исключений из правила пароля больше нет, включая `admin`. Держит
// `test/stand-logins.spec.ts`.
const demoUsers: UserDef[] = ([
  { login: 'admin', fullName: 'Администратор (демо)', role: 'admin', companies: ['trade', 'plant'] },
  // Собственник видит всё по своим компаниям и не администрирует. Их двое, и
  // роль у обоих одна: разделяет их список компаний в учётке (поправка
  // заказчика от 06.10). `owner1` — доступ к обоим бизнесам, `owner2` — только
  // завод. Так на стенде виден и разрез по ролям, и разрез по компаниям внутри
  // одной роли.
  { login: 'owner1', fullName: 'Собственник, обе компании (демо)', role: 'owner', companies: ['trade', 'plant'] },
  { login: 'owner2', fullName: 'Собственник, Завод (демо)', role: 'owner', companies: ['plant'] },
  { login: 'director', fullName: 'Директор (демо)', role: 'director', companies: ['trade', 'plant'] },
  // Логин заказчик назвал сам — `finance`, а роль остаётся `accountant`: код
  // системной роли не переименовывается, на нём висят назначения и тесты
  // (правило 1 в шапке `admin/roles.service.ts`).
  { login: 'finance', fullName: 'Бухгалтер (демо)', role: 'accountant', companies: ['trade', 'plant'] },
  // Один менеджер на обе компании: демо-данные завода и торгового дома держат
  // ответственного, и на одну учётку их иначе не разложить. Разрез по
  // компаниям показывают `owner1`/`owner2`, `master` и `worker`.
  { login: 'sales', fullName: 'Менеджер продаж (демо)', role: 'sales_manager', companies: ['trade', 'plant'] },
  { login: 'warehouse', fullName: 'Кладовщик (демо)', role: 'warehouse_keeper', companies: ['trade', 'plant'] },
  { login: 'master', fullName: 'Начальник производства (демо)', role: 'production_master', companies: ['plant'] },
  { login: 'worker', fullName: 'Сотрудник производства (демо)', role: 'production_worker', companies: ['plant'] },
] satisfies Omit<UserDef, 'email' | 'phone'>[]).map((u, i) => ({
  ...u,
  // Пароль по общему правилу — всем, и правило берётся из одного места, а не
  // пишется здесь второй раз: у двух собственников логины разные (`owner1`,
  // `owner2`), а дефолтный пароль один — `owner123`. Случайный пароль профиля
  // означал бы, что войти ролью нельзя, а ради этого правило и заведено.
  password: defaultPasswordFor(u.login),
  // Признак поднят у всех: дефолтный пароль открыт каждому, кому называли
  // логин, и первым экраном обязана быть смена пароля, а не сводка.
  mustChangePassword: true,
  email: `${u.login}@demo.invalid`,
  phone: `+99800${String(1_000_000 + i).padStart(7, '0')}`,
}));

const demoPartners: PartnerDef[] = ([
  { company: 'trade', nameRu: 'ООО «Демо Строй Альфа»', nameUz: '«Demo Stroy Alfa» MChJ', inn: '000000101', isClient: true, isSupplier: false, manager: 'sales' },
  { company: 'trade', nameRu: 'ООО «Демо Строй Бета»', nameUz: '«Demo Stroy Beta» MChJ', inn: '000000102', isClient: true, isSupplier: false, manager: 'sales' },
  { company: 'trade', nameRu: 'ООО «Демо Строй Гамма»', nameUz: '«Demo Stroy Gamma» MChJ', inn: '000000103', isClient: true, isSupplier: false, manager: 'sales' },
  { company: 'trade', nameRu: 'ООО «Демо Девелопмент»', nameUz: '«Demo Development» MChJ', inn: '000000104', isClient: true, isSupplier: false, manager: 'sales' },
  { company: 'trade', nameRu: 'ООО «Демо Подряд»', nameUz: '«Demo Podryad» MChJ', inn: '000000105', isClient: true, isSupplier: false, manager: 'sales' },
  { company: 'trade', nameRu: 'ООО «Демо Металл Комбинат»', nameUz: '«Demo Metall Kombinat» MChJ', inn: '000000106', isClient: false, isSupplier: true, manager: null },
  { company: 'trade', nameRu: 'ООО «Демо Металл Импорт»', nameUz: '«Demo Metall Import» MChJ', inn: '000000107', isClient: false, isSupplier: true, manager: null },
  { company: 'plant', nameRu: 'ООО «Демо Теплосети»', nameUz: '«Demo Teplaseti» MChJ', inn: '000000201', isClient: true, isSupplier: false, manager: 'sales' },
  { company: 'plant', nameRu: 'ООО «Демо Иссиклик»', nameUz: '«Demo Issiqlik» MChJ', inn: '000000202', isClient: true, isSupplier: false, manager: 'sales' },
  { company: 'plant', nameRu: 'ООО «Демо Тепло Сервис»', nameUz: '«Demo Teplo Servis» MChJ', inn: '000000203', isClient: true, isSupplier: false, manager: 'sales' },
  { company: 'plant', nameRu: 'ООО «Демо Химпром»', nameUz: '«Demo Himprom» MChJ', inn: '000000204', isClient: true, isSupplier: false, manager: 'sales' },
  { company: 'plant', nameRu: 'ООО «Демо Полимер»', nameUz: '«Demo Polimer» MChJ', inn: '000000205', isClient: false, isSupplier: true, manager: null },
  { company: 'plant', nameRu: 'ООО «Демо Прокат»', nameUz: '«Demo Prokat» MChJ', inn: '000000206', isClient: false, isSupplier: true, manager: null },
] satisfies Omit<PartnerDef, 'legalAddress'>[]).map((p) => ({
  ...p,
  legalAddress: 'Демонстрационные данные, адрес не настоящий',
}));

export const demoProfile: SeedProfile = {
  name: 'demo',
  companies: demoCompanies,
  users: demoUsers,
  logins: {
    admin: 'admin',
    director: 'director',
    // Трёх менеджеров в демо-профиле больше нет: один `sales` на обе
    // компании. Функциональные ключи остались — на них опирается сид, — и все
    // три ведут в одну учётку. Набор ключей обязан совпадать с рабочим
    // профилем, иначе сид в одном расставит ответственных, а в другом
    // промолчит (сторож — `test/seed-profiles.spec.ts`).
    salesTrade1: 'sales',
    salesTrade2: 'sales',
    salesPlant: 'sales',
    master: 'master',
    warehouse: 'warehouse',
    accountant: 'finance',
  },
  partners: demoPartners,
  leadNames: [
    'Демо Заявка Альфа', 'Демо Заявка Бета', 'Демо Заявка Гамма', 'Демо Заявка Дельта',
    'Демо Заявка Эпсилон', 'Демо Заявка Дзета', 'Демо Заявка Эта', 'Демо Заявка Тета',
  ],
  contactName: (i) => `Контактное лицо ${i + 1} (демо)`,
  contactPosition: ['Директор', 'Главный инженер', 'Снабженец', 'Главный бухгалтер'],
  contactEmail: (i) => `contact${i + 1}@demo.invalid`,
  contactPhone: (i) => `+99800${String(2_000_000 + i).padStart(7, '0')}`,
  leadEmail: (i) => `lead${i + 1}@demo.invalid`,
  leadPhone: (i) => `+99800${String(3_000_000 + i).padStart(7, '0')}`,
  // Пароль рождается в прогоне и печатается один раз. Ни в окружении, ни в
  // git его нет: общий известный пароль на внешнем адресе — это открытая дверь.
  password: () => randomBytes(15).toString('base64url'),
};

export const profiles = { dev: devProfile, demo: demoProfile } as const;

/** Профиль прогона. Незнакомое значение — остановка, а не молчаливый `dev`. */
export function selectProfile(): SeedProfile {
  const name = process.env.SEED_PROFILE ?? 'dev';
  if (name !== 'dev' && name !== 'demo') {
    throw new Error(`SEED_PROFILE=«${name}»: допустимы только dev и demo`);
  }
  return profiles[name];
}
