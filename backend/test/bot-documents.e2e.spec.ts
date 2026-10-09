/**
 * Документы в боте (ТЗ 11.6, решение заказчика 02.10 — весь функционал).
 *
 * Согласование — то, из-за чего документ стоит неделю: бумага ждёт человека,
 * который в разъездах. Проверяется весь его путь в боте: список ждущих
 * решения, карточка с объяснением статуса, маршрут целиком (вернуть с
 * причиной → отправить заново → утвердить → отметить подписанным), отмена с
 * причиной и получение файла.
 *
 * И отдельно то, без чего бота нельзя пускать к документам: право проверяется
 * на нажатии, а не только при отрисовке кнопок, а возврат без слов не
 * проходит — иначе автор не узнает, что переделывать.
 *
 * Разговор идёт через те же методы, что зовёт Telegram, но без Telegram и без
 * привязки учётной записи. Статусы документов прогон возвращает на место сам:
 * это документы заказчика в базе разработки, а не данные проверки.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { DocumentsModule } from '../src/documents/documents.module.js';
import { SalesModule } from '../src/sales/sales.module.js';
import { BotDocuments } from '../src/bot/documents.bot.js';
import type { Me, Screen, SectionFlow } from '../src/bot/section.js';

/** Бухгалтер: согласует документы. */
const APPROVER = 'm.rahimova';

let docs: BotDocuments;
let authService: AuthService;
let db: Client;
let approver: Me;
/** Документ, которым проверяем маршрут, и его исходное состояние. */
let uid = '';
let number = '';
let before: { status: string; comment: string | null } = { status: '', comment: null };
/** Заказ, из которого выписываем документ, и то, что завёл прогон. */
let order: { uid: string; number: string; total: string; lines: number };
const madeDocuments: string[] = [];

const norm = (v: string) => v.replace(/[  ]/g, ' ');

const plain = (s: Screen) =>
  norm((s.text ?? '').replace(/<blockquote>|<\/blockquote>/g, '').replace(/<[^>]+>/g, ''));

const buttons = (s: Screen) => s.keyboard.flat().map((b) => norm(b.text));

class Talk {
  flow: SectionFlow | null = null;
  screen!: Screen;

  constructor(private readonly me: Me) {}

  async press(data: string) {
    this.screen = await docs.route(this.me, this.flow, data, false);
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
    this.screen = await docs.text(this.me, this.flow!, text, false);
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

const statusOf = async (docUid: string) => {
  const row = await db.query<{ status: string; comment: string | null }>(
    `SELECT status::text, status_comment AS comment FROM document WHERE uid = $1::uuid`,
    [docUid],
  );
  return row.rows[0]!;
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, DocumentsModule, SalesModule],
    providers: [BotDocuments],
  }).compile();
  docs = moduleRef.get(BotDocuments);
  authService = moduleRef.get(AuthService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  approver = await profile(APPROVER);

  // Берём документ, который действительно ждёт решения, и со строками: пустую
  // карточку проверять нечем.
  const found = await db.query<{
    uid: string;
    number: string;
    status: string;
    comment: string | null;
  }>(
    `SELECT d.uid, d.number, d.status::text, d.status_comment AS comment
       FROM document d
       JOIN company co ON co.id = d.company_id
      WHERE d.status = 'pending_approval'
        AND co.id = ANY($1::bigint[])
        AND (SELECT count(*) FROM document_line l WHERE l.document_id = d.id) > 0
      ORDER BY d.id DESC
      LIMIT 1`,
    [approver.companyIds.map(String)],
  );
  uid = found.rows[0]!.uid;
  number = found.rows[0]!.number;
  before = { status: found.rows[0]!.status, comment: found.rows[0]!.comment };

  // Заказ со строками в компании этого человека: из него и выпишем счёт.
  const ord = await db.query<{ uid: string; number: string; total: string; lines: string }>(
    `SELECT o.uid, o.number, o.amount_total::text AS total,
            (SELECT count(*) FROM sales_order_line l WHERE l.sales_order_id = o.id)::text AS lines
       FROM sales_order o
      WHERE o.status <> 'cancelled' AND o.company_id = ANY($1::bigint[])
        AND (SELECT count(*) FROM sales_order_line l WHERE l.sales_order_id = o.id) > 0
      ORDER BY o.id DESC LIMIT 1`,
    [approver.companyIds.map(String)],
  );
  expect(ord.rows[0], 'в базе нужен заказ со строками').toBeTruthy();
  order = {
    uid: ord.rows[0]!.uid,
    number: ord.rows[0]!.number,
    total: ord.rows[0]!.total,
    lines: Number(ord.rows[0]!.lines),
  };
}, 60_000);

