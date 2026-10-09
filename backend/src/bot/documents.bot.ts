import { Injectable, Logger } from '@nestjs/common';
import { DocumentsService } from '../documents/documents.service.js';
import { DocumentWorkflowService } from '../documents/workflow.service.js';
import { DocumentRenderService } from '../documents/render.service.js';
import { DocumentsFromSourceService } from '../documents/from-source.service.js';
import { OrdersService } from '../sales/orders.service.js';
import {
  DOCUMENT_ACTIONS,
  TRANSITIONS,
  type DocumentAction,
  type DocumentStatus,
} from '../documents/workflow.js';
import {
  asUser,
  escape,
  homeRow,
  qtyText,
  type Me,
  type Screen,
  type SectionFlow,
} from './section.js';
import { sum, showDay } from './format.js';
import { ACTION, D, STATUS, TAB } from './documents.texts.js';
import { BLUE, CB, GREEN, RED } from './menu.js';
import type { InlineButton, InlineKeyboard } from './telegram.api.js';

/**
 * Раздел «Документы» в боте (ТЗ 11.6, решение заказчика 02.10 — весь
 * функционал).
 *
 * Согласование — то, из-за чего документ стоит на месте неделю: бумага ждёт
 * человека, который в разъездах. Поэтому в боте есть всё, что нужно для
 * решения: список ждущих, карточка со строками и причиной возврата, действия
 * маршрута и сам файл — PDF клиенту, DOCX на правку.
 *
 * Правил маршрута здесь нет. Какие действия доступны, какое право нужно и где
 * обязательны слова — всё в `documents/workflow.ts`, и бот берёт кнопки из того
 * же `availableActions`, что экран в браузере. Своё у бота одно: он объясняет
 * каждое действие словами до нажатия.
 */

/** Незаконченный разговор раздела. Своего файла ему не нужно: шага всего два. */
interface Flow extends SectionFlow {
  kind: 'doc';
  step: 'search' | 'comment' | 'type' | 'newConfirm';
  uid?: string;
  number?: string;
  action?: DocumentAction;
  /**
   * Заказ, из которого выписывают документ. Хранится в разговоре, а не в
   * кнопке: номер заказа и номер типа вместе в 64 знака `callback_data` не
   * влезают — только uuid занимает 36.
   */
  sourceUid?: string;
  sourceNumber?: string;
  typeUid?: string;
  typeName?: string;
}

/** Буква действия в кнопке. Полное имя вместе с uuid не влезает в 64 знака. */
const CODE: Record<DocumentAction, string> = {
  submit: 's',
  approve: 'a',
  return: 'r',
  sign: 'n',
  cancel: 'x',
};
const ACTION_BY_CODE: Record<string, DocumentAction> = Object.fromEntries(
  DOCUMENT_ACTIONS.map((a) => [CODE[a], a]),
);

/** Сколько строк и кнопок показываем. Больше на телефоне не читается. */
const LIST_LIMIT = 8;
/** Сколько строк документа показываем в карточке: остальное видно в файле. */
const LINES_LIMIT = 6;
/** Причина короче этого ничего не объясняет. */
const COMMENT_MIN = 5;

@Injectable()
export class BotDocuments {
  private readonly log = new Logger('bot/documents');

  constructor(
    private readonly documents: DocumentsService,
    private readonly workflow: DocumentWorkflowService,
    private readonly render: DocumentRenderService,
    private readonly fromSource: DocumentsFromSourceService,
    // Заказ читаем только чтобы показать, что попадёт в бумагу. Правил продаж
    // раздел документов не повторяет.
    private readonly orders: OrdersService,
  ) {}

  private as<T>(me: Me, uz: boolean, fn: () => Promise<T>): Promise<T> {
    return asUser(me, uz, fn);
  }

  // --- разбор нажатий -------------------------------------------------------

