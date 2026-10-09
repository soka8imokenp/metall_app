/** Номенклатура «Металл Азии» - настоящая, из каталога заказчика.
 *
 *  Источник: `prisma/data/catalog-metallasia.json` - выгрузка из базы живого
 *  сайта metallasia.uz, снятая скриптом `tools/export-catalog.php` проекта
 *  `~/clients/metall-asia/sayt-2026/dev`. 303 позиции, 10 терминов каталога.
 *  Правок руками в выгрузке нет: этот файл только раскладывает её по полям
 *  номенклатуры ERP, ничего не досочиняя.
 *
 *  Что в выгрузке есть по каждой позиции: диаметр, толщина стенки, ГОСТ или ТУ,
 *  марка стали, наличие в тоннах, адрес карточки на сайте. Этого хватает на
 *  название, характеристики (`item_attribute`) и начальный остаток.
 *
 *  Чего в каталоге заказчика НЕТ, и это важно знать, глядя на демо-данные:
 *
 *  1. **Цен.** Ни у одной из 303 позиций. Цена и себестоимость ниже считаются
 *     по тарифу за тонну (`PRICE_PER_TONNE`) и остаются единственным
 *     придуманным числом в номенклатуре. Заменяются прайсом заказчика.
 *  2. **Изготовителя.** На карточке сайта в строке «ГОСТ / ТУ» стоит ещё завод
 *     («ГОСТ 8732-78, Баку»), в выгрузке этого поля нет. Из-за этого 7 групп
 *     позиций различаются только остатком - им выдаётся числовой суффикс кода
 *     (`...-2`, `...-3`). Открытый вопрос 24 к заказчику в проекте сайта.
 *  3. **Артикулов.** Своих кодов у позиций нет, код ERP собирается из
 *     типоразмера, стандарта и марки: `TR-114X5-8732-78-09G2S`.
 *  4. **Длины.** Поэтому `lengthMm` у каталожных позиций не заполняется:
 *     мерная длина у трубы договорная, а учёт всё равно тоннами.
 *
 *  Отдельно про данные, которые выглядят подозрительно и не правятся здесь:
 *  у 50 позиций из 303 стенка больше 20% диаметра (57×20, 76×20, 20×6).
 *  Масса метра считается по стенке, то есть это деньги. Вопрос у заказчика,
 *  ответа нет - переносим как есть, но считаем и показываем число
 *  `THICK_WALL_COUNT`, чтобы оно не потерялось. */
import { readFileSync } from 'node:fs';

type RawProduct = {
  id: number;
  title: string;
  slug: string;
  url: string;
  cats: string[];
  diameter: string;
  wall: string;
  gost: string;
  steel: string;
  inventory: string;
  excerpt: string;
};

type RawCategory = {
  id: number;
  name: string;
  slug: string;
  count: number;
  parent: number;
  url: string;
  desc: string;
};

const raw = JSON.parse(
  readFileSync(new URL('./data/catalog-metallasia.json', import.meta.url), 'utf8'),
) as { site: string; categories: RawCategory[]; products: RawProduct[] };

export const CATALOG_SITE = raw.site;
export const CATALOG_PRODUCTS: RawProduct[] = raw.products;
export const CATALOG_CATEGORIES: RawCategory[] = raw.categories;

/** Число из поля выгрузки: там встречается и точка, и запятая. */
const num = (v: unknown): number => Number(String(v ?? '').trim().replace(',', '.'));

/** Как записано в выгрузке, без приведения к единому виду: «17Г1с-у» и «17Г1С»
 *  живут рядом, и это данные заказчика, а не опечатка на нашей стороне. */
const text = (v: unknown): string => String(v ?? '').trim();

/** Масса метра трубы, кг: (D - S) × S × 0,02466. Множитель - плотность стали
 *  7850 кг/м³, свёрнутая со числом π для кольцевого сечения в миллиметрах. */
export function massPerMetre(diameter: unknown, wall: unknown): number | null {
  const D = num(diameter);
  const S = num(wall);
  if (!Number.isFinite(D) || !Number.isFinite(S) || D <= 0 || S <= 0 || S * 2 >= D) return null;
  return (D - S) * S * 0.02466;
}

