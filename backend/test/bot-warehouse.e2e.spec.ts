/**
 * Склад в боте (ТЗ 11.3, решение заказчика 02.10 — весь функционал).
 *
 * Проверяется работа кладовщика целиком: найти остаток, принять товар, отменить
 * ошибочное движение, списать с причиной, пересчитать полку. И отдельно то, без
 * чего бота нельзя пускать к остаткам: право проверяется на нажатии, а не
 * только при отрисовке кнопок, и повторная доставка одного нажатия не
 * удваивает приход.
 *
 * Разговор идёт через те же методы, что зовёт Telegram, но без Telegram и без
 * привязки учётной записи: привязка у человека одна, и два файла проверок,
 * идущих параллельно, отбирали бы её друг у друга. Один раз так и вышло.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { HUB_ITEM } from '../prisma/catalog-metallasia.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { WarehouseModule } from '../src/warehouse/warehouse.module.js';
import { AttachmentsModule } from '../src/attachments/attachments.module.js';
import { InventoryService } from '../src/warehouse/inventory.service.js';
import { BotWarehouse } from '../src/bot/warehouse.bot.js';
import { asUser, type Me, type Screen } from '../src/bot/section.js';
import type { SectionFlow } from '../src/bot/section.js';
import { devProfile } from '../prisma/seed-profiles.js';

/**
 * Названия компаний берутся из сида, а не пишутся строкой: юрлица
 * переименовали 08.10, и тесты про приход и пересчёт упали на кнопке выбора
 * компании - то есть ругались не на то, что проверяют.
 */
const TRADE = devProfile.companies.find((c) => c.code === 'trade')!.nameRu;
const PLANT = devProfile.companies.find((c) => c.code === 'plant')!.nameRu;

/** Кладовщик: принимает, списывает, считает — но не утверждает пересчёт. */
const KEEPER = 'a.saidov';
/** Директор: ему выдано утверждение пересчёта. */
const BOSS = 's.radjabov';

/** Куда кладём товар проверки: зона, которую не выберет проверка пересчёта. */
const WAREHOUSE = 'SERGELI';
/** Склад и зона под пересчёт — другие, чтобы два листа не столкнулись. */
const SHEET_WAREHOUSE = 'ZAVOD-SYR';
const SHEET_ZONE = 'B';
const ITEM = HUB_ITEM.code;
const BATCH = `БОТ-${Date.now()}`;

let wh: BotWarehouse;
let inventory: InventoryService;
let db: Client;
let keeper: Me;
let boss: Me;
let sheetUid = '';

const plain = (s: Screen) =>
  (s.text ?? '')
    .replace(/<blockquote>|<\/blockquote>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/ /g, ' ');

const buttons = (s: Screen) => s.keyboard.flat().map((b) => b.text);

/** Разговор, как он идёт у человека: состояние живёт между нажатиями. */
class Talk {
  flow: SectionFlow | null = null;
  screen!: Screen;

  constructor(private readonly me: Me) {}

  async press(data: string) {
    this.screen = await wh.route(this.me, this.flow, data, false);
    if (this.screen.flow !== undefined) this.flow = this.screen.flow;
    return this.screen;
  }

  async tap(prefix: string) {
    const all = this.screen.keyboard.flat();
    const hit =
      all.find((b) => b.text.startsWith(prefix)) ?? all.find((b) => b.text.includes(prefix));
    expect(hit, `кнопки «${prefix}» нет: ${all.map((b) => b.text).join(' | ')}`).toBeTruthy();
    return this.press(hit!.data);
  }

  async say(text: string) {
    expect(this.flow, 'разговора нет, писать некуда').toBeTruthy();
    this.screen = await wh.text(this.me, this.flow!, text, false);
    if (this.screen.flow !== undefined) this.flow = this.screen.flow;
    return this.screen;
  }
}