afterAll(async () => {
  // Возвращаем документ в то состояние, в котором его застали: это бумага из
  // базы разработки, а не след проверки.
  if (uid) {
    await db.query(
      `UPDATE document SET status = $1::"DocumentStatus", status_comment = $2 WHERE uid = $3::uuid`,
      [before.status, before.comment, uid],
    );
  }
  // Выписанные прогоном документы уносим с собой: счётчик нумерации при этом
  // остаётся сдвинутым — он и должен, дырку в номерах объясняют налоговой,
  // а не базе.
  for (const made of madeDocuments) {
    await db.query(
      `DELETE FROM document_line WHERE document_id = (SELECT id FROM document WHERE uid = $1::uuid)`,
      [made],
    );
    await db.query(`DELETE FROM document WHERE uid = $1::uuid`, [made]);
  }
  await db.end();
});

describe('документы в боте: раздел', () => {
  it('открывается вкладками и находит документ по номеру', async () => {
    const talk = new Talk(approver);
    await talk.press('d');
    expect(plain(talk.screen), 'не сказано, что здесь за бумаги').toMatch(/счёта, договоры/);
    const labels = buttons(talk.screen).join(' | ');
    expect(labels).toMatch(/Ждут решения/);
    expect(labels).toMatch(/Найти документ/);

    await talk.press('d:f');
    expect(plain(talk.screen), 'нет примера, как искать').toMatch(/СЧ-/);
    await talk.say(number);
    expect(plain(talk.screen), 'поиск по номеру не нашёл документ').toContain(number);
  });

  it('в списке ждущих решения показывает суть каждой бумаги', async () => {
    const talk = new Talk(approver);
    await talk.press('d:s:wait');
    const text = plain(talk.screen);
    expect(text).toMatch(/Ждут решения/);
    expect(text, 'в списке не видно суммы').toMatch(/сум|\$/);
    const first = talk.screen.keyboard.flat().find((b) => b.data.startsWith('d:c:'));
    expect(first, 'ни одного документа в списке').toBeTruthy();
  });

  it('карточка объясняет статус и даёт файл обоих видов', async () => {
    const talk = new Talk(approver);
    await talk.press(`d:c:${uid}`);
    const card = plain(talk.screen);
    expect(card).toContain(number);
    expect(card, 'не объяснено, что документ ждёт решения').toMatch(/ждёт решения/);
    expect(card, 'в карточке нет строк документа').toMatch(/В документе/);
    const labels = buttons(talk.screen).join(' | ');
    expect(labels).toMatch(/PDF/);
    expect(labels).toMatch(/DOCX/);
    expect(labels, 'согласующему не предложили утвердить').toMatch(/Утвердить/);
    expect(labels, 'согласующему не предложили вернуть').toMatch(/Вернуть/);
  });

  it('у кого нет права согласовывать — тому и кнопки нет, и нажатие не проходит', async () => {
    const author: Me = {
      ...approver,
      permissions: new Set(['documents.view', 'documents.edit']),
    };
    const talk = new Talk(author);
    await talk.press(`d:c:${uid}`);
    const labels = buttons(talk.screen).join(' | ');
    expect(labels, 'утверждение предложили без права').not.toMatch(/Утвердить/);

    // Кнопки нет, но её данные известны: запрет не держится на отрисовке.
    await talk.press(`d:y:a:${uid}`);
    expect(talk.screen.toast, 'отказа не было').toMatch(/прав/i);
    expect((await statusOf(uid)).status, 'документ утвердили без права').toBe('pending_approval');
  });
});

