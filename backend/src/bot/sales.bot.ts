import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { OrdersService, type Stage } from '../sales/orders.service.js';
import {
  NEXT_STATUS,
  SHIPPABLE,
  SalesWriteService,
  type OrderStatusName,
} from '../sales/write.service.js';
import {
  asUser,
  comingNext,
  escape,
  explainButton,
  homeRow,
  qtyText,
  type Me,
  type Screen,
  type SectionFlow,
  understoodButton,
} from './section.js';
import { BASE_CURRENCY, parseDay, shiftDay, showDay, sum, today } from './format.js';
import { MOVE_HELP, PAID, S, SHIPPED, STAGE, STATUS } from './sales.texts.js';
import {
  type Flow,
  type Line,
  type ShipLine,
  type Step,
  lineTotal,
  nextStep,
  order,
  parsePrice,
  parseQty,
  prevStep,
} from './sales.flow.js';
import { BLUE, CB, GREEN, RED } from './menu.js';
import type { InlineButton, InlineKeyboard } from './telegram.api.js';

/**
 * Раздел «Продажи» в боте (ТЗ 11.5, решение заказчика 02.10 — весь функционал).
 *
 * Менеджер по продажам сидит не за столом, а у клиента или в машине, и заказ
 * ему нужно завести там же, где он договорился. Поэтому в боте есть всё: что
 * происходит с заказами, новый заказ со спецификацией, смена статуса, наличие
 * под заказ и отгрузка.
 *
 * Правил продаж здесь нет ни одного. Откуда берётся цена, какой переход статуса
 * разрешён, можно ли отгрузить больше обещанного, какую партию списать — всё
 * это в `src/sales` и `src/warehouse`, и бот зовёт те же службы, что экран в
 * браузере. Своё у бота только одно: один вопрос на экран.
 */

/** Буква статуса в кнопке: `in_production` вместе с uuid не влезает в 64 знака. */
const CODE: Partial<Record<OrderStatusName, string>> = {
  confirmed: 'c',
  reserved: 'r',
  in_production: 'p',
  picking: 'k',
  closed: 'z',
  cancelled: 'x',
};
const STATUS_BY_CODE: Record<string, OrderStatusName> = Object.fromEntries(
  Object.entries(CODE).map(([status, code]) => [code!, status as OrderStatusName]),
);

/**
 * Право на переход. То же, что проверяет служба: отмена отдельно, потому что
 * отменённый заказ уходит из отчётов.
 */
const statusRight = (target: OrderStatusName) =>
  target === 'cancelled' ? 'sales.delete' : 'sales.edit';

/** Сколько строк и кнопок показываем. Больше на телефоне не читается. */
const LIST_LIMIT = 8;
/** Вариантов выбора на экране. Шесть — то, что видно без прокрутки. */
const PICK_LIMIT = 6;

