/**
 * Тракт уведомлений (ТЗ 11.1) на живой базе.
 *
 * Проверяется то, ради чего он сделан: событие доходит до человека один раз,
 * выключенный вид не приходит вовсе, роль не из бота не получает ничего, а текст
 * говорит человеку, что сделать — он системой не пользуется и догадываться не
 * должен.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { NeedsService } from '../src/warehouse/needs.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { KINDS, KIND_BY_CODE } from '../src/notifications/kinds.js';
import { FinanceModule } from '../src/finance/finance.module.js';
import { ApprovalsService } from '../src/finance/approvals.service.js';
import { DocumentsModule } from '../src/documents/documents.module.js';
import { SalesModule } from '../src/sales/sales.module.js';
import { SalesWriteService } from '../src/sales/write.service.js';
import { DocumentWorkflowService } from '../src/documents/workflow.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { runWithContext } from '../src/common/request-context.js';
import { ACTION as FIN_ACTION } from '../src/bot/finance.texts.js';
import { ACTION as DOC_ACTION } from '../src/bot/documents.texts.js';

const ACCOUNTANT = 'm.rahimova';
/** Директор: единственная роль с правом согласования платежей (см. rbac.ts). */
const DIRECTOR = 's.radjabov';
/** Кладовщик: складские поводы адресованы ему. */
const KEEPER = 'a.saidov';
/** Начальник производства: роль не из бота, уведомлений от бота ему не положено. */
const MASTER = 'j.tashpulatov';
const TG_ACC = 980000201n;
const TG_MASTER = 980000202n;
const TG_DIR = 980000203n;
const TG_KEEPER = 980000204n;

let notify: NotificationsService;
let db: Client;
let accId: bigint;
let masterId: bigint;
let dirId: bigint;
let approvals: ApprovalsService;
let docs: DocumentWorkflowService;
let sales: SalesWriteService;
let keeperId: bigint;
/** Номер листа пересчёта, который проверка заводит сама. */
let evenSheet = '';
let auth: AuthService;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, FinanceModule, DocumentsModule, SalesModule],
    providers: [NeedsService, NotificationsService],
  }).compile();
  notify = moduleRef.get(NotificationsService);
  approvals = moduleRef.get(ApprovalsService);
  docs = moduleRef.get(DocumentWorkflowService);
  sales = moduleRef.get(SalesWriteService);
  auth = moduleRef.get(AuthService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  accId = await link(ACCOUNTANT, TG_ACC);
  masterId = await link(MASTER, TG_MASTER);
  dirId = await link(DIRECTOR, TG_DIR);
  keeperId = await link(KEEPER, TG_KEEPER);
});

afterAll(async () => {
  await restoreOperations();
  await restoreDocuments();
  await dropEvenSheet();
  await clean();
  await db.end();
});

async function link(login: string, tg: bigint): Promise<bigint> {
  const r = await db.query('SELECT id FROM user_account WHERE login = $1', [login]);
  const id = BigInt(r.rows[0].id);
  await db.query(
    `UPDATE user_account
        SET telegram_user_id = $2, telegram_linked_at = now(),
            telegram_blocked = false, telegram_blocked_at = NULL
      WHERE id = $1`,
    [String(id), String(tg)],
  );
  await db.query('DELETE FROM notification_outbox WHERE user_id = $1', [String(id)]);
  await db.query('DELETE FROM notification_setting WHERE user_id = $1', [String(id)]);
  return id;
}

async function clean() {
  for (const id of [accId, masterId, dirId, keeperId]) {
    await db.query('DELETE FROM notification_outbox WHERE user_id = $1', [String(id)]);
    await db.query('DELETE FROM notification_setting WHERE user_id = $1', [String(id)]);
    await db.query(
      `UPDATE user_account SET telegram_user_id = NULL, telegram_linked_at = NULL,
              telegram_blocked = false, telegram_blocked_at = NULL
        WHERE id = $1`,
      [String(id)],
    );
  }
}

/**
 * Операция, которую проверка двигает по-настоящему, и её исходное состояние.
 *
 * Решение проводим живой службой, а не вставкой строки в журнал: уведомление
 * «вашу запись отклонили» читает журнал, и подложенная туда запись проверяла
 * бы саму себя. Журнал дописывать нельзя задним числом — он append-only, —
 * поэтому возвращаем на место саму операцию, а запись о действии остаётся:
 * действие правда было.
 */
