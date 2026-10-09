/**
 * Продажи в боте (ТЗ 11.5, решение заказчика 02.10 — весь функционал).
 *
 * Проверяется работа менеджера целиком: посмотреть заказы, завести новый с
 * ценой из прайса, перевести по статусу, увидеть наличие и отгрузить машину.
 * И отдельно то, без чего бота нельзя пускать к заказам: право проверяется на
 * нажатии, а не только при отрисовке кнопок, повторное нажатие «Отгрузить» не
 * увозит товар дважды, а повторное «Записать» не заводит второй заказ.
 *
 * Разговор идёт через те же методы, что зовёт Telegram, но без Telegram и без
 * привязки учётной записи: привязка у человека одна, и два файла проверок,
 * идущих параллельно, отбирали бы её друг у друга.
 *
 * Заказ и накладная после прогона остаются в базе — журнал склада запрещает
 * стирать след (`stock_move_append_only`). Товар возвращаем обратным приходом,
 * как это делает `sales-write.e2e`.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { SalesModule } from '../src/sales/sales.module.js';
import { WarehouseModule } from '../src/warehouse/warehouse.module.js';
import { WriteService } from '../src/warehouse/write.service.js';
import { BotSales } from '../src/bot/sales.bot.js';
import { asUser, type Me, type Screen, type SectionFlow } from '../src/bot/section.js';
import { devProfile } from '../prisma/seed-profiles.js';

/** Директор: у него есть и продажи, и отмена заказа, и обе компании. */
const BOSS = 's.radjabov';

/**
 * Завод: только у него есть прайс, а бот обязан брать цену из прайса.
 *
 * Название берётся из сида, а не пишется строкой: юрлицо переименовали 08.10,
 * и тест про цену из прайса упал на названии компании - то есть ругался не на
 * то, что проверяет.
 */
const COMPANY = devProfile.companies.find((c) => c.code === 'plant')!.nameRu;
const CLIENT = 'Навоийазот';
/** Отсрочка этого клиента по договору — её бот и предложит сроком оплаты. */
const CLIENT_DELAY = 21;
const ITEM = 'PPU-108-200';
/** Склад завода, на котором лежит эта труба. */
const WAREHOUSE = 'Склад готовой продукции завода';
const ITEM_SEARCH = 'ППУ-ПЭ 108';
const LIST_PRICE = 1_880_000;
/** Сколько обещаем клиенту и сколько из этого увезём одной машиной. */
const ORDER_QTY = 3;
const SHIP_QTY = 2;

let sales: BotSales;
let warehouse: WriteService;
let authService: AuthService;
let db: Client;
let boss: Me;
let orderUid = '';
let orderNumber = '';
/** Партия, которой уехала первая машина: повторная отправка идёт той же. */
let shippedBatch = '';

/**
 * Разряды в суммах Intl разделяет неразрывным пробелом, и проверка «1 880 000»
 * с обычным пробелом иначе не сходится ни в тексте, ни в подписи кнопки.
 */
const norm = (v: string) => v.replace(/[\u00a0\u202f]/g, ' ');

const plain = (s: Screen) =>
  norm((s.text ?? '').replace(/<blockquote>|<\/blockquote>/g, '').replace(/<[^>]+>/g, ''));

const buttons = (s: Screen) => s.keyboard.flat().map((b) => norm(b.text));
/** Кнопки по рядам: «по одной в ряд» по плоскому списку не видно. */
const rows = (s: Screen) => s.keyboard.map((r) => r.map((b) => norm(b.text)));

/** Разговор, как он идёт у человека: состояние живёт между нажатиями. */
class Talk {
  flow: SectionFlow | null = null;
  screen!: Screen;

  constructor(private readonly me: Me) {}

  async press(data: string) {
    this.screen = await sales.route(this.me, this.flow, data, false);
    if (this.screen.flow !== undefined) this.flow = this.screen.flow;
    return this.screen;
  }

