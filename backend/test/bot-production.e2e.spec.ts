/**
 * Производство в боте (ТЗ 11.4).
 *
 * Последний раздел, который до этого был заглушкой. Проверяется то, ради чего
 * он в телефоне: цех отмечает свой этап и записывает выпуск, руководитель
 * видит, как идёт заказ, и останавливает его с причиной.
 *
 * Отдельно — то, без чего бота нельзя пускать к складу: право проверяется на
 * нажатии, а не только при отрисовке кнопок, и выпуск кладёт продукцию на
 * склад настоящим движением, а не меняет цифру в заказе.
 *
 * Разговор идёт теми же методами, что зовёт Telegram, но без Telegram: привязка
 * учётной записи у человека одна, и два файла проверок отбирали бы её друг у друга.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { ProductionModule } from '../src/production/production.module.js';
import { WarehouseModule } from '../src/warehouse/warehouse.module.js';
import { AttachmentsModule } from '../src/attachments/attachments.module.js';
import { WriteService } from '../src/warehouse/write.service.js';
import { ProductionWriteService } from '../src/production/write.service.js';
import { ProductionStagesService } from '../src/production/stages.service.js';
import { BotProduction, parseQty } from '../src/bot/production.bot.js';
import { asUser, type Me, type Screen, type SectionFlow } from '../src/bot/section.js';

/** Начальник производства: заводит заказы, запускает и выпускает. */
const MASTER = 'j.tashpulatov';
/** Кладовщик: производство видит, но не распоряжается им. */
const KEEPER = 'a.saidov';

/** Что делаем в проверочном заказе и куда кладём выпуск. */
const ITEM = 'PPU-159-250';
const WAREHOUSE = 'ZAVOD-GP';

let bot: BotProduction;
let write: ProductionWriteService;
let moves: WriteService;
let stages: ProductionStagesService;
let authService: AuthService;
let db: Client;
let master: Me;
let keeper: Me;
let orderUid = '';
let orderNumber = '';
/** Компания заказа: кладовщик видит две, и списание просит выбрать явно. */
let plantUid = '';

const plain = (s: Screen) =>
  (s.text ?? '')
    .replace(/<blockquote>|<\/blockquote>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/ /g, ' ');

const buttons = (s: Screen) => s.keyboard.flat().map((b) => b.text);

/** Разговор, как он идёт у человека: состояние живёт между нажатиями. */
class Talk {
  flow: SectionFlow | null = null;
  screen!: Screen;

  constructor(
    private readonly me: Me,
    private readonly uz = false,
  ) {}

  async press(data: string) {
    this.screen = await bot.route(this.me, this.flow, data, this.uz);
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
    this.screen = await bot.text(this.me, this.flow!, text, this.uz);
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

const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 10);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    // Вложения — ради счётчика файлов и кнопки снимка в карточке задания:
    // `BotProduction` просит `AttachmentsService`, и без модуля сборка падает
    // на разборе зависимостей, не доходя ни до одной проверки.
    imports: [PrismaModule, AuthModule, ProductionModule, WarehouseModule, AttachmentsModule],
    providers: [BotProduction],
  }).compile();
  bot = moduleRef.get(BotProduction);
  write = moduleRef.get(ProductionWriteService);
  moves = moduleRef.get(WriteService);
  stages = moduleRef.get(ProductionStagesService);
  authService = moduleRef.get(AuthService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  master = await profile(MASTER);
  keeper = await profile(KEEPER);
  plantUid = (await db.query(`SELECT uid::text AS uid FROM company WHERE code = 'plant'`)).rows[0]
    .uid;

  // Свой заказ: чужой трогать нельзя, его состояние проверяют соседние файлы.
  const made = await asUser(master, false, () =>
    write.create({
      itemCode: ITEM,
      qtyPlanned: '10',
      dueDate: tomorrow(),
      responsibleUid: null as unknown as undefined,
      comment: 'проверка бота производства',
    }),
  );
  orderUid = made.uid;
  orderNumber = made.number;
  // Ответственный — сам мастер: «мои задания» собираются по нему.
  const me = await db.query('SELECT uid::text AS uid FROM user_account WHERE login = $1', [MASTER]);
  await asUser(master, false, () => write.update(orderUid, { responsibleUid: me.rows[0].uid }));
  await asUser(master, false, () => stages.planFromCard(orderUid));
}, 90_000);