const TRANSLIT: Record<string, string> = {
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ж: 'ZH', З: 'Z', И: 'I', Й: 'Y',
  К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O', П: 'P', Р: 'R', С: 'S', Т: 'T', У: 'U',
  Ф: 'F', Х: 'H', Ц: 'TS', Ч: 'CH', Ш: 'SH', Щ: 'SCH', Ъ: '', Ы: 'Y', Ь: '',
  Э: 'E', Ю: 'YU', Я: 'YA',
};
const translit = (s: string): string =>
  s.toUpperCase().split('').map((c) => TRANSLIT[c] ?? c).join('');

/** Марка стали в код: «17Г1с-у» → `17G1SU`, «Сталь 10» → `10`, «н/у» → `NU`. */
const gradeToken = (steel: string): string => {
  const s = text(steel);
  if (!s || s === 'н/у') return 'NU';
  return translit(s.replace(/^Сталь\s*/i, '')).replace(/[^A-Z0-9]/g, '');
};

/** Буквы обозначений для узбекского названия, с сохранением регистра. */
const UZ_LETTER: Record<string, string> = {
  А: 'A', а: 'a', Б: 'B', б: 'b', В: 'V', в: 'v', Г: 'G', г: 'g', Д: 'D', д: 'd',
  Е: 'E', е: 'e', Ж: 'J', ж: 'j', З: 'Z', з: 'z', И: 'I', и: 'i', Й: 'Y', й: 'y',
  К: 'K', к: 'k', Л: 'L', л: 'l', М: 'M', м: 'm', Н: 'N', н: 'n', О: 'O', о: 'o',
  П: 'P', п: 'p', Р: 'R', р: 'r', С: 'S', с: 's', Т: 'T', т: 't', У: 'U', у: 'u',
  Ф: 'F', ф: 'f', Х: 'H', х: 'h', Ц: 'Ts', ц: 'ts', Ч: 'Ch', ч: 'ch', Ш: 'Sh',
  ш: 'sh', Щ: 'Sh', щ: 'sh', Ъ: '', ъ: '', Ы: 'Y', ы: 'y', Ь: '', ь: '',
  Э: 'E', э: 'e', Ю: 'Yu', ю: 'yu', Я: 'Ya', я: 'ya', Ё: 'Yo', ё: 'yo',
};

const toLatin = (s: string): string =>
  s.split('').map((c) => UZ_LETTER[c] ?? c).join('');

/**
 * Марка стали в узбекское название: «09Г2С» → `09G2S`, «3сп» → `3sp`,
 * «Сталь 10» → `St 10`, «н/у» → `ko‘rsatilmagan`.
 *
 * Зачем это нужно, хотя обозначение марки по ГОСТ не переводится: узбекское
 * название целиком латиницей, и кириллическая марка внутри делала его
 * смешанным. Проверка `qa/web-uz` считает надпись с кириллицей
 * непереведённой и перестаёт сверять поле вовсе - то есть молча теряет
 * контроль над 186 позициями из 303. Сама характеристика `steelGrade`
 * остаётся как в каталоге: там это данные, а не надпись.
 */
const gradeUz = (steel: string): string => {
  const s = text(steel);
  if (!s || s === 'н/у') return 'ko‘rsatilmagan';
  return toLatin(s.replace(/^Сталь\s*/i, 'St '));
};

/** Стандарт в узбекское название: «ТУ 14-3Р-50-2001» → `TU 14-3R-50-2001`. */
const gostUz = (gost: string): string =>
  toLatin(text(gost).replace(/^ГОСТ/, 'GOST').replace(/^ТУ/, 'TU'));

/** Стандарт в код: «ГОСТ 8732-78» → `8732-78`, «ТУ 14-3Р-50-2001» → `TU14-3R-50-2001`. */
const gostToken = (gost: string): string =>
  translit(text(gost))
    .replace(/^GOST\s*/, '')
    .replace(/^TU\s*/, 'TU')
    .replace(/[^A-Z0-9-]/g, '');

/** Сочетания терминов каталога. В выгрузке их ровно три, и это настоящее
 *  дерево терминов заказчика: «Бесшовная» делится на горячекатанную и
 *  холоднокатанную, «Электросварная» - на прямошовную (остальные ветви у него
 *  пустые). Группы номенклатуры повторяют это дерево один в один. */