  async route(me: Me, any: SectionFlow | null, data: string, uz: boolean): Promise<Screen> {
    const flow = any?.kind === 'doc' ? (any as Flow) : null;

    if (data === CB.doc) return { ...this.home(me, uz), flow: null };
    if (data === CB.docSearch) {
      return {
        text: D.askSearch(uz),
        keyboard: [this.row(uz)],
        flow: { kind: 'doc', step: 'search' } satisfies Flow,
      };
    }
    if (data === CB.docCancel) {
      if (flow?.uid) return this.card(me, flow.uid, uz, D.cancelled(uz), null);
      return { ...this.home(me, uz), toast: D.cancelled(uz), flow: null };
    }
    if (data.startsWith('d:ns:')) return this.newBegin(me, data.slice(5), uz);
    if (data.startsWith('d:nt:')) {
      if (!flow?.sourceUid) return { ...this.home(me, uz), toast: D.stale(uz), flow: null };
      return this.newType(me, flow, data.slice(5), uz);
    }
    if (data === CB.docNewGo) {
      if (!flow?.sourceUid || !flow.typeUid) {
        return { ...this.home(me, uz), toast: D.stale(uz), flow: null };
      }
      return this.newSave(me, flow, uz);
    }
    if (data.startsWith('d:s:')) return this.list(me, data.slice(4), undefined, uz);
    if (data.startsWith('d:c:')) return this.card(me, data.slice(4), uz, undefined, null);
    if (data.startsWith('d:p:')) return this.file(me, data.slice(4), 'pdf', uz);
    if (data.startsWith('d:w:')) return this.file(me, data.slice(4), 'docx', uz);
    if (data.startsWith('d:q:')) return this.ask(me, data.slice(4), uz);
    if (data.startsWith('d:y:')) return this.apply(me, data.slice(4), uz, null);

    return { ...this.home(me, uz), toast: D.stale(uz) };
  }

  home(me: Me, uz: boolean): Screen {
    const rows: InlineKeyboard = [
      [this.tabButton('wait', uz), this.tabButton('draft', uz)],
      [this.tabButton('back', uz), this.tabButton('all', uz)],
      [{ text: uz ? '🔍 Qidirish' : '🔍 Найти документ', data: CB.docSearch, style: BLUE }],
      [{ text: uz ? '⬅️ Menyu' : '⬅️ Меню', data: CB.menu, style: BLUE }],
    ];
    return { text: D.home(uz), keyboard: rows };
  }

  private tabButton(key: string, uz: boolean): InlineButton {
    const tab = TAB.find((t) => t.key === key)!;
    return { text: `${tab.mark} ${uz ? tab.uz : tab.ru}`, data: CB.docTab(key), style: BLUE };
  }

  // --- выписка документа из заказа -----------------------------------------

  /**
   * «Надо счёт по этому заказу».
   *
   * Собирает документ та же служба, что и форма в браузере
   * (`DocumentsFromSourceService`): реквизиты, строки, суммы и сумма прописью
   * — всё оттуда. Бот только спрашивает тип и показывает, что уйдёт в бумагу.
   *
   * Какие типы предлагать, тоже решает служба (`typesFor`): из заказа не
   * выписывают товарно-транспортную накладную — это документ о том, что машина
   * уехала, а здесь ещё ничего не отгружали.
   */
  private async newBegin(me: Me, orderUid: string, uz: boolean): Promise<Screen> {
    if (!me.permissions.has('documents.edit')) {
      return { ...this.home(me, uz), toast: D.noRight(uz), flow: null };
    }

    let order: Awaited<ReturnType<OrdersService['one']>>;
    let types: Awaited<ReturnType<DocumentsFromSourceService['typesFor']>>;
    try {
      order = await this.as(me, uz, () => this.orders.one(orderUid));
      types = await this.as(me, uz, () => this.fromSource.typesFor('sales_order', orderUid));
    } catch (e) {
      return this.refusal(me, uz, e);
    }

    const offered = types.rows.filter((t) => t.suggested);
    if (offered.length === 0) {
      return {
        text: D.newNoTypes(uz),
        keyboard: [[this.backToOrder(orderUid, uz)], this.row(uz)],
        flow: null,
      };
    }

    const flow: Flow = {
      kind: 'doc',
      step: 'type',
      sourceUid: orderUid,
      sourceNumber: order.number,
    };
    return {
      text: D.newAskType(uz, escape(order.number)),
      keyboard: [
        ...offered.map((t) => [
          {
            text: uz ? t.nameUz : t.nameRu,
            data: CB.docType(t.uid),
            style: BLUE,
          },
        ]),
        [this.backToOrder(orderUid, uz)],
      ],
      fresh: true,
      flow,
    };
  }

