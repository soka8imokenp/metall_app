/**
 * Наполнение стенда METALL ASIA.
 *
 * Данные детерминированы: генератор псевдослучайных чисел с фиксированным
 * зерном. Повторный прогон даёт ту же базу до последней цифры — иначе эталоны
 * pixel-diff и контрольные примеры расчётов пришлось бы пересобирать после
 * каждого сида.
 *
 * Сид ходит ролью metall_owner: ей выдан BYPASSRLS, потому что строки
 * создаются раньше, чем существует компания, чей контекст можно выставить.
 * Рабочая роль metall_app такого права не имеет.
 *
 * Номенклатура торговой компании - настоящий каталог заказчика: 303 позиции
 * с metallasia.uz со всеми характеристиками, раскладка в `catalog-metallasia.ts`.
 * Придуманного в ней осталось одно - цена: в каталоге её нет ни у одной позиции.
 *
 * Названия фирм, ИНН, реквизиты, ФИО, почта и телефоны берутся из профиля
 * (`seed-profiles.ts`, переменная `SEED_PROFILE`): на внешнем стенде эти поля
 * обязаны быть синтетическими, а структура данных от этого не зависит.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  CATALOG_SITE,
  HUB_ITEM_CODE,
  THICK_WALL_COUNT,
  catalogGroups,
  catalogItemDefs,
} from './catalog-metallasia.js';
import { permissionDefs, roleDefs } from './rbac.js';
import { selectProfile } from './seed-profiles.js';

// Сессия в UTC — по той же причине, что и в PrismaService: иначе драйвер
// смещает все записанные даты на пояс сервера базы, и посев уезжает на пять
// часов относительно `now()`.
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  options: '-c timezone=UTC',
});
const prisma = new PrismaClient({ adapter });

const profile = selectProfile();
/** Логины по функциональным ключам: `L.salesTrade1` вместо `'d.karimov'`. */
const L = profile.logins;

// --- детерминированный генератор ------------------------------------------

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(20260924);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const between = (min: number, max: number) => min + rnd() * (max - min);
const intBetween = (min: number, max: number) => Math.floor(between(min, max + 1));

/** Деньги и количества уходят в базу строками: через число их гонять нельзя. */
const money = (n: number) => n.toFixed(4);
const qty = (n: number) => n.toFixed(6);

/**
 * Количества в базе хранятся с шестью знаками. Считать их в памяти с полной
 * точностью double нельзя: сумма округлённых частей не сходится с округлённым
 * целым, и остаток по партии садится на -0.000002 — видимый минус в журнале.
 * Поэтому всё, что попадёт в `qty()`, округляется здесь же, до арифметики.
 */
const qty6 = (n: number) => Math.round(n * 1e6) / 1e6;
const floor6 = (n: number) => Math.floor(n * 1e6 + 1e-3) / 1e6;

// Точка отсчёта фиксированная — иначе данные «едут» при каждом прогоне.
const TODAY = new Date('2026-09-24T00:00:00.000Z');
const DAY = 86_400_000;
const dayOffset = (days: number) => new Date(TODAY.getTime() - days * DAY);
const dateOnly = (d: Date) => new Date(d.toISOString().slice(0, 10));

const PERIOD_DAYS = 120;