const TECH: Record<string, { ru: string; uz: string; typeRu: string; typeUz: string }> = {
  'bezshovnaya+goryachekatannaya': {
    ru: 'Горячекатанная', uz: 'Issiq prokatlangan',
    typeRu: 'бесшовная горячекатанная', typeUz: 'choksiz, issiq prokatlangan',
  },
  'bezshovnaya+xolodnokatannaya': {
    ru: 'Холоднокатанная', uz: 'Sovuq prokatlangan',
    typeRu: 'бесшовная холоднокатанная', typeUz: 'choksiz, sovuq prokatlangan',
  },
  'elektrosvarnaya+pryamoshovnaya': {
    ru: 'Прямошовная', uz: 'To‘g‘ri chokli',
    typeRu: 'электросварная прямошовная', typeUz: 'elektr payvandlangan, to‘g‘ri chokli',
  },
};

/** Корень группы для каждого сочетания - по полю `parent` терминов выгрузки. */
const ROOT: Record<string, { ru: string; uz: string }> = {
  'bezshovnaya+goryachekatannaya': { ru: 'Бесшовная', uz: 'Choksiz' },
  'bezshovnaya+xolodnokatannaya': { ru: 'Бесшовная', uz: 'Choksiz' },
  'elektrosvarnaya+pryamoshovnaya': { ru: 'Электросварная', uz: 'Elektr payvandlangan' },
};

const techKey = (p: RawProduct): string => p.cats.slice().sort().join('+');

/** Группы номенклатуры: сначала два корня, потом три листа. Пустые термины
 *  каталога («Бурильные», «НКТ», «Профильные», «Микрошовная», «Спиралешовная»)
 *  группами не становятся - показывать в них нечего. Появятся позиции -
 *  появятся группы. */
export type CatalogGroup = { ru: string; uz: string; parentRu?: string };

export function catalogGroups(): CatalogGroup[] {
  const keys = [...new Set(CATALOG_PRODUCTS.map(techKey))];
  const roots: CatalogGroup[] = [];
  for (const k of keys) {
    const r = ROOT[k];
    if (!r) throw new Error(`каталог: неизвестное сочетание терминов «${k}»`);
    if (!roots.some((x) => x.ru === r.ru)) roots.push({ ru: r.ru, uz: r.uz });
  }
  const leaves = keys.map((k) => ({ ...TECH[k]!, parentRu: ROOT[k]!.ru }))
    .map(({ ru, uz, parentRu }) => ({ ru, uz, parentRu }));
  return [...roots, ...leaves];
}

/** Тариф за тонну, UZS. Придуман нами: цен в каталоге заказчика нет. Разница
 *  между технологиями взята по порядку величин рынка металлопроката, надбавка
 *  за легированную марку - по ней же. Любое из этих чисел заменяется прайсом
 *  заказчика, и больше в номенклатуре придуманного ничего нет. */
const PRICE_PER_TONNE: Record<string, number> = {
  'bezshovnaya+goryachekatannaya': 10_900_000,
  'bezshovnaya+xolodnokatannaya': 12_400_000,
  'elektrosvarnaya+pryamoshovnaya': 9_600_000,
};

/** Надбавка за марку стали к тарифу за тонну. */
const GRADE_MARKUP: { test: RegExp; k: number }[] = [
  { test: /^10Г2ФБЮ|^К60/i, k: 1.12 },
  { test: /^17Г1/i, k: 1.08 },
  { test: /^09Г2С/i, k: 1.06 },
];

const priceOf = (p: RawProduct): number => {
  const base = PRICE_PER_TONNE[techKey(p)]!;
  const k = GRADE_MARKUP.find((g) => g.test.test(text(p.steel)))?.k ?? 1;
  return Math.round((base * k) / 10_000) * 10_000;
};

export type CatalogItemDef = {
  code: string;
  ru: string;
  uz: string;
  type: 'goods';
  group: string;
  unit: 't';
  price: number;
  cost: number;
  /** Остаток из каталога, тонны. По нему заводится начальный приход. */
  stockT: number;
  /** Ходовая позиция: по ней идут регулярные закупки и продажи периода. */
  rotating?: boolean;
  minQty: number;
  criticalQty: number;
  attrs: Record<string, unknown>;
};