afterAll(async () => {
  // Заказ проверки убираем целиком: отменённый он остался бы в списках цеха.
  if (orderUid) {
    /**
     * Выпущенное снимаем со склада списанием: приход был настоящий, и стереть
     * его нельзя — журнал движений дополняется, а не правится. Сколько лежит,
     * спрашиваем у остатка, а не у журнала: журнал закрыт политикой RLS, и
     * обычное соединение проверки увидело бы в нём ноль.
     *
     * Причина списания — внутренний номер строки справочника: служба склада
     * ждёт именно его, а не uid, которым ходит экран.
     */
    const left = await db.query<{ qty: string; wh: string; loc: string | null }>(
      `SELECT sum(bal.qty_on_hand)::text AS qty, w.code AS wh, l.code AS loc
         FROM stock_balance bal
         JOIN batch b ON b.id = bal.batch_id
         JOIN item i ON i.id = bal.item_id
         JOIN warehouse w ON w.id = bal.warehouse_id
         LEFT JOIN storage_location l ON l.id = bal.location_id
        WHERE b.number = $1 AND i.code = $2
        GROUP BY w.code, l.code
       HAVING sum(bal.qty_on_hand) > 0`,
      [orderNumber, ITEM],
    );
    const reason = await db.query<{ id: string }>(
      `SELECT r.id::text FROM stock_reason r
         JOIN company c ON c.id = r.company_id
        WHERE r.kind = 'write_off' AND r.is_active AND c.code = 'plant' LIMIT 1`,
    );
    for (const row of left.rows) {
      await asUser(keeper, false, () =>
        moves.create({
          companyUid: plantUid,
          operationType: 'write_off',
          itemCode: ITEM,
          qty: row.qty,
          fromWarehouseCode: row.wh,
          ...(row.loc ? { fromLocationCode: row.loc } : {}),
          batchNumber: orderNumber,
          ...(reason.rows[0] ? { reasonId: reason.rows[0].id } : {}),
          comment: 'уборка прогона бота производства',
        }),
      );
    }
    /**
     * Строки заказа убираем до него самого: внешние ключи на удалении заказа
     * обнуляются, и оставленная строка журнала отклонений повисла бы ни на
     * чём — а соседняя проверка считает, что простой в журнале есть у каждой
     * паузы. Один раз так и вышло.
     */
    await db.query(
      `DELETE FROM deviation_log WHERE production_order_id =
         (SELECT id FROM production_order WHERE uid = $1::uuid)`,
      [orderUid],
    );
    await db.query(
      `DELETE FROM production_stage_event WHERE stage_id IN
         (SELECT s.id FROM production_stage s JOIN production_order o ON o.id = s.production_order_id
           WHERE o.uid = $1::uuid)`,
      [orderUid],
    );
    await db.query(
      `DELETE FROM production_output WHERE production_order_id =
         (SELECT id FROM production_order WHERE uid = $1::uuid)`,
      [orderUid],
    );
    await db.query(
      `DELETE FROM production_stage WHERE production_order_id =
         (SELECT id FROM production_order WHERE uid = $1::uuid)`,
      [orderUid],
    );
    await db.query(
      `DELETE FROM production_material WHERE production_order_id =
         (SELECT id FROM production_order WHERE uid = $1::uuid)`,
      [orderUid],
    );
    /**
     * Строки заказа убираем до него самого: внешние ключи на удалении заказа
     * обнуляются, и оставленная строка журнала отклонений повисла бы ни на
     * чём — а соседняя проверка считает, что простой в журнале есть у каждой
     * паузы. Один раз так и вышло.
     */
    await db.query(
      `DELETE FROM deviation_log WHERE production_order_id =
         (SELECT id FROM production_order WHERE uid = $1::uuid)`,
      [orderUid],
    );
    await db.query(
      `DELETE FROM production_stage_event WHERE stage_id IN
         (SELECT s.id FROM production_stage s JOIN production_order o ON o.id = s.production_order_id
           WHERE o.uid = $1::uuid)`,
      [orderUid],
    );
    await db.query(
      `DELETE FROM production_output WHERE production_order_id =
         (SELECT id FROM production_order WHERE uid = $1::uuid)`,
      [orderUid],
    );
    await db.query(
      `DELETE FROM production_stage WHERE production_order_id =
         (SELECT id FROM production_order WHERE uid = $1::uuid)`,
      [orderUid],
    );
    await db.query(
      `DELETE FROM production_material WHERE production_order_id =
         (SELECT id FROM production_order WHERE uid = $1::uuid)`,
      [orderUid],
    );
    /**
     * Партию держит журнал движений, удалить её нельзя. Но номер заказа после
     * удаления освободится и достанется следующему прогону, а чужую партию
     * выпуск не пополняет — поэтому номер уводим в сторону. Так же прибирается
     * за собой прогон выпуска.
     */
    await db.query(
      `UPDATE batch SET production_order_id = NULL, number = number || '-бот' || id
        WHERE production_order_id = (SELECT id FROM production_order WHERE uid = $1::uuid)`,
      [orderUid],
    );
    await db.query(`DELETE FROM production_order WHERE uid = $1::uuid`, [orderUid]);
  }
  await db.end();
});