async function profile(login: string): Promise<Me> {
  const row = await db.query('SELECT id FROM user_account WHERE login = $1', [login]);
  const userId = BigInt(row.rows[0].id);
  const auth = await authService.loadProfile(userId);
  const companies = await authService.companies(auth.companyIds);
  return {
    userId,
    permissions: auth.permissions,
    companyIds: auth.companyIds,
    companies: companies.map((c) => ({
      id: BigInt(c.id),
      uid: c.uid,
      nameRu: c.nameRu,
      nameUz: c.nameUz,
    })),
  };
}

let authService: AuthService;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, WarehouseModule, AttachmentsModule],
    providers: [BotWarehouse],
  }).compile();
  wh = moduleRef.get(BotWarehouse);
  inventory = moduleRef.get(InventoryService);
  authService = moduleRef.get(AuthService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  keeper = await profile(KEEPER);
  boss = await profile(BOSS);
}, 60_000);

afterAll(async () => {
  // Лист пересчёта за собой закрываем: открытый лист занимает склад, и
  // соседняя проверка не сможет открыть свой.
  if (sheetUid) {
    const row = await db.query(`SELECT status::text AS s FROM inventory_sheet WHERE uid = $1`, [
      sheetUid,
    ]);
    if (['draft', 'counting', 'review'].includes(row.rows[0]?.s)) {
      await asUser(keeper, false, () => inventory.cancel(sheetUid));
    }
  }
  await db.end();
});

async function onHand(cell: string | null): Promise<number> {
  const out = await db.query<{ qty: string }>(
    `SELECT coalesce(sum(b.qty_on_hand), 0)::text AS qty
       FROM stock_balance b
       JOIN warehouse w ON w.id = b.warehouse_id
       JOIN item i ON i.id = b.item_id
       LEFT JOIN batch bt ON bt.id = b.batch_id
       LEFT JOIN storage_location l ON l.id = b.location_id
       LEFT JOIN warehouse_zone z ON z.id = l.zone_id
      WHERE w.code = $1 AND i.code = $2 AND bt.number = $3
        AND ($4::text IS NULL OR z.code || '/' || l.code = $4)`,
    [WAREHOUSE, ITEM, BATCH, cell],
  );
  return Number(out.rows[0].qty);
}

/** Куда положим: первая ячейка зоны A и первая зоны B того же склада. */
async function cells() {
  const out = await db.query<{ cell: string; zone: string }>(
    `SELECT z.code || '/' || l.code AS cell, z.code AS zone
       FROM storage_location l
       JOIN warehouse_zone z ON z.id = l.zone_id
       JOIN warehouse w ON w.id = z.warehouse_id
      WHERE w.code = $1 AND l.is_active
      ORDER BY z.code, l.code`,
    [WAREHOUSE],
  );
  const a = out.rows.find((r) => r.zone === 'A')!;
  const b = out.rows.find((r) => r.zone === 'B')!;
  return { a: a.cell, b: b.cell };
}

describe('склад в боте: раздел', () => {
  it('открывается экранами и даёт кладовщику его действия', async () => {
    const talk = new Talk(keeper);
    await talk.press('w');
    expect(plain(talk.screen)).toMatch(/Здесь товар/);
    const labels = buttons(talk.screen).join(' | ');
    expect(labels).toMatch(/Остаток/);
    expect(labels).toMatch(/Приход/);
    expect(labels).toMatch(/Списание/);
    expect(labels, 'кладовщику не предложили пересчёт').toMatch(/Пересчёт/);
  });

  it('у кого нет права на списание — тому и кнопки нет', async () => {
    const limited: Me = {
      ...keeper,
      permissions: new Set(['warehouse.view', 'warehouse.move']),
    };
    const talk = new Talk(limited);
    await talk.press('w');
    const labels = buttons(talk.screen).join(' | ');
    expect(labels, 'списание предложили тому, кому его не выдано').not.toMatch(/Списание/);
    expect(labels).toMatch(/Приход/);
  });

  it('и прямое нажатие на списание не проходит', async () => {
    const limited: Me = {
      ...keeper,
      permissions: new Set(['warehouse.view', 'warehouse.move']),
    };
    const talk = new Talk(limited);
    // Кнопки на экране нет, но её данные известны: запрет не должен держаться
    // на том, что кнопку не нарисовали.
    await talk.press('w:n:w');
    expect(talk.screen.toast, 'отказа не было').toMatch(/прав/i);
    expect(plain(talk.screen), 'мастер списания всё-таки открылся').not.toMatch(/Шаг 1/);
  });
});

