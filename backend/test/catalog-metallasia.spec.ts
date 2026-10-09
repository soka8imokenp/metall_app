/**
 * Номенклатура «Металл Азии» в базе - это каталог заказчика, а не наша выдумка.
 *
 * Поручение Отабека (группа проекта, 08.10.2026): «у них есть сайт с каталогом
 * https://metallasia.uz/ru/ изучи ее, и поменяй наши данные ( то что демо
 * придумано ) на их, все характеристики и тд тоже напиши».
 *
 * Проверка держит две вещи. Первая - раскладка выгрузки по полям номенклатуры
 * не разъезжается с самой выгрузкой: код уникален, характеристики заполнены,
 * масса метра считается по формуле, а не берётся из воздуха. Вторая - в базе
 * у торговой компании лежит ровно этот каталог, и придуманные демо-позиции
 * (арматура, балка, швеллер, уголок, лист) из неё ушли. Без второй половины
 * достаточно забыть пересев, и система снова показывает выдуманный товар.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CATALOG_PRODUCTS,
  CATALOG_SITE,
  THICK_WALL_COUNT,
  catalogGroups,
  catalogItemDefs,
  massPerMetre,
} from '../prisma/catalog-metallasia.js';

const defs = catalogItemDefs();

describe('выгрузка каталога', () => {
  it('снята с сайта заказчика и не растеряла позиции', () => {
    expect(CATALOG_SITE).toBe('metallasia.uz');
    expect(CATALOG_PRODUCTS).toHaveLength(303);
    expect(defs).toHaveLength(CATALOG_PRODUCTS.length);
  });

  it('код у каждой позиции свой', () => {
    expect(new Set(defs.map((d) => d.code)).size).toBe(defs.length);
    // 15 позиций различаются в каталоге только остатком: изготовителя выгрузка
    // потеряла. Им и достаётся числовой суффикс, остальным он не нужен.
    expect(defs.filter((d) => /-\d$/.test(d.code)).length).toBe(8);
  });

  it('характеристики заполнены у всех позиций', () => {
    for (const d of defs) {
      expect(d.attrs.diameterMm, d.code).toBeGreaterThan(0);
      expect(d.attrs.wallThicknessMm, d.code).toBeGreaterThan(0);
      expect(String(d.attrs.gost), d.code).toMatch(/^(ГОСТ|ТУ)\s/);
      expect(String(d.attrs.steelGrade), d.code).not.toBe('');
      expect(String(d.attrs.pipeType), d.code).not.toBe('');
      expect(d.stockT, d.code).toBeGreaterThan(0);
    }
  });

  it('масса метра - по формуле (D - S) × S × 0,02466', () => {
    expect(massPerMetre(114, 5)).toBeCloseTo(13.44, 2);
    // Невозможная геометрия не даёт числа вместо ошибки.
    expect(massPerMetre(20, 10)).toBeNull();
    const withMass = defs.filter((d) => d.attrs.weightKgPerUnit !== undefined);
    expect(withMass).toHaveLength(defs.length);
  });

  it('название собрано из данных заказчика, а не из шаблона с пропуском', () => {
    const d = defs.find((x) => x.code === 'TR-114X5-8732-78-09G2S')!;
    expect(d.ru).toBe('Труба стальная 114×5 мм бесшовная горячекатанная, 09Г2С, ГОСТ 8732-78');
    expect(d.uz).toContain('Po‘lat quvur 114×5 mm');
    expect(d.uz).toContain('GOST 8732-78');
    for (const x of defs) {
      expect(x.ru, x.code).not.toMatch(/undefined|NaN|,\s*,/);
      expect(x.uz, x.code).not.toMatch(/undefined|NaN|,\s*,/);
    }
  });

  it('узбекское название целиком латиницей', () => {
    // Кириллица внутри узбекского названия выключает сверку поля в `qa/web-uz`:
    // смешанная надпись там считается непереведённой, и проверка «показано не
    // то поле» молча перестаёт работать по всему каталогу.
    const mixed = defs.filter((d) => /[А-Яа-яЁё]/.test(d.uz));
    expect(mixed.map((d) => `${d.code}: ${d.uz}`)).toEqual([]);
    expect(defs.find((d) => d.code === 'TR-114X5-8732-78-09G2S')!.uz).toContain('09G2S');
  });

  it('группы повторяют дерево терминов каталога', () => {
    const g = catalogGroups();
    expect(g.filter((x) => !x.parentRu).map((x) => x.ru)).toEqual(['Бесшовная', 'Электросварная']);
    expect(g.filter((x) => x.parentRu).map((x) => `${x.parentRu}/${x.ru}`).sort()).toEqual([
      'Бесшовная/Горячекатанная',
      'Бесшовная/Холоднокатанная',
      'Электросварная/Прямошовная',
    ]);
  });

  it('подозрительные стенки посчитаны, а не замолчены', () => {
    expect(THICK_WALL_COUNT).toBe(50);
  });
});

describe('номенклатура торговой компании в базе', () => {
  let db: Client;
  let tradeId: string;

  beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const r = await db.query(`SELECT id FROM company WHERE code = 'trade'`);
    tradeId = r.rows[0].id;
  });

  afterAll(async () => {
    await db.end();
  });

  it('это каталог заказчика, позиция в позицию', async () => {
    // Порядок сверяем своим сравнением, а не `ORDER BY`: сортировка Postgres
    // идёт по collation базы и с сортировкой JS не совпадает.
    const r = await db.query(`SELECT code FROM item WHERE company_id = $1`, [tradeId]);
    expect(r.rows.map((x) => x.code).sort()).toEqual(defs.map((d) => d.code).sort());
  });

  it('придуманного демо-товара в ней нет', async () => {
    const r = await db.query(
      `SELECT code FROM item WHERE company_id = $1
         AND (code LIKE 'ARM-%' OR code LIKE 'BALKA-%' OR code LIKE 'SHVELLER-%'
              OR code LIKE 'UGOL-%' OR code LIKE 'LIST-%')`,
      [tradeId],
    );
    expect(r.rows).toEqual([]);
  });

  it('характеристики доехали до item_attribute', async () => {
    const r = await db.query(
      `SELECT i.code, a.diameter_mm, a.wall_thickness_mm, a.steel_grade, a.gost,
              a.weight_kg_per_unit, a.pipe_type
         FROM item i JOIN item_attribute a ON a.item_id = i.id
        WHERE i.company_id = $1`,
      [tradeId],
    );
    expect(r.rows).toHaveLength(defs.length);
    const byCode = new Map(r.rows.map((x) => [x.code, x]));
    for (const d of defs) {
      const row = byCode.get(d.code);
      expect(row, d.code).toBeDefined();
      expect(Number(row.diameter_mm), d.code).toBe(d.attrs.diameterMm);
      expect(Number(row.wall_thickness_mm), d.code).toBe(d.attrs.wallThicknessMm);
      expect(row.steel_grade, d.code).toBe(d.attrs.steelGrade);
      expect(row.gost, d.code).toBe(d.attrs.gost);
      expect(row.pipe_type, d.code).toBe(d.attrs.pipeType);
      expect(Number(row.weight_kg_per_unit), d.code).toBeCloseTo(
        d.attrs.weightKgPerUnit as number,
        2,
      );
    }
  });

  it('начальный приход позиции - те тонны, что показывает сайт', async () => {
    // Сверяется приход по партии, а не текущий остаток: по складу гуляют
    // списания, перекладки и излишки, и остаток законно уезжает от каталога.
    // А вот сколько товара завели на старте - это ровно каталожное число.
    const r = await db.query(
      `SELECT i.code, SUM(m.qty)::text AS qty
         FROM item i JOIN stock_move m ON m.item_id = i.id
        WHERE i.company_id = $1 AND m.operation_type = 'receipt'
          AND m.source_doc_type = 'batch'
        GROUP BY i.code`,
      [tradeId],
    );
    const byCode = new Map(r.rows.map((x) => [x.code, Number(x.qty)]));
    // Ходовые позиции закупаются каждые десять дней, их приход сайту не равен.
    for (const d of defs.filter((x) => !x.rotating)) {
      expect(byCode.get(d.code), d.code).toBeCloseTo(d.stockT, 6);
    }
    const total = defs.filter((x) => !x.rotating).reduce((s, d) => s + d.stockT, 0);
    expect(total).toBeGreaterThan(2000);
  });
});