type OpSnap = {
  uid: string;
  status: string;
  version: number;
  created_by: string | null;
  approved_by: string | null;
  comment: string | null;
  company_id: string;
};

const taken: OpSnap[] = [];

async function takePending(): Promise<OpSnap> {
  const used = taken.map((t) => t.uid);
  const r = await db.query<OpSnap>(
    `SELECT uid, status::text AS status, version, created_by::text, approved_by::text,
            comment, company_id::text
       FROM finance_operation
      WHERE status = 'pending_approval' AND NOT (uid = ANY($1::uuid[]))
      ORDER BY id LIMIT 1`,
    [used],
  );
  if (r.rowCount === 0) throw new Error('в базе нет заявки на согласовании — проверять нечего');
  taken.push(r.rows[0]!);
  return r.rows[0]!;
}

async function restoreOperations() {
  for (const t of taken) {
    await db.query(
      `UPDATE finance_operation
          SET status = $2::\"FinanceStatus\", version = $3, created_by = $4, approved_by = $5,
              comment = $6
        WHERE uid = $1`,
      [t.uid, t.status, t.version, t.created_by, t.approved_by, t.comment],
    );
  }
}

type DocSnap = {
  uid: string;
  status: string;
  created_by: string | null;
  status_comment: string | null;
  company_id: string;
};

const docsTaken: DocSnap[] = [];

async function takePendingDoc(): Promise<DocSnap> {
  const used = docsTaken.map((t) => t.uid);
  const r = await db.query<DocSnap>(
    `SELECT uid, status::text AS status, created_by::text, status_comment, company_id::text
       FROM document
      WHERE status = 'pending_approval' AND NOT (uid = ANY($1::uuid[]))
      ORDER BY id LIMIT 1`,
    [used],
  );
  if (r.rowCount === 0) throw new Error('в базе нет документа на согласовании — проверять нечего');
  docsTaken.push(r.rows[0]!);
  return r.rows[0]!;
}

async function dropEvenSheet() {
  if (!evenSheet) return;
  await db.query(
    `DELETE FROM inventory_sheet_line
      WHERE sheet_id IN (SELECT id FROM inventory_sheet WHERE number = $1)`,
    [evenSheet],
  );
  await db.query('DELETE FROM inventory_sheet WHERE number = $1', [evenSheet]);
}

async function restoreDocuments() {
  for (const t of docsTaken) {
    await db.query(
      `UPDATE document
          SET status = $2::\"DocumentStatus\", created_by = $3, status_comment = $4,
              status_at = NULL, status_by = NULL
        WHERE uid = $1`,
      [t.uid, t.status, t.created_by, t.status_comment],
    );
  }
}

/** Нажать кнопку от лица человека: те же права и тот же контекст, что в вебе. */
async function asUser<T>(userId: bigint, companyId: string, fn: () => Promise<T>): Promise<T> {
  const profile = await auth.loadProfile(userId);
  return runWithContext(
    {
      requestId: 'notifications-test',
      userId,
      companyIds: [BigInt(companyId)],
      allCompanyIds: profile.companyIds,
      permissions: profile.permissions,
      locale: 'ru',
      source: 'web',
    },
    fn,
  );
}

/** Номера операций в заданном статусе: уведомление обязано звать именно их. */
const numbersIn = async (status: string): Promise<string[]> => {
  const r = await db.query<{ number: string }>(
    `SELECT number FROM finance_operation WHERE status = $1::"FinanceStatus"`,
    [status],
  );
  return r.rows.map((x) => x.number);
};

const rows = async (userId: bigint, kind?: string) => {
  const r = await db.query(
    kind
      ? 'SELECT kind, dedupe_key, text_ru FROM notification_outbox WHERE user_id = $1 AND kind = $2'
      : 'SELECT kind, dedupe_key, text_ru FROM notification_outbox WHERE user_id = $1',
    kind ? [String(userId), kind] : [String(userId)],
  );
  return r.rows as { kind: string; dedupe_key: string; text_ru: string }[];
};