async function main() {
  console.log('очистка...');
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      attachment,
      finance_entry, finance_operation, budget, cashflow_item, account,
      shipment_line, shipment, sales_order_line, sales_order,
      stock_reservation, stock_balance, stock_move, serial_number, batch,
      production_order_cost, production_output, production_material,
      production_stage_event, production_stage, production_order,
      deviation_log, tech_card_material, tech_card_stage, tech_card,
      work_center, stock_reason, label_template, item_stock_level,
      storage_location, warehouse_zone, warehouse,
      partner_price, price_list, price_type, partner_contact, partner,
      item_attribute, item_unit, item, item_group,
      document_counter, document_line, document, document_template, document_type,
      crm_activity, crm_task, crm_task_type,
      deal_stage_event, deal, deal_lost_reason, deal_stage, lead, lead_source_rule, site_key, lead_source,
      audit_log, login_log, user_role_assignment, role_permission, permission,
      role, user_account, department, company, currency_rate, currency, unit,
      outbox_event, idempotency_key
    RESTART IDENTITY CASCADE
  `);

  // --- справочники общие ----------------------------------------------------

  // Названия и `autoload` ставим здесь же: у учётной валюты компании своего
  // курса нет, поэтому загрузку с банка ей выключаем (ТЗ 6.2).
  await prisma.currency.createMany({
    data: [
      { code: 'UZS', symbol: 'сўм', precision: 2, nameRu: 'Узбекский сум', nameUz: 'O‘zbek so‘mi', autoload: false },
      { code: 'USD', symbol: '$', precision: 2, nameRu: 'Доллар США', nameUz: 'AQSH dollari', autoload: true },
      { code: 'RUB', symbol: '₽', precision: 2, nameRu: 'Российский рубль', nameUz: 'Rossiya rubli', autoload: true },
    ],
  });
  const currencies = Object.fromEntries(
    (await prisma.currency.findMany()).map((c) => [c.code, c.id]),
  );

  // Курсы на каждый день периода: отчёт за прошлый месяц должен считаться по
  // курсу того дня, а не по сегодняшнему. Источник — `demo`, а не `cbu.uz`:
  // числа здесь придуманы, и выдавать их за официальные нельзя. Настоящие
  // курсы подтянет загрузка с ЦБ РУз (RatesService).
  const rates: { currencyId: bigint; rateDate: Date; rate: string; source: string }[] = [];
  for (let d = PERIOD_DAYS; d >= 0; d--) {
    const day = dateOnly(dayOffset(d));
    rates.push({
      currencyId: currencies.USD,
      rateDate: day,
      rate: (12_380 + between(-90, 140)).toFixed(8),
      source: 'demo',
    });
    rates.push({
      currencyId: currencies.RUB,
      rateDate: day,
      rate: (139 + between(-4, 5)).toFixed(8),
      source: 'demo',
    });
  }
  await prisma.currencyRate.createMany({ data: rates });

  await prisma.unit.createMany({
    data: [
      { code: 't', nameRu: 'т', nameUz: 't', kind: 'weight' },
      { code: 'kg', nameRu: 'кг', nameUz: 'kg', kind: 'weight' },
      { code: 'pm', nameRu: 'п.м.', nameUz: 'p.m.', kind: 'length' },
      { code: 'm', nameRu: 'м', nameUz: 'm', kind: 'length' },
      { code: 'pcs', nameRu: 'шт', nameUz: 'dona', kind: 'piece' },
      { code: 'm3', nameRu: 'м³', nameUz: 'm³', kind: 'volume' },
    ],
  });
  const units = Object.fromEntries((await prisma.unit.findMany()).map((u) => [u.code, u.id]));

  // --- права и роли ---------------------------------------------------------

  await prisma.permission.createMany({
    data: permissionDefs.map(([code, module, descriptionRu, descriptionUz]) => ({
      code,
      module,
      descriptionRu,
      descriptionUz,
    })),
  });
  const permissions = Object.fromEntries(
    (await prisma.permission.findMany()).map((p) => [p.code, p.id]),
  );

  await prisma.role.createMany({
    data: roleDefs.map((r) => ({ code: r.code, nameRu: r.ru, nameUz: r.uz, isSystem: true })),
  });
  const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.code, r.id]));
  await prisma.rolePermission.createMany({
    data: roleDefs.flatMap((r) =>
      r.perms.map((code) => ({ roleId: roles[r.code], permissionId: permissions[code] })),
    ),
  });

  // --- компании -------------------------------------------------------------

  await prisma.company.createMany({
    data: profile.companies.map((c) => ({
      code: c.code,
      nameRu: c.nameRu,
      nameUz: c.nameUz,
      inn: c.inn,
      legalAddress: c.legalAddress,
      baseCurrency: 'UZS',
      bankDetails: c.bankDetails,
    })),
  });
  const companies = Object.fromEntries(
    (await prisma.company.findMany()).map((c) => [c.code, c.id]),
  );
  const TRADE = companies.trade;
  const PLANT = companies.plant;

  const departmentDefs = [
    { companyId: TRADE, nameRu: 'Отдел продаж', nameUz: 'Savdo bo‘limi' },
    { companyId: TRADE, nameRu: 'Складская логистика', nameUz: 'Ombor logistikasi' },
    { companyId: TRADE, nameRu: 'Бухгалтерия', nameUz: 'Buxgalteriya' },
    { companyId: PLANT, nameRu: 'Цех сварных труб', nameUz: 'Payvandlangan quvurlar sexi' },
    { companyId: PLANT, nameRu: 'Цех изоляции ППУ', nameUz: 'PPU izolyatsiya sexi' },
    { companyId: PLANT, nameRu: 'Отдел снабжения', nameUz: 'Ta’minot bo‘limi' },
  ];
  await prisma.department.createMany({ data: departmentDefs });
  const departments = await prisma.department.findMany();

  // --- пользователи ---------------------------------------------------------
  // Пароль даёт профиль: в рабочем — общий из окружения, в демонстрационном —
  // случайный на прогон. В файле и в git его нет ни в одном из случаев.
  const bcrypt = await import('bcryptjs');
  const password = profile.password();
  const passwordHash = await bcrypt.hash(password, 10);
  // Учётка со своим паролем получает свой хеш: общий пароль профиля случайный,
  // а эти логины называют людям голосом.
  const hashByLogin = Object.fromEntries(
    await Promise.all(
      profile.users
        .filter((u) => u.password)
        .map(async (u) => [u.login, await bcrypt.hash(u.password!, 10)] as const),
    ),
  );

  const companyIdByCode = { trade: TRADE, plant: PLANT };
  await prisma.userAccount.createMany({
    data: profile.users.map((u) => ({
      login: u.login,
      fullName: u.fullName,
      email: u.email,
      phone: u.phone,
      passwordHash: hashByLogin[u.login] ?? passwordHash,
      locale: 'ru' as const,
      // Дефолтный пароль — временный: первым экраном человек меняет его сам.
      // Рабочий профиль признак не поднимает: там пароль один, из окружения, и
      // наружу стенд не смотрит.
      mustChangePassword: u.mustChangePassword ?? false,
    })),
  });
  const users = Object.fromEntries(
    (await prisma.userAccount.findMany()).map((u) => [u.login, u.id]),
  );
  await prisma.userRoleAssignment.createMany({
    data: profile.users.flatMap((u) =>
      u.companies.map((code) => ({
        userId: users[u.login],
        roleId: roles[u.role],
        companyId: companyIdByCode[code],
        scope: 'all' as const,
      })),
    ),
  });

  // --- номенклатура ---------------------------------------------------------

  const groupDefs = [
    { companyId: PLANT, nameRu: 'Трубы прямошовные', nameUz: 'To‘g‘ri chokli quvurlar' },
    { companyId: PLANT, nameRu: 'Трубы ППУ-ПЭ', nameUz: 'PPU-PE quvurlar' },
    { companyId: PLANT, nameRu: 'Сырьё и материалы', nameUz: 'Xomashyo va materiallar' },
  ];
  await prisma.itemGroup.createMany({ data: groupDefs });

  // Группы торговой компании - дерево терминов каталога заказчика, как оно
  // лежит у него в базе сайта: «Бесшовная» с горячекатанной и холоднокатанной
  // внутри, «Электросварная» с прямошовной. Своих названий мы здесь не
  // придумываем, поэтому два прохода: корни, потом листья с parentId.
  const catalogGroupDefs = catalogGroups();
  await prisma.itemGroup.createMany({
    data: catalogGroupDefs
      .filter((g) => !g.parentRu)
      .map((g) => ({ companyId: TRADE, nameRu: g.ru, nameUz: g.uz })),
  });
  const roots = Object.fromEntries(
    (await prisma.itemGroup.findMany({ where: { companyId: TRADE } })).map((g) => [g.nameRu, g.id]),
  );
  await prisma.itemGroup.createMany({
    data: catalogGroupDefs
      .filter((g) => g.parentRu)
      .map((g) => ({
        companyId: TRADE,
        nameRu: g.ru,
        nameUz: g.uz,
        parentId: roots[g.parentRu!],
      })),
  });

  const groups = Object.fromEntries(
    (await prisma.itemGroup.findMany()).map((g) => [`${g.companyId}:${g.nameRu}`, g.id]),
  );

  type ItemDef = {
    company: bigint;
    code: string;
    ru: string;
    uz: string;
    type: 'finished' | 'goods' | 'raw' | 'component';
    group: string;
    unit: string;
    price: number; // цена продажи в UZS за базовую единицу
    cost: number; // себестоимость / закупка
    /** Штучный учёт по серийным номерам вместо партий. */
    serial?: boolean;
    /** Остаток из каталога заказчика, тонны: начальный приход по позиции. */
    stockT?: number;
    /** Ходовая позиция: по ней идут закупки и продажи периода. */
    rotating?: boolean;
    /** Уровни запаса, если считаются от остатка позиции, а не по виду. */
    minQty?: number;
    criticalQty?: number;
    attrs?: Record<string, unknown>;
  };

  const itemDefs: ItemDef[] = [
    // Завод: готовая продукция
    {
      company: PLANT, code: 'TESA-219X6', type: 'finished', group: 'Трубы прямошовные', unit: 't',
      ru: 'Труба электросварная прямошовная 219х6 мм ГОСТ 10704-91',
      uz: 'Elektr payvandlangan to‘g‘ri chokli quvur 219x6 mm GOST 10704-91',
      price: 9_850_000, cost: 8_240_000,
      attrs: { pipeType: 'электросварная прямошовная', steelGrade: 'Ст3сп', diameterMm: 219, wallThicknessMm: 6, lengthMm: 12000, weightKgPerUnit: 31.52, gost: 'ГОСТ 10704-91' },
    },
    {
      company: PLANT, code: 'TESA-159X4.5', type: 'finished', group: 'Трубы прямошовные', unit: 't',
      ru: 'Труба электросварная прямошовная 159х4.5 мм ГОСТ 10704-91',
      uz: 'Elektr payvandlangan to‘g‘ri chokli quvur 159x4.5 mm GOST 10704-91',
      price: 9_640_000, cost: 8_110_000,
      attrs: { pipeType: 'электросварная прямошовная', steelGrade: 'Ст3сп', diameterMm: 159, wallThicknessMm: 4.5, lengthMm: 12000, weightKgPerUnit: 17.15, gost: 'ГОСТ 10704-91' },
    },
    {
      company: PLANT, code: 'TESA-108X4', type: 'finished', group: 'Трубы прямошовные', unit: 't',
      ru: 'Труба электросварная 108х4 мм ГОСТ 10705-80, Ст20',
      uz: 'Elektr payvandlangan quvur 108x4 mm GOST 10705-80, St20',
      price: 10_120_000, cost: 8_490_000,
      attrs: { pipeType: 'электросварная', steelGrade: 'Ст20', diameterMm: 108, wallThicknessMm: 4, lengthMm: 11700, weightKgPerUnit: 10.26, gost: 'ГОСТ 10705-80' },
    },
    {
      company: PLANT, code: 'TESA-57X3.5', type: 'finished', group: 'Трубы прямошовные', unit: 't',
      ru: 'Труба электросварная 57х3.5 мм ГОСТ 10704-91, Ст3сп',
      uz: 'Elektr payvandlangan quvur 57x3.5 mm GOST 10704-91, St3sp',
      price: 10_380_000, cost: 8_760_000,
      attrs: { pipeType: 'электросварная', steelGrade: 'Ст3сп', diameterMm: 57, wallThicknessMm: 3.5, lengthMm: 11700, weightKgPerUnit: 4.62, gost: 'ГОСТ 10704-91' },
    },
    {
      company: PLANT, code: 'PPU-159-250', type: 'finished', group: 'Трубы ППУ-ПЭ', unit: 'pm',
      ru: 'Труба предизолированная ППУ-ПЭ 159/250 мм ГОСТ 30732-2020',
      uz: 'Oldindan izolyatsiyalangan PPU-PE quvur 159/250 mm GOST 30732-2020',
      price: 2_460_000, cost: 1_980_000,
      attrs: { pipeType: 'предизолированная ППУ-ПЭ', steelGrade: 'Ст20', diameterMm: 159, insulationType: 'ППУ-ПЭ', gost: 'ГОСТ 30732-2020', extra: { sodk: true } },
    },
    {
      company: PLANT, code: 'PPU-219-315', type: 'finished', group: 'Трубы ППУ-ПЭ', unit: 'pm',
      ru: 'Труба предизолированная ППУ-ПЭ 219/315 мм ГОСТ 30732-2020',
      uz: 'Oldindan izolyatsiyalangan PPU-PE quvur 219/315 mm GOST 30732-2020',
      price: 3_320_000, cost: 2_690_000,
      attrs: { pipeType: 'предизолированная ППУ-ПЭ', steelGrade: 'Ст20', diameterMm: 219, insulationType: 'ППУ-ПЭ', gost: 'ГОСТ 30732-2020', extra: { sodk: true } },
    },
    {
      // Единственная позиция штучного учёта: труба большого диаметра под
      // конкретный участок теплотрассы. Такую принимают и отгружают по номеру
      // трубы, а не тоннами, и сертификат спрашивают на номер.
      company: PLANT, code: 'PPU-530-710', type: 'finished', group: 'Трубы ППУ-ПЭ', unit: 'pcs',
      ru: 'Труба предизолированная ППУ-ПЭ 530/710 мм ГОСТ 30732-2020, штучный учёт',
      uz: 'Oldindan izolyatsiyalangan PPU-PE quvur 530/710 mm GOST 30732-2020, donalab',
      price: 41_600_000, cost: 33_900_000, serial: true,
      attrs: { pipeType: 'предизолированная ППУ-ПЭ', steelGrade: 'Ст20', diameterMm: 530, insulationType: 'ППУ-ПЭ', lengthMm: 12000, gost: 'ГОСТ 30732-2020', extra: { sodk: true } },
    },
    {
      company: PLANT, code: 'PPU-108-200', type: 'finished', group: 'Трубы ППУ-ПЭ', unit: 'pm',
      ru: 'Труба предизолированная ППУ-ПЭ 108/200 мм ГОСТ 30732-2020',
      uz: 'Oldindan izolyatsiyalangan PPU-PE quvur 108/200 mm GOST 30732-2020',
      price: 1_880_000, cost: 1_510_000,
      attrs: { pipeType: 'предизолированная ППУ-ПЭ', steelGrade: 'Ст20', diameterMm: 108, insulationType: 'ППУ-ПЭ', gost: 'ГОСТ 30732-2020' },
    },
    // Завод: сырьё
    {
      company: PLANT, code: 'SHTRIPS-1.5', type: 'raw', group: 'Сырьё и материалы', unit: 't',
      ru: 'Штрипс горячекатаный 1.5х219 мм Ст3сп, рулон',
      uz: 'Issiq prokatlangan shtrips 1.5x219 mm St3sp, rulon',
      price: 0, cost: 7_420_000,
      attrs: { steelGrade: 'Ст3сп', wallThicknessMm: 1.5, gost: 'ГОСТ 19903-2015' },
    },
    {
      company: PLANT, code: 'PE-100', type: 'raw', group: 'Сырьё и материалы', unit: 't',
      ru: 'Полиэтилен ПЭ-100 гранулированный, чёрный',
      uz: 'Polietilen PE-100 granulali, qora', price: 0, cost: 18_900_000,
    },
    {
      company: PLANT, code: 'PPU-POLIOL', type: 'raw', group: 'Сырьё и материалы', unit: 't',
      ru: 'Компонент ППУ полиол', uz: 'PPU komponenti poliol', price: 0, cost: 34_500_000,
    },
    {
      company: PLANT, code: 'PPU-IZO', type: 'raw', group: 'Сырьё и материалы', unit: 't',
      ru: 'Компонент ППУ изоцианат', uz: 'PPU komponenti izotsianat', price: 0, cost: 41_200_000,
    },
    {
      company: PLANT, code: 'SODK-WIRE', type: 'component', group: 'Сырьё и материалы', unit: 'm',
      ru: 'Провод системы оперативного дистанционного контроля (СОДК)',
      uz: 'Masofaviy nazorat tizimi simi (SODK)', price: 0, cost: 9_800,
    },
    // Торговая компания: каталог заказчика целиком, 303 позиции с
    // metallasia.uz. Руками здесь ничего не перечислено сознательно - список
    // должен меняться вместе с выгрузкой, а не вместе с нашей памятью.
    // Придуманной арматуры, балки, швеллера, уголка и листа в каталоге нет:
    // заказчик торгует трубой.
    ...catalogItemDefs().map((d) => ({ ...d, company: TRADE })),
  ];

  await prisma.item.createMany({
    data: itemDefs.map((d) => ({
      companyId: d.company,
      code: d.code,
      nameRu: d.ru,
      nameUz: d.uz,
      itemType: d.type,
      groupId: groups[`${d.company}:${d.group}`],
      baseUnitId: units[d.unit],
      vatRate: '12.0000',
      // Партия и номер — разные ответы на один вопрос «какая именно труба».
      // Держать оба у одной позиции значит спрашивать его дважды.
      trackBatches: !d.serial,
      trackSerials: !!d.serial,
      isWeighted: d.unit === 't',
      // Уровни у штучной позиции — в штуках. Общие сорок тонн на трубах,
      // которых на складе восемь штук, держали бы их вечно ниже критического
      // и врали бы в счётчике «ниже критического уровня» на дашборде.
      // У каталожных позиций уровень свой, от настоящего остатка (`stockT`):
      // одна цифра на 303 позиции врала бы в обе стороны сразу.
      minQty: qty(d.minQty ?? (d.serial ? 4 : d.type === 'raw' ? 150 : 40)),
      criticalQty: qty(d.criticalQty ?? (d.serial ? 2 : d.type === 'raw' ? 60 : 15)),
      barcode: `200${String(itemDefs.indexOf(d) + 1).padStart(6, '0')}`,
    })),
  });
  const itemRows = await prisma.item.findMany();
  const items = Object.fromEntries(itemRows.map((i) => [i.code, i]));

  await prisma.itemAttribute.createMany({
    data: itemDefs
      .filter((d) => d.attrs)
      .map((d) => ({ itemId: items[d.code].id, ...(d.attrs as object) })),
  });

  // Ходовые позиции каталога - те, на которых у заказчика самый большой
  // остаток. Обороты периода (закупки, заказы, отгрузки) идут по ним, иначе
  // приход раз в десять дней по каждой из 303 позиций завёз бы на склад
  // шестьсот тысяч тонн. Первая из них - опорная для уровней на склад ниже.
  const tradeRotating = itemDefs.filter((d) => d.company === TRADE && d.rotating);
  const HUB = tradeRotating.find((d) => d.code === HUB_ITEM_CODE)!;
  console.log(
    `номенклатура: ${itemDefs.length} позиций, из них каталог ${CATALOG_SITE} -` +
      ` ${itemDefs.filter((d) => d.company === TRADE).length}` +
      ` (ходовых ${tradeRotating.length}, со стенкой больше 20% диаметра ${THICK_WALL_COUNT})`,
  );

  // --- склады ---------------------------------------------------------------

  const warehouseDefs = [
    { companyId: TRADE, code: 'ERKIN', ru: 'Логистический хаб «Эркин»', uz: '«Erkin» logistika markazi', address: 'Зангиатинский р-н, промзона «Эркин»' },
    { companyId: TRADE, code: 'SERGELI', ru: 'Склад «Сергели»', uz: '«Sergeli» ombori', address: 'г. Ташкент, Сергелийский р-н' },
    { companyId: PLANT, code: 'ZAVOD-GP', ru: 'Склад готовой продукции завода', uz: 'Zavod tayyor mahsulot ombori', address: 'Зангиатинский р-н, промзона «Эркин»' },
    { companyId: PLANT, code: 'ZAVOD-SYR', ru: 'Склад сырья завода', uz: 'Zavod xomashyo ombori', address: 'Зангиатинский р-н, промзона «Эркин»' },
  ];
  await prisma.warehouse.createMany({
    data: warehouseDefs.map((w) => ({
      companyId: w.companyId, code: w.code, nameRu: w.ru, nameUz: w.uz, address: w.address,
    })),
  });
  const warehouses = Object.fromEntries(
    (await prisma.warehouse.findMany()).map((w) => [w.code, w]),
  );

  await prisma.warehouseZone.createMany({
    data: warehouseDefs.flatMap((w) => [
      { warehouseId: warehouses[w.code].id, code: 'A', nameRu: 'Зона А — открытая площадка', nameUz: 'A zonasi — ochiq maydon' },
      { warehouseId: warehouses[w.code].id, code: 'B', nameRu: 'Зона Б — крытый склад', nameUz: 'B zonasi — yopiq ombor' },
    ]),
  });
  const zones = await prisma.warehouseZone.findMany();
  await prisma.storageLocation.createMany({
    data: zones.flatMap((z) =>
      [1, 2, 3].map((n) => ({
        zoneId: z.id,
        code: `${z.code}-${String(n).padStart(2, '0')}`,
        barcode: `LOC${String(z.id).padStart(4, '0')}${n}`,
      })),
    ),
  });
  const locations = await prisma.storageLocation.findMany();
  const locationByWarehouse = new Map<bigint, bigint[]>();
  for (const loc of locations) {
    const zone = zones.find((z) => z.id === loc.zoneId)!;
    const list = locationByWarehouse.get(zone.warehouseId) ?? [];
    list.push(loc.id);
    locationByWarehouse.set(zone.warehouseId, list);
  }

  // Уровни на склад (ТЗ 5.10). Компанийский уровень у позиции уже есть, эти
  // строки его перекрывают: логистический хаб держит запас под оба склада, а
  // городской — только под текущие заявки, и одна цифра «на компанию» не
  // годится ни там, ни там.
  //
  // Перекрытие действует по позиции целиком: заведя уровень на ERKIN и SERGELI,
  // компанийский уровень этой трубы мы выключили — потребность считается по этим
  // двум складам, а не по ним и ещё раз по компании.
  await prisma.itemStockLevel.createMany({
    data: [
      // Числа - от оборота опорной позиции за период, а не круглые на глаз:
      // за 120 дней по ней проходит около девятисот тонн на каждом складе,
      // и уровень ниже этого никогда не загорелся бы. Смысл этих двух строк
      // в том, чтобы потребность считалась по складам, а не по компании, —
      // значит уровень должен быть достижимым, иначе перекрытие не видно.
      {
        companyId: TRADE, itemId: items[HUB.code].id, warehouseId: warehouses['ERKIN'].id,
        minQty: qty(1200), criticalQty: qty(600),
        comment: 'Хаб держит запас под отгрузки обоих складов',
      },
      {
        companyId: TRADE, itemId: items[HUB.code].id, warehouseId: warehouses['SERGELI'].id,
        minQty: qty(1000), criticalQty: qty(500),
        comment: 'Городской склад — под текущие заявки',
      },
      {
        // Сырьё лежит только на складе сырья, и уровень на складе готовой
        // продукции по нему бессмыслен: приход туда не привезут.
        companyId: PLANT, itemId: items['PPU-POLIOL'].id, warehouseId: warehouses['ZAVOD-SYR'].id,
        minQty: qty(180), criticalQty: qty(80),
        comment: 'Расход линии заливки ППУ на две недели',
      },
    ],
  });

  console.log(
    `уровни на склад: ${await prisma.itemStockLevel.count()}` +
      ` (перекрывают компанийский у ${HUB.code} и PPU-POLIOL)`,
  );

  // Шаблоны этикеток (ТЗ 5.9). У завода рулонный принтер, у торговой конторы
  // лист с наклейками — поэтому «по умолчанию» у них разное. Мелкая этикетка
  // 38×21 идёт с QR: Code 128 на тринадцать знаков даёт 134 модуля, и на
  // ширине 38 мм полоса выходит тоньше 0,2 мм — ручной сканер такую берёт
  // через раз.
  await prisma.labelTemplate.createMany({
    data: [
      {
        companyId: TRADE, code: 'A4-24', nameRu: 'Лист A4, 24 этикетки 70×37',
        nameUz: 'A4 varaq, 24 ta yorliq 70×37',
        pageWidthMm: 210, pageHeightMm: 297, labelWidthMm: 70, labelHeightMm: 37,
        columns: 3, rows: 8, symbology: 'code128', isDefault: true,
      },
      {
        companyId: TRADE, code: 'A4-65', nameRu: 'Лист A4, 65 этикеток 38×21',
        nameUz: 'A4 varaq, 65 ta yorliq 38×21',
        pageWidthMm: 210, pageHeightMm: 297, labelWidthMm: 38, labelHeightMm: 21,
        columns: 5, rows: 13, marginTopMm: 10, marginLeftMm: 5, gapXMm: 2.5,
        symbology: 'qr',
      },
      {
        companyId: PLANT, code: 'ROLL-58', nameRu: 'Рулон 58×40, одна этикетка',
        nameUz: 'Rulon 58×40, bitta yorliq',
        pageWidthMm: 58, pageHeightMm: 40, labelWidthMm: 58, labelHeightMm: 40,
        columns: 1, rows: 1, symbology: 'code128', isDefault: true,
      },
      {
        companyId: PLANT, code: 'A4-24', nameRu: 'Лист A4, 24 этикетки 70×37',
        nameUz: 'A4 varaq, 24 ta yorliq 70×37',
        pageWidthMm: 210, pageHeightMm: 297, labelWidthMm: 70, labelHeightMm: 37,
        columns: 3, rows: 8, symbology: 'code128',
      },
    ],
  });

  console.log(
    `шаблоны этикеток: ${await prisma.labelTemplate.count()}` +
      ` (по умолчанию у торговой A4-24, у завода рулон 58×40)`,
  );

  await prisma.stockReason.createMany({
    data: [TRADE, PLANT].flatMap((companyId) => [
      { companyId, kind: 'write_off' as const, nameRu: 'Брак при транспортировке', nameUz: 'Tashishda nuqson' },
      { companyId, kind: 'write_off' as const, nameRu: 'Порча при хранении', nameUz: 'Saqlashda buzilish' },
      { companyId, kind: 'inventory' as const, nameRu: 'Излишки по инвентаризации', nameUz: 'Inventarizatsiya ortiqchasi' },
      { companyId, kind: 'defect' as const, nameRu: 'Несоответствие геометрии', nameUz: 'Geometriya nomuvofiqligi' },
      // отход цеха: те же строки заводит миграция 20261004190100 — база со
      // стенда не пересеивается, а чистый dev получает их отсюда
      { companyId, kind: 'waste' as const, nameRu: 'Технологическая обрезь', nameUz: 'Texnologik qirqim' },
      { companyId, kind: 'waste' as const, nameRu: 'Стружка и окалина', nameUz: 'Qirindi va kuyundi' },
      { companyId, kind: 'downtime' as const, nameRu: 'Плановое техобслуживание', nameUz: 'Rejali texnik xizmat' },
      { companyId, kind: 'downtime' as const, nameRu: 'Отсутствие сырья', nameUz: 'Xomashyo yo‘qligi' },
    ]),
  });

  // --- контрагенты ----------------------------------------------------------

  await prisma.leadSource.createMany({
    data: [TRADE, PLANT].flatMap((companyId) => [
      { companyId, code: 'site', nameRu: 'Сайт', nameUz: 'Sayt', channel: 'site' as const },
      { companyId, code: 'call', nameRu: 'Входящий звонок', nameUz: 'Kiruvchi qo‘ng‘iroq', channel: 'call' as const },
      { companyId, code: 'ads', nameRu: 'Реклама', nameUz: 'Reklama', channel: 'ads' as const },
      { companyId, code: 'manual', nameRu: 'Занесён вручную', nameUz: 'Qo‘lda kiritilgan', channel: 'manual' as const },
      { companyId, code: 'telegram', nameRu: 'Telegram-бот', nameUz: 'Telegram-bot', channel: 'telegram' as const },
      // Метки с сайта раскладываются по этим трём: без них «Сайт» один на всё,
      // и поиск не отличить от контекста — ровно то, за что платят SEO.
      { companyId, code: 'seo', nameRu: 'Поиск (SEO)', nameUz: 'Qidiruv (SEO)', channel: 'site' as const },
      { companyId, code: 'direct', nameRu: 'Прямой заход', nameUz: 'To‘g‘ridan-to‘g‘ri', channel: 'site' as const },
      { companyId, code: 'referral', nameRu: 'Переход по ссылке', nameUz: 'Havola orqali o‘tish', channel: 'site' as const },
    ]),
  });
  const leadSources = await prisma.leadSource.findMany();

  // Правила разбора меток. Порядок решает: первое подходящее побеждает, а
  // правило со всеми пустыми условиями — запасное и стоит последним.
  const ruleDefs: [number, string, string | null, string | null, boolean | null, boolean | null, boolean | null, string][] = [
    [10, 'Поиск: organic', 'organic', null, null, null, null, 'seo'],
    [20, 'Клик из рекламной системы', null, null, true, null, null, 'ads'],
    [30, 'Контекст: cpc', 'cpc', null, null, null, null, 'ads'],
    [40, 'Telegram', null, 'telegram', null, null, null, 'telegram'],
    [50, 'Переход: referral', 'referral', null, null, null, null, 'referral'],
    [60, 'Без меток, без перехода', null, null, null, false, false, 'direct'],
    [70, 'Без меток, но с переходом', null, null, null, false, true, 'referral'],
    [100, 'Запасное: сайт', null, null, null, null, null, 'site'],
  ];
  await prisma.leadSourceRule.createMany({
    data: [TRADE, PLANT].flatMap((companyId) =>
      ruleDefs.map(([priority, name, medium, source, hasClick, marks, referrer, code]) => ({
        companyId,
        priority,
        name,
        matchMedium: medium,
        matchSource: source,
        matchHasClick: hasClick,
        matchHasMarks: marks,
        matchHasReferrer: referrer,
        sourceId: leadSources.find((x) => x.companyId === companyId && x.code === code)!.id,
      })),
    ),
  });

  // Ключ сайта для демо-стенда. Секрета в нём нет по устройству: он уходит в
  // открытый код страницы, и компанию определяет только он.
  await prisma.siteKey.createMany({
    data: [
      { companyId: TRADE, code: 'demo-site-trade', name: 'Сайт торгового дома (демо)' },
      { companyId: PLANT, code: 'demo-site-plant', name: 'Сайт завода (демо)' },
    ],
  });

  await prisma.priceType.createMany({
    data: [TRADE, PLANT].flatMap((companyId) => [
      { companyId, code: 'wholesale', nameRu: 'Оптовая', nameUz: 'Ulgurji', kind: 'wholesale' as const },
      { companyId, code: 'contract', nameRu: 'Договорная', nameUz: 'Shartnomaviy', kind: 'contract' as const },
      { companyId, code: 'retail', nameRu: 'Розничная', nameUz: 'Chakana', kind: 'retail' as const },
    ]),
  });
  const priceTypes = Object.fromEntries(
    (await prisma.priceType.findMany()).map((p) => [`${p.companyId}:${p.code}`, p.id]),
  );

  await prisma.priceList.createMany({
    data: itemDefs
      .filter((d) => d.price > 0)
      .flatMap((d) => [
        { companyId: d.company, priceTypeId: priceTypes[`${d.company}:wholesale`], itemId: items[d.code].id, price: money(d.price), currencyId: currencies.UZS, validFrom: dateOnly(dayOffset(PERIOD_DAYS)) },
        { companyId: d.company, priceTypeId: priceTypes[`${d.company}:contract`], itemId: items[d.code].id, price: money(d.price * 0.96), currencyId: currencies.UZS, validFrom: dateOnly(dayOffset(PERIOD_DAYS)) },
        { companyId: d.company, priceTypeId: priceTypes[`${d.company}:retail`], itemId: items[d.code].id, price: money(d.price * 1.07), currencyId: currencies.UZS, validFrom: dateOnly(dayOffset(PERIOD_DAYS)) },
      ]),
  });

  await prisma.partner.createMany({
    data: profile.partners.map((p) => {
      const companyId = companyIdByCode[p.company];
      return {
        companyId,
        nameRu: p.nameRu,
        nameUz: p.nameUz,
        inn: p.inn,
        isClient: p.isClient,
        isSupplier: p.isSupplier,
        managerId: p.manager ? users[p.manager] : null,
        priceTypeId: priceTypes[`${companyId}:${p.isClient ? 'wholesale' : 'contract'}`],
        paymentDelayDays: p.isClient ? pick([0, 14, 21, 30]) : 0,
        debtLimit: money(p.isClient ? intBetween(2, 9) * 1_000_000_000 : 0),
        legalAddress: p.legalAddress,
      };
    }),
  });
  const partnerRows = await prisma.partner.findMany();

  // Индивидуальные цены (ТЗ 9.2) — у двух клиентов на каждую компанию. Дата
  // начала сегодняшняя: прошлые заказы выписаны по прайсу, и задним числом их
  // «договорной ценой» объяснять нечем.
  const contractPriceClients = partnerRows.filter((p) => p.isClient).slice(0, 4);
  await prisma.partnerPrice.createMany({
    data: contractPriceClients.flatMap((client) => {
      const defs = itemDefs.filter((d) => d.company === client.companyId && d.price > 0).slice(0, 3);
      return defs.map((d) => ({
        companyId: client.companyId,
        partnerId: client.id,
        itemId: items[d.code].id,
        price: money(d.price * between(0.9, 0.97)),
        currencyId: currencies.UZS,
        validFrom: dateOnly(dayOffset(0)),
      }));
    }),
  });
  const clientsByCompany = new Map<string, typeof partnerRows>();
  for (const p of partnerRows) {
    if (!p.isClient) continue;
    const key = String(p.companyId);
    clientsByCompany.set(key, [...(clientsByCompany.get(key) ?? []), p]);
  }
  const suppliers = partnerRows.filter((p) => p.isSupplier);

  await prisma.partnerContact.createMany({
    data: partnerRows.map((p, i) => ({
      partnerId: p.id,
      fullName: profile.contactName(i),
      position: pick(profile.contactPosition),
      phone: profile.contactPhone(i),
      email: profile.contactEmail(i),
      isPrimary: true,
    })),
  });

  console.log('справочники готовы');

  // --- движение товара и продажи -------------------------------------------
  // Остаток здесь не отдельное число, а то, что осталось в партиях. Партия —
  // единица хранения: у неё своя дата прихода, своя себестоимость и свой
  // сертификат, и списать с неё больше, чем в неё пришло, нельзя даже на день.
  // Поэтому расход идёт FIFO по партиям, доступным на дату расхода, а строка
  // `stock_balance` в конце собирается свёрткой журнала — см. `foldBalances`.

  type Lot = {
    batchId: bigint;
    /** Сколько дней назад партия пришла: чем больше, тем партия старше. */
    day: number;
    onHand: number;
    reserved: number;
    unitCost: number;
  };
  const lots = new Map<string, Lot[]>(); // `${warehouseId}:${itemId}`, старые первыми

  const lotsAt = (warehouseId: bigint, itemId: bigint, day: number) =>
    (lots.get(`${warehouseId}:${itemId}`) ?? []).filter((l) => l.day >= day);

  /**
   * Снять `want` со склада по FIFO. Возвращает столько, сколько нашлось:
   * выдумывать недостающее — тот самый минус, который ловит проверка.
   * `reserve` не трогает остаток, а помечает его под неотгруженный заказ.
   */
  function takeFifo(
    warehouseId: bigint,
    itemId: bigint,
    day: number,
    want: number,
    mode: 'issue' | 'reserve',
  ): { batchId: bigint; qty: number; cost: number }[] {
    const parts: { batchId: bigint; qty: number; cost: number }[] = [];
    let left = want;
    for (const lot of lotsAt(warehouseId, itemId, day)) {
      if (left <= 1e-6) break;
      const free = lot.onHand - lot.reserved;
      if (free <= 1e-6) continue;
      const take = floor6(Math.min(free, left));
      if (take <= 0) continue;
      if (mode === 'issue') lot.onHand = qty6(lot.onHand - take);
      else lot.reserved = qty6(lot.reserved + take);
      parts.push({ batchId: lot.batchId, qty: take, cost: take * lot.unitCost });
      left = qty6(left - take);
    }
    return parts;
  }

  const freeAt = (warehouseId: bigint, itemId: bigint, day: number) =>
    lotsAt(warehouseId, itemId, day).reduce((s, l) => s + Math.max(0, l.onHand - l.reserved), 0);

  const moves: any[] = [];
  // Слова отмены берём по кругу: заказ должен объяснять, почему его сняли.
  const CANCEL_REASONS = [
    'Клиент отказался: перенёс стройку на следующий сезон.',
    'Отменён по просьбе клиента: не согласовали оплату.',
    'Отменили сами: не успевали к сроку, клиент не стал ждать.',
  ];
  const orderPayloads: any[] = [];
  const linePayloads: {
    orderNumber: string;
    companyId: bigint;
    line: any;
    /** Заказ не отгружен: взятые FIFO партии не уехали, а обещаны покупателю. */
    reserve: boolean;
    manager: bigint;
  }[] = [];
  const shipmentPayloads: any[] = [];
  const shipmentLinePayloads: { shipmentNumber: string; companyId: bigint; line: any }[] = [];

  // Штучная позиция в общую генерацию не идёт: тут всё меряется тоннами и
  // партиями, а у неё ни того, ни другого. Её приход, выдача и остаток
  // заводятся отдельным блоком по номерам — ниже, у серийного учёта.
  //
  // У торговой компании в оборот идут только ходовые позиции каталога.
  // Остальные 291 стоят начальным остатком ровно в тех тоннах, что показывает
  // сайт заказчика: это его склад на день выгрузки, а не наша генерация.
  const salesItems = {
    [String(TRADE)]: tradeRotating,
    [String(PLANT)]: itemDefs.filter((d) => d.company === PLANT && d.price > 0 && !d.serial),
  };
  const openingOnly = itemDefs.filter(
    (d) => d.company === TRADE && d.stockT !== undefined && !d.rotating,
  );
  const stockWarehouse = {
    [String(TRADE)]: [warehouses.ERKIN, warehouses.SERGELI],
    [String(PLANT)]: [warehouses['ZAVOD-GP']],
  };

  // Сырьё завода лежит на отдельном складе и в продажу не идёт. Его приход
  // здесь не генерируется: снабжение везёт сырьё под потребность цеха, а она
  // известна только после того, как построены производственные заказы. Приходы
  // сырья — в производственном блоке, ниже.
  const rawDefs = itemDefs.filter((d) => d.company === PLANT && d.price === 0);

  // Номенклатура собственного выпуска. Тот же список ниже становится
  // технологическими картами: цех умеет ровно то, на что есть карта.
  const MADE_IN_HOUSE = new Set(['TESA-219X6', 'PPU-159-250']);

  // --- производство ---------------------------------------------------------

  await prisma.workCenter.createMany({
    data: [
      { companyId: PLANT, code: 'TESA-219', nameRu: 'Стан ТЭСА 57-219', nameUz: 'TESA 57-219 stani', capacityPerShift: qty(85) },
      { companyId: PLANT, code: 'TESA-325', nameRu: 'Стан ТЭСА 219-325', nameUz: 'TESA 219-325 stani', capacityPerShift: qty(110) },
      { companyId: PLANT, code: 'PPU-LINE', nameRu: 'Линия заливки ППУ', nameUz: 'PPU quyish liniyasi', capacityPerShift: qty(320) },
      { companyId: PLANT, code: 'PE-EXTR', nameRu: 'Экструдер ПЭ-оболочки', nameUz: 'PE qobiq ekstruderi', capacityPerShift: qty(340) },
    ],
  });
  const workCenters = Object.fromEntries(
    (await prisma.workCenter.findMany()).map((w) => [w.code, w.id]),
  );

  // Смены завода: те же строки заводит миграция 20261004210100 — стенд не
  // пересеивается, а чистая база разработки получает их отсюда. График свой
  // завод назовёт отдельно (09-CLIENT-INPUTS.md), это демо-значения.
  await prisma.productionShift.createMany({
    data: [
      { companyId: PLANT, code: 'S1', nameRu: 'Первая смена', nameUz: 'Birinchi smena', startsAt: new Date('1970-01-01T08:00:00Z'), endsAt: new Date('1970-01-01T16:00:00Z') },
      { companyId: PLANT, code: 'S2', nameRu: 'Вторая смена', nameUz: 'Ikkinchi smena', startsAt: new Date('1970-01-01T16:00:00Z'), endsAt: new Date('1970-01-01T00:00:00Z') },
    ],
  });

  const techCardDefs = [
    {
      itemCode: 'TESA-219X6', unit: 't',
      stages: [
        { ru: 'Роспуск рулона и подготовка штрипса', uz: 'Rulonni yoyish va shtripsni tayyorlash', wc: 'TESA-219', min: 45, waste: 1.2 },
        { ru: 'Формовка и сварка ТВЧ', uz: 'Shakllantirish va YuCh payvandlash', wc: 'TESA-219', min: 120, waste: 2.4 },
        { ru: 'Калибровка и резка в размер', uz: 'Kalibrlash va o‘lchamga kesish', wc: 'TESA-219', min: 60, waste: 0.8 },
        { ru: 'Контроль качества и маркировка', uz: 'Sifat nazorati va markirovka', wc: 'TESA-219', min: 40, waste: 0 },
      ],
      materials: [{ code: 'SHTRIPS-1.5', qty: 1.045, unit: 't' }],
    },
    {
      itemCode: 'PPU-159-250', unit: 'pm',
      stages: [
        { ru: 'Дробеструйная очистка стальной трубы', uz: 'Po‘lat quvurni drobli tozalash', wc: 'PPU-LINE', min: 35, waste: 0.4 },
        { ru: 'Экструзия ПЭ-оболочки', uz: 'PE qobiqni ekstruziya qilish', wc: 'PE-EXTR', min: 55, waste: 1.6 },
        { ru: 'Центровка и установка СОДК', uz: 'Markazlash va SODK o‘rnatish', wc: 'PPU-LINE', min: 40, waste: 0.5 },
        { ru: 'Заливка пенополиуретана', uz: 'Poliuretan ko‘pikni quyish', wc: 'PPU-LINE', min: 70, waste: 2.1 },
        { ru: 'Выдержка и торцовка', uz: 'Saqlash va uchini tekislash', wc: 'PPU-LINE', min: 90, waste: 0.3 },
      ],
      materials: [
        { code: 'PPU-POLIOL', qty: 0.0081, unit: 't' },
        { code: 'PPU-IZO', qty: 0.0094, unit: 't' },
        { code: 'PE-100', qty: 0.0132, unit: 't' },
        { code: 'SODK-WIRE', qty: 2.1, unit: 'm' },
      ],
    },
  ];

  // Списки разъезжаются молча: закупка перестанет возить то, что цех уже не
  // делает, и склад опустеет на ровном месте. Пусть падает здесь.
  const cardCodes = new Set(techCardDefs.map((tc) => tc.itemCode));
  if (cardCodes.size !== MADE_IN_HOUSE.size || [...cardCodes].some((c) => !MADE_IN_HOUSE.has(c))) {
    throw new Error(
      `MADE_IN_HOUSE и технологические карты разошлись: ${[...MADE_IN_HOUSE]} против ${[...cardCodes]}`,
    );
  }

  for (const tc of techCardDefs) {
    const item = items[tc.itemCode];
    const card = await prisma.techCard.create({
      data: {
        companyId: PLANT,
        itemId: item.id,
        version: 1,
        nameRu: `Техкарта: ${item.nameRu}`,
        nameUz: `Texkarta: ${item.nameUz}`,
        status: 'active',
        outputQty: qty(1),
        outputUnitId: units[tc.unit],
        validFrom: dayOffset(PERIOD_DAYS),
        stages: {
          create: tc.stages.map((s, i) => ({
            seq: i + 1,
            nameRu: s.ru,
            nameUz: s.uz,
            workCenterId: workCenters[s.wc],
            normDurationMin: s.min,
            wastePercent: s.waste.toFixed(4),
          })),
        },
      },
    });
    await prisma.techCardMaterial.createMany({
      data: tc.materials.map((m) => ({
        techCardId: card.id,
        itemId: items[m.code].id,
        qtyPerUnit: qty(m.qty),
        unitId: units[m.unit],
      })),
    });
  }
  const techCards = await prisma.techCard.findMany({ include: { stages: true, materials: true } });
  const downtimeReasons = await prisma.stockReason.findMany({
    where: { companyId: PLANT, kind: 'downtime' },
    orderBy: { id: 'asc' },
  });

  const MINUTE = 60_000;

  let prodSeq = 0;
  let openSeq = 0;
  for (let d = PERIOD_DAYS; d >= 0; d -= 4) {
    const card = pick(techCards);
    prodSeq += 1;
    const planned = card.outputUnitId === units.t ? between(60, 180) : between(400, 1100);
    const finished = d > 10;
    /**
     * Форма заказа задаётся один раз, и от неё пляшут статус заказа, статусы
     * этапов и журнал. Раньше заказ мог стоять в «запланирован», пока его
     * первый этап числился идущим, — на экране это выглядит как ошибка данных.
     *
     * Незакрытых заказов в периоде всего три, и на случайном выборе одно из
     * состояний выпадало ноль раз: на экране оставалась вкладка, за которой
     * никогда ничего нет. Раздаём по кругу — встречается каждое.
     */
    const shape = finished
      ? 'finished'
      : (['planned', 'in_progress', 'paused'] as const)[openSeq++ % 3]!;
    const started = shape !== 'planned';
    const produced = finished ? planned * between(0.93, 1.0) : started ? planned * between(0.2, 0.7) : 0;
    const defect = produced * between(0.005, 0.03);
    const waste = produced * between(0.01, 0.025);

    /**
     * Ход этапа восстанавливается по журналу событий, а не приписывается
     * колонкой: после пауз только журнал помнит, сколько этап реально шёл.
     * Поэтому `actualDurationMin` здесь — сумма закрытых отрезков работы,
     * то есть производная от событий. Незакрытый отрезок идущего этапа в неё
     * не входит: подтверждено только то, что уже кончилось.
     */
    let cursor = dayOffset(d).getTime();
    const stagePlans = card.stages
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((s) => {
        const status: 'done' | 'running' | 'paused' | 'pending' = finished
          ? 'done'
          : s.seq === 1 && started
            ? (shape === 'paused' ? 'paused' : 'running')
            : 'pending';

        const events: { event: 'start' | 'pause' | 'resume' | 'finish'; occurredAt: Date; reasonId?: bigint }[] = [];
        let worked = 0;
        const pauses: { at: Date; minutes: number; reasonId: bigint }[] = [];

        if (status !== 'pending') {
          const total = Math.round(s.normDurationMin * between(0.92, 1.25));
          // Простой случается не в каждую смену, но и не раз в квартал.
          const stops = status === 'paused' || between(0, 1) < 0.22;
          events.push({ event: 'start', occurredAt: new Date(cursor) });

          if (stops) {
            const before = Math.max(5, Math.round(total * between(0.3, 0.7)));
            cursor += before * MINUTE;
            worked += before;
            const reasonId = pick(downtimeReasons).id;
            const minutes = Math.round(between(20, 120));
            const at = new Date(cursor);
            events.push({ event: 'pause', occurredAt: at, reasonId });
            pauses.push({ at, minutes, reasonId });
            cursor += minutes * MINUTE;
            // Этап на паузе на паузе и остаётся: возобновления у него нет.
            if (status !== 'paused') events.push({ event: 'resume', occurredAt: new Date(cursor) });
          }

          if (status === 'done') {
            const rest = Math.max(5, total - worked);
            cursor += rest * MINUTE;
            worked += rest;
            events.push({ event: 'finish', occurredAt: new Date(cursor) });
          }
        }

        return { seq: s.seq, status, events, pauses, actualDurationMin: worked, def: s };
      });

    const order = await prisma.productionOrder.create({
      data: {
        companyId: PLANT,
        number: `ПР-${String(prodSeq).padStart(5, '0')}`,
        itemId: card.itemId,
        techCardId: card.id,
        techCardVersion: card.version,
        qtyPlanned: qty(planned),
        qtyProduced: qty(produced),
        qtyDefect: qty(defect),
        qtyWaste: qty(waste),
        unitId: card.outputUnitId,
        dueDate: dateOnly(dayOffset(d - 6)),
        status: shape === 'finished' ? pick(['produced', 'closed'] as const) : shape,
        priority: pick([0, 0, 1]),
        responsibleId: users[L.master],
        startedAt: started ? dayOffset(d) : null,
        finishedAt: finished ? dayOffset(d - 3) : null,
        createdBy: users[L.master],
        createdAt: dayOffset(d + 1),
        stages: {
          create: stagePlans.map((p) => ({
            seq: p.seq,
            nameRu: p.def.nameRu,
            nameUz: p.def.nameUz,
            workCenterId: p.def.workCenterId,
            responsibleId: users[L.master],
            plannedStart: dayOffset(d),
            plannedEnd: dayOffset(d - 1),
            plannedDurationMin: p.def.normDurationMin,
            actualDurationMin: p.actualDurationMin,
            status: p.status,
          })),
        },
      },
      include: { stages: true },
    });

    const stageIdBySeq = new Map(order.stages.map((s) => [s.seq, s.id]));
    const stageEvents = stagePlans.flatMap((p) =>
      p.events.map((e) => ({
        stageId: stageIdBySeq.get(p.seq)!,
        event: e.event,
        occurredAt: e.occurredAt,
        reasonId: e.reasonId ?? null,
        userId: users[L.master],
      })),
    );
    if (stageEvents.length) await prisma.productionStageEvent.createMany({ data: stageEvents });

    // Простой — это отклонение. Без строки в журнале отклонений он виден
    // только в событиях этапа, и отчёт по простоям покажет ноль.
    const deviations = stagePlans.flatMap((p) =>
      p.pauses.map((x) => ({
        companyId: PLANT,
        productionOrderId: order.id,
        stageId: stageIdBySeq.get(p.seq)!,
        kind: 'downtime' as const,
        reasonId: x.reasonId,
        occurredAt: x.at,
        durationMin: x.minutes,
        registeredBy: users[L.master],
      })),
    );
    if (deviations.length) await prisma.deviationLog.createMany({ data: deviations });

    await prisma.productionMaterial.createMany({
      data: card.materials.map((m) => ({
        productionOrderId: order.id,
        itemId: m.itemId,
        qtyPlanned: qty(Number(m.qtyPerUnit) * planned),
        qtyIssued: qty(Number(m.qtyPerUnit) * produced * between(1.0, 1.04)),
        qtyUsed: qty(Number(m.qtyPerUnit) * produced),
        unitId: m.unitId,
        costTotal: money(Number(m.qtyPerUnit) * produced * 12_000_000),
      })),
    });

    // Запланированный заказ ничего не выпустил: выпуск нулём — это не выпуск,
    // а строка, которую отчёт посчитает как событие.
    if (produced > 0) {
      await prisma.productionOutput.createMany({
        data: [
          { productionOrderId: order.id, itemId: card.itemId, qty: qty(produced), kind: 'good' as const, occurredAt: dayOffset(d - 2), userId: users[L.master] },
          { productionOrderId: order.id, itemId: card.itemId, qty: qty(defect), kind: 'defect' as const, occurredAt: dayOffset(d - 2), userId: users[L.master] },
          { productionOrderId: order.id, itemId: card.itemId, qty: qty(waste), kind: 'waste' as const, occurredAt: dayOffset(d - 2), userId: users[L.master] },
        ],
      });
    }

    if (finished) {
      const materialCost = produced * (card.outputUnitId === units.t ? 8_100_000 : 1_620_000);
      const directCost = materialCost * between(0.08, 0.14);
      const total = materialCost + directCost;
      await prisma.productionOrderCost.create({
        data: {
          productionOrderId: order.id,
          calculatedAt: dayOffset(d - 3),
          materialCost: money(materialCost),
          directCost: money(directCost),
          totalCost: money(total),
          qtyGood: qty(produced),
          unitCost: money(total / produced),
          calculatedBy: users[L.accountant],
          isCurrent: true,
        },
      });
    }
  }
  console.log(`производство: ${prodSeq} заказов`);

  // --- цех и склад: выдача материалов и приход выпуска ------------------------
  // Пока цех не двигает склад, две трети системы живут в разных мирах: мастер
  // отчитался о выпуске, а кладовщик его не видит. Здесь связь и создаётся.

  const dayOf = (dt: Date) => Math.round((TODAY.getTime() - dt.getTime()) / DAY);
  const costByItemId = new Map<bigint, number>(
    itemDefs.map((d) => [items[d.code].id, d.cost] as const),
  );
  const unitByItemId = new Map(itemRows.map((i) => [i.id, i.baseUnitId] as const));

  const prodOrderRows = await prisma.productionOrder.findMany({
    select: { id: true, itemId: true, startedAt: true, createdAt: true },
  });
  const prodOrderById = new Map(prodOrderRows.map((o) => [o.id, o]));
  const materialRows = await prisma.productionMaterial.findMany();
  const outputRows = await prisma.productionOutput.findMany();

  const SYR = warehouses['ZAVOD-SYR'];
  const GP = warehouses['ZAVOD-GP'];

  // 1. Приход сырья. Снабжение завозит раз в десять дней под потребность
  // ближайшего окна с запасом: цех не должен ждать сырьё, но и склад сырья на
  // квартал вперёд — это замороженные деньги, а не правдоподобные данные.
  type Issue = { pm: (typeof materialRows)[number]; day: number };
  const issuesByItem = new Map<string, Issue[]>();
  for (const pm of materialRows) {
    if (Number(pm.qtyIssued) <= 0) continue;
    const ord = prodOrderById.get(pm.productionOrderId)!;
    const day = dayOf(ord.startedAt ?? ord.createdAt);
    const list = issuesByItem.get(String(pm.itemId)) ?? [];
    list.push({ pm, day });
    issuesByItem.set(String(pm.itemId), list);
  }

  const rawBatchPayloads: any[] = [];
  const plantSuppliers = suppliers.filter((s) => s.companyId === PLANT);
  // Первый поставщик завода везёт всё: и сырьё, и закупной товар. Второй стоит
  // под аванс - ему заплатили вперёд, а привезти ещё не привезли, и приходов
  // по нему нет ни одного. Строка-аванс заводится ниже, в финансах, нарочно:
  // отчёт по кредиторке называет переплату отдельным числом и обрезает долг
  // нулём, а проверить это нечем, если переплаченного поставщика в базе нет.
  const PLANT_SUPPLIER = plantSuppliers[0]!;
  const PLANT_ADVANCE_SUPPLIER = plantSuppliers[1] ?? plantSuppliers[0]!;
  let rawSeq = 0;
  const firstWindow = Math.max(
    PERIOD_DAYS,
    ...[...issuesByItem.values()].flat().map((x) => x.day),
  );
  for (const [itemKey, list] of issuesByItem) {
    const itemId = BigInt(itemKey);
    const unitCost = costByItemId.get(itemId) ?? 0;
    for (let d = firstWindow; d > -10; d -= 10) {
      const need = list
        .filter((x) => x.day <= d && x.day > d - 10)
        .reduce((s, x) => s + Number(x.pm.qtyIssued), 0);
      if (need <= 0) continue;
      rawSeq += 1;
      rawBatchPayloads.push({
        companyId: PLANT,
        itemId,
        number: `СР-${String(rawSeq).padStart(5, '0')}`,
        producedAt: dayOffset(Math.max(0, d) + 5),
        receivedAt: dayOffset(Math.max(0, d)),
        supplierId: PLANT_SUPPLIER.id,
        productionOrderId: null,
        unitCost: money(unitCost * between(0.97, 1.03)),
        certificateNumber: `СК-2026-С${String(rawSeq).padStart(4, '0')}`,
        __amount: qty6(need * between(1.15, 1.3)),
        __day: Math.max(0, d),
      });
    }
  }
  await prisma.batch.createMany({
    data: rawBatchPayloads.map(({ __amount, __day, ...rest }) => rest),
  });
  const rawBatches = await prisma.batch.findMany({
    where: { number: { startsWith: 'СР-' } },
  });
  const rawBatchByNumber = Object.fromEntries(rawBatches.map((b) => [b.number, b]));

  for (const bp of rawBatchPayloads) {
    const batch = rawBatchByNumber[bp.number];
    const unitCost = Number(batch.unitCost);
    moves.push({
      companyId: PLANT,
      movedAt: dayOffset(bp.__day),
      operationType: 'receipt',
      itemId: bp.itemId,
      batchId: batch.id,
      toWarehouseId: SYR.id,
      qty: qty(bp.__amount),
      unitId: unitByItemId.get(bp.itemId)!,
      qtyBase: qty(bp.__amount),
      costTotal: money(bp.__amount * unitCost),
      sourceDocType: 'batch',
      sourceDocId: batch.id,
      partnerId: bp.supplierId,
      createdBy: users[L.warehouse],
      createdAt: dayOffset(bp.__day),
    });
    const key = `${SYR.id}:${bp.itemId}`;
    const pool = lots.get(key) ?? [];
    pool.push({ batchId: batch.id, day: bp.__day, onHand: bp.__amount, reserved: 0, unitCost });
    lots.set(key, pool);
  }
  for (const pool of lots.values()) pool.sort((a, b) => b.day - a.day);

  // 2. Выдача в цех. Списываем тем же FIFO, что и отгрузку: материал уходит
  // со склада сырья строкой на каждую партию.
  const issuesInOrder = [...issuesByItem.values()].flat().sort((a, b) => b.day - a.day);
  for (const { pm, day } of issuesInOrder) {
    const amount = Number(pm.qtyIssued);
    const parts = takeFifo(SYR.id, pm.itemId, day, amount, 'issue');
    const taken = parts.reduce((s, p) => s + p.qty, 0);
    if (Math.abs(taken - amount) > 0.001) {
      throw new Error(
        `сырья не хватило: позиция ${pm.itemId}, нужно ${amount}, нашлось ${taken} на дне ${day}`,
      );
    }
    for (const part of parts) {
      moves.push({
        companyId: PLANT,
        movedAt: dayOffset(day),
        operationType: 'issue_to_production',
        itemId: pm.itemId,
        batchId: part.batchId,
        fromWarehouseId: SYR.id,
        qty: qty(part.qty),
        unitId: pm.unitId,
        qtyBase: qty(part.qty),
        costTotal: money(part.cost),
        sourceDocType: 'production_material',
        sourceDocId: pm.id,
        createdBy: users[L.master],
        createdAt: dayOffset(day),
      });
    }
  }

  // 3. Выпуск. На склад готовой продукции попадает только годное: брак и
  // отходы складом не приходуются, у них свой путь — и своя строка отчёта.
  const goodOutputs = outputRows.filter((o) => o.kind === 'good' && Number(o.qty) > 0);
  const outBatchPayloads = goodOutputs.map((o, idx) => {
    const ord = prodOrderById.get(o.productionOrderId)!;
    return {
      companyId: PLANT,
      itemId: o.itemId,
      number: `ВП-${String(idx + 1).padStart(5, '0')}`,
      producedAt: o.occurredAt,
      receivedAt: o.occurredAt,
      supplierId: null,
      productionOrderId: ord.id,
      unitCost: money((costByItemId.get(o.itemId) ?? 0) * between(0.96, 1.02)),
      certificateNumber: `СК-2026-В${String(idx + 1).padStart(4, '0')}`,
      __outputId: o.id,
      __qty: Number(o.qty),
      __at: o.occurredAt,
    };
  });
  await prisma.batch.createMany({
    data: outBatchPayloads.map(({ __outputId, __qty, __at, ...rest }) => rest),
  });
  const outBatches = await prisma.batch.findMany({ where: { number: { startsWith: 'ВП-' } } });
  const outBatchByNumber = Object.fromEntries(outBatches.map((b) => [b.number, b]));

  for (const bp of outBatchPayloads) {
    const batch = outBatchByNumber[bp.number];
    const unitCost = Number(batch.unitCost);
    moves.push({
      companyId: PLANT,
      movedAt: bp.__at,
      operationType: 'output',
      itemId: bp.itemId,
      batchId: batch.id,
      toWarehouseId: GP.id,
      qty: qty(bp.__qty),
      unitId: unitByItemId.get(bp.itemId)!,
      qtyBase: qty(bp.__qty),
      costTotal: money(bp.__qty * unitCost),
      sourceDocType: 'production_output',
      sourceDocId: bp.__outputId,
      createdBy: users[L.master],
      createdAt: bp.__at,
    });
    const key = `${GP.id}:${bp.itemId}`;
    const pool = lots.get(key) ?? [];
    pool.push({
      batchId: batch.id,
      day: dayOf(bp.__at),
      onHand: bp.__qty,
      reserved: 0,
      unitCost,
    });
    lots.set(key, pool);
  }

  // Приходы: раз в 10 дней завозим партию по каждой позиции. Объём подобран
  // под отгрузки периода — так, чтобы на конец остался рабочий запас, а не
  // склад в десять раз больше месячного оборота.
  const batchPayloads: any[] = [];
  let batchSeq = 0;
  for (let d = PERIOD_DAYS; d > 0; d -= 10) {
    for (const companyId of [TRADE, PLANT]) {
      for (const def of salesItems[String(companyId)]) {
        for (const wh of stockWarehouse[String(companyId)]) {
          batchSeq += 1;
          // То, что завод делает сам, он не закупает. По такой позиции есть
          // только начальный запас на старте периода, дальше склад пополняет
          // цех: иначе к концу периода на складе три оборота продаж.
          const madeInHouse = companyId === PLANT && MADE_IN_HOUSE.has(def.code);
          if (madeInHouse && d !== PERIOD_DAYS) continue;
          const amount = qty6(
            companyId === PLANT
              ? (def.unit === 't' ? between(100, 160) : between(460, 720)) * (madeInHouse ? 2.5 : 1)
              : between(80, 135),
          );
          batchPayloads.push({
            companyId,
            itemId: items[def.code].id,
            number: `П-${String(batchSeq).padStart(5, '0')}`,
            producedAt: dayOffset(d + 2),
            receivedAt: dayOffset(d),
            // Поставщик есть у любой купленной партии, в том числе заводской:
            // партия без поставщика и без производственного заказа - это
            // потерянное происхождение, сертификат привязывать не к чему.
            // Партии собственного выпуска заводятся не здесь, а в цеховом
            // блоке, и подписаны производственным заказом.
            supplierId:
              companyId === PLANT
                ? PLANT_SUPPLIER.id
                : pick(suppliers.filter((s) => s.companyId === TRADE)).id,
            productionOrderId: null,
            unitCost: money(def.cost * between(0.97, 1.03)),
            certificateNumber: `СК-${2026}-${String(batchSeq).padStart(4, '0')}`,
            __amount: amount,
            __warehouseId: wh.id,
            __itemCode: def.code,
            __day: d,
          });
        }
      }
    }
  }
  // Остальной каталог: одна партия на позицию, на старте периода, объёмом
  // в настоящий остаток с сайта. Эти позиции в заказы периода не попадают, и
  // остаток по ним так и остаётся равным каталожному - то же число, что видит
  // клиент в карточке «В наличии». Склад один: товар лежит на хабе.
  //
  // Это входящий остаток, а не закупка периода. Поставщик у партии есть -
  // иначе у неё потеряно происхождение и сертификат не к чему привязать, -
  // а вот в движении контрагент не указан сознательно: кредиторка считается по
  // приходам с контрагентом, и записав сюда поставщика, мы повесили бы на него
  // двадцать пять миллиардов неоплаченного долга за товар, который лежал на
  // складе до начала периода.
  for (const def of openingOnly) {
    batchSeq += 1;
    batchPayloads.push({
      companyId: TRADE,
      itemId: items[def.code].id,
      number: `П-${String(batchSeq).padStart(5, '0')}`,
      producedAt: dayOffset(PERIOD_DAYS + 12),
      receivedAt: dayOffset(PERIOD_DAYS),
      supplierId: pick(suppliers.filter((s) => s.companyId === TRADE)).id,
      productionOrderId: null,
      unitCost: money(def.cost * between(0.97, 1.03)),
      certificateNumber: `СК-${2026}-${String(batchSeq).padStart(4, '0')}`,
      __amount: qty6(def.stockT!),
      __warehouseId: warehouses.ERKIN.id,
      __itemCode: def.code,
      __day: PERIOD_DAYS,
      __opening: true,
    });
  }

  await prisma.batch.createMany({
    data: batchPayloads.map(
      ({ __amount, __warehouseId, __itemCode, __day, __opening, ...rest }) => rest,
    ),
  });
  const batchRows = await prisma.batch.findMany();
  const batchByNumber = Object.fromEntries(batchRows.map((b) => [b.number, b]));

  for (const bp of batchPayloads) {
    const batch = batchByNumber[bp.number];
    const item = items[bp.__itemCode];
    const key = `${bp.__warehouseId}:${item.id}`;
    const unitCost = Number(batch.unitCost);
    moves.push({
      companyId: bp.companyId,
      movedAt: dayOffset(bp.__day),
      operationType: 'receipt',
      itemId: item.id,
      batchId: batch.id,
      toWarehouseId: bp.__warehouseId,
      qty: qty(bp.__amount),
      unitId: item.baseUnitId,
      qtyBase: qty(bp.__amount),
      costTotal: money(bp.__amount * unitCost),
      sourceDocType: 'batch',
      sourceDocId: batch.id,
      // У входящего остатка контрагента в движении нет: см. комментарий выше.
      partnerId: bp.__opening ? null : bp.supplierId,
      createdBy: users[L.warehouse],
      createdAt: dayOffset(bp.__day),
    });
    const pool = lots.get(key) ?? [];
    pool.push({ batchId: batch.id, day: bp.__day, onHand: bp.__amount, reserved: 0, unitCost });
    lots.set(key, pool);
  }

  // Партии в пуле должны лежать от старых к новым: FIFO идёт по порядку.
  // Сортируем здесь, потому что цех положил свои партии раньше закупки.
  for (const pool of lots.values()) pool.sort((x, y) => y.day - x.day);

  // Заказы. Номер сквозной по компании, дата — рабочий день периода.
  let orderSeq = { [String(TRADE)]: 0, [String(PLANT)]: 0 };
  let shipmentSeq = { [String(TRADE)]: 0, [String(PLANT)]: 0 };

  for (let d = PERIOD_DAYS - 2; d >= 0; d--) {
    const date = dayOffset(d);
    if (date.getUTCDay() === 0) continue; // воскресенье — не отгружаем

    for (const companyId of [TRADE, PLANT]) {
      const key = String(companyId);
      const perDay = companyId === TRADE ? intBetween(2, 5) : intBetween(1, 4);

      for (let k = 0; k < perDay; k++) {
        const client = pick(clientsByCompany.get(key)!);
        orderSeq[key] += 1;
        const number = `${companyId === TRADE ? 'ТД' : 'ЗВ'}-${String(orderSeq[key]).padStart(5, '0')}`;
        const manager = client.managerId ?? users[L.salesTrade1];
        const warehouse = pick(stockWarehouse[key]);

        // Старые заказы закрыты, свежие ещё в работе. Знать это нужно до того,
        // как набраны строки: отгруженный заказ снимает товар со склада,
        // неотгруженный только резервирует его.
        const isClosed = d > 12;
        const isShipped = d > 5;
        const moveDay = isShipped ? d - 1 : d;

        const lineCount = intBetween(1, 3);
        const chosen = new Set<string>();
        const lines: any[] = [];
        let net = 0;
        let vat = 0;
        let cost = 0;

        for (let li = 0; li < lineCount; li++) {
          const def = pick(salesItems[key]);
          if (chosen.has(def.code)) continue;
          chosen.add(def.code);

          const item = items[def.code];
          const free = freeAt(warehouse.id, item.id, moveDay);
          if (free <= 1) continue;

          // Завод отгружает крупными партиями под теплотрассу, торговый дом —
          // мелкой розницей стройкам. Одна формула на обоих даёт неправдоподобный
          // масштаб хоть у того, хоть у другого.
          const want =
            companyId === PLANT
              ? def.unit === 't' ? between(6, 26) : between(35, 130)
              : between(5, 32);
          const want2 = floor6(Math.min(want, free * 0.35));
          if (want2 < 1) continue;

          // Берём ровно столько, сколько реально нашлось в партиях: FIFO может
          // отдать меньше запрошенного, и тогда строка должна стать меньше,
          // а не уйти в минус на складе.
          const parts = takeFifo(warehouse.id, item.id, moveDay, want2, isShipped ? 'issue' : 'reserve');
          const amount = parts.reduce((s, p) => s + p.qty, 0);
          if (amount < 1) continue;

          // Цена берётся из прайса, а не выдумывается: тип цены клиента в
          // посеве — оптовый, а оптовая цена в прайсе равна `def.price`.
          // Прежде посев ставил `def.price * 0.97…1.05`, и на стенде все
          // строки выглядели ценой, набранной руками мимо прайса, — картины,
          // которую система теперь не пропустит без права и основания.
          const listUnit = def.price;
          const manualPrice = between(0, 1) < 0.12;
          const priceUnit = manualPrice ? def.price * between(0.9, 1.04) : listUnit;
          const discount = pick([0, 0, 0, 1.5, 3]);
          const lineNet = amount * priceUnit * (1 - discount / 100);
          const lineVat = lineNet * 0.12;
          const lineCost = parts.reduce((s, p) => s + p.cost, 0);

          net += lineNet;
          vat += lineVat;
          cost += lineCost;

          lines.push({
            seq: lines.length + 1,
            itemId: item.id,
            qty: qty(amount),
            unitId: item.baseUnitId,
            price: money(priceUnit),
            discountPercent: discount.toFixed(4),
            vatRate: '12.0000',
            amountNet: money(lineNet),
            amountVat: money(lineVat),
            amountTotal: money(lineNet + lineVat),
            costTotal: money(lineCost),
            warehouseId: warehouse.id,
            priceSource: (manualPrice ? 'manual' : 'list') as 'manual' | 'list',
            listPrice: money(listUnit),
            costRef: money(lineCost / amount),
            priceComment: manualPrice
              ? pick([
                  'Согласовано с руководителем: постоянный клиент, объём выше обычного.',
                  'Цена по переписке с клиентом, учтён самовывоз.',
                  'Уступили против прайса, чтобы не потерять заказ конкуренту.',
                  'Дороже прайса: срочная поставка, доставка нашим транспортом.',
                ])
              : null,
            __itemId: item.id,
            __qty: amount,
            __parts: parts,
            __cost: lineCost,
          });
        }

        if (lines.length === 0) {
          orderSeq[key] -= 1;
          continue;
        }

        // Часть незакрытых заказов в жизни отменяют: клиент передумал, не
        // пришла оплата. Без таких строк состояние «Отменён» нигде не видно,
        // а резерв под отменённым заказом система держать не должна.
        // Выбираем по номеру, а не жребием: жребий сдвинул бы весь дальнейший
        // посев, и данные перестали бы совпадать с прошлыми прогонами.
        const isCancelled = !isClosed && !isShipped && orderSeq[key] % 9 === 0;
        const status = isClosed
          ? 'closed'
          : isShipped
            ? 'shipped'
            : isCancelled
              ? 'cancelled'
              : pick(['confirmed', 'reserved', 'picking'] as const);
        const paymentStatus = isCancelled
          ? 'unpaid'
          : isClosed
            ? 'paid'
            : isShipped
              ? pick(['paid', 'partial'] as const)
              : pick(['unpaid', 'partial'] as const);
        const shipmentStatus = isShipped ? 'full' : 'none';
        const paid = paymentStatus === 'paid' ? net + vat : paymentStatus === 'partial' ? (net + vat) * 0.5 : 0;

        orderPayloads.push({
          companyId,
          number,
          partnerId: client.id,
          managerId: manager,
          orderDate: dateOnly(date),
          deliveryDate: dateOnly(dayOffset(d - 3)),
          paymentDueDate: dateOnly(dayOffset(d - (client.paymentDelayDays ?? 14))),
          warehouseId: warehouse.id,
          priceTypeId: client.priceTypeId,
          currencyId: currencies.UZS,
          rate: '1.00000000',
          amountNet: money(net),
          amountVat: money(vat),
          amountTotal: money(net + vat),
          costTotal: money(cost),
          marginTotal: money(net - cost),
          paidAmount: money(paid),
          status,
          paymentStatus,
          shipmentStatus,
          comment: isCancelled ? CANCEL_REASONS[orderSeq[key] % CANCEL_REASONS.length] : null,
          createdBy: manager,
          createdAt: date,
        });

        for (const line of lines) {
          linePayloads.push({
            orderNumber: number,
            companyId,
            line,
            reserve: !isShipped && !isCancelled,
            manager,
          });
        }

        if (isShipped) {
          shipmentSeq[key] += 1;
          const shipNumber = `ТТН-${companyId === TRADE ? 'ТД' : 'ЗВ'}-${String(shipmentSeq[key]).padStart(5, '0')}`;
          const totalT = lines.reduce((s, l) => s + (items[Object.keys(items).find((c) => items[c].id === l.__itemId)!].isWeighted ? l.__qty : l.__qty * 0.045), 0);
          shipmentPayloads.push({
            companyId,
            __orderNumber: number,
            number: shipNumber,
            shippedAt: dayOffset(d - 1),
            warehouseId: warehouse.id,
            responsibleId: users[L.warehouse],
            vehicle: `${pick(['01', '10', '30'])} ${String(intBetween(100, 999))} ${pick(['AAA', 'BBB', 'CCA'])}`,
            driver: pick(['Тошев Б.', 'Юлдашев А.', 'Мирзаев С.', 'Каримов Ш.']),
            netWeightT: qty(totalT),
            grossWeightT: qty(totalT * 1.04),
          });
          for (const line of lines) {
            shipmentLinePayloads.push({ shipmentNumber: shipNumber, companyId, line });
          }
          // Движение — на каждую партию своё: одна строка заказа может закрыться
          // двумя партиями, и в журнале это должно быть видно двумя строками.
          for (const line of lines) {
            for (const part of line.__parts) {
              moves.push({
                companyId,
                movedAt: dayOffset(d - 1),
                operationType: 'shipment',
                itemId: line.__itemId,
                batchId: part.batchId,
                fromWarehouseId: warehouse.id,
                qty: qty(part.qty),
                unitId: itemRows.find((i) => i.id === line.__itemId)!.baseUnitId,
                qtyBase: qty(part.qty),
                costTotal: money(part.cost),
                sourceDocType: 'shipment',
                // Номер ТТН, а не её id: сами отгрузки заводятся ниже, и id у
                // них ещё нет. Разрешается в id перед вставкой журнала. Без
                // этого движение не знает своего документа, и цепочка
                // прослеживаемости обрывается на вопросе «кому отгрузили».
                __shipmentNumber: shipNumber,
                partnerId: client.id,
                createdBy: users[L.warehouse],
                createdAt: dayOffset(d - 1),
              });
            }
          }
        }
      }
    }
  }

  await prisma.salesOrder.createMany({ data: orderPayloads });
  const orderRows = await prisma.salesOrder.findMany({ select: { id: true, number: true, companyId: true } });
  const orderId = new Map(orderRows.map((o) => [`${o.companyId}:${o.number}`, o.id]));

  await prisma.salesOrderLine.createMany({
    data: linePayloads.map(({ orderNumber, companyId, line }) => {
      const { __itemId, __qty, __parts, __cost, ...rest } = line;
      return { ...rest, salesOrderId: orderId.get(`${companyId}:${orderNumber}`)! };
    }),
  });

  // Резерв неотгруженных заказов — строками `stock_reservation`, а не числом в
  // остатке. `qty_reserved` — свёртка этих строк: запиши его прямо, и первый же
  // пересчёт (любая складская операция по той же партии) обнулит обещанное,
  // потому что обещать его будет нечем.
  const lineIdRows = await prisma.salesOrderLine.findMany({
    select: { id: true, salesOrderId: true, seq: true },
  });
  const lineId = new Map(lineIdRows.map((l) => [`${l.salesOrderId}:${l.seq}`, l.id]));

  const reservationPayloads = linePayloads.flatMap(({ orderNumber, companyId, line, reserve, manager }) => {
    if (!reserve) return [];
    const salesOrderLineId = lineId.get(`${orderId.get(`${companyId}:${orderNumber}`)}:${line.seq}`)!;
    return line.__parts.map((part: { batchId: bigint; qty: number }, i: number) => ({
      companyId,
      salesOrderLineId,
      itemId: line.__itemId,
      batchId: part.batchId,
      warehouseId: line.warehouseId,
      qty: qty(part.qty),
      // Срок ставят не всем: часть резервов держат до отгрузки, часть — до
      // условленной даты. Просроченных в сиде нет: их снял бы первый пересчёт,
      // и остаток разошёлся бы с таблицей на глазах.
      expiresAt: i === 0 && line.seq % 2 === 0 ? dayOffset(-intBetween(60, 120)) : null,
      status: 'active' as const,
      createdBy: manager,
      createdAt: TODAY,
    }));
  });
  await prisma.stockReservation.createMany({ data: reservationPayloads });

  await prisma.shipment.createMany({
    data: shipmentPayloads.map(({ __orderNumber, ...rest }) => ({
      ...rest,
      salesOrderId: orderId.get(`${rest.companyId}:${__orderNumber}`)!,
    })),
  });
  const shipmentRows = await prisma.shipment.findMany({ select: { id: true, number: true, companyId: true } });
  const shipmentId = new Map(shipmentRows.map((s) => [`${s.companyId}:${s.number}`, s.id]));

  await prisma.shipmentLine.createMany({
    data: shipmentLinePayloads.flatMap(({ shipmentNumber, companyId, line }) =>
      line.__parts.map((part: { batchId: bigint; qty: number; cost: number }) => ({
        shipmentId: shipmentId.get(`${companyId}:${shipmentNumber}`)!,
        itemId: line.__itemId,
        batchId: part.batchId,
        qty: qty(part.qty),
        costTotal: money(part.cost),
      })),
    ),
  });

  // Журнал и остатки пишутся не здесь: цех тоже двигает склад, и остаток,
  // посчитанный до производства, разойдётся с журналом. См. конец файла.
  console.log(
    `продажи: ${orderPayloads.length} заказов, ${linePayloads.length} строк, ` +
      `${reservationPayloads.length} резервов, ${moves.length} движений склада`,
  );

  // --- журнал и остатки -------------------------------------------------------
  // Журнал читается сверху вниз как хронология, а не как порядок вставки.
  // В одну и ту же секунду приход идёт раньше расхода: иначе остаток на
  // мгновение уходит в минус, и он же так и запишется в отчёт по датам.
  const INCOMING = new Set(['receipt', 'output', 'surplus', 'return_from_client', 'return_from_production']);
  moves.sort(
    (a, b) =>
      a.movedAt.getTime() - b.movedAt.getTime() ||
      (INCOMING.has(a.operationType) ? 0 : 1) - (INCOMING.has(b.operationType) ? 0 : 1),
  );
  // Ячейка хранения — функция от склада и партии, а не случайный выбор.
  // Случайной ячейкой расход ушёл бы не оттуда, куда приход положил товар:
  // по одной ячейке остаток уехал бы в минус, по другой завис бы навсегда.
  // Партия, а не позиция, — чтобы одна номенклатура лежала в разных ячейках
  // и поле в интерфейсе было видно на данных.
  const locationFor = (warehouseId: bigint, m: any): bigint | null => {
    const cells = locationByWarehouse.get(warehouseId);
    if (!cells || cells.length === 0) return null;
    const key = BigInt(m.batchId ?? m.itemId);
    return cells[Number(key % BigInt(cells.length))];
  };
  for (const m of moves) {
    if (m.fromWarehouseId) m.fromLocationId = locationFor(m.fromWarehouseId, m);
    if (m.toWarehouseId) m.toLocationId = locationFor(m.toWarehouseId, m);
  }

  // Остаток — свёртка журнала, а не отдельно посчитанное число: только так
  // карточка позиции сходится со строкой над ней. Ячейка входит в ключ
  // свёртки ровно потому, что входит в уникальный ключ самого остатка.
  type Fold = {
    companyId: bigint;
    warehouseId: bigint;
    locationId: bigint | null;
    itemId: bigint;
    batchId: bigint;
    qty: number;
    cost: number;
  };
  const folded = new Map<string, Fold>();
  const foldInto = (m: any, warehouseId: bigint, locationId: bigint | null, sign: 1 | -1) => {
    const key = `${m.companyId}:${warehouseId}:${locationId}:${m.itemId}:${m.batchId}`;
    const row = folded.get(key) ?? {
      companyId: m.companyId,
      warehouseId,
      locationId,
      itemId: m.itemId,
      batchId: m.batchId,
      qty: 0,
      cost: 0,
    };
    row.qty += sign * Number(m.qtyBase);
    row.cost += sign * Number(m.costTotal);
    folded.set(key, row);
  };
  for (const m of moves) {
    if (m.toWarehouseId) foldInto(m, m.toWarehouseId, m.toLocationId ?? null, 1);
    if (m.fromWarehouseId) foldInto(m, m.fromWarehouseId, m.fromLocationId ?? null, -1);
  }

  // --- операции, которых в журнале не было ----------------------------------
  // До этого места в журнале были только приход, выдача в цех, выпуск и
  // отгрузка. Ни списания, ни перекладки, ни возвратов, ни излишков: экран
  // «журнал движений» на таких данных показывал фильтры, под которые нечего
  // найти, а ячейка была видна, но неподвижна — проверить перемещение между
  // полками было нечем.
  //
  // Каждый тип операции, который можно провести с экрана склада, должен быть
  // в сиде хотя бы несколькими строками. Иначе фильтр по нему держится на
  // мусоре от прошлых прогонов, и после пересева проверка падает.
  //
  // Эти движения идут последними по времени и берут долю от уже сложившегося
  // остатка ячейки. Поэтому они не могут увести остаток в минус ни в итоге,
  // ни в середине периода: раньше них по этой ячейке ничего не происходит.
  // Дата — на час позже самого позднего движения журнала, а не «сегодня»:
  // выпуск цеха в сиде заходит за TODAY, и движение с датой TODAY оказалось бы
  // не последним по своей ячейке. Тогда доля от итогового остатка увела бы
  // ячейку в минус в моменте, хотя итог сошёлся бы.
  const lastAt = new Date(Math.max(...moves.map((m: any) => m.movedAt.getTime())) + 60 * 60 * 1000);
  const writeOffReasons = await prisma.stockReason.findMany({
    where: { kind: { in: ['write_off', 'defect'] } },
  });
  const surplusReasons = await prisma.stockReason.findMany({ where: { kind: 'inventory' } });
  const extra: any[] = [];
  // Доли считаем от остатка ячейки **до** этих движений, снимком. Иначе
  // перекладка, пришедшая в ячейку позже по списку, но раньше по журналу,
  // раздула бы базу для списания, и ячейка ушла бы в минус в моменте: 30 %
  // плюс 5 % от снимка безопасны при любом порядке, а от текущего числа — нет.
  const positive = [...folded.values()]
    .filter((r) => r.qty > 1)
    .map((row) => ({ row, base: row.qty, cost: row.cost }));
  positive.sort(
    (a, b) =>
      Number(a.row.warehouseId - b.row.warehouseId) || Number(a.row.batchId - b.row.batchId),
  );

  for (const [i, { row, base, cost }] of positive.entries()) {
    const unitCost = base > 0 ? Math.max(0, cost) / base : 0;
    const cells = locationByWarehouse.get(row.warehouseId) ?? [];

    // Каждая девятая строка — списание: брак нашли при хранении.
    if (i % 9 === 4) {
      const part = base * 0.05;
      if (part > 0.001) {
        const reason = writeOffReasons.find((r) => r.companyId === row.companyId)!;
        const m = {
          companyId: row.companyId,
          movedAt: lastAt,
          operationType: 'write_off' as const,
          itemId: row.itemId,
          batchId: row.batchId,
          fromWarehouseId: row.warehouseId,
          fromLocationId: row.locationId,
          qty: qty(part),
          unitId: unitByItemId.get(row.itemId)!,
          qtyBase: qty(part),
          costTotal: money(part * unitCost),
          reasonId: reason.id,
          comment: 'Брак выявлен при осмотре на складе',
        };
        extra.push(m);
        foldInto(m, row.warehouseId, row.locationId, -1);
      }
    }

    // Возврат из цеха: отрезки, которые не пошли в дело, вернулись на склад.
    // Только у завода — выдаёт в производство тоже он.
    if (i % 11 === 6 && row.companyId === PLANT) {
      const part = base * 0.08;
      if (part > 0.001) {
        const m = {
          companyId: row.companyId,
          movedAt: lastAt,
          operationType: 'return_from_production' as const,
          itemId: row.itemId,
          batchId: row.batchId,
          toWarehouseId: row.warehouseId,
          toLocationId: row.locationId,
          qty: qty(part),
          unitId: unitByItemId.get(row.itemId)!,
          qtyBase: qty(part),
          costTotal: money(part * unitCost),
          comment: 'Остаток не пошёл в раскрой, вернули на склад',
        };
        extra.push(m);
        foldInto(m, row.warehouseId, row.locationId, 1);
      }
    }

    // Возврат от клиента: приняли обратно по рекламации, на строке стоит
    // контрагент — без него такой приход и не проходит проверку на сервере.
    if (i % 17 === 5) {
      const clients = clientsByCompany.get(String(row.companyId)) ?? [];
      const part = base * 0.04;
      if (clients.length > 0 && part > 0.001) {
        const m = {
          companyId: row.companyId,
          movedAt: lastAt,
          operationType: 'return_from_client' as const,
          itemId: row.itemId,
          batchId: row.batchId,
          toWarehouseId: row.warehouseId,
          toLocationId: row.locationId,
          qty: qty(part),
          unitId: unitByItemId.get(row.itemId)!,
          qtyBase: qty(part),
          costTotal: money(part * unitCost),
          partnerId: clients[i % clients.length].id,
          comment: 'Возврат по рекламации, принято обратно',
        };
        extra.push(m);
        foldInto(m, row.warehouseId, row.locationId, 1);
      }
    }

    // Излишек по инвентаризации: пересчитали ячейку, нашли больше учётного.
    if (i % 13 === 3) {
      const part = base * 0.03;
      const reason = surplusReasons.find((r) => r.companyId === row.companyId);
      if (reason && part > 0.001) {
        const m = {
          companyId: row.companyId,
          movedAt: lastAt,
          operationType: 'surplus' as const,
          itemId: row.itemId,
          batchId: row.batchId,
          toWarehouseId: row.warehouseId,
          toLocationId: row.locationId,
          qty: qty(part),
          unitId: unitByItemId.get(row.itemId)!,
          qtyBase: qty(part),
          costTotal: money(part * unitCost),
          reasonId: reason.id,
          comment: 'Пересчёт ячейки: фактически больше учётного',
        };
        extra.push(m);
        foldInto(m, row.warehouseId, row.locationId, 1);
      }
    }

    // Каждая седьмая — перекладка в соседнюю ячейку того же склада: товар
    // переставили с открытой площадки под навес.
    if (i % 7 === 2 && cells.length > 1 && row.locationId !== null) {
      const to = cells[(cells.indexOf(row.locationId) + 1) % cells.length];
      const part = base * 0.3;
      if (to !== row.locationId && part > 0.001) {
        const m = {
          companyId: row.companyId,
          movedAt: lastAt,
          operationType: 'transfer' as const,
          itemId: row.itemId,
          batchId: row.batchId,
          fromWarehouseId: row.warehouseId,
          fromLocationId: row.locationId,
          toWarehouseId: row.warehouseId,
          toLocationId: to,
          qty: qty(part),
          unitId: unitByItemId.get(row.itemId)!,
          qtyBase: qty(part),
          costTotal: money(part * unitCost),
          comment: 'Переложено под навес',
        };
        extra.push(m);
        foldInto(m, row.warehouseId, row.locationId, -1);
        foldInto(m, row.warehouseId, to, 1);
      }
    }
  }

  // --- инвентаризация (ТЗ 5.8) ------------------------------------------------
  // Лист - снимок учётного количества на момент создания, поэтому снимок берём
  // из уже сложившейся свёртки `folded`. Поправки утверждённого листа кладём
  // движениями в тот же журнал и в ту же свёртку: иначе на экране висела бы
  // недостача, которой в остатке нет, и остаток перестал бы быть свёрткой
  // журнала - а на этом держится сходимость карточки позиции.
  //
  // Состояния берём все четыре: без утверждённого не видно движений от
  // пересчёта, без `counting` и `review` не проверить кнопки «посчитать» и
  // «утвердить», без отменённого фильтр по статусу держался бы на мусоре от
  // прошлых прогонов.
  const zoneOfLocation = new Map(locations.map((l) => [l.id, l.zoneId] as const));
  const zoneOf = (warehouseCode: string, zoneCode: string) =>
    zones.find((z) => z.warehouseId === warehouses[warehouseCode].id && z.code === zoneCode)!;
  // Поправки идут последними по времени: доля берётся от остатка, который к
  // этому моменту уже сложился, и в минус в середине периода не уводит.
  const invAt = new Date(lastAt.getTime() + 60 * 60 * 1000);

  type SheetPlan = {
    companyId: bigint;
    warehouse: string;
    zone: string | null;
    status: 'counting' | 'review' | 'approved' | 'cancelled';
    blockMode: 'block' | 'mark';
    comment: string;
    /** Какая часть строк посчитана: всё, каждая вторая, ничего. */
    counted: 'all' | 'half' | 'none';
  };
  // Открытые листы (`counting`, `review`) стоят на разных зонах одного склада -
  // так их пускает и частичный уникальный индекс, и проверка в сервисе.
  // Режим у открытых - `mark`: `block` в сиде закрыл бы половину склада, и
  // обычные проверки складских операций падали бы на пересчёте.
  const sheetPlans: SheetPlan[] = [
    {
      companyId: TRADE,
      warehouse: 'SERGELI',
      zone: 'B',
      status: 'approved',
      blockMode: 'mark',
      comment: 'Плановый пересчёт крытого склада, расхождения списаны',
      counted: 'all',
    },
    {
      companyId: TRADE,
      warehouse: 'ERKIN',
      zone: 'A',
      status: 'counting',
      blockMode: 'mark',
      comment: 'Пересчёт открытой площадки, считаем по полкам',
      counted: 'half',
    },
    {
      companyId: TRADE,
      warehouse: 'ERKIN',
      zone: 'B',
      status: 'review',
      blockMode: 'mark',
      comment: 'Посчитано, расхождения ждут утверждения директором',
      counted: 'all',
    },
    {
      companyId: PLANT,
      warehouse: 'ZAVOD-SYR',
      zone: null,
      status: 'cancelled',
      blockMode: 'block',
      comment: 'Отменён: цех не остановили, считать было нечем',
      counted: 'none',
    },
  ];

  const invNumber = new Map<bigint, number>();
  let invLines = 0;
  let invDiffs = 0;
  for (const plan of sheetPlans) {
    const warehouseId = warehouses[plan.warehouse].id;
    const zone = plan.zone === null ? null : zoneOf(plan.warehouse, plan.zone);
    const next = (invNumber.get(plan.companyId) ?? 0) + 1;
    invNumber.set(plan.companyId, next);

    const snapshot = [...folded.values()]
      .filter((r) => r.warehouseId === warehouseId && r.qty > 1e-6)
      .filter(
        (r) =>
          zone === null ||
          (r.locationId !== null && zoneOfLocation.get(r.locationId) === zone.id),
      )
      .sort(
        (a, b) =>
          Number((a.locationId ?? 0n) - (b.locationId ?? 0n)) || Number(a.batchId - b.batchId),
      );
    if (snapshot.length === 0) continue;

    const approved = plan.status === 'approved';
    const sheet = await prisma.inventorySheet.create({
      data: {
        companyId: plan.companyId,
        number: `ИНВ-${String(next).padStart(5, '0')}`,
        warehouseId,
        zoneId: zone?.id ?? null,
        status: plan.status,
        blockMode: plan.blockMode,
        comment: plan.comment,
        createdBy: users['a.saidov'],
        createdAt: invAt,
        countedAt: plan.counted === 'none' ? null : invAt,
        approvedBy: approved ? users['s.radjabov'] : null,
        approvedAt: approved ? invAt : null,
      },
      select: { id: true },
    });

    const lines = snapshot.map((row, i) => {
      const expected = qty6(row.qty);
      const unitCost = row.qty > 0 ? Math.max(0, row.cost) / row.qty : 0;
      // Расхождение - доля от учётного, а не круглое число: единицы у позиций
      // разные (тонны, метры, штуки), и «минус два» по тоннам увело бы полку в
      // минус там, где на ней полтонны.
      const found =
        i % 7 === 3
          ? qty6(expected * 1.06) // нашли больше учётного: излишек
          : i % 7 === 5
            ? qty6(expected * 0.94) // нашли меньше: недостача
            : expected;
      const skip = plan.counted === 'none' || (plan.counted === 'half' && i % 2 === 1);
      return { row, i, expected, unitCost, count: skip ? null : found };
    });

    await prisma.inventorySheetLine.createMany({
      data: lines.map(({ row, i, expected, unitCost, count }) => ({
        sheetId: sheet.id,
        seq: i + 1,
        itemId: row.itemId,
        batchId: row.batchId,
        locationId: row.locationId,
        qtyExpected: qty(expected),
        qtyCounted: count === null ? null : qty(count),
        unitCost: money(unitCost),
        countedBy: count === null ? null : users['a.saidov'],
        countedAt: count === null ? null : invAt,
      })),
    });
    invLines += lines.length;

    // Утверждённый лист обязан иметь под каждым расхождением движение: недостачу
    // списали, излишек приняли. Без этого лист говорит одно, журнал - другое.
    if (approved) {
      for (const { row, expected, unitCost, count } of lines) {
        if (count === null) continue;
        const diff = qty6(count - expected);
        if (Math.abs(diff) < 1e-6) continue;
        invDiffs += 1;
        const m = {
          companyId: row.companyId,
          movedAt: invAt,
          operationType: (diff > 0 ? 'surplus' : 'write_off') as 'surplus' | 'write_off',
          itemId: row.itemId,
          batchId: row.batchId,
          fromWarehouseId: diff < 0 ? row.warehouseId : null,
          fromLocationId: diff < 0 ? row.locationId : null,
          toWarehouseId: diff > 0 ? row.warehouseId : null,
          toLocationId: diff > 0 ? row.locationId : null,
          qty: qty(Math.abs(diff)),
          unitId: unitByItemId.get(row.itemId)!,
          qtyBase: qty(Math.abs(diff)),
          costTotal: money(Math.abs(diff) * unitCost),
          sourceDocType: 'inventory_sheet',
          sourceDocId: sheet.id,
          comment: `Инвентаризация ИНВ-${String(next).padStart(5, '0')}`,
          createdBy: users['s.radjabov'],
        };
        extra.push(m);
        foldInto(m, row.warehouseId, row.locationId, diff > 0 ? 1 : -1);
      }
    }
  }

  moves.push(...extra);
  await prisma.stockMove.createMany({
    data: moves.map(({ __shipmentNumber, ...m }: any) =>
      __shipmentNumber
        ? { ...m, sourceDocId: shipmentId.get(`${m.companyId}:${__shipmentNumber}`)! }
        : m,
    ),
  });

  // Резерв в остатке берём из тех же строк `stock_reservation`, которыми он
  // заведён, а не из партий отдельным счётом: два независимых счёта одного и
  // того же разойдутся, и разойдутся молча.
  const reservedByKey = new Map<string, number>();
  for (const r of reservationPayloads) {
    const key = `${r.warehouseId}:${r.itemId}:${r.batchId}`;
    reservedByKey.set(key, qty6((reservedByKey.get(key) ?? 0) + Number(r.qty)));
  }

  const balanceRows: any[] = [];
  for (const row of folded.values()) {
    if (row.qty <= 1e-6) continue;
    // Резерв стоит на партии, а партия после перекладки лежит в двух ячейках.
    // Поэтому резерв не копируем на каждую строку, а раскладываем по ячейкам,
    // пока не кончится: иначе зарезервировано окажется больше, чем заказано.
    const reserveKey = `${row.warehouseId}:${row.itemId}:${row.batchId}`;
    const left = reservedByKey.get(reserveKey) ?? 0;
    const reserved = Math.min(left, row.qty);
    reservedByKey.set(reserveKey, left - reserved);
    balanceRows.push({
      companyId: row.companyId,
      warehouseId: row.warehouseId,
      locationId: row.locationId,
      itemId: row.itemId,
      batchId: row.batchId,
      qtyOnHand: qty(row.qty),
      qtyReserved: qty(reserved),
      unitCost: money(row.qty > 0 ? Math.max(0, row.cost) / row.qty : 0),
      updatedAt: TODAY,
    });
  }
  await prisma.stockBalance.createMany({ data: balanceRows });

  // --- штучный учёт: серийные номера (ТЗ 5.6) -------------------------------
  //
  // Отдельным блоком, а не в общей свёртке движений: у штучной позиции строка
  // остатка своя на каждый номер и всегда равна единице, и складывать такие
  // строки в одну «двенадцать штук» нечем — вопрос к ним ровно обратный,
  // «где труба номер такой-то».
  const serialItem = items['PPU-530-710'];
  const serialWarehouse = warehouses['ZAVOD-GP'];
  const serialLocation = locationByWarehouse.get(serialWarehouse.id)![0];
  const serialCost = 33_900_000;
  const serialDefs = [
    // in_stock — лежат на складе готовой продукции, их видно в остатке
    ...Array.from({ length: 8 }, (_, i) => ({ n: i + 1, state: 'in_stock' as const })),
    // in_production — ушли на участок сборки теплотрассы
    { n: 9, state: 'in_production' as const },
    { n: 10, state: 'in_production' as const },
    // written_off — повреждены при разгрузке
    { n: 11, state: 'written_off' as const },
    { n: 12, state: 'written_off' as const },
  ];

  await prisma.serialNumber.createMany({
    data: serialDefs.map((d) => ({
      companyId: PLANT,
      itemId: serialItem.id,
      number: `SN-530-2026-${String(d.n).padStart(4, '0')}`,
      currentState: d.state,
    })),
  });
  const serialRows = await prisma.serialNumber.findMany({ where: { itemId: serialItem.id } });
  const serialMoves: any[] = [];
  const serialBalances: any[] = [];
  const serialReason = (await prisma.stockReason.findFirst({
    where: { companyId: PLANT, kind: 'write_off' },
  }))!;

  for (const row of serialRows) {
    const d = serialDefs.find((x) => row.number.endsWith(String(x.n).padStart(4, '0')))!;
    const base = {
      companyId: PLANT,
      itemId: serialItem.id,
      serialId: row.id,
      unitId: unitByItemId.get(serialItem.id)!,
      qty: qty(1),
      qtyBase: qty(1),
      costTotal: money(serialCost),
      createdBy: users['s.radjabov'],
    };
    serialMoves.push({
      ...base,
      movedAt: dayOffset(40 - d.n),
      operationType: 'receipt' as const,
      toWarehouseId: serialWarehouse.id,
      toLocationId: serialLocation,
    });
    if (d.state === 'in_stock') {
      serialBalances.push({
        companyId: PLANT,
        warehouseId: serialWarehouse.id,
        locationId: serialLocation,
        itemId: serialItem.id,
        serialId: row.id,
        qtyOnHand: qty(1),
        qtyReserved: qty(0),
        unitCost: money(serialCost),
        updatedAt: TODAY,
      });
      continue;
    }
    serialMoves.push({
      ...base,
      movedAt: dayOffset(10 - d.n),
      operationType: (d.state === 'in_production' ? 'issue_to_production' : 'write_off') as
        | 'issue_to_production'
        | 'write_off',
      fromWarehouseId: serialWarehouse.id,
      fromLocationId: serialLocation,
      reasonId: d.state === 'written_off' ? serialReason.id : null,
      comment: d.state === 'written_off' ? 'Повреждение изоляции при разгрузке' : null,
    });
  }
  await prisma.stockMove.createMany({ data: serialMoves });
  await prisma.stockBalance.createMany({ data: serialBalances });
  console.log(
    `серийный учёт: ${serialRows.length} номеров по ${serialItem.code}, ` +
      `${serialBalances.length} на складе, ${serialMoves.length} движений`,
  );

  const inCells = balanceRows.filter((r) => r.locationId !== null).length;
  const byKind = (k: string) => extra.filter((m) => m.operationType === k).length;
  console.log(
    `склад: ${moves.length} движений (списаний ${byKind('write_off')}, ` +
      `перекладок ${byKind('transfer')}, возвратов из цеха ${byKind('return_from_production')}, ` +
      `возвратов от клиента ${byKind('return_from_client')}, излишков ${byKind('surplus')}), ` +
      `${balanceRows.length} строк остатка, из них в ячейках ${inCells}`,
  );
  console.log(
    `инвентаризация: ${sheetPlans.length} листов, ${invLines} строк, ` +
      `${invDiffs} расхождений с движениями`,
  );

  // --- финансы --------------------------------------------------------------

  const accountDefs = [
    { code: '5010', ru: 'Касса', uz: 'Kassa', kind: 'cash' as const },
    { code: '5110', ru: 'Расчётный счёт UZS', uz: 'Hisob raqami UZS', kind: 'bank' as const },
    { code: '5210', ru: 'Валютный счёт USD', uz: 'Valyuta hisobi USD', kind: 'bank' as const },
    { code: '4010', ru: 'Расчёты с покупателями', uz: 'Xaridorlar bilan hisob-kitob', kind: 'receivable' as const },
    { code: '6010', ru: 'Расчёты с поставщиками', uz: 'Yetkazib beruvchilar bilan hisob-kitob', kind: 'payable' as const },
    { code: '9010', ru: 'Доход от реализации', uz: 'Sotuvdan daromad', kind: 'income' as const },
    { code: '9410', ru: 'Расходы периода', uz: 'Davr xarajatlari', kind: 'expense' as const },
    { code: '6410', ru: 'НДС к уплате', uz: 'To‘lanadigan QQS', kind: 'vat' as const },
  ];
  await prisma.account.createMany({
    data: [TRADE, PLANT].flatMap((companyId) =>
      accountDefs.map((a) => ({
        companyId,
        code: a.code,
        nameRu: a.ru,
        nameUz: a.uz,
        kind: a.kind,
        currencyId: a.code === '5210' ? currencies.USD : currencies.UZS,
      })),
    ),
  });
  const accounts = Object.fromEntries(
    (await prisma.account.findMany()).map((a) => [`${a.companyId}:${a.code}`, a.id]),
  );

  const cashflowDefs = [
    { ru: 'Поступление от покупателей', uz: 'Xaridorlardan tushum', dir: 'inflow' as const, act: 'operating' as const },
    { ru: 'Оплата поставщикам', uz: 'Yetkazib beruvchilarga to‘lov', dir: 'outflow' as const, act: 'operating' as const },
    { ru: 'Заработная плата', uz: 'Ish haqi', dir: 'outflow' as const, act: 'operating' as const },
    { ru: 'Налоги и сборы', uz: 'Soliqlar va yig‘imlar', dir: 'outflow' as const, act: 'operating' as const },
    { ru: 'Логистика и транспорт', uz: 'Logistika va transport', dir: 'outflow' as const, act: 'operating' as const },
    { ru: 'Закупка оборудования', uz: 'Uskuna xaridi', dir: 'outflow' as const, act: 'investing' as const },
  ];
  await prisma.cashflowItem.createMany({
    data: [TRADE, PLANT].flatMap((companyId) =>
      cashflowDefs.map((c) => ({ companyId, nameRu: c.ru, nameUz: c.uz, direction: c.dir, activity: c.act })),
    ),
  });
  const cashflowItems = await prisma.cashflowItem.findMany();

  // По каждому оплаченному заказу — операция прихода и сходящаяся проводка.
  const paidOrders = await prisma.salesOrder.findMany({
    where: { paidAmount: { gt: 0 } },
    select: { id: true, companyId: true, number: true, paidAmount: true, orderDate: true, partnerId: true },
  });

  let finSeq = 0;
  const finOps: any[] = [];
  for (const o of paidOrders) {
    finSeq += 1;
    const amount = Number(o.paidAmount);
    finOps.push({
      companyId: o.companyId,
      number: `ПП-${String(finSeq).padStart(6, '0')}`,
      operationType: 'income' as const,
      occurredAt: o.orderDate,
      accountId: accounts[`${o.companyId}:5110`],
      // Корреспондент пишем в саму операцию, а не только в проводку: по нему
      // строится сторно, и без него приход отменить нечем, а карточка при этом
      // показывает «—», хотя в проводке счёт есть.
      counterAccountId: accounts[`${o.companyId}:4010`],
      amount: money(amount),
      currencyId: currencies.UZS,
      rate: '1.00000000',
      amountBase: money(amount),
      cashflowItemId: cashflowItems.find((c) => c.companyId === o.companyId && c.direction === 'inflow')!.id,
      partnerId: o.partnerId,
      sourceDocType: 'sales_order',
      sourceDocId: o.id,
      status: 'posted' as const,
      createdBy: users[L.accountant],
      approvedBy: users[L.director],
      postedAt: o.orderDate,
      createdAt: o.orderDate,
    });
  }
  await prisma.financeOperation.createMany({ data: finOps });
  const finRows = await prisma.financeOperation.findMany({
    select: {
      id: true,
      companyId: true,
      amountBase: true,
      occurredAt: true,
      accountId: true,
      counterAccountId: true,
    },
  });

  // Проводка: дебет расчётного счёта, кредит расчётов с покупателями.
  // Триггер проверяет сходимость в конце транзакции, поэтому обе строки
  // обязаны уехать одной пачкой.
  await prisma.financeEntry.createMany({
    data: finRows.flatMap((op) => [
      {
        operationId: op.id,
        companyId: op.companyId,
        accountId: op.accountId,
        debit: op.amountBase,
        credit: '0',
        amountBase: op.amountBase,
        occurredAt: op.occurredAt,
      },
      {
        operationId: op.id,
        companyId: op.companyId,
        accountId: op.counterAccountId!,
        debit: '0',
        credit: op.amountBase,
        amountBase: op.amountBase,
        occurredAt: op.occurredAt,
      },
    ]),
  });

  // Бюджеты по ТЗ 6.6: период — месяц или квартал, а не произвольные дни.
  // Прежде посев ставил окно «30 дней назад — 30 вперёд»: ни месяц, ни квартал,
  // и экран не мог назвать период словами. Основной набор — прошлый полный
  // месяц (по нему виден и недобор, и перерасход), плюс по одному квартальному
  // бюджету на компанию: квартал в системе тоже должен быть видно.
  const monthStart = (shift: number) =>
    new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() + shift, 1));
  const monthEnd = (shift: number) =>
    new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() + shift + 1, 0));
  const quarterStart = () =>
    new Date(Date.UTC(TODAY.getUTCFullYear(), Math.floor(TODAY.getUTCMonth() / 3) * 3, 1));
  const quarterEnd = () =>
    new Date(Date.UTC(TODAY.getUTCFullYear(), Math.floor(TODAY.getUTCMonth() / 3) * 3 + 3, 0));

  await prisma.budget.createMany({
    data: [TRADE, PLANT].flatMap((companyId) => {
      const outflow = cashflowItems.filter(
        (c) => c.companyId === companyId && c.direction === 'outflow',
      );
      const dept = departments.find((d) => d.companyId === companyId)!.id;
      return [
        ...outflow.map((c, i) => ({
          companyId,
          // Часть бюджетов без подразделения: по ТЗ 6.6 оно необязательно, и
          // экран обязан показывать обе картины, а не только полную.
          departmentId: i % 4 === 3 ? null : dept,
          cashflowItemId: c.id,
          periodStart: dateOnly(monthStart(-1)),
          periodEnd: dateOnly(monthEnd(-1)),
          amountPlanned: money(intBetween(2, 14) * 500_000_000),
          // Порог предупреждения разный: 80 % по умолчанию, где-то 90, где-то
          // ровно 100 — «предупреждать только при перерасходе».
          thresholdWarnPercent: String(pick([80, 90, 90, 100])),
          responsibleId: i % 2 === 0 ? users[L.accountant] : users[L.director],
        })),
        {
          companyId,
          departmentId: dept,
          cashflowItemId: outflow[0]!.id,
          periodStart: dateOnly(quarterStart()),
          periodEnd: dateOnly(quarterEnd()),
          amountPlanned: money(intBetween(10, 30) * 500_000_000),
          thresholdWarnPercent: '90',
          responsibleId: users[L.director],
        },
      ];
    }),
  });
  // Расход, переводы и очередь согласования.
  //
  // Приход от покупателей — это ещё не финансы: на одних поступлениях экран
  // показывает один приток, план против нуля и пустую очередь согласования.
  // Ниже — вторая половина оборота: платежи по всем расходным статьям внутри
  // периода их бюджета, перевод на кассу, покупка валюты и операции, которые
  // ещё не проведены. Сторож — test/finance-seed.spec.ts.
  const budgets = await prisma.budget.findMany({
    select: {
      companyId: true,
      cashflowItemId: true,
      periodStart: true,
      periodEnd: true,
      amountPlanned: true,
    },
  });
  const itemById = new Map(cashflowItems.map((c) => [c.id, c]));

  /** Счёт-корреспондент: куда ложится расход по этой статье. */
  const counterAccountFor = (companyId: bigint, itemName: string) => {
    if (itemName.startsWith('Оплата поставщикам')) return accounts[`${companyId}:6010`];
    if (itemName.startsWith('Налоги')) return accounts[`${companyId}:6410`];
    return accounts[`${companyId}:9410`];
  };

  type Op = (typeof finOps)[number];
  const extraOps: Op[] = [];
  let expSeq = 0;
  /**
   * Сколько ушло наличными: ровно столько же плюс запас надо перевести в кассу
   * раньше, иначе остаток кассы уйдёт в минус — деньги, которых не было.
   */
  const cashSpent = new Map<string, number>();
  /** Самый ранний наличный расход компании в «днях назад»: перевод должен быть раньше него. */
  const cashFirstDay = new Map<string, number>();

  // Факт по бюджету: доля плана. Чередуем недобор и перерасход — отклонение
  // на экране должно быть видно в обе стороны, иначе колонку можно и не рисовать.
  budgets.forEach((b, i) => {
    const item = itemById.get(b.cashflowItemId)!;
    const planned = Number(b.amountPlanned);
    const factor = i % 3 === 0 ? between(1.04, 1.22) : between(0.58, 0.94);
    const payments = intBetween(6, 11);
    const fromCash = item.nameRu.startsWith('Логистика');
    let left = planned * factor;

    // Границы периода бюджета в «днях назад»: `dayOffset` отсчитывает от
    // сегодня, и нижняя граница — не раньше начала периода, верхняя — не
    // позже сегодняшнего дня.
    const daysBack = (d: Date) => Math.round((TODAY.getTime() - d.getTime()) / DAY);
    const factDayTo = Math.max(0, daysBack(b.periodEnd));
    const factDayFrom = Math.max(factDayTo, daysBack(b.periodStart));

    for (let n = 0; n < payments; n++) {
      // Последний платёж добирает остаток: сумма платежей обязана сойтись с
      // тем фактом, который мы задумали, иначе проверка отклонения врёт.
      const share = n === payments - 1 ? left : (left / (payments - n)) * between(0.7, 1.3);
      const amount = Math.max(1_000_000, Math.round(share));
      left -= amount;
      expSeq += 1;
      // Платёж ложится внутрь периода своего бюджета и не в будущее: иначе
      // факт считался бы по операциям, которых в этом периоде нет, а
      // проведённая операция с завтрашней датой — это ошибка учёта.
      const day = intBetween(factDayTo, factDayFrom);
      const byCash = fromCash && n % 2 === 0;
      if (byCash) {
        const key = String(b.companyId);
        cashSpent.set(key, (cashSpent.get(key) ?? 0) + amount);
        cashFirstDay.set(key, Math.max(cashFirstDay.get(key) ?? 0, day));
      }
      const account = byCash ? accounts[`${b.companyId}:5010`] : accounts[`${b.companyId}:5110`];
      extraOps.push({
        companyId: b.companyId,
        number: `РП-${String(expSeq).padStart(6, '0')}`,
        operationType: 'expense' as const,
        occurredAt: dayOffset(day),
        accountId: account,
        counterAccountId: counterAccountFor(b.companyId, item.nameRu),
        amount: money(amount),
        currencyId: currencies.UZS,
        rate: '1.00000000',
        amountBase: money(amount),
        cashflowItemId: b.cashflowItemId,
        partnerId: item.nameRu.startsWith('Оплата поставщикам')
          ? (suppliers.find((s) => s.companyId === b.companyId)?.id ?? null)
          : null,
        status: 'posted' as const,
        createdBy: users[L.accountant],
        approvedBy: users[L.director],
        postedAt: dayOffset(day),
        createdAt: dayOffset(day + 1),
      });
    }
  });

  // Перевод на кассу: наличные расходы должны браться откуда-то, а не
  // появляться на пустом счёте.
  for (const companyId of [TRADE, PLANT]) {
    // Переводим с запасом в 15% и раньше трат: касса не должна уходить в минус
    // ни в итоге, ни по ходу месяца.
    const needed = (cashSpent.get(String(companyId)) ?? 0) * 1.15;
    // Все переводы — до первого наличного расхода: бюджеты теперь стоят на
    // месяце и квартале, траты разъехались по датам, и фиксированные
    // «29 дней назад» загоняли кассу в минус посреди периода.
    const first = (cashFirstDay.get(String(companyId)) ?? 29) + 7;
    for (let n = 0; n < 6; n++) {
      expSeq += 1;
      const day = first - n;
      const amount = Math.max(100_000_000, Math.round(needed / 6));
      extraOps.push({
        companyId,
        number: `ПЕР-${String(expSeq).padStart(6, '0')}`,
        operationType: 'transfer' as const,
        occurredAt: dayOffset(day),
        // Счёт операции — тот, с которого деньги уходят: проводка ниже кредитует
        // его и дебетует счёт-корреспондент. Перепутать их местами значит
        // снять наличные из кассы в банк, а не наоборот.
        accountId: accounts[`${companyId}:5110`],
        counterAccountId: accounts[`${companyId}:5010`],
        amount: money(amount),
        currencyId: currencies.UZS,
        rate: '1.00000000',
        amountBase: money(amount),
        cashflowItemId: null,
        partnerId: null,
        status: 'posted' as const,
        createdBy: users[L.accountant],
        approvedBy: users[L.director],
        postedAt: dayOffset(day),
        createdAt: dayOffset(day),
      });
    }

    // Покупка валюты: курс берём того дня, а не сегодняшний, — иначе сумма в
    // сумах разойдётся с тем, что покажет отчёт за прошлый месяц.
    for (let n = 0; n < 3; n++) {
      expSeq += 1;
      const day = 24 - n * 8;
      const rateRow = rates.find(
        (r) => r.currencyId === currencies.USD && r.rateDate.getTime() === dateOnly(dayOffset(day)).getTime(),
      )!;
      const rate = Number(rateRow.rate);
      const usd = intBetween(20, 90) * 1_000;
      extraOps.push({
        companyId,
        number: `КНВ-${String(expSeq).padStart(6, '0')}`,
        operationType: 'conversion' as const,
        occurredAt: dayOffset(day),
        accountId: accounts[`${companyId}:5110`],
        counterAccountId: accounts[`${companyId}:5210`],
        amount: money(usd),
        currencyId: currencies.USD,
        rate: rate.toFixed(8),
        amountBase: money(usd * rate),
        cashflowItemId: null,
        partnerId: null,
        status: 'posted' as const,
        createdBy: users[L.accountant],
        approvedBy: users[L.director],
        postedAt: dayOffset(day),
        createdAt: dayOffset(day),
      });
    }
  }

  // Непроведённые: на них держится экран согласования. Проводок у них нет
  // намеренно — заявка на оплату не двигает остаток на счёте, пока её не
  // провели. Отклонённая остаётся в журнале: её видно, но она ни на что не влияет.
  const pendingDefs = [
    { status: 'draft' as const, count: 4, approved: false },
    { status: 'pending_approval' as const, count: 7, approved: false },
    { status: 'approved' as const, count: 3, approved: true },
    { status: 'rejected' as const, count: 2, approved: true },
  ];
  for (const companyId of [TRADE, PLANT]) {
    const outflow = cashflowItems.filter((c) => c.companyId === companyId && c.direction === 'outflow');
    for (const def of pendingDefs) {
      for (let n = 0; n < def.count; n++) {
        expSeq += 1;
        const item = pick(outflow);
        const day = intBetween(0, 9);
        const amount = intBetween(30, 900) * 1_000_000;
        extraOps.push({
          companyId,
          number: `ЗЯВ-${String(expSeq).padStart(6, '0')}`,
          operationType: 'expense' as const,
          occurredAt: dayOffset(day),
          plannedDate: dateOnly(dayOffset(day - intBetween(1, 12))),
          accountId: accounts[`${companyId}:5110`],
          counterAccountId: counterAccountFor(companyId, item.nameRu),
          amount: money(amount),
          currencyId: currencies.UZS,
          rate: '1.00000000',
          amountBase: money(amount),
          cashflowItemId: item.id,
          partnerId: item.nameRu.startsWith('Оплата поставщикам')
            ? (suppliers.find((s) => s.companyId === companyId)?.id ?? null)
            : null,
          status: def.status,
          createdBy: users[L.accountant],
          approvedBy: def.approved ? users[L.director] : null,
          postedAt: null,
          createdAt: dayOffset(day),
          comment:
            def.status === 'rejected'
              ? 'Отклонено: статья исчерпана, перенести на следующий период'
              : null,
        });
      }
    }
  }

  // Аванс поставщику. Оплата проведена, приходов по этому поставщику нет -
  // в отчёте по кредиторке это переплата, а не долг со знаком минус.
  expSeq += 1;
  extraOps.push({
    companyId: PLANT,
    number: `РП-${String(expSeq).padStart(6, '0')}`,
    operationType: 'expense' as const,
    occurredAt: dayOffset(18),
    accountId: accounts[`${PLANT}:5110`],
    counterAccountId: accounts[`${PLANT}:6010`],
    amount: money(420_000_000),
    currencyId: currencies.UZS,
    rate: '1.00000000',
    amountBase: money(420_000_000),
    cashflowItemId:
      cashflowItems.find(
        (c) => c.companyId === PLANT && c.nameRu.startsWith('Оплата поставщикам'),
      )?.id ?? null,
    partnerId: PLANT_ADVANCE_SUPPLIER.id,
    status: 'posted' as const,
    createdBy: users[L.accountant],
    approvedBy: users[L.director],
    postedAt: dayOffset(18),
    createdAt: dayOffset(19),
    comment: 'Аванс под поставку, товар ещё не поступил',
  });

  await prisma.financeOperation.createMany({ data: extraOps });

  // Проводка только у проведённых. Деньги уходят со счёта оплаты (кредит) и
  // ложатся на счёт-корреспондент (дебет): у перевода это касса, у покупки
  // валюты — валютный счёт, у расхода — поставщики, налоги или расходы периода.
  const extraPosted = await prisma.financeOperation.findMany({
    where: { status: 'posted', number: { not: { startsWith: 'ПП-' } } },
    select: { id: true, companyId: true, accountId: true, counterAccountId: true, amountBase: true, occurredAt: true },
  });
  await prisma.financeEntry.createMany({
    data: extraPosted.flatMap((op) => [
      {
        operationId: op.id,
        companyId: op.companyId,
        accountId: op.counterAccountId!,
        debit: op.amountBase,
        credit: '0',
        amountBase: op.amountBase,
        occurredAt: op.occurredAt,
      },
      {
        operationId: op.id,
        companyId: op.companyId,
        accountId: op.accountId,
        debit: '0',
        credit: op.amountBase,
        amountBase: op.amountBase,
        occurredAt: op.occurredAt,
      },
    ]),
  });

  const unposted = extraOps.length - extraPosted.length;
  console.log(
    `финансы: ${finOps.length + extraOps.length} операций ` +
      `(${extraOps.length - unposted} расход/перевод/конверсия, ${unposted} на согласовании), ` +
      `${(finRows.length + extraPosted.length) * 2} проводок`,
  );

  // --- CRM ------------------------------------------------------------------

  const stageDefs = [
    { code: 'new', ru: 'Новая заявка', uz: 'Yangi ariza', prob: 10 },
    { code: 'qualify', ru: 'Квалификация', uz: 'Malakalash', prob: 25 },
    { code: 'offer', ru: 'Коммерческое предложение', uz: 'Tijorat taklifi', prob: 50 },
    { code: 'contract', ru: 'Согласование договора', uz: 'Shartnomani kelishish', prob: 75 },
    { code: 'won', ru: 'Сделка заключена', uz: 'Bitim tuzilgan', prob: 100, final: true },
    { code: 'lost', ru: 'Сделка не состоялась', uz: 'Bitim amalga oshmadi', prob: 0, final: true },
  ];
  await prisma.dealStage.createMany({
    data: [TRADE, PLANT].flatMap((companyId) =>
      stageDefs.map((s, i) => ({
        companyId, seq: i + 1, code: s.code, nameRu: s.ru, nameUz: s.uz,
        probabilityDefault: s.prob, isFinal: s.final ?? false,
      })),
    ),
  });
  const dealStages = await prisma.dealStage.findMany();

  const leadNames = profile.leadNames;
  // Статус обращения и его следы должны сходиться: «стал клиентом» без ссылки
  // на карточку и «отказ» без причины — это ровно те дыры, которые правила
  // модуля запрещают, и показывать их в демо значит учить ими пользоваться.
  const LOST_REASONS = [
    'Дороже конкурента',
    'Сдвинулись сроки стройки',
    'Нет нужного типоразмера',
    'Передумал, взял у поставщика напрямую',
  ];
  await prisma.lead.createMany({
    data: Array.from({ length: 34 }, (_, i) => {
      const companyId = i % 2 === 0 ? TRADE : PLANT;
      const status = pick(['new', 'qualified', 'converted', 'rejected'] as const);
      return {
        companyId,
        sourceId: pick(leadSources.filter((s) => s.companyId === companyId)).id,
        name: `${pick(leadNames)} (заявка ${i + 1})`,
        phone: profile.leadPhone(i),
        email: profile.leadEmail(i),
        status,
        rejectReason: status === 'rejected' ? pick(LOST_REASONS) : null,
        partnerId:
          status === 'converted' ? pick(clientsByCompany.get(String(companyId))!).id : null,
        managerId: companyId === TRADE ? pick([users[L.salesTrade1], users[L.salesTrade2]]) : users[L.salesPlant],
        createdAt: dayOffset(intBetween(0, PERIOD_DAYS)),
      };
    }),
  });

  // Причины проигрыша — справочник компании (ТЗ 8.3), а не строка в сделке.
  const lostReasonDefs = [
    { code: 'price', ru: 'Дороже конкурента', uz: 'Raqobatchidan qimmat' },
    { code: 'timing', ru: 'Сдвинулись сроки стройки', uz: 'Qurilish muddati surildi' },
    { code: 'size', ru: 'Нет нужного типоразмера', uz: 'Kerakli o‘lcham yo‘q' },
    { code: 'direct', ru: 'Взял у производителя напрямую', uz: 'Ishlab chiqaruvchidan to‘g‘ridan-to‘g‘ri oldi' },
  ];
  await prisma.dealLostReason.createMany({
    data: [TRADE, PLANT].flatMap((companyId) =>
      lostReasonDefs.map((r) => ({ companyId, code: r.code, nameRu: r.ru, nameUz: r.uz })),
    ),
  });
  const lostReasons = await prisma.dealLostReason.findMany();

  // Сделка проходит воронку по порядку, и след переходов пишется вместе с ней:
  // конверсия между стадиями считается по следу, и сделка, «появившаяся» сразу
  // в договоре, нарисовала бы переход, которого не было.
  for (let i = 0; i < 46; i += 1) {
    const companyId = i % 2 === 0 ? TRADE : PLANT;
    const stages = dealStages
      .filter((s) => s.companyId === companyId)
      .sort((a, b) => a.seq - b.seq);
    const open = stages.filter((s) => !s.isFinal);
    const won = stages.find((s) => s.code === 'won')!;
    const lost = stages.find((s) => s.code === 'lost')!;
    const stage = pick(stages);
    const client = pick(clientsByCompany.get(String(companyId))!);
    const createdAt = dayOffset(intBetween(10, PERIOD_DAYS));

    // Путь: по открытым стадиям до текущей; выигранная прошла их все,
    // проигранная выбыла с какой-то из них.
    const reached = stage.isFinal
      ? open.slice(0, stage.code === 'won' ? open.length : intBetween(1, open.length))
      : open.slice(0, open.findIndex((s) => s.id === stage.id) + 1);
    const path = stage.isFinal ? [...reached, stage] : reached;

    const deal = await prisma.deal.create({
      data: {
        companyId,
        number: `СД-${String(i + 1).padStart(4, '0')}`,
        title: `Поставка ${pick(['арматуры А500С', 'труб ППУ-ПЭ', 'труб ТЭСА', 'листового проката', 'швеллера и балки'])} — ${client.nameRu}`,
        partnerId: client.id,
        managerId: client.managerId,
        stageId: stage.id,
        amount: money(intBetween(3, 42) * 100_000_000),
        currencyId: currencies.UZS,
        probability: stage.probabilityDefault,
        expectedCloseDate: dateOnly(dayOffset(-intBetween(1, 45))),
        status: stage.id === won.id ? 'won' : stage.id === lost.id ? 'lost' : 'open',
        lostReasonId:
          stage.id === lost.id
            ? pick(lostReasons.filter((r) => r.companyId === companyId)).id
            : null,
        createdAt,
        closedAt: stage.isFinal ? dayOffset(intBetween(0, 9)) : null,
        // Закрытие без комментария система не принимает — ни на заключении, ни
        // на отказе. Посев это правило обходил, и на стенде заключённые сделки
        // стояли без исхода словами: картина, которой у заказчика быть не может.
        closeComment: stage.isFinal
          ? stage.id === won.id
            ? pick([
                'Согласовали объём и срок поставки, предоплата 50%.',
                'Взяли по нашей цене после сравнения с конкурентом.',
                'Договорились на отгрузку партиями, первая — на этой неделе.',
                'Клиент вернулся после паузы, подписали на прежних условиях.',
              ])
            : pick([
                'Ушли к поставщику с более короткой отсрочкой.',
                'Проект заморозили до следующего квартала.',
                'Не сошлись по цене: просили ниже себестоимости.',
                'Нужного профиля не было в наличии в их срок.',
              ])
          : null,
      },
    });

    const step = Math.max(1, Math.floor((Date.now() - createdAt.getTime()) / (path.length + 1)));
    await prisma.dealStageEvent.createMany({
      data: path.map((s, k) => ({
        dealId: deal.id,
        fromStageId: k === 0 ? null : path[k - 1]!.id,
        toStageId: s.id,
        userId: client.managerId,
        at: new Date(createdAt.getTime() + step * k),
      })),
    });
  }

  // Источник у карточки клиента (ТЗ 8, отчёт по источникам).
  //
  // В жизни он попадает туда сам: превращение обращения переносит источник
  // заявки в карточку. В посеве клиенты заведены раньше обращений, и без этой
  // доводки отчёт по источникам показывал бы обращения отдельно, а сделки —
  // нулями: у карточек источника нет вовсе.
  //
  // Клиенту, на которого ссылается превращённое обращение, ставим источник
  // этого обращения — ровно то, что сделала бы служба. Остальным ставим
  // источник их компании: база подаётся как уже работающая, и клиенты в ней
  // откуда-то пришли.
  const convertedLeads = await prisma.lead.findMany({
    where: { status: 'converted', partnerId: { not: null } },
    select: { partnerId: true, sourceId: true },
  });
  const sourceByPartner = new Map<string, bigint>();
  for (const l of convertedLeads) sourceByPartner.set(String(l.partnerId), l.sourceId!);

  for (const p of await prisma.partner.findMany({ select: { id: true, companyId: true } })) {
    const fromLead = sourceByPartner.get(String(p.id));
    await prisma.partner.update({
      where: { id: p.id },
      data: {
        sourceId:
          fromLead ?? pick(leadSources.filter((s) => s.companyId === p.companyId)).id,
      },
    });
  }

  // --- задачи и активности (ТЗ 8.4) -----------------------------------------
  //
  // Экран задач существует ради просроченного, поэтому часть задач просрочена
  // намеренно: демо, где всё в будущем, не показывает того, ради чего модуль
  // сделан. Закрытая задача несёт результат и свою запись в ленте — ровно то,
  // что требует служба: показывать в демо состояние, которого система не
  // допускает, значит учить неправде.

  const dealsForTasks = await prisma.deal.findMany({
    select: { id: true, companyId: true, partnerId: true, managerId: true, status: true },
  });
  const openDeals = dealsForTasks.filter((d) => d.status === 'open' && d.partnerId !== null);

  const taskTitles: Record<string, string[]> = {
    call: ['Перезвонить по спецификации', 'Уточнить объём по арматуре', 'Согласовать дату отгрузки'],
    meeting: ['Встреча на объекте', 'Встреча в офисе: подписание договора'],
    letter: ['Выслать КП на трубу', 'Отправить реквизиты и счёт'],
    document: ['Подготовить договор поставки', 'Подготовить спецификацию к договору'],
    site_visit: ['Замер на объекте заказчика', 'Выезд на площадку: согласовать разгрузку'],
    other: ['Проверить остаток на складе перед отгрузкой'],
  };
  // Типы задач — справочник (ТЗ 8.4), а не перечисление: «выезд на объект»
  // здесь для того, чтобы на стенде было видно, что список правится, а не
  // вшит. Вид активности у типа обязателен — им закрытая задача ложится в
  // ленту клиента.
  const taskTypeDefs = [
    { code: 'call', ru: 'Звонок', uz: 'Qoʻngʻiroq', kind: 'call', seq: 10 },
    { code: 'meeting', ru: 'Встреча', uz: 'Uchrashuv', kind: 'meeting', seq: 20 },
    { code: 'letter', ru: 'Письмо', uz: 'Xat', kind: 'letter', seq: 30 },
    { code: 'document', ru: 'Подготовить документ', uz: 'Hujjat tayyorlash', kind: 'note', seq: 40 },
    { code: 'site_visit', ru: 'Выезд на объект', uz: 'Obyektga chiqish', kind: 'meeting', seq: 50 },
    { code: 'other', ru: 'Другое', uz: 'Boshqa', kind: 'note', seq: 60 },
  ] as const;
  await prisma.crmTaskType.createMany({
    data: [TRADE, PLANT].flatMap((companyId) =>
      taskTypeDefs.map((t) => ({
        companyId,
        code: t.code,
        nameRu: t.ru,
        nameUz: t.uz,
        activityKind: t.kind,
        seq: t.seq,
      })),
    ),
  });
  const crmTaskTypes = await prisma.crmTaskType.findMany();
  const taskTypeOf = (companyId: bigint, code: string) =>
    crmTaskTypes.find((t) => t.companyId === companyId && t.code === code)!;

  const taskTypes = ['call', 'call', 'meeting', 'letter', 'document', 'site_visit', 'other'] as const;
  const taskResults = [
    'Дозвонились, ждут счёт до конца недели',
    'Встретились на объекте, объём подтвердили',
    'Отправили, ждём ответ',
    'Подготовил, передал менеджеру на проверку',
  ];
  const HOUR = 60 * 60 * 1000;
  const startOfDayUtc = (ms: number) => Math.floor(ms / DAY) * DAY;

  for (let i = 0; i < openDeals.length; i += 1) {
    const d = openDeals[i]!;
    const type = taskTypes[i % taskTypes.length]!;
    const taskType = taskTypeOf(d.companyId, type);
    const title = pick(taskTitles[type]!);

    // Каждая четвёртая просрочена, каждая пятая — со сроком сегодня.
    const overdue = i % 4 === 0;
    const today = !overdue && i % 5 === 0;
    // Срок ставят на рабочее время, а не на полночь: «перезвонить в 05:00»
    // в демо выглядит опечаткой. TODAY — полночь UTC, то есть 05:00 по
    // Ташкенту, поэтому рабочий день здесь это +4…+12 часов от неё.
    const workHour = () => intBetween(4, 12) * HOUR;
    const dueAt = overdue
      ? new Date(TODAY.getTime() - intBetween(1, 6) * DAY + workHour())
      : today
        ? new Date(Date.now() + intBetween(2, 6) * HOUR)
        : new Date(startOfDayUtc(Date.now() + intBetween(2, 9) * DAY) + workHour());

    // Каждая третья уже сделана — иначе в ленте клиента пусто.
    const done = i % 3 === 2;
    const closedAt = done ? new Date(TODAY.getTime() - intBetween(1, 20) * DAY) : null;
    const result = done ? pick(taskResults) : null;

    const task = await prisma.crmTask.create({
      data: {
        companyId: d.companyId,
        typeId: taskType.id,
        title,
        dueAt: done ? new Date(closedAt!.getTime() - 2 * DAY) : dueAt,
        assigneeId: d.managerId!,
        partnerId: d.partnerId,
        dealId: d.id,
        status: done ? 'done' : 'open',
        result,
        createdBy: d.managerId,
        createdAt: new Date((done ? closedAt! : TODAY).getTime() - intBetween(3, 14) * DAY),
        closedAt,
      },
    });

    if (done) {
      await prisma.crmActivity.create({
        data: {
          companyId: d.companyId,
          type: taskType.activityKind,
          subject: title,
          note: result,
          at: closedAt!,
          partnerId: d.partnerId,
          dealId: d.id,
          taskId: task.id,
          userId: d.managerId,
        },
      });
    }
  }

  // Входящие звонки и заметки, которых не было в задачах: в жизни половина
  // общения начинается со звонка клиента, а не с нашей задачи.
  const inboundSubjects = [
    'Входящий: спрашивал наличие трубы 57×3,5',
    'Входящий: уточнял цену на арматуру А500С',
    'Заметка: просил счёт на новое юрлицо',
    'Заметка: работает через тендерную площадку',
  ];
  for (let i = 0; i < 18; i += 1) {
    const d = pick(openDeals);
    const call = i % 2 === 0;
    await prisma.crmActivity.create({
      data: {
        companyId: d.companyId,
        type: call ? 'call' : 'note',
        direction: call ? 'incoming' : null,
        durationSec: call ? intBetween(40, 480) : null,
        subject: pick(inboundSubjects),
        at: new Date(TODAY.getTime() - intBetween(1, 40) * DAY),
        partnerId: d.partnerId,
        userId: d.managerId,
      },
    });
  }

  const taskCount = await prisma.crmTask.count();
  const overdueCount = await prisma.crmTask.count({
    where: { status: 'open', dueAt: { lt: new Date() } },
  });
  const actCount = await prisma.crmActivity.count();
  console.log(
    `CRM: ${taskCount} задач (просрочено ${overdueCount}), ${actCount} активностей`,
  );

  // --- документы ------------------------------------------------------------

  const docTypeDefs = [
    { code: 'INV', ru: 'Счёт на оплату', uz: 'To‘lov uchun hisob', mask: 'СЧ-{YY}/{SEQ}' },
    { code: 'TTN', ru: 'Товарно-транспортная накладная', uz: 'Yuk xati', mask: 'ТТН-{YY}/{SEQ}' },
    { code: 'CONTRACT', ru: 'Договор поставки', uz: 'Yetkazib berish shartnomasi', mask: 'ДГ-{YY}/{SEQ}' },
    { code: 'SPEC', ru: 'Спецификация к договору', uz: 'Shartnomaga spetsifikatsiya', mask: 'СП-{YY}/{SEQ}' },
    { code: 'ACT', ru: 'Акт выполненных работ', uz: 'Bajarilgan ishlar dalolatnomasi', mask: 'АКТ-{YY}/{SEQ}' },
  ];
  await prisma.documentType.createMany({
    data: [TRADE, PLANT].flatMap((companyId) =>
      docTypeDefs.map((t) => ({
        companyId, code: t.code, nameRu: t.ru, nameUz: t.uz, numberingMask: t.mask,
      })),
    ),
  });
  const docTypes = await prisma.documentType.findMany();

  const recentOrders = await prisma.salesOrder.findMany({
    take: 120,
    orderBy: { orderDate: 'desc' },
    select: { id: true, companyId: true, partnerId: true, amountTotal: true, orderDate: true },
  });
  const docCounters = new Map<string, number>();
  const docs: any[] = [];
  for (const o of recentOrders) {
    for (const code of ['INV', 'TTN']) {
      const t = docTypes.find((dt) => dt.companyId === o.companyId && dt.code === code)!;
      const ckey = `${t.id}`;
      const next = (docCounters.get(ckey) ?? 0) + 1;
      docCounters.set(ckey, next);
      docs.push({
        companyId: o.companyId,
        documentTypeId: t.id,
        number: t.numberingMask.replace('{YY}', '26').replace('{SEQ}', String(next).padStart(5, '0')),
        documentDate: o.orderDate,
        partnerId: o.partnerId,
        sourceDocType: 'sales_order',
        sourceDocId: o.id,
        currencyId: currencies.UZS,
        amountTotal: Number(o.amountTotal).toFixed(2),
        status: pick(['approved', 'signed', 'pending_approval'] as const),
        createdBy: users[L.accountant],
        createdAt: o.orderDate,
      });
    }
  }
  await prisma.document.createMany({ data: docs });

  // Строки, реквизиты и суммы выписанных документов (ТЗ 7.1, 7.2).
  //
  // Без них печатная форма собирается пустой: в бумаге остаются заголовки,
  // а таблица позиций и «получатель» — нет. Документ — снимок, поэтому здесь
  // всё записывается в него, а не берётся из заказа при печати.
  const { amountInWords } = await import('../src/documents/amount-words.js');
  const docCompanyRows = await prisma.company.findMany({
    select: {
      id: true, nameRu: true, nameUz: true, inn: true,
      legalAddress: true, bankDetails: true, baseCurrency: true,
    },
  });
  const companyById = new Map(docCompanyRows.map((c) => [String(c.id), c]));
  const docPartnerRows = await prisma.partner.findMany({
    select: {
      id: true, nameRu: true, nameUz: true, inn: true,
      legalAddress: true, actualAddress: true, bankDetails: true,
      paymentDelayDays: true,
    },
  });
  const partnerById = new Map(docPartnerRows.map((p) => [String(p.id), p]));
  const orderById = new Map(
    (
      await prisma.salesOrder.findMany({
        where: { id: { in: recentOrders.map((o) => o.id) } },
        select: {
          id: true, number: true, paymentDueDate: true, deliveryDate: true,
          amountNet: true, amountVat: true, amountTotal: true,
        },
      })
    ).map((o) => [String(o.id), o]),
  );
  const orderLines = await prisma.salesOrderLine.findMany({
    where: { salesOrderId: { in: recentOrders.map((o) => o.id) } },
    orderBy: { seq: 'asc' },
    select: {
      salesOrderId: true, seq: true, itemId: true, qty: true, price: true,
      discountPercent: true, vatRate: true,
      amountNet: true, amountVat: true, amountTotal: true,
      item: { select: { code: true, nameRu: true, nameUz: true } },
      unit: { select: { code: true, nameRu: true, nameUz: true } },
    },
  });
  const linesByOrder = new Map<string, typeof orderLines>();
  for (const l of orderLines) {
    const k = String(l.salesOrderId);
    if (!linesByOrder.has(k)) linesByOrder.set(k, []);
    linesByOrder.get(k)!.push(l);
  }

  const createdDocs = await prisma.document.findMany({
    where: { sourceDocType: 'sales_order' },
    select: {
      id: true, companyId: true, partnerId: true, sourceDocId: true, locale: true,
    },
  });
  const docLines: any[] = [];
  for (const d of createdDocs) {
    const order = orderById.get(String(d.sourceDocId));
    const co = companyById.get(String(d.companyId));
    if (!order || !co) continue;
    const lines = linesByOrder.get(String(d.sourceDocId)) ?? [];
    const uz = d.locale === 'uz';
    const partner = d.partnerId ? partnerById.get(String(d.partnerId)) : null;

    for (const [i, l] of lines.entries()) {
      docLines.push({
        companyId: d.companyId,
        documentId: d.id,
        seq: i + 1,
        itemId: l.itemId,
        itemCode: l.item.code,
        name: uz ? l.item.nameUz : l.item.nameRu,
        qty: l.qty,
        unitCode: l.unit.code,
        unitName: uz ? l.unit.nameUz : l.unit.nameRu,
        price: l.price,
        discountPercent: l.discountPercent,
        vatRate: l.vatRate,
        // Деньги документа — тийины, не доли тийина (то же правило, что в
        // `from-source.service.ts`): в заказе цена держит четыре знака, а
        // документ показывает два, и несведённый остаток всплывал суммой
        // прописью, расходившейся с шапкой на тийин.
        amountNet: Number(l.amountNet).toFixed(2),
        amountVat: Number(l.amountVat).toFixed(2),
        amountTotal: Number(l.amountTotal).toFixed(2),
      });
    }

    await prisma.document.update({
      where: { id: d.id },
      data: {
        amountNet: Number(order.amountNet).toFixed(2),
        amountVat: Number(order.amountVat).toFixed(2),
        requisites: {
          company: {
            name: uz ? co.nameUz : co.nameRu,
            inn: co.inn,
            legalAddress: co.legalAddress,
            bank: co.bankDetails ?? null,
          },
          partner: partner && {
            name: uz ? partner.nameUz : partner.nameRu,
            inn: partner.inn,
            legalAddress: partner.legalAddress,
            actualAddress: partner.actualAddress,
            bank: partner.bankDetails ?? null,
          },
          basis: `Заказ ${order.number}`,
          paymentDueDate: order.paymentDueDate
            ? order.paymentDueDate.toISOString().slice(0, 10)
            : null,
          paymentDelayDays: partner?.paymentDelayDays ?? null,
          deliveryDate: order.deliveryDate
            ? order.deliveryDate.toISOString().slice(0, 10)
            : null,
          vehicle: null, driver: null, netWeightT: null, grossWeightT: null,
          currency: co.baseCurrency,
          amountInWords: amountInWords(
            Number(order.amountTotal).toFixed(2),
            co.baseCurrency,
            uz ? 'uz' : 'ru',
          ),
        },
      },
    });
  }
  await prisma.documentLine.createMany({ data: docLines });

  await prisma.documentCounter.createMany({
    data: [...docCounters.entries()].map(([typeId, last]) => {
      const t = docTypes.find((dt) => String(dt.id) === typeId)!;
      return { companyId: t.companyId, documentTypeId: t.id, periodKey: '2026', lastNumber: last };
    }),
  });

  // Черновые печатные формы (ТЗ 7.2).
  //
  // Без опубликованного шаблона «Скачать DOCX» не работает, а образцы
  // заказчика ещё не приехали. Кладём свои заготовки — на счёт, накладную,
  // акт и спецификацию, на двух языках. Придут настоящие — загружаются
  // файлами поверх, код не меняется.
  const { draftForm, draftFormFileName, DRAFT_FORM_CODES } = await import(
    '../src/documents/draft-forms.js'
  );
  const { TemplateHandler } = await import('easy-template-x');
  const tagReader = new TemplateHandler();
  let tplCount = 0;
  for (const t of docTypes) {
    if (!DRAFT_FORM_CODES.includes(t.code)) continue;
    for (const locale of ['ru', 'uz'] as const) {
      const file = await draftForm(t.code, locale);
      // Теги читаем из собранного файла тем же разбором, что и загрузка с
      // экрана: иначе у посева и у администратора вышли бы разные списки.
      const raw = await tagReader.parseTags(file);
      const seen = new Map<string, string>();
      for (const tag of raw) {
        const name = String(tag.name ?? '').trim();
        if (name && !seen.has(name)) {
          seen.set(name, String(tag.disposition) === 'SelfClosed' ? 'text' : 'block');
        }
      }
      await prisma.documentTemplate.create({
        data: {
          companyId: t.companyId,
          documentTypeId: t.id,
          locale,
          version: 1,
          fileName: draftFormFileName(t.code, locale),
          fileSize: file.length,
          content: new Uint8Array(file),
          tags: [...seen.entries()].map(([name, kind]) => ({
            name,
            kind,
            known: true,
            mappedTo: null,
          })),
          isPublished: true,
          publishedAt: new Date(),
          createdBy: users[L.accountant],
        },
      });
      tplCount += 1;
    }
  }
  console.log(
    `Документы: ${docs.length} шт., строк ${docLines.length}, шаблонов печати ${tplCount}`,
  );

  // --- вложения (ТЗ 5.4, 5.6, 6.3) -----------------------------------------
  // Стенд должен показывать вложение, а не пустую панель: без единого файла не
  // видно ни просмотра фото, ни скачивания сертификата. Файлы кладём тем же
  // хранилищем, что и приложение, — иначе сид разошёлся бы с ним в ключах.
  const { LocalDiskStorage, defaultStorageRoot, sha256 } = await import(
    '../src/attachments/storage.js'
  );
  const { storageKey } = await import('../src/attachments/attachments.js');
  const { demoPdf, demoPng } = await import('./demo-files.js');

  const storage = new LocalDiskStorage(defaultStorageRoot());

  /**
   * Номера в системе кириллические («СР-00001»), а имя демо-файла читают
   * в списке загрузок. Выбрасывать кириллицу нельзя: остаётся «--00001».
   */
  const TRANSLIT: Record<string, string> = {
    А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ж: 'ZH', З: 'Z', И: 'I',
    Й: 'Y', К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O', П: 'P', Р: 'R', С: 'S',
    Т: 'T', У: 'U', Ф: 'F', Х: 'H', Ц: 'C', Ч: 'CH', Ш: 'SH', Щ: 'SCH',
    Ы: 'Y', Э: 'E', Ю: 'YU', Я: 'YA', Ь: '', Ъ: '',
  };
  const translit = (v: string): string =>
    [...v.toUpperCase()]
      .map((ch) => TRANSLIT[ch] ?? ch)
      .join('')
      .replace(/[^A-Za-z0-9-]/g, '');

  const attachTo = async (
    owner: 'stock_move' | 'batch' | 'finance_operation' | 'partner',
    ownerId: bigint,
    companyId: bigint,
    kind: 'photo' | 'scan' | 'certificate' | 'other',
    fileName: string,
    mime: string,
    bytes: Buffer,
    comment: string,
    userId: bigint,
  ) => {
    const column =
      owner === 'stock_move'
        ? 'stock_move_id'
        : owner === 'batch'
          ? 'batch_id'
          : owner === 'partner'
            ? 'partner_id'
            : 'finance_operation_id';
    const rows = await prisma.$queryRawUnsafe<{ uid: string; id: bigint }[]>(
      `INSERT INTO attachment (company_id, ${column}, kind, file_name, mime_type,
                               size_bytes, sha256, storage_key, comment, created_by)
       VALUES ($1, $2, $3::"AttachmentKind", $4, $5, $6, $7, 'seed:' || gen_random_uuid()::text, $8, $9)
       RETURNING uid, id`,
      companyId,
      ownerId,
      kind,
      fileName,
      mime,
      bytes.length,
      sha256(bytes),
      comment,
      userId,
    );
    const created = rows[0]!;
    const key = storageKey(companyId, created.uid, mime);
    await prisma.$queryRawUnsafe(`UPDATE attachment SET storage_key = $1 WHERE id = $2`, key, created.id);
    await storage.put(key, bytes);
  };

  const keeperId = users[L.warehouse] ?? users[profile.users[0]!.login]!;
  const accountantId = users[L.accountant] ?? keeperId;

  // Сертификат качества — у партий с номером сертификата: там он и обещан.
  const certBatches = await prisma.batch.findMany({
    where: { certificateNumber: { not: null } },
    select: { id: true, companyId: true, number: true, certificateNumber: true },
    orderBy: { id: 'asc' },
    take: 4,
  });
  for (const b of certBatches) {
    await attachTo(
      'batch',
      b.id,
      b.companyId,
      'certificate',
      `sertifikat-${translit(b.number)}.pdf`,
      'application/pdf',
      demoPdf(`QUALITY CERTIFICATE ${b.certificateNumber} (demo) batch ${b.number}`),
      'Сертификат качества партии (демо)',
      keeperId,
    );
  }

  // Фото — к списаниям и приёмкам: именно там его требуют, чтобы потом
  // объяснить недостачу и брак.
  const photoMoves = await prisma.stockMove.findMany({
    where: { operationType: { in: ['write_off', 'receipt'] } },
    select: { id: true, companyId: true, operationType: true },
    orderBy: { id: 'asc' },
    take: 6,
  });
  for (const [i, m] of photoMoves.entries()) {
    const writeOff = m.operationType === 'write_off';
    await attachTo(
      'stock_move',
      m.id,
      m.companyId,
      'photo',
      writeOff ? `foto-brak-${i + 1}.png` : `foto-priemka-${i + 1}.png`,
      'image/png',
      demoPng(96, writeOff ? [196, 84, 64] : [96, 132, 176]),
      writeOff ? 'Фото брака при списании (демо)' : 'Фото штабеля при приёмке (демо)',
      keeperId,
    );
  }

  // Скан накладной — к расходным финансовым операциям (ТЗ 6.3).
  const payments = await prisma.financeOperation.findMany({
    select: { id: true, companyId: true, number: true },
    orderBy: { id: 'asc' },
    take: 3,
  });
  for (const op of payments) {
    await attachTo(
      'finance_operation',
      op.id,
      op.companyId,
      'scan',
      `nakladnaya-${translit(op.number)}.pdf`,
      'application/pdf',
      demoPdf(`INVOICE SCAN (demo) operation ${op.number}`),
      'Скан накладной (демо)',
      accountantId,
    );
  }

  // Доверенность и карточка предприятия — к клиенту (ТЗ 8.2, вкладка «файлы»).
  const filedPartners = await prisma.partner.findMany({
    where: { isClient: true },
    select: { id: true, companyId: true, nameRu: true, managerId: true },
    orderBy: { id: 'asc' },
    take: 4,
  });
  for (const [i, p] of filedPartners.entries()) {
    const card = i % 2 === 0;
    await attachTo(
      'partner',
      p.id,
      p.companyId,
      'scan',
      card ? `kartochka-predpriyatiya-${i + 1}.pdf` : `doverennost-${i + 1}.pdf`,
      'application/pdf',
      demoPdf(`${card ? 'COMPANY CARD' : 'POWER OF ATTORNEY'} (demo) ${p.nameRu}`),
      card ? 'Карточка предприятия (демо)' : 'Доверенность на получение (демо)',
      p.managerId ?? accountantId,
    );
  }

  // История карточки клиента начинается там, где её начала система: записью
  // о заведении. Выдумывать клиентам правки задним числом нельзя — журнал
  // читают как доказательство, а не как украшение экрана.
  const allPartners = await prisma.partner.findMany({
    select: { id: true, uid: true, companyId: true, nameRu: true, inn: true, createdAt: true, managerId: true },
  });
  await prisma.auditLog.createMany({
    data: allPartners.map((p) => ({
      companyId: p.companyId,
      userId: p.managerId,
      occurredAt: p.createdAt,
      entityType: 'partner',
      entityId: p.uid,
      action: 'create',
      changes: { nameRu: { from: null, to: p.nameRu }, inn: { from: null, to: p.inn } },
    })),
  });

  const attachments = await prisma.attachment.count();
  console.log(`вложения: ${attachments}`);

  console.log(`документы: ${docs.length}`);
  console.log(`готово, профиль «${profile.name}»`);

  // Пароль демонстрационного прогона нигде не хранится: он печатается здесь
  // один раз, и это единственная возможность его узнать. Потерялся — сид
  // прогоняется заново. Логины перечисляем: в этом профиле они другие.
  if (profile.name === 'demo') {
    console.log('');
    console.log('--- учётные записи демо-стенда, сохраните сейчас ---');
    console.log(`пароль у всех, кроме названных ниже: ${password}`);
    for (const u of profile.users) {
      console.log(`  ${u.login} — ${u.fullName}${u.password ? ` (пароль постоянный: ${u.password})` : ''}`);
    }
    console.log('--- второй раз пароль не покажет никто ---');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