  /** Тип выбран — показываем, что попадёт в бумагу, до того как её выпишем. */
  private async newType(me: Me, flow: Flow, typeUid: string, uz: boolean): Promise<Screen> {
    let order: Awaited<ReturnType<OrdersService['one']>>;
    let types: Awaited<ReturnType<DocumentsFromSourceService['typesFor']>>;
    try {
      order = await this.as(me, uz, () => this.orders.one(flow.sourceUid!));
      types = await this.as(me, uz, () => this.fromSource.typesFor('sales_order', flow.sourceUid!));
    } catch (e) {
      return this.refusal(me, uz, e);
    }
    const type = types.rows.find((t) => t.uid === typeUid);
    if (!type) return { ...this.home(me, uz), toast: D.stale(uz), flow: null };

    const label = (ru: string, uzs: string) => (uz ? uzs : ru);
    const lines = [
      `${label('Заказ', 'Buyurtma')}: <b>${escape(order.number)}</b>`,
      `${label('Клиент', 'Mijoz')}: ${escape(uz ? order.partner.nameUz : order.partner.nameRu)}`,
      `${label('Сумма', 'Summa')}: <b>${sum(order.amountTotal, order.currency, uz)}</b>`,
      `${label('Позиций', 'Qatorlar')}: ${order.lines.length}`,
      ...(order.paymentDueDate
        ? [`${label('Оплатить до', 'To‘lov muddati')}: ${showDay(order.paymentDueDate)}`]
        : []),
    ];

    const next: Flow = {
      ...flow,
      step: 'newConfirm',
      typeUid: type.uid,
      typeName: uz ? type.nameUz : type.nameRu,
    };
    return {
      text: D.newConfirm(uz, escape(next.typeName!), lines),
      keyboard: [
        [
          {
            text: uz ? '✅ Hujjatni tayyorlash' : '✅ Выписать документ',
            data: CB.docNewGo,
            style: GREEN,
          },
        ],
        [
          { text: uz ? '⬅️ Orqaga' : '⬅️ Назад', data: CB.docNew(flow.sourceUid!), style: BLUE },
          { text: uz ? '❌ Bekor qilish' : '❌ Отменить', data: CB.docCancel, style: RED },
        ],
      ],
      flow: next,
    };
  }

  /**
   * Выписать. Второго нажатия бояться не нужно по той же причине, что в
   * продажах: ключа повторной отправки у создания документа нет, зато разговор
   * после записи заканчивается (`flow: null`), а обновления Telegram бот
   * разбирает по одному — второе нажатие попадает в разговор, которого уже нет.
   */
  private async newSave(me: Me, flow: Flow, uz: boolean): Promise<Screen> {
    if (!me.permissions.has('documents.edit')) {
      return { ...this.home(me, uz), toast: D.noRight(uz), flow: null };
    }
    try {
      const out = await this.as(me, uz, () =>
        this.fromSource.create({
          documentTypeUid: flow.typeUid!,
          sourceType: 'sales_order',
          sourceUid: flow.sourceUid!,
          locale: uz ? 'uz' : 'ru',
        }),
      );
      const card = await this.card(me, out.uid, uz, D.newSaved(uz, out.number), null);
      return { ...card, fresh: false };
    } catch (e) {
      return this.refusal(me, uz, e);
    }
  }

  private backToOrder(orderUid: string, uz: boolean): InlineButton {
    return {
      text: uz ? '⬅️ Buyurtmaga' : '⬅️ К заказу',
      data: CB.salOrder(orderUid),
      style: BLUE,
    };
  }

  private row(uz: boolean): InlineButton[] {
    return homeRow(CB.doc, 'Документы', 'Hujjatlar', uz);
  }