describe('документы в боте: маршрут', () => {
  /**
   * Весь маршрут одним сценарием: это один разговор, и проверять его частями
   * значит проверять не то, что видит человек.
   */
  it('возвращает с причиной, принимает заново, утверждает и отмечает подписанным', async () => {
    const talk = new Talk(approver);
    await talk.press(`d:c:${uid}`);

    // 1. Вернуть на доработку. Без слов — нельзя.
    await talk.tap('↩️ Вернуть');
    expect(plain(talk.screen), 'причину не спросили').toMatch(/Напишите причину/);
    expect(plain(talk.screen), 'не сказано, зачем причина').toMatch(/не узнает/);

    await talk.say('нет');
    expect(plain(talk.screen), 'короткую отписку приняли за причину').toMatch(/Слишком коротко/);
    expect((await statusOf(uid)).status, 'документ вернули без причины').toBe('pending_approval');

    await talk.say('перепутана ставка НДС во второй строке');
    expect(plain(talk.screen)).toMatch(/Возвращён на доработку/);
    const back = await statusOf(uid);
    expect(back.status).toBe('returned');
    expect(back.comment, 'причина не записалась').toMatch(/ставка НДС/);
    // Причину видно в карточке рядом со статусом, а не только в истории.
    expect(plain(talk.screen), 'в карточке не видно, что переделать').toMatch(/Причина/);
    expect(plain(talk.screen)).toMatch(/ставка НДС/);

    // 2. Автор отправляет заново — это право работы с документом, не согласования.
    await talk.tap('📨 На согласование');
    expect(plain(talk.screen), 'не сказано, что будет после отправки').toMatch(
      /править цифры после этого будет нельзя/,
    );
    await talk.tap('✅ Да');
    expect(plain(talk.screen)).toMatch(/Отправлено на согласование/);
    expect((await statusOf(uid)).status).toBe('pending_approval');

    // 3. Утвердить.
    await talk.tap('✅ Утвердить');
    expect(plain(talk.screen), 'не сказано, с чем человек соглашается').toMatch(
      /соглашаетесь с тем, что в документе написано/,
    );
    await talk.tap('✅ Да');
    expect(plain(talk.screen)).toMatch(/Утверждён/);
    expect((await statusOf(uid)).status).toBe('approved');

    // 4. Отметить подписанным.
    await talk.tap('🖋 Подписан');
    await talk.tap('✅ Да');
    expect((await statusOf(uid)).status).toBe('signed');
    expect(plain(talk.screen), 'не объяснено, что значит подписан').toMatch(/подписана сторонами/);
  });

  it('отмена тоже требует слов и объясняет, зачем они', async () => {
    const talk = new Talk(approver);
    await talk.press(`d:c:${uid}`);
    await talk.tap('🚫 Отменить');
    expect(plain(talk.screen), 'причину отмены не спросили').toMatch(/Напишите причину/);
    expect(plain(talk.screen), 'не сказано, зачем причина отмены').toMatch(/журнале/);

    await talk.say('выписан на неверного контрагента, выписан новый');
    expect(plain(talk.screen)).toMatch(/Отменён/);
    const after = await statusOf(uid);
    expect(after.status).toBe('cancelled');
    expect(after.comment).toMatch(/неверного контрагента/);
    // Отменённому документу бот больше ничего не предлагает, кроме файлов.
    const labels = buttons(talk.screen).join(' | ');
    expect(labels).not.toMatch(/Утвердить|На согласование/);
    expect(plain(talk.screen)).toMatch(/Действий по этому документу у вас нет/);
  });
});

describe('документы в боте: файл', () => {
  it('отдаёт DOCX того же документа и той же печатной формой', async () => {
    const talk = new Talk(approver);
    await talk.press(`d:w:${uid}`);
    const file = talk.screen.file;
    expect(file, 'файл не приложен').toBeTruthy();
    expect(file!.fileName, 'имя файла без номера документа').toContain(
      number.replace(/[^\dA-Za-zА-Яа-я-]/g, '-'),
    );
    expect(file!.fileName.endsWith('.docx')).toBe(true);
    expect(file!.mimeType).toMatch(/wordprocessingml/);
    expect(file!.bytes.byteLength, 'файл пустой').toBeGreaterThan(1_000);
    // DOCX — это zip, он начинается с «PK»: проверяем, что это документ, а не
    // пустая заготовка с нужным расширением.
    expect(Buffer.from(file!.bytes.slice(0, 2)).toString('latin1'), 'это не docx').toBe('PK');
    expect(plain(talk.screen), 'человеку не сказали, что файл ушёл').toMatch(/Файл отправлен/);
  });

  it('отдаёт PDF — тот же, что скачивают в системе', async () => {
    const talk = new Talk(approver);
    await talk.press(`d:p:${uid}`);
    const file = talk.screen.file;
    expect(file, 'файл не приложен').toBeTruthy();
    expect(file!.fileName.endsWith('.pdf')).toBe(true);
    expect(file!.mimeType).toBe('application/pdf');
    // Первые байты PDF — «%PDF»: проверяем, что это действительно он.
    const head = Buffer.from(file!.bytes.slice(0, 4)).toString('latin1');
    expect(head, 'это не PDF').toBe('%PDF');
  }, 120_000);
});

/**
 * Выписка документа из заказа (ТЗ 7.1, 11.6).
 *
 * Менеджер стоит в заказе и говорит «надо счёт». Больше он знать ничего не
 * обязан: реквизиты, строки, суммы и сумму прописью собирает служба — та же,
 * что заполняет форму в браузере. Проверяется, что бот предлагает уместные
 * типы, показывает бумагу до выписки и отдаёт готовый черновик с файлом.
 */
