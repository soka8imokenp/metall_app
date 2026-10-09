import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  asUser,
  comingNext,
  escape,
  explainButton,
  type Incoming,
  type Me,
  type Screen,
  type SectionFlow,
  understoodButton,
} from './section.js';
import { FinanceService } from '../finance/finance.service.js';
import { OperationsService } from '../finance/operations.service.js';
import { ApprovalsService, type Action } from '../finance/approvals.service.js';
import { WriteService } from '../finance/write.service.js';
import { OrdersService } from '../sales/orders.service.js';
import { paymentStateByUid } from '../sales/order-payment.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { ACTION, F, STATUS, STATUS_HELP } from './finance.texts.js';
import { R } from './rates.texts.js';
import {
  BASE_CURRENCY,
  type Flow,
  type FlowStep,
  moment,
  nextStep,
  order,
  parseAmount,
  parseDay,
  prevStep,
  shiftDay,
  showDay,
  sum,
  today,
} from './finance.flow.js';
import { BLUE, CB, GREEN, RED, finRow } from './menu.js';
import type { InlineButton, InlineKeyboard } from './telegram.api.js';

/**
 * Раздел «Финансы» в боте целиком (ТЗ 11.2, решение заказчика 02.10).
 *
 * Зачем раздел вообще есть в боте, а не только в системе: пользователи — люди
 * в возрасте, которые компьютером не пользуются. Для них бот и есть рабочее
 * место, значит в нём должно быть всё, вплоть до проведения и сторно.
 *
 * Чего здесь нет — своих правил про деньги. Переходы по статусам, двойная
 * запись, нумерация, проверка версии и журнал живут в службах `src/finance`, и
 * бот зовёт их так же, как экран в браузере. Повторить правило здесь значило
 * бы, что однажды «провести» в боте и «провести» на экране разойдутся, а
 * сойтись им будет негде: это два ответа на один вопрос о тех же деньгах.
 *
 * Своё у бота только одно — разговор. Форма в браузере спрашивает восемь полей
 * сразу; человек, которому бот заменяет систему, на такой экран не ответит.
 * Поэтому мастер: один вопрос на экран, перед каждым — зачем он, перед
 * деньгами — отдельное подтверждение словами, что именно сейчас случится.
 */

/** Откуда и куда ходят деньги: касса и банк. Остальные счета — учётные. */
const MONEY_KINDS = new Set(['cash', 'bank']);

/** Сколько строк и кнопок показываем списком. Больше на телефоне не читается. */
const LIST_LIMIT = 8;

/** Буквы действий в `callback_data`: 64 знака на всё, uid занимает 36. */
const ACTION_CODE: Record<string, string> = {
  submit: 's',
  approve: 'a',
  reject: 'r',
  post: 'p',
  reverse: 'v',
};
const ACTION_BY_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(ACTION_CODE).map(([k, v]) => [v, k]),
);

/** Какое право нужно на действие. Те же, что у соответствующих маршрутов. */
const ACTION_RIGHT: Record<string, string> = {
  submit: 'finance.post',
  approve: 'finance.approve',
  reject: 'finance.approve',
  post: 'finance.post',
  reverse: 'finance.post',
};