  async text(me: Me, any: SectionFlow, raw: string, uz: boolean): Promise<Screen> {
    const flow = any.kind === 'doc' ? (any as Flow) : null;
    if (!flow) return { ...this.home(me, uz), toast: D.stale(uz), flow: null };
    const typed = raw.trim();

    if (flow.step === 'search') return this.list(me, 'all', typed, uz);

    if (flow.step === 'comment') {
      if (!flow.uid || !flow.action) {
        return { ...this.home(me, uz), toast: D.stale(uz), flow: null };
      }
      if (typed.length < COMMENT_MIN) {
        return {
          text: `${D.shortComment(uz)}\n\n${D.askComment(uz, escape(flow.number ?? ''), flow.action)}`,
          keyboard: [this.commentFooter(flow, uz)],
          fresh: true,
          flow,
        };
      }
      return this.apply(me, `${CODE[flow.action]}:${flow.uid}`, uz, typed.slice(0, 500), true);
    }

    return { ...this.home(me, uz), toast: D.stale(uz), flow: null };
  }

  // --- список и карточка ----------------------------------------------------

  private async list(
    me: Me,
    key: string,
    search: string | undefined,
    uz: boolean,
  ): Promise<Screen> {
    const tab = TAB.find((t) => t.key === key) ?? TAB.find((t) => t.key === 'all')!;
    const out = await this.as(me, uz, () =>
      this.documents.list({
        ...(tab.status ? { status: tab.status } : {}),
        ...(search ? { search } : {}),
        limit: LIST_LIMIT,
      }),
    );
    if (out.rows.length === 0 && search) {
      return {
        text: `${D.searchEmpty(uz, escape(search))}\n\n${D.askSearch(uz)}`,
        keyboard: [this.row(uz)],
        fresh: true,
        flow: { kind: 'doc', step: 'search' } satisfies Flow,
      };
    }
    const title = search
      ? `<b>🔍 ${escape(search)}</b>`
      : `<b>${tab.mark} ${uz ? tab.uz : tab.ru}</b>`;
    const lines = out.rows.map((r) => {
      const st = STATUS[r.status as DocumentStatus];
      return (
        `${st?.mark ?? '•'} <b>${escape(r.number)}</b> · ` +
        `${escape(uz ? r.type.nameUz : r.type.nameRu)}\n` +
        `  ${escape(r.partner?.name ?? (uz ? 'kontragentsiz' : 'без контрагента'))} · ` +
        `${sum(r.amountTotal, r.currency ?? 'UZS', uz)} · ` +
        `${st ? (uz ? st.uz : st.ru) : r.status}`
      );
    });
    const keyboard: InlineKeyboard = out.rows.map((r) => [
      {
        text: `${STATUS[r.status as DocumentStatus]?.mark ?? '•'} ${r.number} · ${
          r.partner?.name ?? (uz ? r.type.nameUz : r.type.nameRu)
        }`,
        data: CB.docOne(r.uid),
        style: BLUE,
      },
    ]);
    keyboard.push(this.row(uz));
    return {
      text: D.list(uz, title, lines),
      keyboard,
      fresh: Boolean(search),
      flow: search ? null : undefined,
    };
  }