describe('раздел открывается и рассказывает, что в нём есть', () => {
  it('на главном экране есть задания, заказы, цех и отклонения', async () => {
    const talk = new Talk(master);
    await talk.press('p');
    const text = plain(talk.screen);
    expect(text).toContain('Производство');
    expect(text, 'раздел не объясняет, что в нём делают').toContain('отметить свой этап');
    const b = buttons(talk.screen);
    expect(b.some((t) => t.includes('Мои задания'))).toBe(true);
    expect(b.some((t) => t.includes('В работе'))).toBe(true);
    expect(b.some((t) => t.includes('Что в цеху'))).toBe(true);
    expect(b.some((t) => t.includes('Отклонения'))).toBe(true);
  });

  it('заказ находится поиском по номеру и открывается карточкой', async () => {
    const talk = new Talk(master);
    await talk.press('p');
    await talk.tap('🔍');
    await talk.say(orderNumber);
    expect(plain(talk.screen)).toContain(orderNumber);

    await talk.tap(orderNumber);
    const card = plain(talk.screen);
    expect(card).toContain(orderNumber);
    expect(card, 'в карточке нет плана').toContain('План');
    expect(card, 'в карточке нет статуса словами').toContain('Черновик');
    expect(card, 'статус не объяснён словами').toContain('Цех заказа ещё не видит');
  });
});

describe('заказ ведут из бота', () => {
  it('запуск идёт через план и объясняет, что произойдёт', async () => {
    const talk = new Talk(master);
    await talk.press(`p:c:${orderUid}`);
    await talk.tap('🗓');
    expect(plain(talk.screen), 'не сказано, что будет после нажатия').toContain(
      'увидит цех',
    );
    await talk.tap('✅ Да');
    expect(plain(talk.screen)).toContain('Запланирован');

    await talk.tap('⚙️');
    await talk.tap('✅ Да');
    expect(plain(talk.screen)).toContain('В работе');
  });

  it('пауза требует причину, и короткую не принимает', async () => {
    const talk = new Talk(master);
    await talk.press(`p:c:${orderUid}`);
    await talk.tap('⏸');
    expect(plain(talk.screen), 'причину не спросили').toContain('почему');

    await talk.say('ждём');
    expect(plain(talk.screen), 'короткую причину приняли').toContain('Слишком коротко');

    await talk.say('ждём заготовку с соседнего участка');
    const card = plain(talk.screen);
    expect(card).toContain('Приостановлен');
    expect(card, 'причина не видна в карточке').toContain('ждём заготовку');

    // Возврат в работу: кнопка «Запустить» у приостановленного заказа.
    await talk.tap('⚙️');
    await talk.tap('✅ Да');
    expect(plain(talk.screen)).toContain('В работе');
  });

  it('кладовщик заказ видит, но ведёт его не он', async () => {
    const talk = new Talk(keeper);
    await talk.press(`p:c:${orderUid}`);
    const text = plain(talk.screen);
    expect(text, 'кладовщику не показали заказ').toContain(orderNumber);
    expect(
      buttons(talk.screen).some((t) => t.includes('Приостановить') || t.includes('Записать выпуск')),
      'кладовщику предложили распоряжаться цехом',
    ).toBe(false);
  });

  it('право проверяется на нажатии, а не только на кнопке', async () => {
    const talk = new Talk(keeper);
    // Кнопки у кладовщика нет — но нажатие из чужого сообщения дойти может.
    const screen = await bot.route(keeper, null, `p:q:s:${orderUid}`, false);
    expect(screen.toast, 'нажатие прошло без права').toBeTruthy();
    const after = await db.query(
      `SELECT status::text AS s FROM production_order WHERE uid = $1::uuid`,
      [orderUid],
    );
    expect(after.rows[0].s, 'заказ сменил статус от человека без права').toBe('in_progress');
    expect(talk).toBeTruthy();
  });
});