  async tap(prefix: string) {
    const all = this.screen.keyboard.flat();
    const hit =
      all.find((b) => norm(b.text).startsWith(prefix)) ??
      all.find((b) => norm(b.text).includes(prefix));
    expect(hit, `кнопки «${prefix}» нет: ${all.map((b) => norm(b.text)).join(' | ')}`).toBeTruthy();
    return this.press(hit!.data);
  }

  async say(text: string) {
    expect(this.flow, 'разговора нет, писать некуда').toBeTruthy();
    this.screen = await sales.text(this.me, this.flow!, text, false);
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

/** Сколько накладных по заказу: главный ответ на вопрос о двойной отгрузке. */
async function shipmentCount(): Promise<number> {
  const out = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM shipment s
       JOIN sales_order o ON o.id = s.sales_order_id
      WHERE o.uid = $1::uuid`,
    [orderUid],
  );
  return Number(out.rows[0].n);
}

async function orderCount(): Promise<number> {
  const out = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sales_order o
       JOIN partner p ON p.id = o.partner_id
      WHERE p.name_ru LIKE $1`,
    [`%${CLIENT}%`],
  );
  return Number(out.rows[0].n);
}

async function freeStock(): Promise<number> {
  const out = await db.query<{ qty: string }>(
    `SELECT coalesce(sum(b.qty_available), 0)::text AS qty
       FROM stock_balance b JOIN item i ON i.id = b.item_id
      WHERE i.code = $1`,
    [ITEM],
  );
  return Number(out.rows[0].qty);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, SalesModule, WarehouseModule],
    providers: [BotSales],
  }).compile();
  sales = moduleRef.get(BotSales);
  warehouse = moduleRef.get(WriteService);
  authService = moduleRef.get(AuthService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  boss = await profile(BOSS);
}, 60_000);

afterAll(async () => {
  // Товар возвращаем обратным приходом: журнал движений стирать нельзя, и
  // остаток должен сойтись операцией, а не удалением следа.
  if (orderUid) {
    const moves = await db.query<{
      item: string;
      qty: string;
      cost: string;
      warehouse: string;
      cell: string | null;
      batch: string | null;
      company: string;
    }>(
      `SELECT i.code AS item, m.qty::text, (m.cost_total / m.qty)::text AS cost,
              w.code AS warehouse,
              (SELECT z.code || '/' || l.code FROM storage_location l
                 JOIN warehouse_zone z ON z.id = l.zone_id
                WHERE l.id = m.from_location_id) AS cell,
              b.number AS batch, co.uid::text AS company
         FROM stock_move m
         JOIN item i ON i.id = m.item_id
         JOIN company co ON co.id = m.company_id
         LEFT JOIN warehouse w ON w.id = m.from_warehouse_id
         LEFT JOIN batch b ON b.id = m.batch_id
        WHERE m.source_doc_type = 'shipment'
          AND m.source_doc_id IN (SELECT s.id FROM shipment s
                                    JOIN sales_order o ON o.id = s.sales_order_id
                                   WHERE o.uid = $1::uuid)`,
      [orderUid],
    );
    for (const m of moves.rows) {
      await asUser(boss, false, () =>
        warehouse.create({
          companyUid: m.company,
          operationType: 'receipt',
          itemCode: m.item,
          qty: m.qty,
          ...(m.batch ? { batchNumber: m.batch } : {}),
          toWarehouseCode: m.warehouse,
          ...(m.cell ? { toLocationCode: m.cell } : {}),
          unitCost: m.cost,
          comment: 'возврат после проверки бота',
        }),
      );
    }
  }
  await db.end();
});