describe('документы в боте: счёт из заказа', () => {
  it('предлагает счёт и спецификацию, но не накладную', async () => {
    const talk = new Talk(approver);
    await talk.press(`d:ns:${order.uid}`);
    const labels = buttons(talk.screen).join(' | ');

    expect(plain(talk.screen), 'не назван заказ').toContain(order.number);
    expect(labels, 'счёт на оплату не предложен').toMatch(/Счёт на оплату/);
    expect(labels, 'спецификация не предложена').toMatch(/Спецификация/);
    // ТТН — документ о том, что машина уехала. Из заказа, по которому ничего
    // не отгружали, такой бумаге взяться неоткуда.
    expect(labels, 'из заказа предложили накладную').not.toMatch(/накладная/i);
    expect(plain(talk.screen), 'не сказано, что заполнять ничего не нужно').toMatch(
      /руками ничего вписывать не нужно/,
    );
  });

  it('до выписки показывает, что попадёт в бумагу', async () => {
    const talk = new Talk(approver);
    await talk.press(`d:ns:${order.uid}`);
    await talk.tap('Счёт на оплату');
    const text = plain(talk.screen);

    expect(text).toContain(order.number);
    expect(text, 'суммы заказа на экране нет').toMatch(/Сумма/);
    expect(text, 'числа позиций нет').toContain(String(order.lines));
    // Главное, что человек должен понять: бумага не обновляется вместе с заказом.
    expect(text, 'не объяснено, что документ — снимок').toMatch(/снимок заказа/);
    expect(buttons(talk.screen).join(' | ')).toMatch(/Выписать документ/);
  });

  it('выписывает черновик со строками заказа и отдаёт PDF', async () => {
    const talk = new Talk(approver);
    await talk.press(`d:ns:${order.uid}`);
    await talk.tap('Счёт на оплату');
    await talk.tap('✅ Выписать документ');

    const made = plain(talk.screen).match(/[A-ZА-Я]{2,4}-[\d/]+/);
    expect(made, `номера документа на экране нет: ${plain(talk.screen)}`).not.toBeNull();

    // По номеру и самой свежей записи: номер уникален внутри компании, и у
    // соседней компании может лежать бумага с тем же номером.
    const row = await db.query<{
      uid: string;
      status: string;
      source: string | null;
      total: string;
      lines: string;
      order_number: string | null;
    }>(
      `SELECT d.uid, d.status::text, d.source_doc_type AS source,
              d.amount_total::text AS total,
              (SELECT count(*) FROM document_line l WHERE l.document_id = d.id)::text AS lines,
              o.number AS order_number
         FROM document d
         LEFT JOIN sales_order o ON o.id = d.source_doc_id
        WHERE d.number = $1
        ORDER BY d.id DESC LIMIT 1`,
      [made![0]],
    );
    expect(row.rows[0], 'документа в базе нет').toBeTruthy();
    madeDocuments.push(row.rows[0]!.uid);

    expect(row.rows[0]!.status, 'документ вышел не черновиком').toBe('draft');
    expect(row.rows[0]!.source).toBe('sales_order');
    expect(row.rows[0]!.order_number, 'документ не привязан к заказу').toBe(order.number);
    // Снимок, а не вид на заказ: строки и сумма записаны в сам документ.
    expect(Number(row.rows[0]!.lines)).toBe(order.lines);
    expect(Number(row.rows[0]!.total)).toBeCloseTo(Number(order.total), 2);

    // На карточке сразу есть файл клиенту и следующий шаг маршрута.
    const labels = buttons(talk.screen).join(' | ');
    expect(labels, 'PDF не предложен').toMatch(/PDF/);
    expect(labels, 'нет следующего шага маршрута').toMatch(/На согласование/);
    expect(plain(talk.screen), 'не сказано, что это черновик').toMatch(/черновик/);
  });

  it('без права править документы не выписывает', async () => {
    const watcher: Me = { ...approver, permissions: new Set(['documents.view', 'sales.view']) };
    const talk = new Talk(watcher);
    await talk.press(`d:ns:${order.uid}`);
    expect(talk.screen.toast, 'отказа не было').toMatch(/прав/i);
    expect(plain(talk.screen), 'показали выбор типа без права').not.toMatch(/Какой документ нужен/);
  });

  it('кнопка с чужого экрана без разговора ничего не выписывает', async () => {
    // Кнопка «Выписать документ» остаётся в чате, а разговор к этому времени
    // закончился: заказа бот уже не помнит, и выписывать нечего.
    const screen = await docs.route(approver, null, 'd:ngo', false);
    expect(screen.toast, 'не сказано, что кнопка устарела').toBeTruthy();
    expect(screen.flow, 'разговор остался висеть').toBeNull();
  });
});