@Injectable()
export class BotSales {
  private readonly log = new Logger('bot/sales');

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly write: SalesWriteService,
  ) {}

  private as<T>(me: Me, uz: boolean, fn: () => Promise<T>): Promise<T> {
    return asUser(me, uz, fn);
  }

  // --- разбор нажатий -------------------------------------------------------

  async route(me: Me, any: SectionFlow | null, data: string, uz: boolean): Promise<Screen> {
    const flow = any?.kind === 'sales' ? (any as Flow) : null;

    if (data === CB.sal) return { ...this.home(me, uz), flow: null };
    if (data === CB.salSearch) {
      return {
        text: S.askSearch(uz),
        keyboard: [this.row(uz)],
        flow: { kind: 'sales', step: 'search' } satisfies Flow,
      };
    }
    if (data === CB.salCancel) {
      return { ...this.home(me, uz), toast: S.cancelled(uz), flow: null };
    }
    if (data === CB.salNew) {
      if (!me.permissions.has('sales.edit')) {
        return { ...this.home(me, uz), toast: S.noRight(uz), flow: null };
      }
      return this.begin(me, uz);
    }
    if (data === CB.salBack) {
      if (!flow) return { ...this.home(me, uz), flow: null };
      // Назад из отгрузки — к заказу: мастер отгрузки короткий, и шаг назад в
      // нём человека только путает.
      if (this.shipStep(flow.step)) {
        return flow.orderUid
          ? this.card(me, flow.orderUid, uz, undefined, null)
          : { ...this.home(me, uz), flow: null };
      }
      const back = prevStep(flow, me.companies.length > 1);
      if (!back) return { ...this.home(me, uz), toast: S.cancelled(uz), flow: null };
      return this.stepScreen(me, { ...flow, step: back }, uz);
    }
    if (data === CB.salExplain) {
      if (!flow) return { ...this.home(me, uz), toast: S.stale(uz), flow: null };
      return this.explainScreen(me, flow, uz);
    }
    if (data === CB.salConfirm) {
      if (!flow) return { ...this.home(me, uz), toast: S.stale(uz), flow: null };
      return this.stepScreen(me, { ...flow, step: 'confirm' }, uz);
    }
    if (data === CB.salSave) {
      if (!flow) return { ...this.home(me, uz), toast: S.stale(uz), flow: null };
      return this.save(me, flow, uz);
    }
    if (data === CB.salShipGo) {
      if (!flow || !flow.orderUid) return { ...this.home(me, uz), toast: S.stale(uz), flow: null };
      return this.shipSave(me, flow, uz);
    }
    if (data.startsWith('o:s:')) return this.list(me, data.slice(4) as Stage, undefined, uz);
    if (data.startsWith('o:c:')) return this.card(me, data.slice(4), uz);
    if (data.startsWith('o:a:')) return this.availScreen(me, data.slice(4), uz);
    if (data.startsWith('o:t:')) return this.shipBegin(me, data.slice(4), uz);
    if (data.startsWith('o:k:')) {
      if (!flow) return { ...this.home(me, uz), toast: S.stale(uz), flow: null };
      return this.pick(me, flow, data.slice(4), uz);
    }
    if (data.startsWith('o:q:')) return this.ask(me, data.slice(4), uz);
    if (data.startsWith('o:y:')) return this.apply(me, data.slice(4), uz);

    return { ...this.home(me, uz), toast: S.stale(uz) };
  }

  home(me: Me, uz: boolean): Screen {
    const rows: InlineKeyboard = [
      [this.stageButton('all', uz), this.stageButton('unpaid', uz)],
      [this.stageButton('production', uz), this.stageButton('shipped', uz)],
      [{ text: uz ? '🔍 Qidirish' : '🔍 Найти заказ', data: CB.salSearch, style: BLUE }],
    ];
    if (me.permissions.has('sales.edit')) {
      rows.push([
        { text: uz ? '➕ Yangi buyurtma' : '➕ Новый заказ', data: CB.salNew, style: BLUE },
      ]);
    }
    rows.push([{ text: uz ? '⬅️ Menyu' : '⬅️ Меню', data: CB.menu, style: BLUE }]);
    return { text: S.home(uz), keyboard: rows };
  }

  private stageButton(stage: string, uz: boolean): InlineButton {
    const s = STAGE[stage]!;
    return { text: `${s.mark} ${uz ? s.uz : s.ru}`, data: CB.salStage(stage), style: BLUE };
  }

  private row(uz: boolean): InlineButton[] {
    return homeRow(CB.sal, 'Продажи', 'Sotuv', uz);
  }

  async text(me: Me, any: SectionFlow, raw: string, uz: boolean): Promise<Screen> {
    const flow = any.kind === 'sales' ? (any as Flow) : null;
    if (!flow) return { ...this.home(me, uz), toast: S.stale(uz), flow: null };
    const typed = raw.trim();

    if (flow.step === 'search') return this.list(me, 'all', typed, uz);

    if (flow.step === 'partner') {
      const found = await this.partners(me, flow, typed);
      if (found.length === 0) {
        return this.stepScreen(me, flow, uz, true, S.partnerNotFound(uz, escape(typed)));
      }
      if (found.length === 1) return this.choosePartner(me, flow, found[0]!, uz);
      return this.stepScreen(me, flow, uz, true, undefined, { partners: found });
    }

    if (flow.step === 'item') {
      const found = await this.items(me, flow, typed);
      if (found.length === 0) {
        return this.stepScreen(me, flow, uz, true, S.itemNotFound(uz, escape(typed)));
      }
      if (found.length === 1) return this.chooseItem(me, flow, found[0]!, uz);
      return this.stepScreen(me, flow, uz, true, undefined, { items: found });
    }

    if (flow.step === 'qty') {
      const qty = parseQty(typed);
      if (!qty) return this.stepScreen(me, flow, uz, true, S.badQty(uz));
      return this.forward(me, { ...flow, draft: { ...flow.draft!, qty } }, uz);
    }

    if (flow.step === 'price') {
      const price = parsePrice(typed);
      if (!price) return this.stepScreen(me, flow, uz, true, S.badPrice(uz));
      // Цену назвали руками — значит и причину спросим: так устроен и экран
      // заказа в браузере, и так требует служба записи.
      return this.forward(me, { ...flow, draft: { ...flow.draft!, price, source: 'manual' } }, uz);
    }

    if (flow.step === 'priceWhy') {
      return this.forward(
        me,
        { ...flow, draft: { ...flow.draft!, priceComment: typed.slice(0, 200) } },
        uz,
      );
    }

    if (flow.step === 'due') {
      const day = parseDay(typed, new Date());
      if (!day) return this.stepScreen(me, flow, uz, true, S.badDay(uz));
      return this.forward(me, { ...flow, dueDate: day }, uz);
    }

    if (flow.step === 'shipQty') {
      return this.shipQtyTyped(me, flow, typed, uz);
    }

    if (flow.step === 'shipInfo') {
      // Машина и водитель одной строкой: два экрана ради двух слов — лишнее.
      const [vehicle, driver] = typed.split(',');
      return this.shipConfirmScreen(
        me,
        {
          ...flow,
          step: 'shipConfirm',
          vehicle: vehicle?.trim().slice(0, 64) || undefined,
          driver: driver?.trim().slice(0, 128) || undefined,
        },
        uz,
        true,
      );
    }

    return this.stepScreen(me, flow, uz, true, S.stale(uz));
  }

  // --- список и карточка ----------------------------------------------------

  private async list(me: Me, stage: Stage, search: string | undefined, uz: boolean) {
    const rows = await this.as(me, uz, () => this.orders.list(stage, search, LIST_LIMIT));
    if (rows.length === 0 && search) {
      return {
        text: `${S.searchEmpty(uz, escape(search))}\n\n${S.askSearch(uz)}`,
        keyboard: [this.row(uz)],
        fresh: true,
        flow: { kind: 'sales', step: 'search' } satisfies Flow,
      };
    }
    const title = search
      ? `<b>🔍 ${escape(search)}</b>`
      : S.listTitle(
          uz,
          `${STAGE[stage]?.mark ?? '🛒'} ${uz ? STAGE[stage]?.uz : STAGE[stage]?.ru}`,
        );
    const lines = rows.map((r) => {
      const st = STATUS[r.status as OrderStatusName];
      return (
        `${st?.mark ?? '•'} <b>${escape(r.number)}</b> · ${escape(r.partnerName)}\n` +
        `  ${sum(r.amountTotal, BASE_CURRENCY, uz)} · ${st ? (uz ? st.uz : st.ru) : r.status} · ` +
        `${uz ? PAID[r.paymentStatus]?.uz : PAID[r.paymentStatus]?.ru}`
      );
    });
    const keyboard: InlineKeyboard = rows.map((r) => [
      {
        text: `${STATUS[r.status as OrderStatusName]?.mark ?? '•'} ${r.number} · ${r.partnerName}`,
        data: CB.salOrder(r.uid),
        style: BLUE,
      },
    ]);
    keyboard.push(this.row(uz));
    return {
      text: S.list(uz, title, lines),
      keyboard,
      fresh: Boolean(search),
      flow: search ? null : undefined,
    };
  }

  /**
   * Карточка заказа: что обещано, что уехало, что оплачено — и что с этим
   * можно сделать прямо сейчас.
   */
  private async card(
    me: Me,
    uid: string,
    uz: boolean,
    note?: string,
    flow: null | undefined = undefined,
  ): Promise<Screen> {
    let o: Awaited<ReturnType<OrdersService['one']>>;
    try {
      o = await this.as(me, uz, () => this.orders.one(uid));
    } catch (e) {
      return this.refusal(me, uz, e);
    }
    const label = (ru: string, uzs: string) => (uz ? uzs : ru);
    const st = STATUS[o.status as OrderStatusName];
    const lines = [
      `<b>${escape(o.number)}</b> · ${st?.mark ?? '•'} ${escape(
        st ? (uz ? st.uz : st.ru) : o.status,
      )}`,
      `${label('Клиент', 'Mijoz')}: ${escape(uz ? o.partner.nameUz : o.partner.nameRu)}`,
      `${label('Сумма', 'Summa')}: <b>${sum(o.amountTotal, o.currency, uz)}</b>` +
        (Number(o.paidAmount) > 0
          ? ` (${label('оплачено', 'to‘langan')} ${sum(o.paidAmount, o.currency, uz)})`
          : ''),
      `${label('Оплата', 'To‘lov')}: ${uz ? PAID[o.paymentStatus]?.uz : PAID[o.paymentStatus]?.ru}` +
        (o.paymentDueDate ? ` ${label('до', 'gacha')} ${showDay(o.paymentDueDate)}` : ''),
      // Остаток показываем числом, а не оставляем считать в голове: именно по
      // нему человек решает, сколько принять от клиента.
      ...(Number(o.amountTotal) - Number(o.paidAmount) > 0.005
        ? [
            `${label('Осталось получить', 'Olish qoldi')}: <b>${sum(
              (Number(o.amountTotal) - Number(o.paidAmount)).toFixed(2),
              o.currency,
              uz,
            )}</b>`,
          ]
        : []),
      `${label('Отгрузка', 'Jo‘natish')}: ${
        uz ? SHIPPED[o.shipmentStatus]?.uz : SHIPPED[o.shipmentStatus]?.ru
      }`,
      ...(o.shipments.length > 0
        ? [
            `${label('Накладные', 'Yuk xatlari')}: ` +
              o.shipments.map((s) => escape(s.number)).join(', '),
          ]
        : []),
      ...(o.managerName ? [`${label('Менеджер', 'Menejer')}: ${escape(o.managerName)}`] : []),
    ];

    /**
     * Позиции — отдельным блоком под полями заказа, а не строками среди них.
     * Список внутри списка человек читает как одну стену, и «Менеджер» после
     * трёх позиций теряется: в карточке должно быть видно, где кончились поля
     * и начался товар.
     */
    const items = o.lines.map(
      (l) =>
        `${l.seq}. ${escape(uz ? l.itemNameUz : l.itemNameRu)}\n` +
        `   ${qtyText(l.qty, l.unit)} × ${sum(l.price, o.currency, uz)} = ` +
        `${sum(l.amountTotal, o.currency, uz)}` +
        (Number(l.shippedQty) > 0
          ? `\n   ${label('уехало', 'ketdi')} ${qtyText(l.shippedQty, l.unit)}`
          : '') +
        (l.priceSource === 'manual' && l.priceComment
          ? `\n   ${label('цена руками', 'narx qo‘lda')}: ${escape(l.priceComment)}`
          : ''),
    );

    const keyboard: InlineKeyboard = [];
    const status = o.status as OrderStatusName;
    const targets = (NEXT_STATUS[status] ?? []).filter((t) => me.permissions.has(statusRight(t)));
    for (const target of targets) {
      const code = CODE[target];
      if (!code) continue;
      const t = STATUS[target];
      keyboard.push([
        {
          text: `${t.mark} ${uz ? t.uz : t.ru}`,
          data: CB.salAsk(code, uid),
          style: target === 'cancelled' ? RED : BLUE,
        },
      ]);
    }
    // Приём оплаты — право финансов: платёж заводится как финансовая
    // операция и проходит то же согласование, что любая другая.
    if (
      status !== 'cancelled' &&
      o.paymentStatus !== 'paid' &&
      me.permissions.has('finance.post')
    ) {
      keyboard.push([
        {
          text: uz ? '💵 To‘lovni qabul qilish' : '💵 Принять оплату',
          data: CB.finPay(uid),
          style: GREEN,
        },
      ]);
    }
    if (SHIPPABLE.includes(status) && me.permissions.has('sales.edit')) {
      keyboard.push([
        { text: uz ? '🚚 Jo‘natish' : '🚚 Отгрузить', data: CB.salShip(uid), style: GREEN },
      ]);
    }
    // Документ по заказу выписывают здесь же: менеджер стоит в заказе и
    // говорит «надо счёт». Разговор ведёт раздел документов — бумагу собирает
    // его служба, и второй такой сборки в системе быть не должно.
    if (status !== 'cancelled' && me.permissions.has('documents.edit')) {
      keyboard.push([
        {
          text: uz ? '📄 Hujjat tayyorlash' : '📄 Выписать документ',
          data: CB.docNew(uid),
          style: BLUE,
        },
      ]);
    }
    keyboard.push([
      { text: uz ? '📦 Bor-yo‘g‘i' : '📦 Наличие', data: CB.salAvail(uid), style: BLUE },
    ]);
    keyboard.push(this.row(uz));

    const help = st ? (uz ? st.helpUz : st.helpRu) : '';
    const next = targets.length === 0 && !SHIPPABLE.includes(status) ? S.nextNothing(uz) : '';
    const text = S.card(uz, lines, items, help, next);
    return { text: note ? `${note}\n\n${text}` : text, keyboard, fresh: Boolean(note), flow };
  }

  private async availScreen(me: Me, uid: string, uz: boolean): Promise<Screen> {
    let out: Awaited<ReturnType<SalesWriteService['availability']>>;
    try {
      out = await this.as(me, uz, () => this.write.availability(uid));
    } catch (e) {
      return this.refusal(me, uz, e);
    }
    const short = out.lines.some((l) => Number(l.shortage) > 0);
    const lines = out.lines.map((l) => {
      const mark = Number(l.shortage) > 0 ? '🔴' : '🟢';
      return (
        `${mark} <b>${escape(uz ? l.itemNameUz : l.itemNameRu)}</b>\n` +
        `  ${uz ? 'va’da' : 'обещано'} ${qtyText(l.qty, l.unit)}, ` +
        `${uz ? 'ketdi' : 'уехало'} ${qtyText(l.shippedQty, l.unit)}, ` +
        `${uz ? 'qoldi' : 'осталось'} ${qtyText(l.remainingQty, l.unit)}\n` +
        `  ${uz ? 'omborda erkin' : 'свободно на складе'} ${qtyText(l.availableQty, l.unit)}` +
        (Number(l.shortage) > 0
          ? ` · ${uz ? 'yetmaydi' : 'не хватает'} ${qtyText(l.shortage, l.unit)}`
          : '')
      );
    });
    const keyboard: InlineKeyboard = [];
    if (out.canShip && me.permissions.has('sales.edit')) {
      keyboard.push([
        { text: uz ? '🚚 Jo‘natish' : '🚚 Отгрузить', data: CB.salShip(uid), style: GREEN },
      ]);
    }
    keyboard.push([{ text: `🛒 ${escape(out.orderNumber)}`, data: CB.salOrder(uid), style: BLUE }]);
    keyboard.push(this.row(uz));
    return {
      text: S.avail(uz, lines, short ? S.availShort(uz) : S.availOk(uz)),
      keyboard,
    };
  }

  // --- мастер нового заказа -------------------------------------------------

  private async begin(me: Me, uz: boolean): Promise<Screen> {
    const many = me.companies.length > 1;
    let flow: Flow = { kind: 'sales', step: many ? 'company' : 'partner', lines: [] };
    if (!many && me.companies[0]) {
      flow.companyUid = me.companies[0].uid;
      flow.companyName = uz ? me.companies[0].nameUz : me.companies[0].nameRu;
      flow = await this.withWarehouse(me, flow, uz);
    }
    return this.stepScreen(me, flow, uz);
  }

  /**
   * Склад компании: когда он один, спрашивать не о чем — выбираем молча.
   * Тот же довод, что и с компанией: лишний экран человек в возрасте читает
   * как ещё одну возможность ошибиться.
   */
  private async withWarehouse(me: Me, flow: Flow, uz: boolean): Promise<Flow> {
    const all = await this.warehouses(me, flow, uz);
    if (all.length !== 1) return flow;
    return {
      ...flow,
      warehouseCode: all[0]!.code,
      warehouseName: all[0]!.name,
      oneWarehouse: true,
    };
  }

  private async warehouses(me: Me, flow: Flow, uz: boolean) {
    const refs = await this.as(me, uz, () => this.write.refs());
    return refs.warehouses
      .filter((w) => w.companyUid === flow.companyUid)
      .map((w) => ({ code: w.code, name: uz ? w.nameUz : w.nameRu }));
  }

  private async pick(me: Me, flow: Flow, value: string, uz: boolean): Promise<Screen> {
    const stale = () => this.stepScreen(me, flow, uz, false, S.stale(uz));

    if (flow.step === 'company') {
      const company = me.companies.find((c) => c.uid === value);
      if (!company) return stale();
      const next = await this.withWarehouse(
        me,
        { ...flow, companyUid: company.uid, companyName: uz ? company.nameUz : company.nameRu },
        uz,
      );
      return this.forward(me, next, uz);
    }

    if (flow.step === 'warehouse') {
      const found = (await this.warehouses(me, flow, uz)).find((w) => w.code === value);
      if (!found) return stale();
      return this.forward(
        me,
        { ...flow, warehouseCode: found.code, warehouseName: found.name },
        uz,
      );
    }

    if (flow.step === 'partner') {
      const found = (await this.partners(me, flow)).find((p) => p.uid === value);
      if (!found) return stale();
      return this.choosePartner(me, flow, found, uz);
    }

    if (flow.step === 'item') {
      const found = (await this.items(me, flow)).find((i) => i.code === value);
      if (!found) return stale();
      return this.chooseItem(me, flow, found, uz);
    }

    if (flow.step === 'price' && value === '=') {
      if (!flow.hintPrice) return stale();
      return this.forward(
        me,
        { ...flow, draft: { ...flow.draft!, price: flow.hintPrice, source: 'list' } },
        uz,
      );
    }

    if (flow.step === 'more') {
      if (value === '+') {
        // Ещё позиция: разговор возвращается к выбору товара, собранное остаётся.
        return this.stepScreen(me, { ...flow, step: 'item', draft: undefined }, uz);
      }
      if (value === '-') return this.forward(me, flow, uz);
      return stale();
    }

    if (flow.step === 'due') {
      if (value === '=') {
        const suggested = this.dueSuggestion(flow);
        return this.forward(me, { ...flow, dueDate: suggested }, uz);
      }
      if (value === '-') return this.forward(me, { ...flow, dueDate: undefined }, uz);
      return stale();
    }

    if (flow.step === 'shipQty') {
      const line = flow.shipLines?.[flow.shipAt ?? 0];
      if (!line) return stale();
      // «Всё» и «не везу» — две самые частые суммы, и обе кнопкой.
      if (value === '+') return this.shipAdvance(me, flow, line.remaining, uz);
      if (value === '-') return this.shipAdvance(me, flow, '0', uz);
      return stale();
    }

    if (flow.step === 'shipBatch') {
      const at = flow.shipAt ?? 0;
      const line = flow.shipLines?.[at];
      if (!line || !line.batches.some((b) => b.number === value)) return stale();
      const shipLines = flow.shipLines!.map((l, i) => (i === at ? { ...l, batch: value } : l));
      return this.shipNextLine(me, { ...flow, shipLines }, at, uz);
    }

    if (flow.step === 'shipInfo' && value === '-') {
      return this.shipConfirmScreen(me, { ...flow, step: 'shipConfirm' }, uz, false);
    }

    return stale();
  }

  private choosePartner(
    me: Me,
    flow: Flow,
    partner: { uid: string; name: string; delay: number },
    uz: boolean,
  ): Promise<Screen> {
    return this.forward(
      me,
      {
        ...flow,
        partnerUid: partner.uid,
        partnerName: partner.name,
        partnerDelay: partner.delay,
      },
      uz,
    );
  }

  /**
   * Товар выбрали — и сразу спрашиваем прайс, тем же способом, которым его
   * спросит запись заказа. Иначе бот показал бы одну цену, а записал другую.
   */
  private async chooseItem(
    me: Me,
    flow: Flow,
    item: { code: string; name: string; unit: string },
    uz: boolean,
  ): Promise<Screen> {
    const draft: Line = { itemCode: item.code, itemName: item.name, unit: item.unit, qty: '' };
    let hint: Awaited<ReturnType<SalesWriteService['priceHint']>> | null = null;
    try {
      hint = await this.as(me, uz, () =>
        this.write.priceHint({ partnerUid: flow.partnerUid!, itemCode: item.code }),
      );
    } catch (e) {
      // Прайс не ответил — не причина ломать разговор: цену спросим словами.
      this.log.warn(`прайс в боте: ${String((e as { message?: string }).message ?? e)}`);
    }
    return this.forward(
      me,
      {
        ...flow,
        draft: { ...draft, source: hint?.price ? 'list' : 'manual' },
        hintPrice:
          hint?.price === null || hint?.price === undefined ? undefined : String(hint.price),
        hintSource: hint?.source,
        hintCost: hint?.cost === null || hint?.cost === undefined ? undefined : String(hint.cost),
      },
      uz,
    );
  }

  private forward(me: Me, flow: Flow, uz: boolean, fresh = true): Promise<Screen> {
    const step = nextStep(flow, me.companies.length > 1);
    // Позиция закончилась — она уезжает в спецификацию, и разговор идёт дальше
    // уже без черновика.
    if (step === 'more' && flow.draft) {
      const lines = [...(flow.lines ?? []), flow.draft];
      return this.stepScreen(me, { ...flow, step, lines, draft: undefined }, uz, fresh);
    }
    return this.stepScreen(me, { ...flow, step }, uz, fresh);
  }

  private async stepScreen(
    me: Me,
    flow: Flow,
    uz: boolean,
    fresh = false,
    note?: string,
    ready?: {
      items?: { code: string; name: string; unit: string }[];
      partners?: { uid: string; name: string; delay: number }[];
    },
  ): Promise<Screen> {
    if (flow.step === 'confirm') return this.confirmScreen(me, flow, uz, fresh);
    if (this.shipStep(flow.step)) return this.shipScreen(me, flow, uz, fresh, note);

    const many = me.companies.length > 1;
    const steps = order(flow, many);
    const total = steps.length - 1;
    const index = Math.max(steps.indexOf(flow.step) + 1, 1);
    const head = (title: string) => `${S.newHead(uz)}\n\n${S.step(uz, index, total, title)}`;
    // Чего спрошу после этого вопроса: заказ собирается из нескольких позиций,
    // и без этой строки человек не знает, когда разговор кончится.
    const ahead = comingNext(
      uz,
      steps.slice(index).map((next) => this.stepTitle(next, uz)),
    );
    const rows: InlineKeyboard = [];
    let body: string;

    if (flow.step === 'company') {
      body = `${head(S.companyTitle(uz))}\n\n${S.askCompany(uz)}`;
      for (const c of me.companies) {
        rows.push([{ text: uz ? c.nameUz : c.nameRu, data: CB.salPick(c.uid), style: BLUE }]);
      }
    } else if (flow.step === 'partner') {
      body = `${head(S.partnerTitle(uz))}\n\n${S.askPartner(uz)}`;
      for (const p of ready?.partners ?? (await this.partners(me, flow))) {
        rows.push([{ text: p.name, data: CB.salPick(p.uid), style: BLUE }]);
      }
    } else if (flow.step === 'item') {
      body = `${head(S.itemTitle(uz))}\n\n${S.askItem(uz)}`;
      for (const i of ready?.items ?? (await this.items(me, flow))) {
        rows.push([{ text: `${i.name} · ${i.code}`, data: CB.salPick(i.code), style: BLUE }]);
      }
    } else if (flow.step === 'qty') {
      body = `${head(S.qtyTitle(uz))}\n\n${S.askQty(uz, flow.draft?.unit ?? '—')}`;
    } else if (flow.step === 'price') {
      body = `${head(S.priceTitle(uz))}\n\n`;
      if (flow.hintPrice) {
        const source =
          flow.hintSource === 'partner' ? S.priceSourcePartner(uz) : S.priceSourceList(uz);
        body += S.priceFromList(uz, sum(flow.hintPrice, BASE_CURRENCY, uz), source);
        rows.push([
          {
            text: `✅ ${sum(flow.hintPrice, BASE_CURRENCY, uz)}`,
            data: CB.salPick('='),
            style: GREEN,
          },
        ]);
      } else {
        body += S.askPrice(
          uz,
          flow.draft?.unit ?? '—',
          flow.hintCost ? sum(flow.hintCost, BASE_CURRENCY, uz) : null,
        );
      }
    } else if (flow.step === 'priceWhy') {
      body = `${head(S.priceWhyTitle(uz))}\n\n${S.askPriceWhy(uz)}`;
    } else if (flow.step === 'warehouse') {
      body = `${head(S.warehouseTitle(uz))}\n\n${S.askWarehouse(uz)}`;
      for (const w of await this.warehouses(me, flow, uz)) {
        rows.push([{ text: w.name, data: CB.salPick(w.code), style: BLUE }]);
      }
    } else if (flow.step === 'more') {
      body = `${head(S.moreTitle(uz))}\n\n${S.askMore(uz, this.draftLines(flow, uz))}`;
      // По одной кнопке в ряд: «ещё товар» и «готово» рядом — это полпальца
      // друг от друга, и заказ закрывают, не добавив вторую позицию.
      rows.push([{ text: uz ? '✅ Tayyor' : '✅ Готово', data: CB.salSkip, style: GREEN }]);
      rows.push([{ text: uz ? '➕ Yana tovar' : '➕ Ещё товар', data: CB.salMore, style: BLUE }]);
    } else {
      const suggested = this.dueSuggestion(flow);
      body = `${head(S.dueTitle(uz))}\n\n${S.askDue(uz, showDay(suggested), flow.partnerDelay ?? 0)}`;
      rows.push([{ text: `✅ ${showDay(suggested)}`, data: CB.salPick('='), style: GREEN }]);
      rows.push([
        { text: uz ? '➡️ O‘tkazib yuborish' : '➡️ Пропустить', data: CB.salSkip, style: BLUE },
      ]);
    }

    rows.push(this.footer(me, flow, uz));
    body += ahead;
    return { text: note ? `${note}\n\n${body}` : body, keyboard: rows, fresh, flow };
  }

  /** Срок оплаты по договору: отсрочка клиента от сегодняшнего дня. */
  private dueSuggestion(flow: Flow): string {
    return shiftDay(today(new Date()), flow.partnerDelay ?? 0);
  }

  private draftLines(flow: Flow, uz: boolean): string[] {
    return (flow.lines ?? []).map(
      (l, i) =>
        `${i + 1}. ${escape(l.itemName)} — ${qtyText(l.qty, l.unit)} × ` +
        `${sum(l.price ?? '0', BASE_CURRENCY, uz)} = ${sum(lineTotal(l), BASE_CURRENCY, uz)}`,
    );
  }

  /** Как шаг назван в строке «дальше»: теми же словами, что его заголовок. */
  private stepTitle(step: Step, uz: boolean): string {
    if (step === 'company') return S.companyTitle(uz);
    if (step === 'partner') return S.partnerTitle(uz);
    if (step === 'item') return S.itemTitle(uz);
    if (step === 'qty') return S.qtyTitle(uz);
    if (step === 'price') return S.priceTitle(uz);
    if (step === 'priceWhy') return S.priceWhyTitle(uz);
    if (step === 'more') return S.moreTitle(uz);
    if (step === 'warehouse') return S.warehouseTitle(uz);
    if (step === 'due') return S.dueTitle(uz);
    return S.checkTitle(uz);
  }

  /**
   * «Я не понял» на проверке заказа: то же словами, без перечня полей. Ничего
   * не записывает — человек возвращается на тот же экран проверки.
   */
  private explainScreen(me: Me, flow: Flow, uz: boolean): Screen {
    const total = (flow.lines ?? []).reduce((acc, l) => acc + lineTotal(l), 0);
    return {
      text: S.explain(uz, {
        client: escape(flow.partnerName ?? '—'),
        total: sum(total, BASE_CURRENCY, uz),
        warehouse: escape(flow.warehouseName ?? flow.warehouseCode ?? '—'),
      }),
      keyboard: [[understoodButton(uz, CB.salConfirm)], this.footer(me, flow, uz)],
      flow,
    };
  }

  private footer(me: Me, flow: Flow, uz: boolean): InlineButton[] {
    const row: InlineButton[] = [];
    const back = this.shipStep(flow.step)
      ? flow.step !== 'shipQty' || (flow.shipAt ?? 0) > 0
      : Boolean(prevStep(flow, me.companies.length > 1));
    if (back) row.push({ text: uz ? '⬅️ Orqaga' : '⬅️ Назад', data: CB.salBack, style: BLUE });
    row.push({ text: uz ? '❌ Bekor qilish' : '❌ Отменить', data: CB.salCancel, style: RED });
    return row;
  }

  private confirmScreen(me: Me, flow: Flow, uz: boolean, fresh: boolean): Screen {
    const label = (ru: string, uzs: string) => (uz ? uzs : ru);
    const total = (flow.lines ?? []).reduce((s, l) => s + lineTotal(l), 0);
    const lines = [
      `${label('Клиент', 'Mijoz')}: <b>${escape(flow.partnerName ?? '—')}</b>`,
      `${label('Позиции', 'Qatorlar')}:`,
      ...this.draftLines(flow, uz).map((l) => `  ${l}`),
      `${label('Итого без НДС', 'Jami QQSsiz')}: <b>${sum(total, BASE_CURRENCY, uz)}</b>`,
      ...(flow.dueDate
        ? [`${label('Оплата до', 'To‘lov muddati')}: ${showDay(flow.dueDate)}`]
        : [`${label('Срок оплаты', 'To‘lov muddati')}: ${label('не указан', 'ko‘rsatilmagan')}`]),
      `${label('Со склада', 'Ombordan')}: ${escape(flow.warehouseName ?? flow.warehouseCode ?? '—')}`,
      `${label('Компания', 'Kompaniya')}: ${escape(flow.companyName ?? '—')}`,
    ];
    return {
      text: S.confirm(uz, lines),
      keyboard: [
        [{ text: uz ? '✅ Yozish' : '✅ Записать', data: CB.salSave, style: GREEN }],
        [explainButton(uz, CB.salExplain)],
        this.footer(me, flow, uz),
      ],
      fresh,
      flow,
    };
  }

  /**
   * Запись заказа.
   *
   * Второго нажатия «Записать» здесь можно не бояться по другой причине, чем в
   * финансах: ключа повторной отправки у заказа нет, зато разговор после записи
   * заканчивается — `flow: null`, — а обновления Telegram бот разбирает по
   * одному. Второе нажатие придёт уже в разговор, которого нет, и заведёт не
   * второй заказ, а подсказку «кнопка с прошлого шага».
   */
  private async save(me: Me, flow: Flow, uz: boolean): Promise<Screen> {
    const lines = flow.lines ?? [];
    if (lines.length === 0) return { ...this.home(me, uz), toast: S.stale(uz), flow: null };
    try {
      const out = await this.as(me, uz, () =>
        this.write.createOrder({
          companyUid: flow.companyUid,
          partnerUid: flow.partnerUid!,
          ...(flow.warehouseCode ? { warehouseCode: flow.warehouseCode } : {}),
          ...(flow.dueDate ? { paymentDueDate: flow.dueDate } : {}),
          lines: lines.map((l) => ({
            itemCode: l.itemCode,
            qty: l.qty,
            // Цену из прайса не присылаем вовсе: её подставит служба, и в
            // заказе она будет помечена как прайсовая, а не названная руками.
            ...(l.source === 'manual' ? { price: l.price, priceComment: l.priceComment } : {}),
          })),
        }),
      );
      return {
        text: S.saved(uz, escape(out.number), sum(out.amountTotal, BASE_CURRENCY, uz)),
        keyboard: [
          [{ text: `🛒 ${escape(out.number)}`, data: CB.salOrder(out.uid), style: BLUE }],
          [{ text: uz ? '➕ Yana buyurtma' : '➕ Ещё заказ', data: CB.salNew, style: GREEN }],
          this.row(uz),
        ],
        flow: null,
      };
    } catch (e) {
      return this.refusal(me, uz, e);
    }
  }

  // --- статус ---------------------------------------------------------------

  private async ask(me: Me, tail: string, uz: boolean): Promise<Screen> {
    const [code, uid] = this.split(tail);
    const target = code ? STATUS_BY_CODE[code] : undefined;
    if (!target || !uid) return { ...this.home(me, uz), toast: S.stale(uz) };
    if (!me.permissions.has(statusRight(target))) {
      return { ...(await this.card(me, uid, uz)), toast: S.noRight(uz) };
    }
    const t = STATUS[target];
    const help = MOVE_HELP[target];
    const o = await this.as(me, uz, () => this.orders.one(uid));
    return {
      text: S.askStatus(
        uz,
        escape(o.number),
        uz ? t.uz : t.ru,
        help ? (uz ? help.uz : help.ru) : '',
      ),
      keyboard: [
        [
          {
            text: `✅ ${uz ? 'Ha' : 'Да'}`,
            data: CB.salDo(code!, uid),
            style: target === 'cancelled' ? RED : GREEN,
          },
        ],
        [{ text: uz ? '⬅️ Orqaga' : '⬅️ Назад', data: CB.salOrder(uid), style: BLUE }],
      ],
    };
  }

  private async apply(me: Me, tail: string, uz: boolean): Promise<Screen> {
    const [code, uid] = this.split(tail);
    const target = code ? STATUS_BY_CODE[code] : undefined;
    if (!target || !uid) return { ...this.home(me, uz), toast: S.stale(uz) };
    if (!me.permissions.has(statusRight(target))) {
      return { ...(await this.card(me, uid, uz)), toast: S.noRight(uz) };
    }
    try {
      await this.as(me, uz, () => this.write.setStatus(uid, target));
    } catch (e) {
      return this.refusal(me, uz, e);
    }
    const t = STATUS[target];
    return this.card(me, uid, uz, S.statusDone(uz, uz ? t.uz : t.ru));
  }

  private split(tail: string): [string | undefined, string | undefined] {
    const i = tail.indexOf(':');
    return i < 0 ? [undefined, undefined] : [tail.slice(0, i), tail.slice(i + 1)];
  }

  // --- отгрузка -------------------------------------------------------------

  private shipStep(step: Step): boolean {
    return (
      step === 'shipQty' || step === 'shipBatch' || step === 'shipInfo' || step === 'shipConfirm'
    );
  }

  private async shipBegin(me: Me, uid: string, uz: boolean): Promise<Screen> {
    if (!me.permissions.has('sales.edit')) {
      return { ...(await this.card(me, uid, uz)), toast: S.noRight(uz) };
    }
    let out: Awaited<ReturnType<SalesWriteService['availability']>>;
    try {
      out = await this.as(me, uz, () => this.write.availability(uid));
    } catch (e) {
      return this.refusal(me, uz, e);
    }
    if (!out.canShip) return this.card(me, uid, uz, S.shipClosed(uz));
    const shipLines: ShipLine[] = out.lines
      .filter((l) => Number(l.remainingQty) > 0)
      .map((l) => ({
        lineUid: l.lineUid,
        itemName: uz ? l.itemNameUz : l.itemNameRu,
        unit: l.unit,
        remaining: l.remainingQty,
        available: l.availableQty,
        trackBatches: l.trackBatches,
        // Партии со склада заказа: кладовщик выбирает из того, что лежит, а не
        // вспоминает номер.
        batches: l.batches
          .filter((b) => b.number !== null)
          .map((b) => ({ number: b.number!, available: b.availableQty })),
      }));
    if (shipLines.length === 0) return this.card(me, uid, uz, S.shipNothing(uz));
    const flow: Flow = {
      kind: 'sales',
      step: 'shipQty',
      orderUid: uid,
      orderNumber: out.orderNumber,
      shipLines,
      shipAt: 0,
      // Ключ повторной отправки: служба отгрузки его принимает, и второе
      // нажатие «Отгрузить» вернёт ту же накладную, а не увезёт товар дважды.
      key: randomUUID(),
    };
    return this.shipScreen(me, flow, uz, false);
  }

  private shipScreen(me: Me, flow: Flow, uz: boolean, fresh: boolean, note?: string): Screen {
    if (flow.step === 'shipConfirm') return this.shipConfirmScreen(me, flow, uz, fresh);
    const head = S.shipHead(uz, escape(flow.orderNumber ?? ''));
    if (flow.step === 'shipInfo') {
      return {
        text: `${head}\n\n<b>${S.shipInfoTitle(uz)}</b>\n\n${S.askShipInfo(uz)}`,
        keyboard: [
          [
            {
              text: uz ? '➡️ O‘tkazib yuborish' : '➡️ Пропустить',
              data: CB.salSkip,
              style: GREEN,
            },
          ],
          this.footer(me, flow, uz),
        ],
        fresh,
        flow,
      };
    }
    const at = flow.shipAt ?? 0;
    const line = flow.shipLines?.[at];
    if (!line) return { ...this.home(me, uz), toast: S.stale(uz), flow: null };
    const total = flow.shipLines!.length;
    if (flow.step === 'shipBatch') {
      return {
        text:
          `${head}\n\n<b>${S.shipQtyTitle(uz, at + 1, total)} · ${S.shipBatchTitle(uz)}</b>` +
          `\n\n${S.askShipBatch(uz, escape(line.itemName))}`,
        keyboard: [
          ...line.batches.map((b) => [
            {
              text: `${b.number} · ${qtyText(b.available, line.unit)}`,
              data: CB.salPick(b.number),
              style: BLUE,
            },
          ]),
          this.footer(me, flow, uz),
        ],
        fresh,
        flow,
      };
    }
    const body =
      `${head}\n\n<b>${S.shipQtyTitle(uz, at + 1, total)}</b>\n\n` +
      S.askShipQty(
        uz,
        escape(line.itemName),
        qtyText(line.remaining, line.unit),
        qtyText(line.available, line.unit),
      );
    return {
      text: note ? `${note}\n\n${body}` : body,
      keyboard: [
        [
          {
            text: `✅ ${uz ? 'Hammasi' : 'Всё'}: ${qtyText(line.remaining, line.unit)}`,
            data: CB.salMore,
            style: GREEN,
          },
        ],
        [{ text: uz ? '0 — olib ketmayman' : '0 — не везу', data: CB.salSkip, style: BLUE }],
        this.footer(me, flow, uz),
      ],
      fresh,
      flow,
    };
  }

  private shipQtyTyped(me: Me, flow: Flow, raw: string, uz: boolean): Screen {
    const line = flow.shipLines?.[flow.shipAt ?? 0];
    if (!line) return { ...this.home(me, uz), toast: S.stale(uz), flow: null };
    const qty = parseQty(raw);
    if (!qty) return this.shipScreen(me, flow, uz, true, S.badQty(uz));
    if (Number(qty) > Number(line.remaining)) {
      // Служба отгрузки это тоже не пропустит, но отказ после трёх экранов
      // хуже вопроса на месте.
      return this.shipScreen(
        me,
        flow,
        uz,
        true,
        S.shipTooMuch(uz, qtyText(line.remaining, line.unit)),
      );
    }
    return this.shipAdvance(me, flow, qty, uz, true);
  }

  private shipAdvance(me: Me, flow: Flow, qty: string, uz: boolean, fresh = false): Screen {
    const at = flow.shipAt ?? 0;
    const shipLines = (flow.shipLines ?? []).map((l, i) => (i === at ? { ...l, qty } : l));
    const line = shipLines[at]!;
    const next: Flow = { ...flow, shipLines };

    // Партию спрашиваем только у того, что везут, и только когда есть из чего
    // выбирать: единственную подставляем молча.
    if (Number(qty) > 0 && line.trackBatches && !line.batch) {
      if (line.batches.length === 1) {
        const one = shipLines.map((l, i) =>
          i === at ? { ...l, batch: line.batches[0]!.number } : l,
        );
        return this.shipNextLine(me, { ...next, shipLines: one }, at, uz, fresh);
      }
      if (line.batches.length > 1) {
        return this.shipScreen(me, { ...next, step: 'shipBatch' }, uz, fresh);
      }
      // Партий на складе нет вовсе — служба отгрузки откажет своими словами, и
      // пусть откажет: придумывать номер бот не станет.
    }
    return this.shipNextLine(me, next, at, uz, fresh);
  }

  /** Строка закончилась: либо следующая, либо машина. */
  private shipNextLine(me: Me, flow: Flow, at: number, uz: boolean, fresh = false): Screen {
    const total = (flow.shipLines ?? []).length;
    if (at + 1 < total) {
      return this.shipScreen(me, { ...flow, step: 'shipQty', shipAt: at + 1 }, uz, fresh);
    }
    return this.shipScreen(me, { ...flow, step: 'shipInfo' }, uz, fresh);
  }

  private shipConfirmScreen(me: Me, flow: Flow, uz: boolean, fresh: boolean): Screen {
    const label = (ru: string, uzs: string) => (uz ? uzs : ru);
    const going = (flow.shipLines ?? []).filter((l) => Number(l.qty ?? 0) > 0);
    const lines = [
      `${label('Заказ', 'Buyurtma')}: <b>${escape(flow.orderNumber ?? '')}</b>`,
      `${label('Уедет', 'Ketadi')}:`,
      ...going.map(
        (l) =>
          `  • ${escape(l.itemName)} — <b>${qtyText(l.qty!, l.unit)}</b>` +
          (l.batch ? `, ${label('партия', 'partiya')} ${escape(l.batch)}` : ''),
      ),
      ...(flow.vehicle ? [`${label('Машина', 'Mashina')}: ${escape(flow.vehicle)}`] : []),
      ...(flow.driver ? [`${label('Водитель', 'Haydovchi')}: ${escape(flow.driver)}`] : []),
    ];
    const keyboard: InlineKeyboard = [];
    if (going.length > 0) {
      keyboard.push([
        { text: uz ? '🚚 Jo‘natish' : '🚚 Отгрузить', data: CB.salShipGo, style: GREEN },
      ]);
    }
    keyboard.push(this.footer(me, { ...flow, step: 'shipConfirm' }, uz));
    const text =
      going.length === 0
        ? `${S.shipNothing(uz)}\n\n${S.shipConfirm(uz, lines)}`
        : S.shipConfirm(uz, lines);
    return { text, keyboard, fresh, flow: { ...flow, step: 'shipConfirm' } };
  }

  private async shipSave(me: Me, flow: Flow, uz: boolean): Promise<Screen> {
    const going = (flow.shipLines ?? []).filter((l) => Number(l.qty ?? 0) > 0);
    if (going.length === 0) return this.card(me, flow.orderUid!, uz, S.shipNothing(uz), null);
    try {
      const out = await this.as(me, uz, () =>
        this.write.createShipment(
          {
            orderUid: flow.orderUid!,
            ...(flow.vehicle ? { vehicle: flow.vehicle } : {}),
            ...(flow.driver ? { driver: flow.driver } : {}),
            lines: going.map((l) => ({
              lineUid: l.lineUid,
              qty: l.qty!,
              ...(l.batch ? { batchNumber: l.batch } : {}),
            })),
          },
          flow.key,
        ),
      );
      return this.card(
        me,
        flow.orderUid!,
        uz,
        S.shipped(uz, escape(out.number), escape(out.orderNumber)),
        null,
      );
    } catch (e) {
      return this.refusal(me, uz, e);
    }
  }

  // --- справочники ----------------------------------------------------------

  /**
   * Клиенты компании. Поиск по названию: список у менеджера длинный.
   *
   * Язык здесь не важен — справочник отдаёт оба названия сразу, и выбирает из
   * них уже экран.
   */
  private async partners(me: Me, flow: Flow, query?: string) {
    const refs = await this.as(me, false, () => this.write.refs());
    const term = query?.toLowerCase();
    return refs.partners
      .filter((p) => p.companyUid === flow.companyUid)
      .filter((p) => !term || p.nameRu.toLowerCase().includes(term) || (p.inn ?? '').includes(term))
      .slice(0, PICK_LIMIT)
      .map((p) => ({ uid: p.uid, name: p.nameRu, delay: p.paymentDelayDays }));
  }

  /**
   * Номенклатура: сначала то, что продавали последним.
   *
   * Менеджер возит одно и то же одним и тем же клиентам, и список «последних»
   * экономит ему набор названия на каждом заказе.
   */
  private async items(me: Me, flow: Flow, query?: string) {
    const like = query ? `%${query}%` : null;
    const rows = await this.prisma.withContext(
      me.userId,
      me.companyIds,
      (tx) =>
        tx.$queryRaw<{ code: string; name_ru: string; unit: string }[]>`
        SELECT i.code, i.name_ru, u.code AS unit
          FROM item i
          JOIN company co ON co.id = i.company_id
          JOIN unit u ON u.id = i.base_unit_id
          LEFT JOIN sales_order_line l ON l.item_id = i.id
          LEFT JOIN sales_order o ON o.id = l.sales_order_id
         WHERE co.uid = ${flow.companyUid ?? null}::uuid
           AND i.is_active
           AND i.item_type::text IN ('goods', 'finished')
           AND (${like}::text IS NULL OR i.name_ru ILIKE ${like} OR i.code ILIKE ${like})
         GROUP BY i.code, i.name_ru, u.code
         ORDER BY max(o.order_date) DESC NULLS LAST, i.name_ru
         LIMIT ${PICK_LIMIT}`,
    );
    return rows.map((r) => ({ code: r.code, name: r.name_ru, unit: r.unit }));
  }

  /** Отказ службы продаж — человеку её словами: они уже написаны для людей. */
  private refusal(me: Me, uz: boolean, e: unknown): Screen {
    const message = String((e as { message?: string }).message ?? e);
    this.log.warn(`продажи в боте: ${message}`);
    const home = this.home(me, uz);
    return {
      ...home,
      text: `${S.refused(uz, escape(message))}\n\n${home.text}`,
      flow: null,
    };
  }
}