describe('продажи в боте: раздел', () => {
  it('открывается этапами и даёт менеджеру завести заказ', async () => {
    const talk = new Talk(boss);
    await talk.press('o');
    expect(plain(talk.screen)).toMatch(/Здесь заказы/);
    const labels = buttons(talk.screen).join(' | ');
    expect(labels).toMatch(/Все заказы/);
    expect(labels).toMatch(/Не оплачены/);
    expect(labels).toMatch(/Новый заказ/);
  });

  it('показывает заказы списком и открывает карточку', async () => {
    const talk = new Talk(boss);
    await talk.press('o:s:all');
    expect(plain(talk.screen)).toMatch(/Все заказы/);
    // В списке у каждого заказа видно главное: номер, клиент, сумма и оплата.
    expect(plain(talk.screen)).toMatch(/оплачен/);
    const first = talk.screen.keyboard.flat().find((b) => b.data.startsWith('o:c:'));
    expect(first, 'ни одного заказа в списке').toBeTruthy();
    await talk.press(first!.data);
    expect(plain(talk.screen)).toMatch(/Клиент:/);
    expect(plain(talk.screen)).toMatch(/Товар в заказе/);
  });

  it('у кого нет права заводить заказы — тому и кнопки нет', async () => {
    const watcher: Me = { ...boss, permissions: new Set(['sales.view']) };
    const talk = new Talk(watcher);
    await talk.press('o');
    expect(buttons(talk.screen).join(' | ')).not.toMatch(/Новый заказ/);

    // Кнопки нет, но её данные известны: запрет не должен держаться на том,
    // что кнопку не нарисовали.
    await talk.press('o:n');
    expect(talk.screen.toast, 'отказа не было').toMatch(/прав/i);
    expect(plain(talk.screen), 'мастер заказа всё-таки открылся').not.toMatch(/Шаг 1/);
  });
});