  /**
   * Карточка документа: что в бумаге, где она сейчас и что с ней можно сделать.
   *
   * Кнопки — из `availableActions` службы, а не из своего перечня: иначе бот
   * предлагал бы действие, на которое придёт отказ.
   */
  private async card(
    me: Me,
    uid: string,
    uz: boolean,
    note?: string,
    flow: null | undefined = undefined,
  ): Promise<Screen> {
    let doc: Awaited<ReturnType<DocumentsService['one']>>;
    try {
      doc = await this.as(me, uz, () => this.documents.one(uid));
    } catch (e) {
      return this.refusal(me, uz, e);
    }
    const label = (ru: string, uzs: string) => (uz ? uzs : ru);
    const st = STATUS[doc.status as DocumentStatus];
    const lines = [
      `<b>${escape(doc.number)}</b> · ${st?.mark ?? '•'} ${escape(
        st ? (uz ? st.uz : st.ru) : doc.status,
      )}`,
      `${label('Тип', 'Turi')}: ${escape(uz ? doc.type.nameUz : doc.type.nameRu)}`,
      `${label('Дата', 'Sana')}: ${this.day(doc.documentDate)}`,
      ...(doc.partner
        ? [
            `${label('Контрагент', 'Kontragent')}: ${escape(doc.partner.name)}` +
              (doc.partner.inn ? ` (${escape(doc.partner.inn)})` : ''),
          ]
        : []),
      `${label('Сумма', 'Summa')}: <b>${sum(doc.amountTotal, doc.currency ?? 'UZS', uz)}</b>` +
        (Number(doc.amountVat) > 0
          ? ` (${label('в т.ч. НДС', 'shu jumladan QQS')} ${sum(doc.amountVat, doc.currency ?? 'UZS', uz)})`
          : ''),
      ...(doc.source?.number
        ? [`${label('Основание', 'Asos')}: ${escape(doc.source.number)}`]
        : []),
      ...(doc.author ? [`${label('Выписал', 'Yozgan')}: ${escape(doc.author.name)}`] : []),
      `${label('Компания', 'Kompaniya')}: ${escape(uz ? doc.company.nameUz : doc.company.nameRu)}`,
    ];

    /**
     * Строки документа — отдельным блоком под его реквизитами. Внутри списка
     * полей они читались как стена, и «Выписал» после трёх строк терялся.
     */
    const items = [
      ...doc.lines
        .slice(0, LINES_LIMIT)
        .map(
          (l) =>
            `${l.seq}. ${escape(l.name)}\n   ${qtyText(l.qty, l.unitCode)} × ` +
            `${sum(l.price, doc.currency ?? 'UZS', uz)}`,
        ),
      ...(doc.lines.length > LINES_LIMIT
        ? [`${label('и ещё строк', 'va yana qator')}: ${doc.lines.length - LINES_LIMIT}`]
        : []),
    ];

    const keyboard: InlineKeyboard = [];
    const actions = doc.actions as DocumentAction[];
    for (const action of actions) {
      const a = ACTION[action];
      keyboard.push([
        {
          text: `${a.mark} ${uz ? a.uz : a.ru}`,
          data: CB.docAsk(CODE[action], uid),
          style: action === 'cancel' || action === 'return' ? RED : BLUE,
        },
      ]);
    }
    keyboard.push([
      { text: '📄 PDF', data: CB.docPdf(uid), style: GREEN },
      { text: '📝 DOCX', data: CB.docDocx(uid), style: GREEN },
    ]);
    keyboard.push(this.row(uz));

    const help =
      (st ? (uz ? st.helpUz : st.helpRu) : '') +
      (actions.length === 0 ? `\n${D.nothingToDo(uz)}` : '');
    const why =
      doc.statusComment && doc.statusUser
        ? D.why(uz, escape(doc.statusUser), escape(doc.statusComment))
        : null;
    const text = D.card(uz, lines, items, help, why);
    return { text: note ? `${note}\n\n${text}` : text, keyboard, fresh: Boolean(note), flow };
  }

  private day(value: unknown): string {
    if (!value) return '—';
    const iso = value instanceof Date ? value.toISOString() : String(value);
    return showDay(iso.slice(0, 10));
  }

  // --- маршрут --------------------------------------------------------------