/** Сколько позиций держат обороты периода. Прогонять закупки и сделки по всем
 *  303 позициям значило бы завезти на склад шестьсот тысяч тонн: приход раз
 *  в десять дней на каждую позицию - это 12 × 303 × 2 партии. Обороты идут по
 *  самым запасённым позициям каталога, остальные 291 стоят начальным остатком
 *  ровно в тех тоннах, что показывает сайт. */
const ROTATING = 12;

export function catalogItemDefs(): CatalogItemDef[] {
  const used = new Map<string, number>();
  const rotatingIds = new Set(
    [...CATALOG_PRODUCTS]
      .sort((a, b) => num(b.inventory) - num(a.inventory) || a.id - b.id)
      .slice(0, ROTATING)
      .map((p) => p.id),
  );

  return CATALOG_PRODUCTS.map((p) => {
    const key = techKey(p);
    const tech = TECH[key]!;
    const D = text(p.diameter);
    const S = text(p.wall).replace(',', '.');
    const base = `TR-${D}X${S}-${gostToken(p.gost)}-${gradeToken(p.steel)}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const code = n === 1 ? base : `${base}-${n}`;

    const steel = text(p.steel) || 'н/у';
    const gost = text(p.gost);
    const mass = massPerMetre(p.diameter, p.wall);
    const stockT = num(p.inventory);
    const price = priceOf(p);

    return {
      code,
      ru: `Труба стальная ${D}×${S} мм ${tech.typeRu}, ${steel}, ${gost}`,
      uz: `Po‘lat quvur ${D}×${S} mm, ${tech.typeUz}, ${gradeUz(steel)}, ${gostUz(gost)}`,
      type: 'goods' as const,
      group: tech.ru,
      unit: 't' as const,
      price,
      // Закупка: наценка торгового дома 13% от цены продажи.
      cost: Math.round((price * 0.885) / 10_000) * 10_000,
      stockT,
      rotating: rotatingIds.has(p.id) || undefined,
      // Уровни - от наличия самой позиции, а не одной цифрой на весь каталог.
      // Минимум равен тому, что заказчик публикует на сайте в строке «в
      // наличии»: каталог обещает покупателю именно это количество, значит
      // просадка ниже - повод дозаказать. Критический - половина от него.
      //
      // Одной цифрой на каталог так не выйдет: позиции лежат от 1 до 20 тонн,
      // и «минимум 40 т» держал бы счётчик «ниже минимума» поднятым у всего
      // каталога, а «минимум 1 т» не поднимал бы его никогда.
      minQty: stockT,
      criticalQty: Math.max(1, Math.round(stockT * 0.5)),
      attrs: {
        pipeType: tech.typeRu,
        steelGrade: steel,
        diameterMm: num(p.diameter),
        wallThicknessMm: num(p.wall),
        ...(mass === null ? {} : { weightKgPerUnit: Math.round(mass * 100) / 100 }),
        gost,
        // Откуда позиция и сколько её было на сайте на день выгрузки - чтобы
        // строку в номенклатуре можно было сверить с карточкой заказчика.
        extra: { siteId: p.id, siteUrl: p.url, inventoryT: stockT },
      },
    };
  });
}

/** Опорная позиция каталога: по ней сид заводит складские уровни, а проверки
 *  склада берут «ту позицию, у которой уровень не компанийский, а складской».
 *  Держится здесь, чтобы следующая выгрузка каталога не превратила проверки
 *  в ложь: код изменится в одном месте, а не в шести файлах тестов. */
export const HUB_ITEM = catalogItemDefs().find((d) => d.rotating)!;
export const HUB_ITEM_CODE = HUB_ITEM.code;

/** Позиции, где стенка больше пятой части диаметра. Считается здесь, а не
 *  глазами: число попадает в вывод сида и в сторожа. */
export const THICK_WALL_COUNT = CATALOG_PRODUCTS.filter(
  (p) => num(p.wall) / num(p.diameter) > 0.2,
).length;