describe('продажи в боте: новый заказ', () => {
  /**
   * Один сценарий, а не восемь проверок по шагу: мастер — это разговор, и
   * проверять его частями значит проверять не то, что видит человек.
   */
  it('ведёт по шагам, берёт цену из прайса и записывает заказ', async () => {
    const before = await orderCount();
    const talk = new Talk(boss);

    await talk.press('o:n');
    expect(plain(talk.screen), 'не сказано, что такое заказ').toMatch(/Обещание клиенту/);
    expect(plain(talk.screen)).toMatch(/Шаг 1 из \d+ · Компания/);
    // Заказ собирается из нескольких позиций, и без этой строки человек не
    // знает, когда разговор кончится.
    expect(plain(talk.screen), 'не сказано, что спрошу дальше').toMatch(/Дальше: Клиент → Товар/);
    expect(plain(talk.screen), 'в «дальше» нет последнего шага').toMatch(/→ Проверка/);

    await talk.tap(COMPANY);
    expect(plain(talk.screen)).toMatch(/· Клиент/);
    expect(plain(talk.screen), 'не сказано, откуда берутся клиенты').toMatch(/заводят в системе/);

    await talk.say(CLIENT);
    expect(plain(talk.screen), 'клиент по части названия не нашёлся').toMatch(/· Товар/);

    await talk.say(ITEM_SEARCH);
    expect(plain(talk.screen)).toMatch(/· Количество/);
    expect(plain(talk.screen), 'не названа единица измерения').toMatch(/Единица/);

    await talk.say(String(ORDER_QTY));
    const price = plain(talk.screen);
    expect(price).toMatch(/· Цена/);
    // Цена есть в прайсе — человеку её показывают, а не подставляют молча.
    expect(price, 'цену из прайса не показали').toMatch(/Цена есть/);
    expect(price).toMatch(/прайс/);
    expect(buttons(talk.screen).join(' '), 'нет кнопки с ценой из прайса').toMatch(/1 880 000/);

    await talk.tap('✅ 1 880 000');
    const more = plain(talk.screen);
    expect(more).toMatch(/· Ещё товар/);
    expect(more, 'в списке позиций нет суммы строки').toContain('5 640 000');

    // «Ещё товар» и «Готово» рядом — это полпальца друг от друга, и заказ
    // закрывают, не добавив вторую позицию.
    expect(rows(talk.screen).slice(0, 2), 'кнопки снова в один ряд').toEqual([
      ['✅ Готово'],
      ['➕ Ещё товар'],
    ]);

    await talk.tap('✅ Готово');
    const where = plain(talk.screen);
    expect(where).toMatch(/· Склад/);
    expect(where, 'не сказано, зачем склад в заказе').toMatch(/наличие под заказ/);

    // У завода складов больше одного, поэтому вопрос задан. Берём тот, где
    // труба действительно лежит.
    await talk.tap(WAREHOUSE);
    const due = plain(talk.screen);
    expect(due).toMatch(/· Срок оплаты/);
    expect(due, 'не сказано про отсрочку из договора').toContain(`${CLIENT_DELAY}`);
    expect(due, 'не объяснено, чем грозит просрочка').toMatch(/долги/);

    await talk.tap('✅ ');
    const check = plain(talk.screen);
    expect(check, 'нет экрана проверки перед записью').toMatch(/Проверьте/);
    expect(check).toContain('5 640 000');
    expect(check, 'не предупредили, что товар ещё не отложен').toMatch(/ещё не\s+отклад/);

    // «Я не понял»: заказ — обещание клиенту, и человек должен знать, что
    // черновик ещё ничего не обещает, а товар со склада не уходит.
    expect(buttons(talk.screen), 'на проверке нет кнопки «я не понял»').toContain('🤔 Я не понял');
    await talk.tap('🤔 Я не понял');
    const said = plain(talk.screen);
    expect(said, 'объяснение не названо простыми словами').toMatch(/Простыми словами/);
    expect(said, 'не сказано, что черновик ничего не обещает').toMatch(/ничего не обещает/);
    expect(said, 'не сказано, что товар со склада не уходит').toMatch(/не уходит/);
    expect(await orderCount(), 'объяснение завело заказ').toBe(before);

    await talk.tap('⬅️ Вернуться к проверке');
    expect(plain(talk.screen), 'с объяснения не вернулись на проверку').toMatch(/Проверьте/);

    await talk.tap('✅ Записать');
    expect(plain(talk.screen), 'заказ не записан').toMatch(/Заказ записан/);
    expect(await orderCount(), 'заказ в базе не появился').toBe(before + 1);

    const open = talk.screen.keyboard.flat().find((b) => b.data.startsWith('o:c:'))!;
    orderUid = open.data.slice(4);
    const row = await db.query<{ number: string; status: string }>(
      `SELECT number, status::text FROM sales_order WHERE uid = $1::uuid`,
      [orderUid],
    );
    orderNumber = row.rows[0]!.number;
    expect(row.rows[0]!.status, 'новый заказ должен быть черновиком').toBe('draft');

    // Цена пришла из прайса — в заказе она так и помечена, и объяснения
    // «почему такая цена» с неё не требуют. Если бот пришлёт её как
    // назначенную руками, спор о цене потом разбирать нечем.
    const line = await db.query<{ price: string; source: string; comment: string | null }>(
      `SELECT l.price::text, l.price_source::text AS source, l.price_comment AS comment
         FROM sales_order_line l JOIN sales_order o ON o.id = l.sales_order_id
        WHERE o.uid = $1::uuid`,
      [orderUid],
    );
    expect(Number(line.rows[0]!.price)).toBe(LIST_PRICE);
    expect(line.rows[0]!.source, 'цену из прайса записали как названную руками').toBe('list');
    expect(line.rows[0]!.comment).toBeNull();

    // Повторная доставка того же нажатия — обычное дело у Telegram. Разговор
    // уже закончен, и второго заказа быть не должно.
    await talk.press('o:go');
    expect(await orderCount(), 'повторное «Записать» завело второй заказ').toBe(before + 1);
  });

  it('в карточке объясняет статус и предлагает только разрешённые переходы', async () => {
    const talk = new Talk(boss);
    await talk.press(`o:c:${orderUid}`);
    const card = plain(talk.screen);
    expect(card).toContain(orderNumber);
    expect(card, 'не объяснено, что значит черновик').toMatch(/ничего не обещано/);
    const labels = buttons(talk.screen).join(' | ');
    expect(labels).toMatch(/Подтверждён/);
    expect(labels).toMatch(/Отменён/);
    // «Отгружен» ставит накладная, а не кнопка: такой кнопки быть не должно.
    expect(labels, 'отгрузку предложили кнопкой статуса').not.toMatch(/🚚 Отгружен$/);

    // Из карточки заказа ведут два пути в другие разделы: принять оплату и
    // выписать документ. Оба — кнопкой с префиксом чужого раздела, потому что
    // разговор там ведёт он, а не продажи.
    const data = talk.screen.keyboard.flat().map((b) => b.data);
    expect(data, 'нет пути к приёму оплаты').toContain(`f:pay:${orderUid}`);
    expect(data, 'нет пути к выписке документа').toContain(`d:ns:${orderUid}`);
  });

  it('переводит статус только после подтверждения словами', async () => {
    const talk = new Talk(boss);
    await talk.press(`o:c:${orderUid}`);
    await talk.tap('✅ Подтверждён');
    expect(plain(talk.screen), 'не спросили подтверждения').toMatch(/Перевести заказ/);
    expect(plain(talk.screen), 'не сказано, что изменится').toMatch(/обещанием клиенту/);

    await talk.tap('✅ Да');
    expect(plain(talk.screen)).toMatch(/Статус изменён/);
    const row = await db.query<{ status: string }>(
      `SELECT status::text FROM sales_order WHERE uid = $1::uuid`,
      [orderUid],
    );
    expect(row.rows[0]!.status).toBe('confirmed');
  });

  it('отменить заказ без права на отмену нельзя — ни кнопкой, ни напрямую', async () => {
    // Право на правку есть, на отмену — нет: так устроен менеджер по продажам.
    const manager: Me = {
      ...boss,
      permissions: new Set(['sales.view', 'sales.edit']),
    };
    const talk = new Talk(manager);
    await talk.press(`o:c:${orderUid}`);
    expect(buttons(talk.screen).join(' | '), 'отмену предложили без права').not.toMatch(/Отменён/);

    await talk.press(`o:y:x:${orderUid}`);
    expect(talk.screen.toast, 'отказа не было').toMatch(/прав/i);
    const row = await db.query<{ status: string }>(
      `SELECT status::text FROM sales_order WHERE uid = $1::uuid`,
      [orderUid],
    );
    expect(row.rows[0]!.status, 'заказ отменился без права').toBe('confirmed');
  });
});