@Injectable()
export class BotFinance {
  private readonly log = new Logger('bot/finance');

  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
    private readonly operations: OperationsService,
    private readonly approvals: ApprovalsService,
    private readonly write: WriteService,
    // Заказ нужен ровно для одного: принять по нему оплату из его карточки.
    // Правила продаж бот не повторяет, читает только то, что показывает.
    private readonly orders: OrdersService,
    // Фото чека: предел размера, список типов файлов и право на правку
    // проверяет служба вложений, бот только приносит байты.
    private readonly attachments: AttachmentsService,
  ) {}

  /**
   * Любой вызов службы финансов идёт в контексте вошедшего человека.
   *
   * Это и есть причина, по которой бот не отдельный пользователь системы: RLS,
   * права и журнал смотрят на контекст, и действие из Telegram должно быть
   * подписано тем, кто его сделал. `source: 'bot'` отличает его в журнале от
   * работы в браузере — иначе на вопрос «кто и откуда» ответа нет.
   */
  private as<T>(me: Me, uz: boolean, fn: () => Promise<T>): Promise<T> {
    return asUser(me, uz, fn);
  }

  // --- вход в раздел --------------------------------------------------------

  async route(me: Me, any: SectionFlow | null, data: string, uz: boolean): Promise<Screen> {
    // Чужой разговор нам не принадлежит: человек мог начать склад, а нажать
    // финансы. Тогда у нас разговора нет, и это не ошибка.
    const flow = any?.kind === 'fin' ? (any as Flow) : null;
    const canWrite = me.permissions.has('finance.post');

    if (data === CB.fin) return { ...this.home(me, uz), flow: null };
    if (data === CB.finNew('expense') || data === CB.finNew('income')) {
      if (!canWrite) return { ...this.home(me, uz), toast: F.noRight(uz), flow: null };
      return this.begin(me, data === CB.finNew('income') ? 'income' : 'expense', uz);
    }
    if (data.startsWith('f:ph:')) {
      if (!canWrite) return { ...this.home(me, uz), toast: F.noRight(uz), flow: null };
      return this.photoBegin(me, data.slice(5), uz);
    }
    if (data === CB.finRepeat) {
      if (!canWrite) return { ...this.home(me, uz), toast: F.noRight(uz), flow: null };
      return this.repeatBegin(me, uz);
    }
    if (data.startsWith(CB.finPay(''))) {
      if (!canWrite) return { ...this.home(me, uz), toast: F.noRight(uz), flow: null };
      return this.payBegin(me, data.slice(CB.finPay('').length), uz);
    }
    if (data === CB.finCancel) {
      return { ...this.home(me, uz), toast: F.cancelled(uz), flow: null };
    }
    if (data === CB.finBack) {
      if (!flow) return { ...this.home(me, uz), flow: null };
      const back = prevStep(flow, me.companies.length > 1);
      if (!back) return { ...this.home(me, uz), toast: F.cancelled(uz), flow: null };
      return this.stepScreen(me, { ...flow, step: back }, uz);
    }
    if (data.startsWith(CB.finPick(''))) {
      if (!flow) return { ...this.home(me, uz), toast: F.stale(uz), flow: null };
      return this.pick(me, flow, data.slice(CB.finPick('').length), uz);
    }
    if (data === CB.finExplain) {
      if (!flow) return { ...this.home(me, uz), toast: F.stale(uz), flow: null };
      return this.explainScreen(me, flow, uz);
    }
    if (data === CB.finConfirm) {
      if (!flow) return { ...this.home(me, uz), toast: F.stale(uz), flow: null };
      return this.stepScreen(me, { ...flow, step: 'confirm' }, uz);
    }
    if (data === CB.finSave) {
      if (!flow) return { ...this.home(me, uz), toast: F.stale(uz), flow: null };
      if (!canWrite) return { ...this.home(me, uz), toast: F.noRight(uz), flow: null };
      return this.save(me, flow, uz);
    }
    if (data === CB.finList) return this.list(me, false, uz);
    if (data === CB.finWaiting) return this.list(me, true, uz);
    if (data === CB.finOverdue) return this.debts(me, true, uz);
    if (data === CB.finDebts) return this.debts(me, false, uz);
    if (data === CB.finPlan) return this.planFact(me, uz);
    if (data.startsWith('f:o:')) return this.card(me, data.slice(4), uz);
    if (data.startsWith('f:q:')) return this.step3(me, data.slice(4), uz, false);
    if (data.startsWith('f:y:')) return this.step3(me, data.slice(4), uz, true);

    return { ...this.home(me, uz), toast: F.stale(uz) };
  }

  /** `<буква>:<uid>:<версия>` — хвост кнопки действия. */
  private async step3(me: Me, tail: string, uz: boolean, run: boolean): Promise<Screen> {
    const [code, uid, version] = tail.split(':');
    const action = ACTION_BY_CODE[code ?? ''];
    if (!action || !uid || !version) return { ...this.home(me, uz), toast: F.stale(uz) };
    return run
      ? this.apply(me, action, uid, Number(version), uz)
      : this.ask(me, action, uid, Number(version), uz);
  }

  home(me: Me, uz: boolean): Screen {
    const canWrite = me.permissions.has('finance.post');
    const canApprove = me.permissions.has('finance.approve');
    const rows: InlineKeyboard = [];
    if (canWrite) {
      rows.push([
        {
          text: uz ? '➖ Xarajat' : '➖ Расход',
          data: CB.finNew('expense'),
          style: BLUE,
        },
        {
          text: uz ? '➕ Tushum' : '➕ Поступление',
          data: CB.finNew('income'),
          style: BLUE,
        },
      ]);
    }
    if (canWrite) {
      rows.push([
        {
          text: uz ? '🔁 Oxirgisini takrorlash' : '🔁 Повторить последнюю',
          data: CB.finRepeat,
          style: BLUE,
        },
      ]);
    }
    rows.push([
      {
        text: uz ? '📋 Operatsiyalar' : '📋 Операции',
        data: CB.finList,
        style: BLUE,
      },
    ]);
    if (canWrite || canApprove) {
      rows.push([
        {
          text: uz ? '⏳ Qarorni kutmoqda' : '⏳ Ждут решения',
          data: CB.finWaiting,
          style: BLUE,
        },
      ]);
    }
    rows.push([
      { text: uz ? '💰 Qarzlar' : '💰 Долги', data: CB.finDebts, style: BLUE },
      {
        text: uz ? '📊 Reja va fakt' : '📊 План и факт',
        data: CB.finPlan,
        style: BLUE,
      },
    ]);
    rows.push([{ text: uz ? '⬅️ Menyu' : '⬅️ Меню', data: CB.menu, style: BLUE }]);
    return { text: F.home(uz, canWrite), keyboard: rows };
  }

  // --- мастер ---------------------------------------------------------------

  private async begin(me: Me, type: 'income' | 'expense', uz: boolean): Promise<Screen> {
    const many = me.companies.length > 1;
    const first = order({}, many)[0]!;
    const flow: Flow = { kind: 'fin', type, step: first };
    if (!many && me.companies[0]) {
      flow.companyUid = me.companies[0].uid;
      flow.companyName = uz ? me.companies[0].nameUz : me.companies[0].nameRu;
    }
    return this.stepScreen(me, flow, uz);
  }

  /**
   * Ждём фото чека к операции.
   *
   * Бумажный чек к вечеру теряется в кармане, а снять его телефоном умеет и
   * тот, кто системой не пользуется. Поэтому фото — не украшение: это
   * единственный способ приложить бумагу к записи, не заходя в систему.
   *
   * Сумму с фотографии бот не читает и читать не берётся: распознавание чека
   * ошибается на тысячах, а правит их потом бухгалтер по той же фотографии.
   * В записи остаётся сумма, которую назвал человек, — так и сказано на экране.
   */
  private async photoBegin(me: Me, uid: string, uz: boolean): Promise<Screen> {
    let number: string;
    try {
      const card = await this.as(me, uz, () => this.operations.card(uid));
      number = card.operation.number;
    } catch (e) {
      return this.refusal(me, uz, e, null);
    }
    const flow: Flow = {
      kind: 'fin',
      type: 'expense',
      step: 'photo',
      photoFor: uid,
      photoNumber: number,
    };
    return {
      text: F.askPhoto(uz, escape(number)),
      keyboard: [
        [{ text: uz ? '⬅️ Yozuvga' : '⬅️ К записи', data: CB.finOp(uid), style: BLUE }],
        [{ text: uz ? '❌ Bekor qilish' : '❌ Отменить', data: CB.finCancel, style: RED }],
      ],
      fresh: true,
      flow,
    };
  }

  /**
   * Присланный файл. Разговор к этому моменту должен ждать именно фото: иначе
   * непонятно, к чему его прикладывать, и каркас об этом уже сказал человеку.
   */
  async photo(me: Me, any: SectionFlow, file: Incoming, uz: boolean): Promise<Screen> {
    const flow = any.kind === 'fin' ? (any as Flow) : null;
    if (!flow?.photoFor || flow.step !== 'photo') {
      return { ...this.home(me, uz), toast: F.stale(uz), flow: null };
    }
    if (!me.permissions.has('finance.post')) {
      return { ...this.home(me, uz), toast: F.noRight(uz), flow: null };
    }
    try {
      await this.as(me, uz, () =>
        this.attachments.add({
          owner: 'finance_operation',
          ownerUid: flow.photoFor!,
          fileName: file.fileName,
          mimeType: file.mimeType,
          kind: 'photo',
          bytes: file.bytes,
          comment: 'Чек из Telegram',
        }),
      );
      const count = (
        await this.as(me, uz, () => this.attachments.list('finance_operation', flow.photoFor!))
      ).length;
      const card = await this.card(
        me,
        flow.photoFor,
        uz,
        F.photoSaved(uz, escape(flow.photoNumber ?? ''), count),
      );
      return { ...card, fresh: true, flow: null };
    } catch (e) {
      return this.refusal(me, uz, e, flow.photoFor);
    }
  }

  /**
   * Повтор последней своей записи.
   *
   * Зарплата, аренда и связь приходят каждый месяц одними и теми же, и
   * проходить из-за них весь мастер — ровно та работа, от которой бот должен
   * избавлять. Берём последнюю запись самого человека: чужую повторять нельзя,
   * у неё другой автор в журнале.
   *
   * Платежи по заказу в повтор не попадают намеренно: такой платёж привязан к
   * остатку конкретного заказа, и «повторить» для него значит «заплатить
   * второй раз» — это делают из карточки заказа, где остаток виден.
   */
  private async repeatBegin(me: Me, uz: boolean): Promise<Screen> {
    const rows = await this.prisma.withContext(
      me.userId,
      me.companyIds,
      (tx) =>
        tx.$queryRaw<
          {
            number: string;
            operation_type: 'income' | 'expense';
            amount: string;
            currency: string;
            account_code: string;
            account_name_ru: string;
            account_name_uz: string;
            company_uid: string;
            company_name_ru: string;
            company_name_uz: string;
            item_uid: string | null;
            item_name_ru: string | null;
            item_name_uz: string | null;
            partner_uid: string | null;
            partner_name_ru: string | null;
            comment: string | null;
          }[]
        >`
        SELECT o.number, o.operation_type::text AS operation_type, o.amount::text AS amount,
               cur.code AS currency,
               a.code AS account_code, a.name_ru AS account_name_ru, a.name_uz AS account_name_uz,
               co.uid AS company_uid, co.name_ru AS company_name_ru, co.name_uz AS company_name_uz,
               ci.uid AS item_uid, ci.name_ru AS item_name_ru, ci.name_uz AS item_name_uz,
               p.uid AS partner_uid, p.name_ru AS partner_name_ru,
               o.comment
          FROM finance_operation o
          JOIN account a ON a.id = o.account_id
          JOIN currency cur ON cur.id = o.currency_id
          JOIN company co ON co.id = o.company_id
          LEFT JOIN cashflow_item ci ON ci.id = o.cashflow_item_id
          LEFT JOIN partner p ON p.id = o.partner_id
         WHERE o.created_by = ${me.userId}
           AND o.operation_type IN ('income', 'expense')
           AND o.source_doc_type IS NULL
           AND o.reversal_of_id IS NULL
         ORDER BY o.id DESC
         LIMIT 1`,
    );
    const last = rows[0];
    if (!last) return { ...this.home(me, uz), toast: F.nothingToRepeat(uz), flow: null };

    const flow: Flow = {
      kind: 'fin',
      type: last.operation_type,
      step: 'amount',
      repeat: true,
      repeatOf: last.number,
      repeatAmount: last.amount,
      companyUid: last.company_uid,
      companyName: uz ? last.company_name_uz : last.company_name_ru,
      itemUid: last.item_uid ?? undefined,
      itemName: (uz ? last.item_name_uz : last.item_name_ru) ?? undefined,
      accountCode: last.account_code,
      accountName: uz ? last.account_name_uz : last.account_name_ru,
      currency: last.currency,
      partnerUid: last.partner_uid ?? undefined,
      partnerName: last.partner_name_ru ?? undefined,
      comment: last.comment ?? undefined,
    };
    return this.stepScreen(me, flow, uz, true);
  }

  /**
   * Оплата по заказу: тот же мастер поступления, но известного не спрашиваем.
   *
   * Кнопка стоит в карточке заказа, а разговор ведут финансы: платёж — это
   * финансовая операция со своим согласованием и проведением, и второго такого
   * пути в системе быть не должно. Компания, покупатель и валюта берутся из
   * заказа, статья — если в компании она одна. Человеку остаются сумма и дата.
   */
  private async payBegin(me: Me, orderUid: string, uz: boolean): Promise<Screen> {
    let found: Awaited<ReturnType<OrdersService['one']>>;
    try {
      found = await this.as(me, uz, () => this.orders.one(orderUid));
    } catch (e) {
      return this.refusal(me, uz, e, null);
    }

    const back: InlineButton[] = [
      { text: F.payBack(uz), data: CB.salOrder(orderUid), style: BLUE },
    ];

    // Свободный остаток считает служба продаж: она же считает его и на записи,
    // и расхождение «бот предложил, сервер отказал» здесь невозможно.
    const state = await this.prisma.withContext(me.userId, me.companyIds, (tx) =>
      paymentStateByUid(tx, orderUid),
    );
    const free = state?.remaining ?? 0;
    if (free <= 0.005) {
      const pending =
        (state?.pending ?? 0) > 0 ? sum(String(state!.pending), found.currency, uz) : '';
      return {
        text: F.payNothing(uz, escape(found.number), pending),
        keyboard: [back, finRow(uz)],
        flow: null,
      };
    }

    const flow: Flow = {
      kind: 'fin',
      type: 'income',
      step: 'amount',
      companyUid: found.enterpriseUid,
      companyName: uz ? found.enterpriseNameUz : found.enterpriseNameRu,
      partnerUid: found.partner.uid,
      partnerName: uz ? found.partner.nameUz : found.partner.nameRu,
      currency: found.currency,
      orderUid,
      orderNumber: found.number,
      orderRemaining: free.toFixed(2),
    };

    // Платить можно только с кассы или счёта в валюте заказа: служба не даст
    // завести платёж в другой валюте, и предлагать такой счёт значит вести
    // человека в отказ.
    if ((await this.accounts(me, flow, uz)).length === 0) {
      return {
        text: F.payNoAccount(uz, found.currency),
        keyboard: [back, finRow(uz)],
        flow: null,
      };
    }

    const items = await this.items(me, flow, uz);
    if (items.length === 1) {
      flow.itemUid = items[0]!.uid;
      flow.itemName = items[0]!.name;
      flow.itemFixed = true;
    }

    return this.stepScreen(me, flow, uz, true);
  }

  /**
   * Что человек написал словами. Буквами отвечают на три вопроса: сумма, поиск
   * контрагента и примечание; на остальных есть кнопки, и текст там — признак
   * того, что человек печатает ответ на прошлый вопрос.
   */
  async text(me: Me, any: SectionFlow, raw: string, uz: boolean): Promise<Screen> {
    const flow = any.kind === 'fin' ? (any as Flow) : null;
    if (!flow) return { ...this.home(me, uz), toast: F.stale(uz), flow: null };
    const typed = raw.trim();

    if (flow.step === 'photo') {
      // Человек написал словами там, где ждут снимок. Повторяем просьбу, а не
      // показываем «эта кнопка устарела»: ошибка понятная и поправимая.
      return {
        text: `${F.photoWait(uz)}\n\n${F.askPhoto(uz, escape(flow.photoNumber ?? ''))}`,
        keyboard: [
          [
            {
              text: uz ? '⬅️ Yozuvga' : '⬅️ К записи',
              data: CB.finOp(flow.photoFor ?? ''),
              style: BLUE,
            },
          ],
          [{ text: uz ? '❌ Bekor qilish' : '❌ Отменить', data: CB.finCancel, style: RED }],
        ],
        fresh: true,
        flow,
      };
    }

    if (flow.step === 'amount') {
      const amount = parseAmount(typed);
      if (amount === null) return this.stepScreen(me, flow, uz, true, F.badAmount(uz));
      // Остаток по заказу сверяем сразу, а не на записи: отказ в конце мастера
      // человек читает как «зря заполнял», и это справедливо.
      if (flow.orderUid && Number(amount) > Number(flow.orderRemaining ?? 0) + 0.005) {
        return this.stepScreen(
          me,
          flow,
          uz,
          true,
          F.payTooMuch(uz, sum(flow.orderRemaining ?? '0', flow.currency ?? BASE_CURRENCY, uz)),
        );
      }
      return this.forward(me, { ...flow, amount }, uz);
    }

    if (flow.step === 'partner') {
      const found = await this.partners(me, flow, uz, typed);
      if (found.length === 0) {
        return this.stepScreen(me, flow, uz, true, F.partnerNotFound(uz, escape(typed)));
      }
      if (found.length === 1) {
        return this.forward(
          me,
          { ...flow, partnerUid: found[0]!.uid, partnerName: found[0]!.name },
          uz,
        );
      }
      // Нашлось несколько — показываем те же кнопки, но уже только найденное.
      return this.stepScreen(me, flow, uz, true, undefined, found);
    }

    if (flow.step === 'date') {
      const day = parseDay(typed, new Date());
      if (!day) return this.stepScreen(me, flow, uz, true, F.badDate(uz));
      if (day > today(new Date())) return this.stepScreen(me, flow, uz, true, F.futureDate(uz));
      return this.forward(me, { ...flow, day }, uz);
    }

    if (flow.step === 'comment') {
      return this.forward(me, { ...flow, comment: typed.slice(0, 200) }, uz);
    }

    return this.stepScreen(me, flow, uz, true, F.stale(uz));
  }

  /** Нажали кнопку выбора. Что значит значение, решает текущий шаг. */
  private async pick(me: Me, flow: Flow, value: string, uz: boolean): Promise<Screen> {
    if (flow.step === 'company') {
      const company = me.companies.find((c) => c.uid === value);
      if (!company) return this.stepScreen(me, flow, uz, false, F.stale(uz));
      return this.forward(
        me,
        {
          ...flow,
          companyUid: company.uid,
          companyName: uz ? company.nameUz : company.nameRu,
        },
        uz,
      );
    }

    if (flow.step === 'item') {
      const item = (await this.items(me, flow, uz)).find((i) => i.uid === value);
      if (!item) return this.stepScreen(me, flow, uz, false, F.stale(uz));
      return this.forward(me, { ...flow, itemUid: item.uid, itemName: item.name }, uz);
    }

    if (flow.step === 'account') {
      const account = (await this.accounts(me, flow, uz)).find((a) => a.code === value);
      if (!account) return this.stepScreen(me, flow, uz, false, F.stale(uz));
      return this.forward(
        me,
        {
          ...flow,
          accountCode: account.code,
          accountName: account.name,
          currency: account.currency,
        },
        uz,
      );
    }

    if (flow.step === 'partner') {
      if (value === '-') return this.forward(me, { ...flow, partnerUid: undefined }, uz);
      const found = (await this.partners(me, flow, uz)).find((p) => p.uid === value);
      if (!found) return this.stepScreen(me, flow, uz, false, F.stale(uz));
      return this.forward(me, { ...flow, partnerUid: found.uid, partnerName: found.name }, uz);
    }

    if (flow.step === 'amount' && value === 'same' && flow.repeatAmount) {
      return this.forward(me, { ...flow, amount: flow.repeatAmount }, uz, false);
    }

    if (flow.step === 'date') {
      const now = today(new Date());
      const day = value === 'today' ? now : value === 'yesterday' ? shiftDay(now, -1) : null;
      if (!day) return this.stepScreen(me, flow, uz, false, F.stale(uz));
      return this.forward(me, { ...flow, day }, uz);
    }

    if (flow.step === 'comment' && value === '-') {
      return this.forward(me, { ...flow, comment: undefined }, uz);
    }

    return this.stepScreen(me, flow, uz, false, F.stale(uz));
  }

  private forward(me: Me, flow: Flow, uz: boolean, fresh = true): Promise<Screen> {
    const step = nextStep(flow, me.companies.length > 1);
    return this.stepScreen(me, { ...flow, step }, uz, fresh);
  }

  /**
   * Экран одного шага: шапка «шаг N из M», вопрос, зачем он нужен, кнопки.
   *
   * `note` — то, что не получилось на прошлой попытке. Оно идёт первой строкой,
   * а вопрос повторяется целиком: человек, у которого не принялась сумма, не
   * должен листать переписку вверх, чтобы прочитать, как её писать.
   */
  private async stepScreen(
    me: Me,
    flow: Flow,
    uz: boolean,
    fresh = false,
    note?: string,
    partners?: { uid: string; name: string }[],
  ): Promise<Screen> {
    const many = me.companies.length > 1;
    const steps = order(flow, many);
    const total = steps.length - 1;
    const index = steps.indexOf(flow.step) + 1;
    const expense = flow.type === 'expense';
    const head = (title: string) => F.step(uz, index, total, title);
    /**
     * Чего спрошу после этого вопроса. Номер шага говорит, сколько осталось,
     * но не говорит чего: человек, не знающий, что дальше всего два коротких
     * ответа, бросает разговор на середине.
     */
    const ahead = comingNext(
      uz,
      steps.slice(index).map((next) => this.stepTitle(next, flow, uz)),
    );
    const rows: InlineKeyboard = [];
    let body: string;

    if (flow.step === 'confirm') {
      return this.confirmScreen(me, flow, uz, fresh);
    }

    if (flow.step === 'company') {
      body = `${head(F.companyTitle(uz))}\n\n${F.askCompany(uz)}`;
      for (const c of me.companies) {
        rows.push([
          {
            text: uz ? c.nameUz : c.nameRu,
            data: CB.finPick(c.uid),
            style: BLUE,
          },
        ]);
      }
    } else if (flow.step === 'amount' && flow.repeat) {
      const what = [
        `${flow.type === 'expense' ? (uz ? 'Xarajat' : 'Расход') : uz ? 'Tushum' : 'Поступление'}` +
          `: ${escape(flow.itemName ?? '—')}`,
        `${uz ? 'Hisob' : 'Счёт'}: ${escape(flow.accountName ?? '—')}`,
        ...(flow.partnerName
          ? [`${uz ? 'Kim bilan' : 'Контрагент'}: ${escape(flow.partnerName)}`]
          : []),
      ];
      body = `${head(F.repeatTitle(uz))}\n\n${F.askRepeatAmount(
        uz,
        escape(flow.repeatOf ?? ''),
        what,
      )}`;
      rows.push([
        {
          text: F.sameAmount(uz, sum(flow.repeatAmount ?? '0', flow.currency ?? BASE_CURRENCY, uz)),
          data: CB.finPick('same'),
          style: GREEN,
        },
      ]);
    } else if (flow.step === 'amount') {
      body = flow.orderUid
        ? `${head(F.payTitle(uz))}\n\n${F.askPayAmount(
            uz,
            escape(flow.orderNumber ?? ''),
            sum(flow.orderRemaining ?? '0', flow.currency ?? BASE_CURRENCY, uz),
          )}`
        : `${head(F.amountTitle(uz))}\n\n${F.askAmount(uz, expense)}`;
    } else if (flow.step === 'item') {
      body = `${head(F.itemTitle(uz))}\n\n${F.askItem(uz, expense)}`;
      for (const i of await this.items(me, flow, uz)) {
        rows.push([{ text: i.name, data: CB.finPick(i.uid), style: BLUE }]);
      }
    } else if (flow.step === 'account') {
      body = `${head(F.accountTitle(uz))}\n\n${F.askAccount(uz, expense)}`;
      for (const a of await this.accounts(me, flow, uz)) {
        rows.push([
          {
            text: `${a.name} (${a.currency})`,
            data: CB.finPick(a.code),
            style: BLUE,
          },
        ]);
      }
    } else if (flow.step === 'partner') {
      body = `${head(F.partnerTitle(uz))}\n\n${F.askPartner(uz, expense)}`;
      for (const p of partners ?? (await this.partners(me, flow, uz))) {
        rows.push([{ text: p.name, data: CB.finPick(p.uid), style: BLUE }]);
      }
      rows.push([
        {
          text: uz ? '➡️ O‘tkazib yuborish' : '➡️ Пропустить',
          data: CB.finSkip,
          style: GREEN,
        },
      ]);
    } else if (flow.step === 'date') {
      body = `${head(F.dateTitle(uz))}\n\n${F.askDate(uz)}`;
      // По одной кнопке в ряд: два ответа рядом на телефоне стоят в полпальца
      // друг от друга, и «вчера» вместо «сегодня» ставят мимо.
      rows.push([
        {
          text: uz ? 'Bugun' : 'Сегодня',
          data: CB.finPick('today'),
          style: GREEN,
        },
      ]);
      rows.push([
        {
          text: uz ? 'Kecha' : 'Вчера',
          data: CB.finPick('yesterday'),
          style: BLUE,
        },
      ]);
    } else {
      body = `${head(F.commentTitle(uz))}\n\n${F.askComment(uz)}`;
      rows.push([
        {
          text: uz ? '➡️ O‘tkazib yuborish' : '➡️ Пропустить',
          data: CB.finSkip,
          style: GREEN,
        },
      ]);
    }

    rows.push(this.wizardFooter(me, flow, uz));
    body += ahead;
    return {
      text: note ? `${note}\n\n${body}` : body,
      keyboard: rows,
      fresh,
      flow,
    };
  }

  /** Как называется шаг в строке «дальше»: теми же словами, что его заголовок. */
  private stepTitle(step: FlowStep, flow: Flow, uz: boolean): string {
    if (step === 'company') return F.companyTitle(uz);
    if (step === 'amount') return flow.orderUid ? F.payTitle(uz) : F.amountTitle(uz);
    if (step === 'item') return F.itemTitle(uz);
    if (step === 'account') return F.accountTitle(uz);
    if (step === 'partner') return F.partnerTitle(uz);
    if (step === 'date') return F.dateTitle(uz);
    if (step === 'comment') return F.commentTitle(uz);
    return F.checkTitle(uz);
  }

  /**
   * «Я не понял»: то же подтверждение словами. Ничего не записывает и разговор
   * не меняет — человек возвращается на тот же экран проверки.
   */
  private explainScreen(me: Me, flow: Flow, uz: boolean): Screen {
    return {
      text: F.explain(uz, {
        expense: flow.type === 'expense',
        amount: sum(flow.amount ?? '0', flow.currency ?? BASE_CURRENCY, uz),
        account: escape(flow.accountName ?? '—'),
        order: flow.orderNumber ? escape(flow.orderNumber) : null,
      }),
      keyboard: [[understoodButton(uz, CB.finConfirm)], this.wizardFooter(me, flow, uz)],
      flow,
    };
  }

  private wizardFooter(me: Me, flow: Flow, uz: boolean): InlineButton[] {
    const back = prevStep(flow, me.companies.length > 1);
    const row: InlineButton[] = [];
    if (back)
      row.push({
        text: uz ? '⬅️ Orqaga' : '⬅️ Назад',
        data: CB.finBack,
        style: BLUE,
      });
    row.push({
      text: uz ? '❌ Bekor qilish' : '❌ Отменить',
      data: CB.finCancel,
      style: RED,
    });
    return row;
  }

  private async confirmScreen(me: Me, flow: Flow, uz: boolean, fresh: boolean): Promise<Screen> {
    // Ключ повторной отправки заводим здесь: именно с этого экрана уходит запись.
    const next: Flow = { ...flow, key: flow.key ?? randomUUID() };
    const expense = flow.type === 'expense';
    const label = (ru: string, uzs: string) => (uz ? uzs : ru);
    // Операция в валюте: человек должен увидеть, во сколько сумов она
    // превратится, до того как нажмёт «Записать». Курс бот берёт сам, и до
    // этой строки единственным способом узнать его была карточка после записи.
    const currency = flow.currency ?? BASE_CURRENCY;
    const info = currency === BASE_CURRENCY ? null : await this.rateInfo(me, currency);
    const inBase = info
      ? R.inBase(
          uz,
          sum((Number(flow.amount ?? 0) * Number(info.rate)).toFixed(2), BASE_CURRENCY, uz),
          new Intl.NumberFormat('ru-RU', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }).format(Number(info.rate)),
          showDay(info.day),
        )
      : null;
    const lines = [
      `${label('Что', 'Nima')}: <b>${
        expense ? label('Расход', 'Xarajat') : label('Поступление', 'Tushum')
      }</b>`,
      `${label('Сумма', 'Summa')}: <b>${sum(flow.amount ?? '0', flow.currency ?? BASE_CURRENCY, uz)}</b>`,
      ...(inBase ? [`${label('В сумах', 'So‘mda')}: ${inBase}`] : []),
      `${label('Статья', 'Modda')}: ${escape(flow.itemName ?? '—')}`,
      `${expense ? label('Откуда', 'Qayerdan') : label('Куда', 'Qayerga')}: ${escape(
        flow.accountName ?? '—',
      )}`,
      `${expense ? label('Кому', 'Kimga') : label('От кого', 'Kimdan')}: ${escape(
        flow.partnerName ?? label('не указан', 'ko‘rsatilmagan'),
      )}`,
      ...(flow.orderNumber
        ? [`${label('По заказу', 'Buyurtma bo‘yicha')}: <b>${escape(flow.orderNumber)}</b>`]
        : []),
      ...(flow.orderRemaining
        ? [
            `${F.payLeft(uz)}: ${sum(
              Math.max(0, Number(flow.orderRemaining) - Number(flow.amount ?? 0)).toFixed(2),
              flow.currency ?? BASE_CURRENCY,
              uz,
            )}`,
          ]
        : []),
      `${label('Дата', 'Sana')}: ${showDay(flow.day ?? today(new Date()))}`,
      ...(flow.comment ? [`${label('Примечание', 'Izoh')}: ${escape(flow.comment)}`] : []),
      `${label('Компания', 'Kompaniya')}: ${escape(flow.companyName ?? '—')}`,
    ];
    return {
      text: F.confirm(uz, lines),
      keyboard: [
        [
          {
            text: uz ? '✅ Yozish' : '✅ Записать',
            data: CB.finSave,
            style: GREEN,
          },
        ],
        [explainButton(uz, CB.finExplain)],
        this.wizardFooter(me, flow, uz),
      ],
      fresh,
      flow: next,
    };
  }

  /** Записать черновик. Деньги при этом не двигаются — это заявка. */
  private async save(me: Me, flow: Flow, uz: boolean): Promise<Screen> {
    const counter = await this.counterAccount(me, flow, uz);
    if (!counter) return { ...this.home(me, uz), toast: F.noCounter(uz), flow: null };
    const rate = await this.rateFor(me, flow.currency ?? BASE_CURRENCY);
    if (rate === null) {
      return {
        ...this.home(me, uz),
        toast: F.noRate(uz, flow.currency ?? BASE_CURRENCY),
        flow: null,
      };
    }

    try {
      const op = await this.as(me, uz, () =>
        this.write.create(
          {
            companyUid: flow.companyUid,
            operationType: flow.type,
            accountCode: flow.accountCode!,
            counterAccountCode: counter,
            amount: flow.amount!,
            currencyCode: flow.currency ?? BASE_CURRENCY,
            rate,
            occurredAt: moment(flow.day ?? today(new Date())),
            cashflowItemUid: flow.itemUid,
            partnerUid: flow.partnerUid,
            comment: flow.comment,
            salesOrderUid: flow.orderUid,
          },
          flow.key,
        ),
      );
      const note = flow.orderNumber
        ? F.savedPay(uz, op.number, escape(flow.orderNumber))
        : F.saved(uz, op.number);
      const card = await this.card(me, op.uid, uz, note);
      return { ...card, fresh: false, flow: null };
    } catch (e) {
      return this.refusal(me, uz, e, null);
    }
  }

  // --- операции -------------------------------------------------------------

  private async list(me: Me, waiting: boolean, uz: boolean): Promise<Screen> {
    const rows = waiting ? await this.waiting(me, uz) : await this.recent(me, uz);
    const lines = rows.map(
      (r) =>
        `${STATUS[r.status]?.mark ?? '•'} <b>${r.number}</b> · ${sum(r.amount, r.currency, uz)}` +
        ` · ${escape(r.cashflowItem?.nameRu ?? (r.type === 'income' ? 'поступление' : 'расход'))}`,
    );
    const keyboard: InlineKeyboard = rows.map((r) => [
      {
        text: `${STATUS[r.status]?.mark ?? '•'} ${r.number} · ${sum(r.amount, r.currency, uz)}`,
        data: CB.finOp(r.uid),
        style: BLUE,
      },
    ]);
    keyboard.push(finRow(uz));
    return { text: F.listTitle(uz, waiting, lines), keyboard };
  }

  private async recent(me: Me, uz: boolean) {
    const out = await this.as(me, uz, () => this.operations.list({ limit: LIST_LIMIT }));
    return out.rows;
  }

  /**
   * «Ждут решения» — это разные операции для разных людей: согласующему нужны
   * отправленные, проводящему — уже согласованные. Показываем то, что человек
   * действительно может сдвинуть, иначе список превращается в упрёк.
   */
  private async waiting(me: Me, uz: boolean) {
    const wanted: ('pending_approval' | 'approved')[] = [];
    if (me.permissions.has('finance.approve')) wanted.push('pending_approval');
    if (me.permissions.has('finance.post')) wanted.push('approved');
    const batches = await this.as(me, uz, () =>
      Promise.all(wanted.map((status) => this.operations.list({ status, limit: LIST_LIMIT }))),
    );
    return batches.flatMap((b) => b.rows).slice(0, LIST_LIMIT);
  }

  async card(me: Me, uid: string, uz: boolean, prefix?: string): Promise<Screen> {
    let card: Awaited<ReturnType<OperationsService['card']>>;
    try {
      card = await this.as(me, uz, () => this.operations.card(uid));
    } catch (e) {
      return this.refusal(me, uz, e, null);
    }
    const op = card.operation;
    const label = (ru: string, uzs: string) => (uz ? uzs : ru);
    const status = STATUS[op.status];
    const lines = [
      `${status?.mark ?? '•'} <b>${op.number}</b> — ${
        op.type === 'income' ? label('поступление', 'tushum') : label('расход', 'xarajat')
      }, ${uz ? status?.uz : status?.ru}`,
      `${label('Сумма', 'Summa')}: <b>${sum(op.amount, op.currency, uz)}</b>`,
      `${label('Статья', 'Modda')}: ${escape(
        (uz ? op.cashflowItem?.nameUz : op.cashflowItem?.nameRu) ?? '—',
      )}`,
      `${label('Счёт', 'Hisob')}: ${escape(op.account.nameRu)}`,
      `${label('Контрагент', 'Kim bilan')}: ${escape(
        op.partner?.nameRu ?? label('не указан', 'ko‘rsatilmagan'),
      )}`,
      `${label('Дата', 'Sana')}: ${showDay(op.occurredAt.slice(0, 10))}`,
      ...(op.sourceOrder ? [`${F.payOrder(uz)}: <b>${escape(op.sourceOrder.number)}</b>`] : []),
      ...(op.comment ? [`${label('Примечание', 'Izoh')}: ${escape(op.comment)}`] : []),
      `${label('Компания', 'Kompaniya')}: ${escape(op.company.code)}`,
    ];
    // Сколько бумаг уже приложено. Это не украшение: по операции без чека
    // бухгалтер придёт с вопросом, и видно это должно быть сразу.
    let files = 0;
    try {
      files = (await this.as(me, uz, () => this.attachments.list('finance_operation', uid))).length;
    } catch {
      // Права на просмотр вложений может не быть — тогда просто не показываем.
      files = 0;
    }
    if (files > 0) lines.push(F.photoLine(uz, files));

    const help = (uz ? STATUS_HELP[op.status]?.uz : STATUS_HELP[op.status]?.ru) ?? '';
    const keyboard: InlineKeyboard = this.cardActions(me, op.status, uid, op.version, uz);
    if (me.permissions.has('finance.post')) {
      keyboard.push([
        {
          text: uz ? '📷 Chek rasmi' : '📷 Фото чека',
          data: CB.finPhoto(uid),
          style: BLUE,
        },
      ]);
    }
    // Из платежа должен быть путь к заказу: «за что заплатили» иначе
    // выясняют по номеру в примечании. Кнопку даём только тому, кому заказ
    // откроется, — иначе она ведёт в отказ.
    if (op.sourceOrder && me.permissions.has('sales.view')) {
      keyboard.push([
        {
          text: `${F.payBack(uz)} ${op.sourceOrder.number}`,
          data: CB.salOrder(op.sourceOrder.uid),
          style: BLUE,
        },
      ]);
    }
    keyboard.push([
      {
        text: uz ? '📋 Operatsiyalar' : '📋 Операции',
        data: CB.finList,
        style: BLUE,
      },
    ]);
    keyboard.push(finRow(uz));
    const text = F.card(uz, lines, help);
    return { text: prefix ? `${prefix}\n\n${text}` : text, keyboard };
  }

  /**
   * Кнопки действий — по статусу и по праву. Право проверяется и здесь, и ещё
   * раз на нажатии: между отрисовкой и нажатием роль могли снять, а кнопку
   * с экрана Telegram не забирает.
   */
  private cardActions(
    me: Me,
    status: string,
    uid: string,
    version: number,
    uz: boolean,
  ): InlineKeyboard {
    const can = (action: string) => me.permissions.has(ACTION_RIGHT[action]!);
    const button = (action: string, style: typeof BLUE): InlineButton => ({
      text: uz ? ACTION[action]!.uz : ACTION[action]!.ru,
      data: CB.finAsk(ACTION_CODE[action]!, uid, version),
      style,
    });
    const rows: InlineKeyboard = [];
    if (status === 'draft' && can('submit')) rows.push([button('submit', GREEN)]);
    if (status === 'pending_approval' && can('approve')) rows.push([button('approve', GREEN)]);
    if (status === 'approved' && can('post')) rows.push([button('post', GREEN)]);
    if ((status === 'pending_approval' || status === 'approved') && can('reject')) {
      rows.push([button('reject', RED)]);
    }
    if (status === 'posted' && can('reverse')) rows.push([button('reverse', RED)]);
    return rows;
  }

  /** Экран «что сейчас случится». Перед деньгами он обязателен, не украшение. */
  private async ask(
    me: Me,
    action: string,
    uid: string,
    version: number,
    uz: boolean,
  ): Promise<Screen> {
    if (!me.permissions.has(ACTION_RIGHT[action]!)) {
      return { ...(await this.card(me, uid, uz)), toast: F.noRight(uz) };
    }
    let head: string;
    try {
      const card = await this.as(me, uz, () => this.operations.card(uid));
      head = `<b>${card.operation.number}</b> · ${sum(
        card.operation.amount,
        card.operation.currency,
        uz,
      )}`;
    } catch (e) {
      return this.refusal(me, uz, e, null);
    }
    const a = ACTION[action]!;
    const risky = action === 'post' || action === 'reverse' || action === 'reject';
    return {
      text: `${head}\n\n${uz ? a.askUz : a.askRu}`,
      keyboard: [
        [
          {
            text: `${uz ? 'Ha' : 'Да'} — ${uz ? a.uz : a.ru}`,
            data: CB.finDo(ACTION_CODE[action]!, uid, version),
            style: risky ? RED : GREEN,
          },
        ],
        [
          {
            text: uz ? '⬅️ Orqaga' : '⬅️ Назад',
            data: CB.finOp(uid),
            style: BLUE,
          },
        ],
      ],
    };
  }

  private async apply(
    me: Me,
    action: string,
    uid: string,
    version: number,
    uz: boolean,
  ): Promise<Screen> {
    if (!me.permissions.has(ACTION_RIGHT[action]!)) {
      return { ...(await this.card(me, uid, uz)), toast: F.noRight(uz) };
    }
    const a = ACTION[action]!;
    try {
      const result = await this.as(me, uz, () =>
        action === 'reverse'
          ? this.write.reverse(uid, { version })
          : this.approvals.apply(uid, action as Action, { version }),
      );
      // Сторно — это новая операция, и открываем именно её: человек должен
      // увидеть ту запись, которая теперь существует.
      return this.card(me, result.uid, uz, uz ? a.doneUz : a.doneRu);
    } catch (e) {
      return this.refusal(me, uz, e, uid);
    }
  }

  // --- отчёты ---------------------------------------------------------------

  private async debts(me: Me, overdueOnly: boolean, uz: boolean): Promise<Screen> {
    const out = await this.as(me, uz, () =>
      this.finance.receivables({ overdueOnly, limit: LIST_LIMIT }),
    );
    const lines = out.rows.map((r) => {
      const name = escape(uz ? r.partner.nameUz : r.partner.nameRu);
      const overdue =
        Number(r.overdue) > 0
          ? ` · ${uz ? 'muddati o‘tgan' : 'просрочено'} ${sum(r.overdue, BASE_CURRENCY, uz)}` +
            ` (${r.maxOverdueDays} ${uz ? 'kun' : 'дн.'})`
          : '';
      return `${Number(r.overdue) > 0 ? '🔴' : '•'} ${name} — ${sum(r.debt, BASE_CURRENCY, uz)}${overdue}`;
    });
    return {
      text: F.debts(
        uz,
        overdueOnly,
        lines,
        sum(out.totals.debt, BASE_CURRENCY, uz),
        sum(out.totals.overdue, BASE_CURRENCY, uz),
      ),
      keyboard: [
        [
          overdueOnly
            ? {
                text: uz ? 'Hammasi' : 'Все долги',
                data: CB.finDebts,
                style: BLUE,
              }
            : {
                text: uz ? 'Faqat muddati o‘tgan' : 'Только просроченные',
                data: CB.finOverdue,
                style: BLUE,
              },
        ],
        finRow(uz),
      ],
    };
  }

  private async planFact(me: Me, uz: boolean): Promise<Screen> {
    const out = await this.as(me, uz, () => this.finance.planFact({}));
    const mark: Record<string, string> = { over: '🔴', warn: '🟡', ok: '•' };
    const lines = out.rows
      .slice(0, LIST_LIMIT)
      .map(
        (r) =>
          `${mark[r.status] ?? '•'} ${escape(uz ? r.itemNameUz : r.itemName)} — ` +
          `${uz ? 'reja' : 'план'} ${sum(r.plan, BASE_CURRENCY, uz)}, ` +
          `${uz ? 'fakt' : 'факт'} ${sum(r.fact, BASE_CURRENCY, uz)}` +
          (r.usedPercent ? ` (${r.usedPercent}%)` : ''),
      );
    return { text: F.planFact(uz, lines), keyboard: [finRow(uz)] };
  }

  // --- справочники ----------------------------------------------------------

  private async items(me: Me, flow: Flow, uz: boolean) {
    const refs = await this.as(me, uz, () => this.write.refs());
    const direction = flow.type === 'income' ? 'inflow' : 'outflow';
    return refs.cashflowItems
      .filter((i) => i.companyUid === flow.companyUid && i.direction === direction)
      .map((i) => ({ uid: i.uid, name: uz ? i.nameUz : i.nameRu }));
  }

  private async accounts(me: Me, flow: Flow, uz: boolean) {
    const refs = await this.as(me, uz, () => this.write.refs());
    return (
      refs.accounts
        .filter((a) => a.companyUid === flow.companyUid && MONEY_KINDS.has(a.kind))
        // Платёж по заказу — в валюте заказа: иначе служба откажет, и выбор
        // счёта в другой валюте был бы ловушкой.
        .filter((a) => !flow.orderUid || a.currency === flow.currency)
        .map((a) => ({
          code: a.code,
          name: uz ? a.nameUz : a.nameRu,
          currency: a.currency,
        }))
    );
  }

  /**
   * Второй счёт проводки бот выбирает сам: расход ложится на счёт расходов
   * периода, поступление — на счёт дохода. Спрашивать об этом нельзя — человек,
   * которому бот заменяет систему, про план счетов не знает и знать не должен.
   * Если в компании такого счёта нет, молча подставить нечего: отказываем
   * словами и зовём администратора.
   */
  private async counterAccount(me: Me, flow: Flow, uz: boolean): Promise<string | null> {
    const refs = await this.as(me, uz, () => this.write.refs());
    // Платёж по заказу закрывает долг покупателя, а не создаёт доход второй
    // раз: доход по этой продаже признан при отгрузке. Это правило проверяет
    // и служба — здесь бот только подставляет тот счёт, который она ждёт.
    const kind = flow.orderUid ? 'receivable' : flow.type === 'income' ? 'income' : 'expense';
    const found = refs.accounts
      .filter((a) => a.companyUid === flow.companyUid && a.kind === kind)
      .map((a) => a.code)
      .sort();
    return found[0] ?? null;
  }

  /** Контрагенты: сначала те, с кем уже были операции — их и ищут чаще всего. */
  private async partners(me: Me, flow: Flow, uz: boolean, query?: string) {
    const like = query ? `%${query}%` : null;
    const rows = await this.prisma.withContext(
      me.userId,
      me.companyIds,
      (tx) =>
        tx.$queryRaw<{ uid: string; name_ru: string }[]>`
        SELECT p.uid, p.name_ru
          FROM partner p
          JOIN company co ON co.id = p.company_id
          LEFT JOIN finance_operation o ON o.partner_id = p.id
         WHERE co.uid = ${flow.companyUid ?? null}::uuid
           AND p.is_active
           AND (${like}::text IS NULL OR p.name_ru ILIKE ${like})
         GROUP BY p.uid, p.name_ru
         ORDER BY max(o.occurred_at) DESC NULLS LAST, p.name_ru
         LIMIT 6`,
    );
    return rows.map((r) => ({ uid: r.uid, name: r.name_ru }));
  }

  /**
   * Курс для валютной операции. Учётная валюта сама себе курс; для остальных
   * берём последний известный на сегодня. Спрашивать курс у человека нельзя:
   * он его не знает, а ошибка в курсе — ошибка в сумме.
   */
  private async rateFor(me: Me, currency: string): Promise<string | undefined | null> {
    if (currency === BASE_CURRENCY) return undefined;
    return (await this.rateInfo(me, currency))?.rate ?? null;
  }

  /**
   * Курс и его дата. Дата нужна экрану проверки: человек должен видеть, что
   * пересчёт сделан по курсу такого-то дня, а не «по какому-то курсу».
   */
  private async rateInfo(
    me: Me,
    currency: string,
  ): Promise<{ rate: string; day: string } | null> {
    if (currency === BASE_CURRENCY) return null;
    const rows = await this.prisma.withContext(
      me.userId,
      me.companyIds,
      (tx) =>
        tx.$queryRaw<{ rate: string; day: string }[]>`
        SELECT r.rate::text AS rate, r.rate_date::text AS day
          FROM currency_rate r JOIN currency c ON c.id = r.currency_id
         WHERE c.code = ${currency}
           AND r.rate_date <= (now() AT TIME ZONE 'Asia/Tashkent')::date
         ORDER BY r.rate_date DESC
         LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  /**
   * Отказ службы финансов — человеку её словами.
   *
   * Переводить их заново бот не берётся: тексты в `src/finance` уже написаны
   * для человека («Операцию уже изменили: обновите страницу и повторите»), а
   * второй набор формулировок про те же правила разошёлся бы с первым.
   */
  private async refusal(me: Me, uz: boolean, e: unknown, uid: string | null): Promise<Screen> {
    const message = String((e as { message?: string }).message ?? e);
    this.log.warn(`финансы в боте: ${message}`);
    if (uid) {
      const card = await this.card(me, uid, uz, F.refused(uz, escape(message)));
      return card;
    }
    return {
      ...this.home(me, uz),
      text: `${F.refused(uz, escape(message))}\n\n${F.home(uz, me.permissions.has('finance.post'))}`,
    };
  }
}