describe('склад в боте: приход', () => {
  /**
   * Один сценарий, а не семь проверок по шагу: мастер — это разговор, и
   * проверять его частями значит проверять не то, что видит человек. Каждый
   * шаг здесь со своим утверждением, и упадёт именно тот, который сломали.
   */
  it('ведёт по шагам, объясняет каждый и записывает приход', async () => {
    const place = await cells();
    const talk = new Talk(keeper);

    await talk.press('w:n:r');
    expect(plain(talk.screen), 'не сказано, что делает приход').toMatch(/появляется на складе/);
    // У кладовщика две компании, поэтому первый вопрос о ней.
    expect(plain(talk.screen)).toMatch(/Шаг 1 из \d+ · Компания/);
    // Номер шага говорит, сколько осталось, но не говорит чего: человек, не
    // знающий, что дальше, бросает разговор на середине.
    expect(plain(talk.screen), 'не сказано, что спрошу дальше').toMatch(
      /Дальше: Товар → Количество/,
    );
    expect(plain(talk.screen), 'в «дальше» нет последнего шага').toMatch(/→ Проверка/);

    await talk.tap(TRADE);
    expect(plain(talk.screen)).toMatch(/· Товар/);
    expect(plain(talk.screen), 'нет примера, как искать товар').toMatch(/труба|ТР-108/);

    await talk.say(HUB_ITEM.ru);
    expect(plain(talk.screen), 'номенклатура по части названия не нашлась').toMatch(/· Количество/);
    expect(plain(talk.screen), 'не названа единица измерения').toMatch(/Единица/);

    await talk.say('5');
    // Труба учитывается партиями — и бот это объясняет сам.
    expect(plain(talk.screen)).toMatch(/· Партия/);
    expect(plain(talk.screen)).toMatch(/учитывается партиями/);

    await talk.say(BATCH);
    expect(plain(talk.screen)).toMatch(/· Куда/);

    await talk.tap('Склад «Сергели»');
    expect(plain(talk.screen)).toMatch(/· Место/);
    expect(plain(talk.screen), 'не объяснено, что такое место').toMatch(/полка|площадка/);

    await talk.tap(place.a.split('/')[1]!);
    expect(plain(talk.screen)).toMatch(/· Цена/);
    expect(plain(talk.screen), 'не сказано, зачем цена').toMatch(/себестоимость/);
    expect(buttons(talk.screen).join(' '), 'нельзя честно сказать «не знаю»').toMatch(/Не знаю/);

    await talk.say('8500000');
    expect(plain(talk.screen)).toMatch(/· Контрагент/);
    // Приход открывает новую партию, и поставщика пропустить нельзя: без него
    // у партии нет происхождения.
    expect(plain(talk.screen), 'не сказано, почему поставщик обязателен').toMatch(
      /происхождение партии потеряно/,
    );
    expect(
      buttons(talk.screen).some((b) => b.includes('Пропустить')),
      'новую партию разрешили завести без поставщика',
    ).toBe(false);

    const supplier = buttons(talk.screen).find((b) => b.startsWith('ООО') || b.startsWith('АО'))!;
    await talk.tap(supplier);
    expect(plain(talk.screen)).toMatch(/· Примечание/);

    await talk.say('проверка бота');
    const check = plain(talk.screen);
    expect(check, 'нет экрана проверки перед записью').toMatch(/Проверьте/);
    expect(check).toContain('5 t');
    expect(check).toContain(BATCH);
    expect(check, 'не предупредили, что остаток изменится сразу').toMatch(
      /остаток изменится сразу/,
    );

    const before = await onHand(place.a);

    // «Я не понял»: то же движение словами. Складское движение страшнее
    // денежной заявки — остаток меняется сразу, и человек должен узнать это до
    // нажатия, а не после.
    expect(buttons(talk.screen), 'на проверке нет кнопки «я не понял»').toContain('🤔 Я не понял');
    await talk.tap('🤔 Я не понял');
    const said = plain(talk.screen);
    expect(said, 'объяснение не названо простыми словами').toMatch(/Простыми словами/);
    expect(said, 'не сказано, что остаток изменится сразу').toMatch(/изменится сразу/);
    expect(said, 'не сказано, что ошибку правят отменой').toMatch(/отменяют/);
    expect(await onHand(place.a), 'объяснение изменило остаток').toBe(before);

    await talk.tap('⬅️ Вернуться к проверке');
    expect(plain(talk.screen), 'с объяснения не вернулись на проверку').toMatch(/Проверьте/);
    expect(buttons(talk.screen)).toContain('✅ Записать');

    await talk.tap('✅ Записать');
    expect(plain(talk.screen)).toMatch(/Записано/);
    expect(await onHand(place.a), 'остаток не вырос').toBeCloseTo(before + 5, 3);
    expect(buttons(talk.screen).join(' '), 'не предложено записать ещё одно').toMatch(/Ещё одно/);

    const audit = await db.query(
      `SELECT source::text AS source FROM audit_log
        WHERE entity_type = 'stock_move' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0].source, 'источник записи не «bot»').toBe('bot');
  });

  it('повторная доставка того же нажатия не удваивает приход', async () => {
    const place = await cells();
    const t = new Talk(keeper);
    await t.press('w:n:r');
    await t.tap(TRADE);
    await t.say(ITEM);
    await t.say('2');
    await t.say(BATCH);
    await t.tap('Склад «Сергели»');
    await t.tap(place.a.split('/')[1]!);
    await t.tap('🤷 Не знаю');
    // Партия уже существует — её открыл приход из прошлой проверки, и
    // поставщика спрашивать второй раз незачем.
    await t.tap('➡️ Пропустить');
    await t.tap('➡️ Пропустить');
    expect(plain(t.screen)).toMatch(/Проверьте/);

    const before = await onHand(place.a);
    const save = t.screen.keyboard.flat().find((b) => b.text.startsWith('✅ Записать'))!.data;
    // Telegram при обрыве связи повторяет доставку: два обработчика успевают
    // прочитать разговор до того, как первый его закроет. От удвоения прихода
    // спасает только ключ повторной отправки.
    await Promise.all([
      wh.route(keeper, t.flow, save, false),
      wh.route(keeper, t.flow, save, false),
    ]);
    expect(await onHand(place.a), 'одно нажатие завело два прихода').toBeCloseTo(before + 2, 3);
  });
});

describe('склад в боте: остаток и отмена движения', () => {
  it('остаток находится по названию и говорит, сколько свободно', async () => {
    const talk = new Talk(keeper);
    await talk.press('w:s');
    expect(plain(talk.screen)).toMatch(/Напишите название или код/);
    await talk.say(BATCH);
    const text = plain(talk.screen);
    expect(text, 'партия проверки в остатке не найдена').toContain(BATCH);
    expect(text, 'не объяснено, что значит «свободно»').toMatch(/без того, что уже обещано/);
  });

  it('движение отменяется с подтверждением, и остаток возвращается', async () => {
    const talk = new Talk(keeper);
    await talk.press('w:m');
    expect(plain(talk.screen)).toMatch(/Последние движения/);

    // Открываем своё последнее движение — приход на 2 т.
    const mine = talk.screen.keyboard.flat().find((b) => b.text.includes(ITEM));
    expect(mine, 'своего движения нет в списке').toBeTruthy();
    await talk.press(mine!.data);
    expect(plain(talk.screen), 'карточка не говорит, можно ли отменить').toMatch(
      /можно отменить|отменить нельзя/,
    );

    const before = await onHand(null);
    await talk.tap('↩️ Отменить движение');
    expect(plain(talk.screen), 'перед отменой не спросили').toMatch(/Отменить движение\?/);
    expect(plain(talk.screen)).toMatch(/останутся оба/);
    await talk.tap('✅ Да');
    expect(plain(talk.screen)).toMatch(/Отменено/);
    expect(await onHand(null), 'остаток не вернулся').toBeCloseTo(before - 2, 3);
  });
});

describe('склад в боте: списание', () => {
  it('требует причину кнопкой и уводит остаток в ноль', async () => {
    const place = await cells();
    const talk = new Talk(keeper);
    await talk.press('w:n:w');
    expect(plain(talk.screen), 'не сказано, что делает списание').toMatch(/Остаток уменьшится/);
    await talk.tap(TRADE);
    await talk.say(ITEM);
    await talk.say('5');
    await talk.say(BATCH);
    expect(plain(talk.screen)).toMatch(/· Откуда/);
    await talk.tap('Склад «Сергели»');
    await talk.tap(place.a.split('/')[1]!.slice(0, 2));
    expect(plain(talk.screen), 'у списания спросили цену').not.toMatch(/· Цена/);
    expect(plain(talk.screen)).toMatch(/· Причина/);
    expect(plain(talk.screen), 'не сказано, зачем причина').toMatch(/в отчёте/);

    await talk.tap('Порча при хранении');
    await talk.tap('➡️ Пропустить');
    expect(plain(talk.screen)).toMatch(/Проверьте/);
    expect(plain(talk.screen)).toContain('Порча при хранении');
    await talk.tap('✅ Записать');
    expect(plain(talk.screen)).toMatch(/Записано/);
    expect(await onHand(place.a), 'товар проверки остался на складе').toBeCloseTo(0, 3);

    // Снимок предлагают сразу после списания: товар ещё лежит перед
    // кладовщиком, а через час его увезут, и доказательства не будет.
    const data = talk.screen.keyboard.flat().map((b) => b.data);
    expect(
      data.some((d) => d.startsWith('w:ph:')),
      `после списания не предложили фото: ${data.join(' | ')}`,
    ).toBe(true);
  });

  it('отказ службы приходит её словами, а не кодом ошибки', async () => {
    const talk = new Talk(keeper);
    await talk.press('w:n:w');
    await talk.tap(TRADE);
    await talk.say(ITEM);
    await talk.say('1000');
    await talk.say(BATCH);
    await talk.tap('Склад «Сергели»');
    const cell = buttons(talk.screen).find((b) => b.includes('·'))!;
    await talk.tap(cell.slice(0, 6));
    await talk.tap('Порча при хранении');
    await talk.tap('➡️ Пропустить');
    await talk.tap('✅ Записать');
    expect(plain(talk.screen)).toMatch(/Не получилось/);
    expect(plain(talk.screen), 'отказ не объясняет, чего не хватает').toMatch(
      /доступно|хватает|остат/i,
    );
  });
});

describe('склад в боте: штучный учёт', () => {
  it('у штучной позиции спрашивает номер, а не количество', async () => {
    const talk = new Talk(keeper);
    await talk.press('w:n:r');
    await talk.tap(PLANT);
    await talk.say('PPU-530-710');
    expect(plain(talk.screen), 'у штучной трубы спросили количество').not.toMatch(/· Количество/);
    expect(plain(talk.screen)).toMatch(/· Номер/);
    expect(plain(talk.screen)).toMatch(/у каждой штуки свой номер/);
  });
});

describe('склад в боте: пересчёт', () => {
  it('открывает лист и считает строку, не показывая учётное количество', async () => {
    const company = keeper.companies.find((c) => c.nameRu === PLANT)!;
    const sheet = await asUser(keeper, false, () =>
      inventory.create({
        companyUid: company.uid,
        warehouseCode: SHEET_WAREHOUSE,
        zoneCode: SHEET_ZONE,
        blockMode: 'mark',
      }),
    );
    sheetUid = sheet.uid;

    const talk = new Talk(keeper);
    await talk.press('w:i');
    expect(plain(talk.screen), 'не объяснено, что такое пересчёт').toMatch(
      /сверка того, что лежит/,
    );
    await talk.tap(`🧮 ${sheet.number}`);
    expect(plain(talk.screen)).toContain(sheet.number);

    const line = await db.query<{ uid: string; qty: string }>(
      `SELECT l.uid, l.qty_expected::text AS qty
         FROM inventory_sheet_line l
         JOIN inventory_sheet s ON s.id = l.sheet_id
        WHERE s.uid = $1 ORDER BY l.seq LIMIT 1`,
      [sheet.uid],
    );
    await talk.press(`w:c:${line.rows[0].uid}`);
    const ask = plain(talk.screen);
    expect(ask).toMatch(/Сколько лежит на полке/);
    expect(ask, 'учётное количество показали — переписать его станет проще').not.toContain(
      Number(line.rows[0].qty).toString(),
    );

    await talk.say((Number(line.rows[0].qty) + 1).toFixed(6));
    expect(plain(talk.screen), 'расхождение не названо').toMatch(/Расхождение/);
    const saved = await db.query<{ counted: string }>(
      `SELECT qty_counted::text AS counted FROM inventory_sheet_line WHERE uid = $1`,
      [line.rows[0].uid],
    );
    expect(Number(saved.rows[0].counted)).toBeCloseTo(Number(line.rows[0].qty) + 1, 3);
  });

  it('закрывается, когда посчитаны все строки, и утверждает только тот, кому выдано', async () => {
    const lines = await db.query<{ uid: string; qty: string }>(
      `SELECT l.uid, l.qty_expected::text AS qty
         FROM inventory_sheet_line l
         JOIN inventory_sheet s ON s.id = l.sheet_id
        WHERE s.uid = $1 ORDER BY l.seq`,
      [sheetUid],
    );
    // Считаем ровно столько, сколько по учёту: расхождений не останется, и
    // утверждение не тронет остаток соседних проверок.
    for (const l of lines.rows) {
      const talk = new Talk(keeper);
      await talk.press(`w:c:${l.uid}`);
      await talk.say(l.qty);
    }

    const talk = new Talk(keeper);
    await talk.press(`w:h:${sheetUid}`);
    expect(plain(talk.screen), 'не сказано, что лист можно закрыть').toMatch(
      /Все строки посчитаны/,
    );
    expect(
      buttons(talk.screen).some((b) => b.includes('Утвердить')),
      'кладовщику предложили утверждение, которого ему не выдано',
    ).toBe(false);

    await talk.tap('✅ Закрыть лист');
    expect(plain(talk.screen)).toMatch(/Закрыть лист\?/);
    await talk.tap('✅ Да');
    const status = await db.query(`SELECT status::text AS s FROM inventory_sheet WHERE uid = $1`, [
      sheetUid,
    ]);
    expect(status.rows[0].s).toBe('review');

    const bossTalk = new Talk(boss);
    await bossTalk.press(`w:h:${sheetUid}`);
    expect(
      buttons(bossTalk.screen).some((b) => b.includes('Утвердить')),
      'тому, кому утверждение выдано, кнопку не показали',
    ).toBe(true);
    await bossTalk.tap('⚠️ Утвердить');
    expect(plain(bossTalk.screen), 'не предупредили, что расхождения уйдут в остаток').toMatch(
      /запишутся в остаток/,
    );
    await bossTalk.tap('✅ Да');
    const after = await db.query(`SELECT status::text AS s FROM inventory_sheet WHERE uid = $1`, [
      sheetUid,
    ]);
    expect(after.rows[0].s).toBe('approved');
  });
});

describe('склад в боте: чего не хватает', () => {
  it('отвечает числами и говорит, что это за уровень', async () => {
    const talk = new Talk(keeper);
    await talk.press('w:d');
    expect(plain(talk.screen)).toMatch(/Чего не хватает/);
    expect(plain(talk.screen)).toMatch(/критического уровня/);
  });
});