describe('продажи в боте: наличие и отгрузка', () => {
  it('показывает, что обещано и что свободно на складе', async () => {
    const talk = new Talk(boss);
    await talk.press(`o:a:${orderUid}`);
    const text = plain(talk.screen);
    expect(text).toMatch(/Наличие под заказ/);
    expect(text).toMatch(/обещано 3/);
    expect(text, 'не сказано, что такое «свободно»').toMatch(/свободно на складе/);
    expect(buttons(talk.screen).join(' | '), 'нет перехода к отгрузке').toMatch(/Отгрузить/);
  });

  it('везёт меньше обещанного, спрашивает машину и уменьшает остаток', async () => {
    const stockBefore = await freeStock();
    const talk = new Talk(boss);

    await talk.press(`o:t:${orderUid}`);
    expect(plain(talk.screen), 'не сказано, что товар уходит со склада').toMatch(
      /уходит со склада/,
    );
    expect(plain(talk.screen)).toMatch(/Строка 1 из 1/);
    expect(buttons(talk.screen).join(' | '), 'нет кнопки «всё»').toMatch(/Всё: 3/);

    // Больше обещанного бот не возьмёт и спросит снова на том же шаге.
    await talk.say('10');
    expect(plain(talk.screen), 'перевоз сверх обещанного прошёл').toMatch(
      /Больше обещанного отгрузить нельзя/,
    );

    await talk.say(String(SHIP_QTY));
    // Труба партионная: номер партии попадёт в накладную, и выбирает его
    // человек — сервер за него этого не делает.
    const batchScreen = plain(talk.screen);
    if (/· Партия/.test(batchScreen)) {
      expect(batchScreen, 'не объяснено, что такое партия').toMatch(/сертификат/);
      const batch = talk.screen.keyboard.flat().find((b) => b.data.startsWith('o:k:'))!;
      await talk.press(batch.data);
    }
    expect(plain(talk.screen)).toMatch(/Машина и водитель/);
    expect(plain(talk.screen), 'нет примера, как писать машину').toMatch(/01A123BC/);

    await talk.say('01A123BC, Эргашев');
    const check = plain(talk.screen);
    expect(check).toMatch(/Проверьте/);
    expect(check).toContain(`${SHIP_QTY} pm`);
    expect(check).toContain('01A123BC');
    expect(check, 'не предупредили, что остаток уменьшится').toMatch(/уйдёт со склада/);
    expect(check, 'не сказано, кто выбирает штучные номера').toMatch(
      /Номера штучного товара система выберет/,
    );

    await talk.press('o:tgo');
    expect(plain(talk.screen), 'накладная не записана').toMatch(/Накладная записана/);
    expect(await shipmentCount()).toBe(1);
    expect(await freeStock(), 'остаток не уменьшился').toBeCloseTo(stockBefore - SHIP_QTY, 3);

    const batchRow = await db.query<{ number: string }>(
      `SELECT b.number FROM shipment_line sl
         JOIN shipment s ON s.id = sl.shipment_id
         JOIN sales_order o ON o.id = s.sales_order_id
         JOIN batch b ON b.id = sl.batch_id
        WHERE o.uid = $1::uuid`,
      [orderUid],
    );
    shippedBatch = batchRow.rows[0]!.number;
    expect(shippedBatch, 'в накладной нет номера партии').toBeTruthy();

    const card = plain(talk.screen);
    expect(card, 'в карточке не видно частичной отгрузки').toMatch(/отгружен частично/);
    expect(card).toMatch(/уехало 2/);
  });

  it('повторное нажатие «Отгрузить» не увозит товар дважды', async () => {
    const stockBefore = await freeStock();
    const shipmentsBefore = await shipmentCount();
    const out = await db.query<{ line: string }>(
      `SELECT l.uid AS line FROM sales_order_line l
         JOIN sales_order o ON o.id = l.sales_order_id
        WHERE o.uid = $1::uuid`,
      [orderUid],
    );
    // Тот же разговор, что человек видел на экране подтверждения, — и в нём
    // тот же ключ повторной отправки. Ключ свой на каждый прогон: он живёт в
    // журнале движений, и прошлый прогон иначе ответил бы за этот.
    const flow: SectionFlow = {
      kind: 'sales',
      step: 'shipConfirm',
      orderUid,
      orderNumber,
      shipLines: [
        {
          lineUid: out.rows[0]!.line,
          itemName: ITEM,
          unit: 'pm',
          remaining: '1',
          available: '1',
          trackBatches: true,
          batches: [],
          batch: shippedBatch,
          qty: '1',
        },
      ],
      key: `повтор-доставки-${Date.now()}`,
    } as SectionFlow;

    const first = await sales.route(boss, flow, 'o:tgo', false);
    expect(plain(first), 'накладная не записана').toMatch(/Накладная записана/);
    const number = plain(first).match(/ТТН-[^\s.,]+/)?.[0];
    expect(number, 'номер накладной не показан').toBeTruthy();

    // Telegram доставляет одно нажатие дважды — это его обычное поведение.
    // Второй раз должна вернуться та же накладная, а не уехать второй рейс.
    const again = await sales.route(boss, flow, 'o:tgo', false);
    expect(plain(again), 'повтор закончился отказом').toMatch(/Накладная записана/);
    expect(plain(again).match(/ТТН-[^\s.,]+/)?.[0], 'повтор завёл вторую накладную').toBe(number);

    expect(await shipmentCount(), 'накладных стало больше, чем рейсов').toBe(shipmentsBefore + 1);
    expect(await freeStock(), 'товар уехал дважды').toBeCloseTo(stockBefore - 1, 3);
  });
});