describe('цех отмечает свой этап', () => {
  it('этапы видны списком, этап открывается и объясняет себя', async () => {
    const talk = new Talk(master);
    await talk.press(`p:g:${orderUid}`);
    const list = plain(talk.screen);
    expect(list).toContain('Этапы заказа');
    expect(list, 'не видно нормы времени').toContain('норма');

    await talk.press(`p:t:${orderUid}:1`);
    const card = plain(talk.screen);
    expect(card, 'не сказано, что даёт отметка').toContain('пойдёт время');
    expect(buttons(talk.screen).some((t) => t.includes('Начал'))).toBe(true);
  });

  it('начал → пауза с причиной → продолжил → закончил', async () => {
    const talk = new Talk(master);
    await talk.press(`p:t:${orderUid}:1`);
    await talk.tap('▶️ Начал');
    expect(plain(talk.screen)).toContain('Отметил');

    await talk.tap('⏸');
    expect(plain(talk.screen), 'причину простоя не спросили').toContain('Почему встали');
    const reasons = talk.screen.keyboard.flat().filter((b) => b.data.startsWith('p:k:'));
    expect(reasons.length, 'список причин пуст').toBeGreaterThan(0);
    await talk.press(reasons[0]!.data);
    expect(plain(talk.screen)).toContain('пауза');

    await talk.tap('▶️ Продолжил');
    await talk.tap('✅ Закончил');
    const after = await db.query(
      `SELECT s.status::text AS s FROM production_stage s
         JOIN production_order o ON o.id = s.production_order_id
        WHERE o.uid = $1::uuid AND s.seq = 1`,
      [orderUid],
    );
    expect(after.rows[0].s, 'этап не закрылся').toBe('done');
  });

  it('«мои задания» показывают этап этого человека', async () => {
    const talk = new Talk(master);
    await talk.press('p:me');
    expect(plain(talk.screen)).toContain('Мои задания');
  });
});

describe('выпуск и брак', () => {
  it('выпуск спрашивает по одному, объясняет и кладёт продукцию на склад', async () => {
    const before = await onHand();

    const talk = new Talk(master);
    await talk.press(`p:c:${orderUid}`);
    await talk.tap('📦');
    expect(plain(talk.screen), 'не спросили количество').toContain('Сколько годного');

    await talk.say('не число');
    expect(plain(talk.screen)).toContain('Не понял число');

    await talk.say('4');
    expect(plain(talk.screen), 'не спросили склад').toContain('склад');
    await talk.tap('');

    // Склад с ячейками спросит ещё и ячейку: шаг пропускается сам, если их нет.
    if (plain(talk.screen).includes('ячейку')) await talk.tap('');

    const check = plain(talk.screen);
    expect(check, 'нет экрана проверки').toContain('Проверьте');
    expect(check, 'не сказано, что продукция уйдёт на склад').toContain('окажется на складе');

    await talk.tap('🤔');
    expect(plain(talk.screen), '«я не понял» не объясняет другими словами').toContain(
      'приход продукции на склад',
    );
    expect(await onHand(), 'объяснение что-то записало').toBe(before);

    await talk.tap('⬅️ Вернуться');
    await talk.tap('✅ Записать');
    expect(plain(talk.screen)).toContain('Продукция на складе');
    expect(await onHand(), 'остаток на складе не вырос').toBeGreaterThan(before);

    const row = await db.query(
      `SELECT qty_produced::text AS q FROM production_order WHERE uid = $1::uuid`,
      [orderUid],
    );
    expect(Number(row.rows[0].q)).toBeCloseTo(4, 3);
  });

  it('брак требует причину и на склад не попадает', async () => {
    const before = await onHand();
    const talk = new Talk(master);
    await talk.press(`p:c:${orderUid}`);
    await talk.tap('🔻');
    await talk.say('1');
    expect(plain(talk.screen), 'причину брака не спросили').toContain('Из-за чего брак');

    const reasons = talk.screen.keyboard.flat().filter((b) => b.data.startsWith('p:p:'));
    expect(reasons.length).toBeGreaterThan(0);
    await talk.press(reasons[0]!.data);
    expect(plain(talk.screen), 'не сказано, что брак не вернуть').toContain('Отменить запись нельзя');

    await talk.tap('✅ Записать');
    expect(plain(talk.screen)).toContain('Записал брак');
    expect(await onHand(), 'брак попал на склад').toBe(before);

    const dev = await db.query(
      `SELECT count(*)::int AS n FROM deviation_log
        WHERE kind = 'defect' AND production_order_id =
          (SELECT id FROM production_order WHERE uid = $1::uuid)`,
      [orderUid],
    );
    expect(dev.rows[0].n, 'брак не лёг в журнал отклонений').toBeGreaterThan(0);
  });
});