describe('уведомления: сборка', () => {
  it('собирает события финансисту и не повторяет их на втором проходе', async () => {
    await notify.scan();
    const first = await rows(accId);
    expect(first.length, 'финансисту не собралось ни одного события').toBeGreaterThan(0);
    expect(first.some((r) => r.kind === 'payment_overdue')).toBe(true);

    await notify.scan();
    const second = await rows(accId);
    expect(second.length, 'второй проход создал повторы').toBe(first.length);
    const keys = second.map((r) => `${r.kind}:${r.dedupe_key}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('текст говорит, что случилось и что сделать', async () => {
    const payment = (await rows(accId, 'payment_overdue'))[0]!;
    expect(payment.text_ru).toMatch(/Просроченная оплата/);
    expect(payment.text_ru, 'человеку не сказали, что делать').toMatch(/Что сделать/);
    expect(payment.text_ru, 'в тексте код вместо слов').not.toMatch(/pending_approval|status/);
  });

  it('выключенный вид больше не собирается', async () => {
    expect(await notify.toggle(accId, 'payment_overdue')).toBe(false);
    await db.query('DELETE FROM notification_outbox WHERE user_id = $1', [String(accId)]);
    await notify.scan();
    expect(await rows(accId, 'payment_overdue'), 'выключенный вид всё равно собрался').toHaveLength(
      0,
    );

    expect(await notify.toggle(accId, 'payment_overdue')).toBe(true);
  });

  it('роли не из бота не собирается ничего', async () => {
    await notify.scan();
    expect(await rows(masterId), 'мастеру собрали уведомления от бота').toHaveLength(0);
  });

  it('очередь не даёт одному человеку занять всю отправку', async () => {
    await notify.scan();
    const batch = await notify.pending(30, 2);
    const mine = batch.filter((p) => p.userId === accId);
    expect(mine.length, 'человека с событиями вытеснили из очереди целиком').toBeGreaterThan(0);
    const perUser = new Map<string, number>();
    for (const p of batch) perUser.set(String(p.userId), (perUser.get(String(p.userId)) ?? 0) + 1);
    for (const [user, count] of perUser) {
      expect(count, `человек ${user} занял в проходе больше своей доли`).toBeLessThanOrEqual(2);
    }
  });

  it('очередь отдаёт неотправленное, помнит отправленное и закрытую дверь', async () => {
    await notify.scan();
    const pending = (await notify.pending()).filter((p) => p.userId === accId);
    expect(pending.length).toBeGreaterThan(0);
    expect(String(pending[0]!.chatId)).toBe(String(TG_ACC));

    await notify.markSent(pending[0]!.id);
    const after = (await notify.pending()).filter((p) => p.id === pending[0]!.id);
    expect(after, 'отправленное снова в очереди').toHaveLength(0);

    await notify.markBlocked(accId);
    expect(
      (await notify.pending()).filter((p) => p.userId === accId),
      'очередь бьётся о человека, который закрыл бота',
    ).toHaveLength(0);

    await notify.markReachable(accId);
    expect((await notify.pending()).filter((p) => p.userId === accId).length).toBeGreaterThan(0);
  });
});

describe('виды уведомлений', () => {
  // ТЗ 11.1 называет пять обязательных поводов. Проверка держит список: вид
  // можно переименовать в коде, но не потерять из обязательных.
  it('покрывают обязательный список ТЗ 11.1', () => {
    expect(KINDS.map((k) => k.kind)).toEqual(
      expect.arrayContaining([
        'stage_overdue',
        'stock_critical',
        'task_overdue',
        'deal_overdue',
        'payment_overdue',
        'document_pending',
      ]),
    );
  });

  // Повод «нажмите кнопку» обязан жить на праве этой кнопки, а не на праве
  // просмотра: иначе бот просит сделать то, чего человек сделать не может, и
  // люди привыкают не читать уведомления.
  it('о решении просят того, у кого есть кнопка', () => {
    expect(KIND_BY_CODE.get('finance_pending')!.permission).toBe('finance.approve');
    expect(KIND_BY_CODE.get('finance_to_post')!.permission).toBe('finance.post');
    expect(KIND_BY_CODE.get('document_pending')!.permission).toBe('documents.approve');
    // Крупный платёж — тому, у кого право именно на крупные. Финансист такую
    // заявку утвердить не может, и звать его к ней значит гонять зря.
    expect(KIND_BY_CODE.get('finance_big_pending')!.permission).toBe('finance.approve.large');
  });

  it('у каждого вида есть название, объяснение и право — на двух языках', () => {
    for (const k of KINDS) {
      expect(k.ru.length, `${k.kind}: нет названия по-русски`).toBeGreaterThan(3);
      expect(k.uz.length, `${k.kind}: нет названия по-узбекски`).toBeGreaterThan(3);
      expect(k.aboutRu.length, `${k.kind}: не сказано, зачем это`).toBeGreaterThan(10);
      expect(k.aboutUz.length, `${k.kind}: нет объяснения по-узбекски`).toBeGreaterThan(10);
      expect(k.permission, `${k.kind}: вид без права`).toMatch(/^[a-z]+\.[a-z._]+$/);
    }
  });
});

/**
 * Самое важное в тракте: бот звал по просроченному, но молчал о том, что
 * решения ждут от самого человека. Руководитель узнавал о заявке только если
 * заходил в «Ждут решения» сам — а он заходит редко, он ждёт сообщения.
 */
describe('уведомления: решения', () => {
  it('заявка на согласование приходит тому, кто её согласует', async () => {
    await notify.scan();
    const toDirector = await rows(dirId, 'finance_pending');
    expect(toDirector.length, 'согласующего не позвали к заявке').toBeGreaterThan(0);
    expect(toDirector[0]!.text_ru).toMatch(/ждут вашего согласования/);
    expect(toDirector[0]!.text_ru, 'не сказано, что сделать').toMatch(/Согласовать/);
    expect(toDirector[0]!.text_ru, 'в тексте код вместо слов').not.toMatch(
      /pending_approval|status/,
    );

    // Зовут именно те заявки, что правда ждут решения. Без этого проверка
    // зеленела бы и на черновиках, которых никто не подавал.
    const text = toDirector.map((r) => r.text_ru).join('\n');
    const waiting = await numbersIn('pending_approval');
    expect(
      waiting.some((n) => text.includes(n)),
      'в уведомлении не названа ни одна заявка, которая правда ждёт согласования',
    ).toBe(true);
    for (const n of await numbersIn('draft')) {
      expect(text, `позвали согласовать черновик ${n} — его никто не подавал`).not.toContain(n);
    }
  });

  it('не зовёт согласовать того, у кого нет такого права', async () => {
    await notify.scan();
    expect(
      await rows(accId, 'finance_pending'),
      'позвали нажать «Согласовать» того, у кого этой кнопки нет',
    ).toHaveLength(0);
  });

  it('согласованную заявку зовут провести того, кто проводит', async () => {
    await notify.scan();
    const toAcc = await rows(accId, 'finance_to_post');
    expect(toAcc.length, 'никого не позвали провести согласованное').toBeGreaterThan(0);
    expect(toAcc[0]!.text_ru).toMatch(/можно проводить/);
    expect(toAcc[0]!.text_ru, 'не сказано, что деньги пройдут только после нажатия').toMatch(
      /только после/,
    );

    const text = toAcc.map((r) => r.text_ru).join('\n');
    const approved = await numbersIn('approved');
    expect(
      approved.some((n) => text.includes(n)),
      'зовут провести не согласованные заявки',
    ).toBe(true);
    for (const n of await numbersIn('pending_approval')) {
      expect(text, `позвали провести ещё не согласованную заявку ${n}`).not.toContain(n);
    }
  });

  /**
   * «Нажмите Согласовать» — а на экране кнопка «Утвердить». Так и было в
   * тексте про документы: человек ищет слово, которого там нет. Имена кнопок
   * берутся из того же места, где их рисует бот, и проверка это держит.
   */
  it('зовёт кнопку её настоящим именем', async () => {
    await notify.scan();
    const fin = (await rows(dirId, 'finance_pending'))[0]!;
    expect(fin.text_ru, 'в тексте о деньгах кнопка названа не так, как на экране').toContain(
      FIN_ACTION.approve.ru,
    );
    expect(fin.text_ru).toContain(FIN_ACTION.reject.ru);

    const doc = (await rows(accId, 'document_pending'))[0];
    expect(doc, 'не собралось ни одного документа на согласование').toBeTruthy();
    expect(doc!.text_ru, 'в тексте о документе кнопка названа не так, как на экране').toContain(
      DOC_ACTION.approve.ru,
    );
    expect(doc!.text_ru).toContain(DOC_ACTION.return.ru);
  });

  it('автор узнаёт, что его запись отклонили: с причиной и с чьих слов', async () => {
    const op = await takePending();
    await db.query('UPDATE finance_operation SET created_by = $2 WHERE uid = $1', [
      op.uid,
      String(accId),
    ]);
    const who = (
      await db.query<{ full_name: string }>('SELECT full_name FROM user_account WHERE id = $1', [
        String(dirId),
      ])
    ).rows[0]!.full_name;

    await asUser(dirId, op.company_id, () =>
      approvals.apply(op.uid, 'reject', {
        version: op.version,
        comment: 'не та статья — проверка уведомлений',
      }),
    );

    await db.query('DELETE FROM notification_outbox WHERE user_id = $1', [String(accId)]);
    await notify.scan();
    const text = (await rows(accId, 'finance_decided')).map((r) => r.text_ru).join('\n');
    expect(text, 'автору не сказали, что его запись отклонили').toMatch(/отклонили/);
    expect(text, 'не названа причина отказа').toMatch(/не та статья/);
    expect(text, 'не сказано, кто отклонил').toContain(who);
    expect(text, 'не сказано, что делать дальше').toMatch(/Что сделать/);
  });

  it('о своём же нажатии бот человеку не пишет', async () => {
    const op = await takePending();
    await db.query('UPDATE finance_operation SET created_by = $2 WHERE uid = $1', [
      op.uid,
      String(dirId),
    ]);
    await asUser(dirId, op.company_id, () =>
      approvals.apply(op.uid, 'reject', { version: op.version, comment: 'своё нажатие' }),
    );

    await db.query('DELETE FROM notification_outbox WHERE user_id = $1', [String(dirId)]);
    await notify.scan();
    const mine = (await rows(dirId, 'finance_decided')).map((r) => r.text_ru).join('\n');
    expect(mine, 'бот пересказал человеку его собственное нажатие').not.toMatch(/своё нажатие/);
  });

  it('тот, кто выписал документ, узнаёт о возврате и о причине', async () => {
    const doc = await takePendingDoc();
    await db.query('UPDATE document SET created_by = $2 WHERE uid = $1', [doc.uid, String(accId)]);

    await asUser(dirId, doc.company_id, () =>
      docs.act(doc.uid, 'return', 'не тот адрес доставки — проверка уведомлений'),
    );

    await db.query('DELETE FROM notification_outbox WHERE user_id = $1', [String(accId)]);
    await notify.scan();
    const text = (await rows(accId, 'document_decided')).map((r) => r.text_ru).join('\n');
    expect(text, 'о возврате документа автору не написали').toMatch(/вернули/);
    expect(text, 'не названа причина возврата').toMatch(/не тот адрес/);
    expect(text, 'не сказано, что делать дальше').toMatch(/отправьте на согласование снова/);
  });
});

/**
 * Поводы из профильной таблицы ТЗ 11: продажи («новые заказы и смена
 * статусов») и склад («резервы, расхождения»). Обязательный список 11.1 они не
 * отменяют, но без них менеджер узнаёт об отгрузке своего заказа от клиента, а
 * кладовщик о резерве — случайно.
 */
describe('уведомления: заказы и склад', () => {
  it('менеджеру пишут, что его заказ сдвинул кто-то другой', async () => {
    const order = await db.query<{
      uid: string;
      number: string;
      status: string;
      company_id: string;
    }>(
      `SELECT uid, number, status::text AS status, company_id::text AS company_id
         FROM sales_order
        WHERE status = 'confirmed' AND shipment_status = 'none'
        ORDER BY id LIMIT 1`,
    );
    const row = order.rows[0];
    if (!row) throw new Error('в базе нет подтверждённого заказа — проверять нечего');
    const before = await db.query('SELECT manager_id::text FROM sales_order WHERE uid = $1', [
      row.uid,
    ]);
    await db.query('UPDATE sales_order SET manager_id = $2 WHERE uid = $1', [
      row.uid,
      String(accId),
    ]);

    // Двигает директор, а не сам менеджер: про своё нажатие бот не пишет.
    await asUser(dirId, row.company_id, () => sales.setStatus(row.uid, 'cancelled', 'проверка'));

    await db.query('DELETE FROM notification_outbox WHERE user_id = $1', [String(accId)]);
    await notify.scan();
    const text = (await rows(accId, 'order_moved')).map((r) => r.text_ru).join('\n');
    expect(text, 'менеджеру не сказали, что заказ сдвинули').toMatch(/сдвинули|отгрузили/);
    expect(text, 'в тексте код статуса вместо слов').not.toMatch(/cancelled|confirmed/);
    expect(text, 'не назван номер заказа').toContain(row.number);

    // Возвращаем заказ и менеджера на место.
    await db.query(
      `UPDATE sales_order SET status = $2::"OrderStatus", manager_id = $3 WHERE uid = $1`,
      [row.uid, row.status, before.rows[0].manager_id],
    );
  });

  it('кладовщику пишут про отложенный под заказ товар', async () => {
    await notify.scan();
    const text = (await rows(keeperId, 'stock_reserved')).map((r) => r.text_ru).join('\n');
    if (text.length === 0) {
      // На пустой базе резервов проверять нечего — но молча зеленеть нельзя.
      const live = await db.query(
        `SELECT count(*)::int AS n FROM stock_reservation WHERE status = 'active'`,
      );
      expect(live.rows[0].n, 'резервы в базе есть, а кладовщику не написали').toBe(0);
      return;
    }
    expect(text).toMatch(/отложен/);
    expect(text, 'не сказано, что делать').toMatch(/соберите|Что сделать/i);
  });

  /**
   * Лист в пересчёте, где всё сошлось, — не повод писать: человека зовут, когда
   * есть разница. На живых данных это не проверить, листов без разницы в базе
   * может не быть вовсе, поэтому проверка заводит такой лист сама.
   */
  it('лист без разницы никого не зовёт', async () => {
    const place = await db.query<{ company_id: string; warehouse_id: string; item_id: string }>(
      `SELECT w.company_id::text AS company_id, w.id::text AS warehouse_id,
              (SELECT i.id::text FROM item i WHERE i.company_id = w.company_id
                ORDER BY i.id LIMIT 1) AS item_id
         FROM warehouse w ORDER BY w.id LIMIT 1`,
    );
    const p = place.rows[0]!;
    evenSheet = `ПР-РОВНО-${Date.now()}`;
    const sheet = await db.query<{ id: string }>(
      `INSERT INTO inventory_sheet (company_id, number, warehouse_id, status, block_mode)
       VALUES ($1, $2, $3, 'review', 'mark') RETURNING id::text`,
      [p.company_id, evenSheet, p.warehouse_id],
    );
    await db.query(
      `INSERT INTO inventory_sheet_line
         (sheet_id, seq, item_id, qty_expected, qty_counted, qty_diff, unit_cost)
       VALUES ($1, 1, $2, 5, 5, 0, 0)`,
      [sheet.rows[0]!.id, p.item_id],
    );

    await db.query('DELETE FROM notification_outbox WHERE user_id = $1', [String(keeperId)]);
    await notify.scan();
    const text = (await rows(keeperId, 'inventory_variance')).map((r) => r.text_ru).join('\n');
    expect(text, 'позвали считать лист, в котором всё сошлось').not.toContain(evenSheet);
  });

  it('о расхождениях в пересчёте пишут тому, кто считает', async () => {
    await notify.scan();
    const got = await rows(keeperId, 'inventory_variance');
    const open = await db.query(
      `SELECT count(*)::int AS n
         FROM inventory_sheet s
        WHERE s.status = 'review'
          AND EXISTS (SELECT 1 FROM inventory_sheet_line l
                       WHERE l.sheet_id = s.id AND l.qty_diff IS NOT NULL AND l.qty_diff <> 0)`,
    );
    expect(got.length, 'листы с расхождениями есть, а уведомления нет').toBe(
      Math.min(open.rows[0].n, 5),
    );
    if (got.length > 0) {
      expect(got[0]!.text_ru).toMatch(/Расхождения/);
      expect(got[0]!.text_ru, 'не сказано, что делать').toMatch(/утвердите|пересчитайте/);
    }
  });

  it('заказ и склад не уходят тому, у кого нет права', async () => {
    await notify.scan();
    // У бухгалтера нет складских прав: ни резервов, ни пересчёта он не получит.
    expect(await rows(accId, 'stock_reserved'), 'резерв ушёл без складского права').toHaveLength(0);
    expect(
      await rows(accId, 'inventory_variance'),
      'расхождения ушли без права пересчёта',
    ).toHaveLength(0);
  });
});

/**
 * Крупный платёж (требование заказчика со встречи 07.10).
 *
 * Уведомление - вторая половина меры: порог не даёт финансисту утвердить
 * платёж, а подтвердить его должен владелец, и узнать о заявке он может
 * только сообщением. Без этого платёж просто встанет, и никто не поймёт, чего
 * он ждёт.
 */
describe('уведомления: крупный платёж', () => {
  /** Своя заявка, а не из сида: порог должен задеть ровно её одну. */
  let bigUid = '';
  let bigNumber = '';
  let partnerName = '';
  let companyId = '';

  beforeAll(async () => {
    const src = await db.query<{
      company_id: string;
      account_id: string;
      counter_account_id: string | null;
      currency_id: string;
      cashflow_item_id: string | null;
      partner_id: string | null;
    }>(
      `SELECT o.company_id, o.account_id, o.counter_account_id, o.currency_id,
              o.cashflow_item_id, o.partner_id
         FROM finance_operation o
        WHERE o.operation_type = 'expense' AND o.partner_id IS NOT NULL
          AND o.cashflow_item_id IS NOT NULL
        ORDER BY o.id LIMIT 1`,
    );
    const s = src.rows[0];
    if (!s) throw new Error('в сиде нет расхода с получателем и статьёй');
    companyId = s.company_id;

    const made = await db.query<{ uid: string; number: string }>(
      `INSERT INTO finance_operation
         (uid, company_id, number, operation_type, occurred_at, account_id, counter_account_id,
          amount, currency_id, rate, amount_base, cashflow_item_id, partner_id, status, version,
          created_by)
       VALUES (gen_random_uuid(), $1::bigint, $2, 'expense', now(), $3::bigint, $4::bigint,
               900000000000, $5::bigint, 1, 900000000000, $6::bigint, $7::bigint,
               'pending_approval', 1, $8::bigint)
       RETURNING uid, number`,
      [
        s.company_id,
        `TST-BIG-${process.pid}`,
        s.account_id,
        s.counter_account_id,
        s.currency_id,
        s.cashflow_item_id,
        s.partner_id,
        String(accId),
      ],
    );
    bigUid = made.rows[0].uid;
    bigNumber = made.rows[0].number;
    partnerName = (
      await db.query<{ name: string }>(`SELECT name_ru AS name FROM partner WHERE id = $1::bigint`, [
        s.partner_id,
      ])
    ).rows[0].name;

    // Порог заведомо ниже этой заявки и заведомо выше всех остальных: иначе
    // крупными окажется полсида, и в список из пяти наша могла бы не попасть.
    await db.query(
      `UPDATE company SET approval_limit_single = 100000000000, approval_limit_period = NULL
        WHERE id = $1::bigint`,
      [companyId],
    );
    await db.query('DELETE FROM notification_outbox WHERE user_id = $1', [String(dirId)]);
    await db.query('DELETE FROM notification_outbox WHERE user_id = $1', [String(accId)]);
  });

  afterAll(async () => {
    await db.query(
      `UPDATE company SET approval_limit_single = NULL, approval_limit_period = NULL
        WHERE id = $1::bigint`,
      [companyId],
    );
    if (bigUid) await db.query('DELETE FROM finance_operation WHERE uid = $1', [bigUid]);
  });

  it('зовут подтвердить того, у кого право на крупные платежи', async () => {
    await notify.scan();
    const got = await rows(dirId, 'finance_big_pending');

    expect(got.length, 'крупный платёж никого не позвал').toBeGreaterThan(0);
    const text = got.map((r) => r.text_ru).join('\n');
    expect(text, 'не названа сама заявка').toContain(bigNumber);
    expect(text, 'не сказано, кому платят').toContain(partnerName);
    expect(text, 'не сказано, кто завёл').toMatch(/Завёл/);
    expect(text, 'не назван порог').toMatch(/Порог одной платёжки/);
    expect(text, 'не сказано, сколько уже ушло получателю').toMatch(/за \d+ дн/);
    expect(text, 'не сказано, что сделать').toMatch(/Согласовать/);
    expect(text, 'в тексте код вместо слов').not.toMatch(/pending_approval|amount_base/);
  });

  it('финансисту без права на крупные платежи этот повод не приходит', async () => {
    await notify.scan();
    expect(
      await rows(accId, 'finance_big_pending'),
      'крупный платёж ушёл тому, кто его утвердить не может',
    ).toHaveLength(0);
  });

  it('порог снят — повода нет', async () => {
    await db.query(`UPDATE company SET approval_limit_single = NULL WHERE id = $1::bigint`, [
      companyId,
    ]);
    await db.query('DELETE FROM notification_outbox WHERE user_id = $1', [String(dirId)]);

    await notify.scan();

    expect(
      await rows(dirId, 'finance_big_pending'),
      'без порога платёж всё равно считается крупным',
    ).toHaveLength(0);
  });
});