  private async ask(me: Me, tail: string, uz: boolean): Promise<Screen> {
    const [code, uid] = this.split(tail);
    const action = code ? ACTION_BY_CODE[code] : undefined;
    if (!action || !uid) return { ...this.home(me, uz), toast: D.stale(uz) };
    if (!me.permissions.has(TRANSITIONS[action].permission)) {
      return { ...(await this.card(me, uid, uz)), toast: D.noRight(uz) };
    }
    let doc: Awaited<ReturnType<DocumentsService['one']>>;
    try {
      doc = await this.as(me, uz, () => this.documents.one(uid));
    } catch (e) {
      return this.refusal(me, uz, e);
    }

    // Возврат и отмена без слов — это «переделай, а что именно, догадайся».
    // Того же требует и служба, поэтому спрашиваем причину до нажатия.
    if (TRANSITIONS[action].needsComment) {
      const flow: Flow = { kind: 'doc', step: 'comment', uid, number: doc.number, action };
      return {
        text: D.askComment(uz, escape(doc.number), action),
        keyboard: [this.commentFooter(flow, uz)],
        flow,
      };
    }

    return {
      text: D.ask(uz, escape(doc.number), action),
      keyboard: [
        [
          {
            text: `✅ ${uz ? 'Ha' : 'Да'}`,
            data: CB.docDo(CODE[action], uid),
            style: GREEN,
          },
        ],
        [{ text: uz ? '⬅️ Orqaga' : '⬅️ Назад', data: CB.docOne(uid), style: BLUE }],
      ],
    };
  }

  private commentFooter(flow: Flow, uz: boolean): InlineButton[] {
    return [
      {
        text: uz ? '⬅️ Hujjatga' : '⬅️ К документу',
        data: flow.uid ? CB.docOne(flow.uid) : CB.doc,
        style: BLUE,
      },
      { text: uz ? '❌ Bekor qilish' : '❌ Отменить', data: CB.docCancel, style: RED },
    ];
  }

  private async apply(
    me: Me,
    tail: string,
    uz: boolean,
    comment: string | null,
    fresh = false,
  ): Promise<Screen> {
    const [code, uid] = this.split(tail);
    const action = code ? ACTION_BY_CODE[code] : undefined;
    if (!action || !uid) return { ...this.home(me, uz), toast: D.stale(uz) };
    if (!me.permissions.has(TRANSITIONS[action].permission)) {
      return { ...(await this.card(me, uid, uz)), toast: D.noRight(uz), flow: null };
    }
    try {
      await this.as(me, uz, () => this.workflow.act(uid, action, comment));
    } catch (e) {
      return this.refusal(me, uz, e);
    }
    const card = await this.card(me, uid, uz, D.done(uz, action), null);
    return { ...card, fresh: fresh || card.fresh };
  }

  private split(tail: string): [string | undefined, string | undefined] {
    const i = tail.indexOf(':');
    return i < 0 ? [undefined, undefined] : [tail.slice(0, i), tail.slice(i + 1)];
  }

  // --- файл -----------------------------------------------------------------

  /**
   * Файл документа человеку в чат.
   *
   * Собирает его та же служба, что отдаёт файл в браузере: печатная форма
   * должна быть одна и та же — иначе клиент получит из бота не ту бумагу, что
   * из системы. PDF может собираться несколько секунд (LibreOffice), поэтому
   * экран сначала говорит об этом, а файл уезжает отдельным сообщением.
   */
  private async file(me: Me, uid: string, format: 'pdf' | 'docx', uz: boolean): Promise<Screen> {
    try {
      const out =
        format === 'pdf'
          ? await this.as(me, uz, () => this.render.pdf(uid))
          : await this.as(me, uz, () => this.render.docx(uid));
      const card = await this.card(me, uid, uz, undefined, null);
      const bytes = out.buffer.buffer.slice(
        out.buffer.byteOffset,
        out.buffer.byteOffset + out.buffer.byteLength,
      ) as ArrayBuffer;
      return {
        ...card,
        text: `${D.fileSent(uz, escape(out.fileName))}\n\n${card.text}`,
        fresh: true,
        file: {
          bytes,
          fileName: out.fileName,
          mimeType:
            format === 'pdf'
              ? 'application/pdf'
              : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      };
    } catch (e) {
      return this.refusal(me, uz, e);
    }
  }

  /** Отказ службы документов — человеку её словами: они написаны для людей. */
  private refusal(me: Me, uz: boolean, e: unknown): Screen {
    const message = String((e as { message?: string }).message ?? e);
    this.log.warn(`документы в боте: ${message}`);
    const home = this.home(me, uz);
    return {
      ...home,
      text: `${D.refused(uz, escape(message))}\n\n${home.text}`,
      flow: null,
    };
  }
}