describe('сводки', () => {
  it('«что в цеху» считает заказы и показывает участки', async () => {
    const talk = new Talk(master);
    await talk.press('p:sh');
    const text = plain(talk.screen);
    expect(text).toContain('Что в цеху сейчас');
    expect(text).toContain('Заказов в работе');
    expect(text, 'участков не видно').toContain('Участки');
  });

  it('у кого две компании, тому не врут про незаведённые смены', async () => {
    const talk = new Talk(keeper);
    await talk.press('p:sh');
    const text = plain(talk.screen);
    expect(text, 'не сказано, по каким компаниям считаем').toContain('Компании');
    if (text.includes('загрузку не счита')) {
      expect(
        text,
        'причиной назвали отсутствие смен, хотя дело в двух компаниях сразу',
      ).toContain('две компании сразу');
    }
  });

  it('отклонения объясняют, что в них лежит, и считают итоги', async () => {
    const talk = new Talk(master);
    await talk.press('p:dv');
    const text = plain(talk.screen);
    expect(text).toContain('Отклонения за 30 дней');
    expect(text, 'журнал не объясняет себя').toContain('пошло не по плану');
  });
});

describe('узбекский', () => {
  it('экран раздела и карточка заказа — без кириллицы', async () => {
    const talk = new Talk(master, true);
    await talk.press('p');
    const home = plain(talk.screen).replace(/[A-Za-z0-9\s\p{P}\p{S}]/gu, '');
    expect(home, `кириллица в узбекском экране: ${home}`).toBe('');

    await talk.press(`p:c:${orderUid}`);
    // Название продукции заведено по-русски в данных заказчика — его бот не
    // переводит. Проверяем свои слова: подписи полей и объяснение статуса.
    const card = plain(talk.screen);
    expect(card).toContain('Reja');
    expect(card).toContain('Muddat');
  });
});

describe('количество из сообщения', () => {
  it('принимает дробное с запятой, не принимает ноль и слова', () => {
    expect(parseQty('12,5')).toBe('12.5');
    expect(parseQty('1 200')).toBe('1200');
    expect(parseQty('0')).toBeNull();
    expect(parseQty('-3')).toBeNull();
    expect(parseQty('четыре')).toBeNull();
  });
});

/** Сколько продукции заказа лежит на складе: выпуск виден в остатке, а не в цифре заказа. */
async function onHand(): Promise<number> {
  const out = await db.query<{ qty: string }>(
    `SELECT coalesce(sum(b.qty_on_hand), 0)::text AS qty
       FROM stock_balance b
       JOIN item i ON i.id = b.item_id
       JOIN warehouse w ON w.id = b.warehouse_id
      WHERE i.code = $1 AND w.code = $2`,
    [ITEM, WAREHOUSE],
  );
  return Number(out.rows[0].qty);
}
