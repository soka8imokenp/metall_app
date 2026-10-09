import { Injectable, Logger } from '@nestjs/common';
import { ProductionOrdersService } from '../production/orders.service.js';
import { ProductionWriteService, type ProductionStatusName } from '../production/write.service.js';
import { ProductionStagesService } from '../production/stages.service.js';
import { ProductionOutputsService } from '../production/outputs.service.js';
import { ProductionService } from '../production/production.service.js';
import { ProductionControlService } from '../production/control.service.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import {
  asUser,
  escape,
  qtyText,
  type Incoming,
  type Me,
  type Screen,
  type SectionFlow,
} from './section.js';
import { showDay } from './format.js';
import { DEVIATION, MARK, P, STAGE, STATE, STATUS, type ProdStatus } from './production.texts.js';
import { BLUE, CB, GREEN, RED } from './menu.js';
import type { InlineButton, InlineKeyboard } from './telegram.api.js';

/**
 * Раздел «Производство» в боте (ТЗ 11.4).
 *
 * Последний раздел, который оставался заглушкой: до восьмого захода в модуле
 * нечего было показывать и нечего нажимать. Теперь в нём есть всё, что цех
 * делает руками, — и бот даёт ровно это, а не второй экран системы в телефоне.
 *
 * Что здесь есть и почему именно это:
 *
 * - **мои задания** — этап, к которому человек встал, и отметки «начал, пауза,
 *   закончил». Это единственная работа, которую в цеху делают с телефона: до
 *   компьютера от стана идти через весь пролёт;
 * - **выпуск и брак** — то, что цех записывает по ходу смены. Выпуск кладёт
 *   продукцию на склад настоящим приходом, поэтому экран проверки говорит об
 *   этом словами: отменить такую запись производство не может;
 * - **заказы цеха** — список и карточка: как идёт, сколько осталось, почему
 *   стоит. Руководитель смотрит это чаще, чем нажимает;
 * - **запуск, пауза и выпуск заказа** — по праву `production.manage`, с
 *   причиной там, где её требует служба;
 * - **что в цеху сейчас** и **отклонения** — две сводки, за которыми идут в
 *   систему: загрузка участков и из-за чего встали.
 *
 * Чего в разделе нет сознательно: заведения заказа, правки техкарт, календаря
 * и переделки. Это планирование — его делают, сидя за столом, с номенклатурой
 * и нормами перед глазами, а не на ходу в цеху. Фото к выпуску тоже нет:
 * класть снимок в модуле некуда, а обещать поле, которого в базе не
 * существует, нельзя.
 *
 * Правил производства здесь ни одного: порядок статусов, обязательность
 * причины, проверки «все ли этапы закрыты» живут в службах модуля, и бот
 * зовёт те же методы, что экран в браузере.
 */

/** Незаконченный разговор раздела. */
interface Flow extends SectionFlow {
  kind: 'prod';
  step:
    | 'search'
    | 'reason'
    | 'outQty'
    | 'outWarehouse'
    | 'outLocation'
    | 'outConfirm'
    | 'defQty'
    | 'defReason'
    | 'defConfirm'
    | 'photo';
  /** Заказ, о котором идёт разговор. */
  uid?: string;
  number?: string;
  /** Задание, к которому ждём снимок, и чем оно названо на экране ожидания. */
  photoFor?: string;
  photoWhat?: string;
  /** Статус, в который переводят заказ: ждёт причину. */
  to?: ProductionStatusName;
  /** Выпуск: сколько, куда и по какой причине (у брака). */
  qty?: string;
  unit?: string;
  warehouseCode?: string;
  warehouseName?: string;
  locationCode?: string;
  reasonUid?: string;
  reasonName?: string;
}

/** Буква статуса в кнопке: вместе с uuid полное имя в 64 знака не влезает. */
const CODE: Record<ProductionStatusName, string> = {
  draft: 'd',
  planned: 'p',
  in_progress: 'r',
  paused: 's',
  produced: 'v',
  closed: 'z',
  cancelled: 'x',
};
const STATUS_BY_CODE: Record<string, ProductionStatusName> = Object.fromEntries(
  Object.entries(CODE).map(([name, code]) => [code, name as ProductionStatusName]),
);

/** Сколько строк показываем: больше на телефоне не читается. */
const LIST_LIMIT = 8;
/**
 * Заданий показываем меньше: у каждого две строки с длинным названием трубы, и
 * восемь таких не влезают в подпись панели — Telegram режет её на 1024 знаках
 * молча. Поймано прогоном на данных стенда.
 */
const MINE_LIMIT = 5;
/** Названия труб длинные: в строку списка берём начало, остальное — в карточке. */
const NAME_LIMIT = 44;
const short = (name: string): string =>
  name.length > NAME_LIMIT ? `${name.slice(0, NAME_LIMIT - 1)}…` : name;
/** Причина короче этого ничего не объясняет. */
const REASON_MIN = 5;

@Injectable()
export class BotProduction {
  private readonly log = new Logger('bot/production');

  constructor(
    private readonly orders: ProductionOrdersService,
    private readonly write: ProductionWriteService,
    private readonly stages: ProductionStagesService,
    private readonly outputs: ProductionOutputsService,
    private readonly production: ProductionService,
    private readonly control: ProductionControlService,
    private readonly attachments: AttachmentsService,
  ) {}

  private as<T>(me: Me, uz: boolean, fn: () => Promise<T>): Promise<T> {
    return asUser(me, uz, fn);
  }

  // --- разбор нажатий -------------------------------------------------------

  async route(me: Me, any: SectionFlow | null, data: string, uz: boolean): Promise<Screen> {
    const flow = any?.kind === 'prod' ? (any as Flow) : null;

    if (data === CB.prod) return { ...this.home(uz), flow: null };
    if (data === CB.prodCancel) {
      if (flow?.uid) return this.card(me, flow.uid, uz, P.cancelled(uz), null);
      return { ...this.home(uz), toast: P.cancelled(uz), flow: null };
    }
    if (data === CB.prodSearch) {
      return {
        text: P.askSearch(uz),
        keyboard: [this.row(uz)],
        flow: { kind: 'prod', step: 'search' } satisfies Flow,
      };
    }
    if (data === CB.prodMine) return this.mine(me, uz);
    if (data === CB.prodShop) return this.shop(me, uz);
    if (data === CB.prodDeviations) return this.deviations(me, uz);
    if (data.startsWith('p:s:')) return this.list(me, data.slice(4), undefined, uz);
    if (data.startsWith('p:c:')) return this.card(me, data.slice(4), uz, undefined, null);
    if (data.startsWith('p:g:')) return this.stageList(me, data.slice(4), uz);
    if (data.startsWith('p:t:')) return this.stageCard(me, data.slice(4), uz);
    if (data.startsWith('p:k:')) return this.mark(me, data.slice(4), uz);
    if (data.startsWith('p:q:')) return this.ask(me, data.slice(4), uz);
    if (data.startsWith('p:y:')) return this.apply(me, data.slice(4), uz);
    if (data.startsWith('p:o:')) return this.outBegin(me, data.slice(4), 'good', uz);
    if (data.startsWith('p:b:')) return this.outBegin(me, data.slice(4), 'defect', uz);
    // Раньше выбора из списка: у `p:p:` после `p:p` стоит двоеточие, здесь `h`,
    // и порядок тут не для разбора, а чтобы рядом читались две похожие строки.
    if (data.startsWith('p:ph:')) return this.photoBegin(me, data.slice(5), uz);
    if (data.startsWith('p:p:')) return this.pick(me, flow, data.slice(4), uz);
    if (data === CB.prodSave) return this.outSave(me, flow, uz);
    if (data === CB.prodExplain) return this.explain(flow, uz);
    if (data === CB.prodConfirm) return this.backToConfirm(me, flow, uz);

    return { ...this.home(uz), toast: P.stale(uz) };
  }

  /** Ответ текстом: поиск, причина остановки и количество в выпуске. */
  async text(me: Me, any: SectionFlow, raw: string, uz: boolean): Promise<Screen> {
    const flow = any.kind === 'prod' ? (any as Flow) : null;
    const typed = raw.trim();
    if (!flow) return { ...this.home(uz), toast: P.stale(uz), flow: null };

    if (flow.step === 'search') return this.list(me, 'all', typed, uz);

    // Снимка ждём снимком: текст в этом месте значит, что человек не понял
    // экран, и отвечать ему «устарело» было бы неправдой — разговор идёт.
    if (flow.step === 'photo') {
      return {
        text: `${P.photoWait(uz)}\n\n${P.askPhoto(uz, escape(flow.photoWhat ?? ''))}`,
        keyboard: [
          [
            {
              text: uz ? '⬅️ Topshiriqqa' : '⬅️ К заданию',
              data: CB.prodOrder(flow.photoFor ?? ''),
              style: BLUE,
            },
          ],
          [{ text: uz ? '❌ Bekor qilish' : '❌ Отменить', data: CB.prodCancel, style: RED }],
        ],
        fresh: true,
        flow,
      };
    }

    if (flow.step === 'reason') {
      if (!flow.uid || !flow.to) return { ...this.home(uz), toast: P.stale(uz), flow: null };
      if (typed.length < REASON_MIN) {
        return {
          text: `${P.shortReason(uz)}\n\n${P.askReason(uz, escape(flow.number ?? ''), flow.to)}`,
          keyboard: [this.backRow(flow.uid, uz)],
          fresh: true,
          flow,
        };
      }
      return this.setStatus(me, flow.uid, flow.to, uz, typed.slice(0, 500));
    }

    if (flow.step === 'outQty' || flow.step === 'defQty') {
      const qty = parseQty(typed);
      if (!qty) {
        return {
          text: P.badQty(uz),
          keyboard: [this.backRow(flow.uid ?? '', uz)],
          fresh: true,
          flow,
        };
      }
      return flow.step === 'outQty'
        ? this.askWarehouse(me, { ...flow, qty }, uz)
        : this.askDefectReason(me, { ...flow, qty }, uz);
    }

    return { ...this.home(uz), toast: P.stale(uz), flow: null };
  }

  // --- экраны ---------------------------------------------------------------

  home(uz: boolean): Screen {
    return {
      text: P.home(uz),
      keyboard: [
        [
          { text: `🧰 ${uz ? 'Topshiriqlarim' : 'Мои задания'}`, data: CB.prodMine, style: BLUE },
          { text: `🏭 ${uz ? 'Sexda nima bor' : 'Что в цеху'}`, data: CB.prodShop, style: BLUE },
        ],
        [this.stateButton('active', uz), this.stateButton('planned', uz)],
        [this.stateButton('done', uz), this.stateButton('all', uz)],
        [
          { text: `🔍 ${uz ? 'Buyurtmani topish' : 'Найти заказ'}`, data: CB.prodSearch, style: BLUE },
          { text: `⚠️ ${uz ? 'Chetlanishlar' : 'Отклонения'}`, data: CB.prodDeviations, style: BLUE },
        ],
        [{ text: uz ? '⬅️ Menyu' : '⬅️ Меню', data: CB.menu, style: BLUE }],
      ],
    };
  }

  private stateButton(key: string, uz: boolean): InlineButton {
    const state = STATE.find((s) => s.key === key)!;
    return {
      text: `${state.mark} ${uz ? state.uz : state.ru}`,
      data: CB.prodState(key),
      style: BLUE,
    };
  }

  private row(uz: boolean): InlineButton[] {
    return [
      { text: `⬅️ ${uz ? 'Ishlab chiqarish' : 'Производство'}`, data: CB.prod, style: BLUE },
      { text: uz ? '⬅️ Menyu' : '⬅️ Меню', data: CB.menu, style: BLUE },
    ];
  }

  private backRow(uid: string, uz: boolean): InlineButton[] {
    return [
      {
        text: uz ? '⬅️ Buyurtmaga' : '⬅️ К заказу',
        data: uid ? CB.prodOrder(uid) : CB.prod,
        style: BLUE,
      },
      { text: uz ? '❌ Bekor qilish' : '❌ Отменить', data: CB.prodCancel, style: RED },
    ];
  }

  /** Список заказов цеха: состояние выбирают кнопкой, поиск — словом. */
  private async list(
    me: Me,
    key: string,
    search: string | undefined,
    uz: boolean,
  ): Promise<Screen> {
    const state = STATE.find((s) => s.key === key) ?? STATE.find((s) => s.key === 'all')!;
    const page = await this.as(me, uz, () =>
      this.orders.list(state.key as 'all' | 'active' | 'planned' | 'done', search, LIST_LIMIT),
    );
    if (page.rows.length === 0 && search) {
      return {
        text: `${P.searchEmpty(uz, escape(search))}\n\n${P.askSearch(uz)}`,
        keyboard: [this.row(uz)],
        fresh: true,
        flow: { kind: 'prod', step: 'search' } satisfies Flow,
      };
    }

    const title = search
      ? `<b>🔍 ${escape(search)}</b>`
      : `<b>${state.mark} ${uz ? state.uz : state.ru}</b>`;
    const lines = page.rows.map((r) => {
      const st = STATUS[r.status as ProdStatus];
      return (
        `${st?.mark ?? '•'} <b>${escape(r.number)}</b> · ` +
        `${escape(short(uz ? r.itemNameUz : r.itemNameRu))}\n` +
        `  ${qtyText(r.qtyProduced, r.unit)} ${uz ? 'dan' : 'из'} ${qtyText(r.qtyPlanned, r.unit)} · ` +
        `${uz ? 'muddat' : 'срок'} ${day(r.dueDate)} · ${st ? (uz ? st.uz : st.ru) : r.status}`
      );
    });
    const keyboard: InlineKeyboard = page.rows.map((r) => [
      {
        text: `${STATUS[r.status as ProdStatus]?.mark ?? '•'} ${r.number} · ${
          uz ? r.itemNameUz : r.itemNameRu
        }`.slice(0, 60),
        data: CB.prodOrder(r.uid),
        style: BLUE,
      },
    ]);
    // Сколько всего таких заказов: список обрезан, и это надо сказать.
    const tail =
      page.total > page.rows.length
        ? `\n\n<i>${uz ? 'Jami' : 'Всего'}: ${page.total}. ${
            uz ? 'Ro‘yxatda birinchi' : 'В списке первые'
          } ${page.rows.length}.</i>`
        : '';
    keyboard.push(this.row(uz));
    return {
      text: P.list(uz, title, lines) + tail,
      keyboard,
      fresh: Boolean(search),
      flow: search ? null : undefined,
    };
  }

  /** Карточка заказа: как идёт, что сделано и что с ним можно сделать. */
  private async card(
    me: Me,
    uid: string,
    uz: boolean,
    note?: string,
    flow: null | undefined = undefined,
  ): Promise<Screen> {
    let o: Awaited<ReturnType<ProductionOrdersService['one']>>;
    try {
      o = await this.as(me, uz, () => this.orders.one(uid));
    } catch (e) {
      return this.refusal(uz, e);
    }

    const label = (r: string, u: string) => (uz ? u : r);
    const st = STATUS[o.status as ProdStatus];
    const lines = [
      `<b>${escape(o.number)}</b> · ${st?.mark ?? '•'} ${escape(
        st ? (uz ? st.uz : st.ru) : o.status,
      )}`,
      `${label('Продукция', 'Mahsulot')}: ${escape(uz ? o.itemNameUz : o.itemNameRu)}`,
      `${label('План', 'Reja')}: <b>${qtyText(o.qtyPlanned, o.unit)}</b>`,
      `${label('Принято годного', 'Qabul qilingan yaroqli')}: ${qtyText(o.qtyProduced, o.unit)}` +
        (o.qtyPercent !== null ? ` (${o.qtyPercent}%)` : ''),
      ...(Number(o.qtyDefect) > 0
        ? [`${label('Брак', 'Brak')}: ${qtyText(o.qtyDefect, o.unit)}`]
        : []),
      `${label('Срок', 'Muddat')}: ${day(o.dueDate)}${this.dueTail(o, uz)}`,
      ...(o.responsibleName
        ? [`${label('Ответственный', 'Mas’ul')}: ${escape(o.responsibleName)}`]
        : []),
      ...(o.salesOrderNumber
        ? [
            `${label('Под заказ продажи', 'Sotuv buyurtmasi ostida')}: ${escape(
              o.salesOrderNumber,
            )}` +
              (o.salesPartnerRu
                ? ` (${escape(uz ? (o.salesPartnerUz ?? '') : o.salesPartnerRu)})`
                : ''),
          ]
        : []),
      `${label('Компания', 'Kompaniya')}: ${escape(uz ? o.enterpriseNameUz : o.enterpriseNameRu)}`,
    ];

    // Сколько снимков уже приложено. Отказ здесь карточку не рушит: файлы —
    // приложение к заданию, а не оно само, и «не смог посчитать» не причина
    // не показать цех человеку, который открыл заказ.
    try {
      const files = (await this.as(me, uz, () => this.attachments.list('production_order', uid)))
        .length;
      if (files > 0) lines.push(P.photoLine(uz, files));
    } catch {
      /* молча: карточка важнее счётчика файлов */
    }

    const blocks: string[] = [];
    if (o.stages.length > 0) {
      const done = o.stages.filter((s) => s.status === 'done').length;
      const now = o.stages.find((s) => s.status === 'running' || s.status === 'paused');
      blocks.push(
        '',
        `<b>${label('Этапы', 'Bosqichlar')}: ${done} ${label('из', '/')} ${o.stages.length}</b>` +
          (now
            ? `\n${STAGE[now.status]?.mark ?? '•'} ${escape(uz ? now.nameUz : now.nameRu)} — ${
                uz ? STAGE[now.status]?.uz : STAGE[now.status]?.ru
              }`
            : ''),
      );
    }
    const over = o.materials.filter((m) => Number(m.deviationQty) > 0);
    if (over.length > 0) {
      blocks.push(
        '',
        `<b>${label('Перерасход материала', 'Ortiqcha material sarfi')}</b>\n` +
          over
            .map(
              (m) =>
                `• ${escape(uz ? m.itemNameUz : m.itemNameRu)}: +${qtyText(m.deviationQty, m.unit)}`,
            )
            .join('\n'),
      );
    }
    if (o.cost) {
      blocks.push(
        '',
        `<b>${label('Себестоимость', 'Tannarx')}</b>\n` +
          `• ${label('Всего', 'Jami')}: ${money(o.cost.totalCost, uz)}\n` +
          `• ${label('За единицу', 'Birlik uchun')}: ${money(o.cost.unitCost, uz)}`,
      );
    }

    const keyboard: InlineKeyboard = [];
    if (this.mayManage(me)) {
      for (const to of o.nextStatuses) {
        const s = STATUS[to as ProdStatus];
        keyboard.push([
          {
            text: `${s.mark} ${this.verb(to as ProdStatus, uz)}`,
            data: CB.prodAsk(CODE[to as ProductionStatusName], uid),
            style: to === 'cancelled' || to === 'paused' ? RED : BLUE,
          },
        ]);
      }
      // Выпуск и брак записывают по идущей работе — так же, как в системе.
      if (o.status === 'in_progress' || o.status === 'paused') {
        keyboard.push([
          { text: `📦 ${uz ? 'Chiqarishni yozish' : 'Записать выпуск'}`, data: CB.prodOut(uid), style: GREEN },
          { text: `🔻 ${uz ? 'Brak' : 'Брак'}`, data: CB.prodDefect(uid), style: RED },
        ]);
      }
    }
    if (o.stages.length > 0) {
      keyboard.push([
        { text: `🔧 ${uz ? 'Bosqichlar' : 'Этапы'}`, data: CB.prodStages(uid), style: BLUE },
      ]);
    }
    // Снимок прикладывает тот, кто ведёт задание: кнопка стоит по тому же
    // праву, которым служба вложений её и проверит, иначе кнопка обещала бы
    // то, чего нажатие не сделает.
    if (this.mayManage(me)) {
      keyboard.push([
        {
          text: `📷 ${uz ? 'Rasm biriktirish' : 'Приложить фото'}`,
          data: CB.prodPhoto(uid),
          style: BLUE,
        },
      ]);
    }
    keyboard.push(this.row(uz));

    const help =
      `<i>${escape(st ? (uz ? st.helpUz : st.helpRu) : '')}</i>` +
      (keyboard.length === 1 ? `\n${P.nothingToDo(uz)}` : '');
    const why = o.statusReason ? P.why(uz, escape(o.statusReason)) : null;
    const text = P.card(uz, lines, blocks, help, why);
    return { text: note ? `${note}\n\n${text}` : text, keyboard, fresh: Boolean(note), flow };
  }

  /** «До срока N рабочих дней» — та же цифра, что в карточке на экране. */
  private dueTail(
    o: Awaited<ReturnType<ProductionOrdersService['one']>>,
    uz: boolean,
  ): string {
    if (o.workDaysOverdue !== null && o.workDaysOverdue > 0) {
      return uz
        ? ` · ${o.workDaysOverdue} ish kuni kechikish`
        : ` · просрочка ${o.workDaysOverdue} раб. дн.`;
    }
    if (o.workDaysLeft !== null && o.workDaysLeft > 0) {
      return uz ? ` · ${o.workDaysLeft} ish kuni qoldi` : ` · осталось ${o.workDaysLeft} раб. дн.`;
    }
    return '';
  }

  /** Подпись кнопки перехода: глаголом, а не названием статуса. */
  private verb(to: ProdStatus, uz: boolean): string {
    const words: Record<ProdStatus, { ru: string; uz: string }> = {
      draft: { ru: 'В черновик', uz: 'Qoralamaga' },
      planned: { ru: 'Запланировать', uz: 'Rejalashtirish' },
      in_progress: { ru: 'Запустить', uz: 'Ishga tushirish' },
      paused: { ru: 'Приостановить', uz: 'To‘xtatish' },
      produced: { ru: 'Выпустить', uz: 'Chiqarish' },
      closed: { ru: 'Закрыть заказ', uz: 'Buyurtmani yopish' },
      cancelled: { ru: 'Отменить заказ', uz: 'Buyurtmani bekor qilish' },
    };
    return uz ? words[to].uz : words[to].ru;
  }

  // --- переходы заказа ------------------------------------------------------

  private mayManage(me: Me): boolean {
    return me.permissions.has('production.manage');
  }

  private mayWork(me: Me): boolean {
    return me.permissions.has('production.work');
  }

  private async ask(me: Me, tail: string, uz: boolean): Promise<Screen> {
    const [code, uid] = this.split(tail);
    const to = code ? STATUS_BY_CODE[code] : undefined;
    if (!to || !uid) return { ...this.home(uz), toast: P.stale(uz) };
    if (!this.mayManage(me)) {
      return { ...(await this.card(me, uid, uz)), toast: P.noRight(uz) };
    }

    let o: Awaited<ReturnType<ProductionOrdersService['one']>>;
    try {
      o = await this.as(me, uz, () => this.orders.one(uid));
    } catch (e) {
      return this.refusal(uz, e);
    }

    // Пауза и отмена без причины — это «встали, а почему, догадайся». Того же
    // требует служба, поэтому спрашиваем до нажатия, а не ловим отказ после.
    if (to === 'paused' || to === 'cancelled') {
      const flow: Flow = { kind: 'prod', step: 'reason', uid, number: o.number, to };
      return {
        text: P.askReason(uz, escape(o.number), to),
        keyboard: [this.backRow(uid, uz)],
        flow,
      };
    }

    return {
      text: P.ask(uz, escape(o.number), to),
      keyboard: [
        [
          { text: `✅ ${uz ? 'Ha' : 'Да'}`, data: CB.prodDo(CODE[to], uid), style: GREEN },
        ],
        [{ text: uz ? '⬅️ Orqaga' : '⬅️ Назад', data: CB.prodOrder(uid), style: BLUE }],
      ],
      flow: null,
    };
  }

  private async apply(me: Me, tail: string, uz: boolean): Promise<Screen> {
    const [code, uid] = this.split(tail);
    const to = code ? STATUS_BY_CODE[code] : undefined;
    if (!to || !uid) return { ...this.home(uz), toast: P.stale(uz) };
    if (!this.mayManage(me)) {
      return { ...(await this.card(me, uid, uz)), toast: P.noRight(uz) };
    }
    return this.setStatus(me, uid, to, uz);
  }

  private async setStatus(
    me: Me,
    uid: string,
    to: ProductionStatusName,
    uz: boolean,
    comment?: string,
  ): Promise<Screen> {
    try {
      await this.as(me, uz, () => this.write.setStatus(uid, to, comment));
    } catch (e) {
      return { ...(await this.card(me, uid, uz)), text: await this.refusalOn(me, uid, uz, e) };
    }
    const card = await this.card(me, uid, uz, undefined, null);
    return { ...card, text: `${P.statusDone(uz, '', to as ProdStatus)}\n\n${card.text}`, fresh: true };
  }

  // --- этапы ----------------------------------------------------------------

  private async stageList(me: Me, uid: string, uz: boolean): Promise<Screen> {
    let o: Awaited<ReturnType<ProductionOrdersService['one']>>;
    try {
      o = await this.as(me, uz, () => this.orders.one(uid));
    } catch (e) {
      return this.refusal(uz, e);
    }
    const lines = o.stages.map((s) => {
      const state = STAGE[s.status];
      return (
        `${state?.mark ?? '•'} <b>${s.seq}. ${escape(uz ? s.nameUz : s.nameRu)}</b> — ${
          uz ? state?.uz : state?.ru
        }\n` +
        `  ${s.workCenterCode ? escape(s.workCenterCode) + ' · ' : ''}` +
        `${uz ? 'norma' : 'норма'} ${s.plannedDurationMin} ${uz ? 'daq' : 'мин'}` +
        (s.actualDurationMin > 0
          ? ` · ${uz ? 'fakt' : 'факт'} ${s.actualDurationMin} ${uz ? 'daq' : 'мин'}`
          : '')
      );
    });
    const keyboard: InlineKeyboard = o.stages
      .filter((s) => s.status !== 'done')
      .slice(0, LIST_LIMIT)
      .map((s) => [
        {
          text: `${STAGE[s.status]?.mark ?? '•'} ${s.seq}. ${uz ? s.nameUz : s.nameRu}`.slice(0, 60),
          data: CB.prodStage(uid, s.seq),
          style: BLUE,
        },
      ]);
    keyboard.push([this.toOrder(uid, uz), ...this.row(uz).slice(1)]);
    return { text: P.stages(uz, escape(o.number), lines), keyboard, flow: null };
  }

  private toOrder(uid: string, uz: boolean): InlineButton {
    return { text: uz ? '⬅️ Buyurtmaga' : '⬅️ К заказу', data: CB.prodOrder(uid), style: BLUE };
  }

  /** Экран одного этапа: что с ним сейчас и что можно отметить. */
  private async stageCard(me: Me, tail: string, uz: boolean, note?: string): Promise<Screen> {
    const [uid, seqRaw] = this.split(tail);
    const seq = Number(seqRaw);
    if (!uid || !Number.isFinite(seq)) return { ...this.home(uz), toast: P.stale(uz) };

    let o: Awaited<ReturnType<ProductionOrdersService['one']>>;
    try {
      o = await this.as(me, uz, () => this.orders.one(uid));
    } catch (e) {
      return this.refusal(uz, e);
    }
    const stage = o.stages.find((s) => s.seq === seq);
    if (!stage) return { ...this.home(uz), toast: P.stale(uz) };

    const label = (r: string, u: string) => (uz ? u : r);
    const lines = [
      `<b>${escape(o.number)} · ${stage.seq}. ${escape(uz ? stage.nameUz : stage.nameRu)}</b>`,
      `${label('Состояние', 'Holati')}: ${STAGE[stage.status]?.mark ?? ''} ${
        uz ? STAGE[stage.status]?.uz : STAGE[stage.status]?.ru
      }`,
      ...(stage.workCenterCode
        ? [
            `${label('Участок', 'Uchastka')}: ${escape(stage.workCenterCode)} · ${escape(
              uz ? (stage.workCenterNameUz ?? '') : (stage.workCenterNameRu ?? ''),
            )}`,
          ]
        : []),
      `${label('Норма', 'Norma')}: ${stage.plannedDurationMin} ${label('мин', 'daq')}`,
      ...(stage.actualDurationMin > 0
        ? [`${label('Отработано', 'Ishlangan')}: ${stage.actualDurationMin} ${label('мин', 'daq')}`]
        : []),
      ...(stage.pauseReasonRu
        ? [
            `${label('Причина паузы', 'Pauza sababi')}: ${escape(
              uz ? (stage.pauseReasonUz ?? '') : stage.pauseReasonRu,
            )}`,
          ]
        : []),
    ];

    const keyboard: InlineKeyboard = [];
    if (this.mayWork(me) && o.status === 'in_progress') {
      for (const kind of allowedMarks(stage.status)) {
        keyboard.push([
          {
            text: `${MARK[kind].mark} ${uz ? MARK[kind].uz : MARK[kind].ru}`,
            data: CB.prodMark(uid, stage.seq, kind[0]),
            style: kind === 'pause' ? RED : GREEN,
          },
        ]);
      }
    }
    keyboard.push([{ text: uz ? '⬅️ Bosqichlar' : '⬅️ Этапы', data: CB.prodStages(uid), style: BLUE }]);
    keyboard.push([this.toOrder(uid, uz), ...this.row(uz).slice(1)]);

    const text = P.stage(uz, lines, P.stageHelp(uz, stage.status));
    return { text: note ? `${note}\n\n${text}` : text, keyboard, fresh: Boolean(note), flow: null };
  }

  /** Отметка по этапу. Пауза спрашивает причину кнопками: их список конечный. */
  private async mark(me: Me, tail: string, uz: boolean): Promise<Screen> {
    const parts = tail.split(':');
    const uid = parts[0] ?? '';
    const seq = Number(parts[1]);
    const letter = parts[2] ?? '';
    const kind = MARK_BY_LETTER[letter];
    if (!uid || !Number.isFinite(seq) || !kind) return { ...this.home(uz), toast: P.stale(uz) };
    if (!this.mayWork(me)) {
      return { ...(await this.stageCard(me, `${uid}:${seq}`, uz)), toast: P.noRight(uz) };
    }

    if (kind === 'pause' && parts.length === 3) {
      // Причина — из справочника простоев, тем же списком, что на экране.
      const options = await this.as(me, uz, () => this.write.options());
      const o = await this.as(me, uz, () => this.orders.one(uid));
      const stage = o.stages.find((s) => s.seq === seq);
      const keyboard: InlineKeyboard = options.downtimeReasons
        .slice(0, LIST_LIMIT)
        .map((r) => [
          {
            text: (uz ? r.nameUz : r.nameRu).slice(0, 60),
            data: `p:k:${uid}:${seq}:p:${r.uid}`,
            style: BLUE,
          },
        ]);
      keyboard.push([
        { text: uz ? '⬅️ Bosqichga' : '⬅️ К этапу', data: CB.prodStage(uid, seq), style: BLUE },
      ]);
      return {
        text: P.askPauseReason(
          uz,
          escape(`${o.number} · ${seq}. ${uz ? (stage?.nameUz ?? '') : (stage?.nameRu ?? '')}`),
        ),
        keyboard,
        flow: null,
      };
    }

    try {
      await this.as(me, uz, () =>
        this.stages.mark(uid, seq, kind, parts[3] ? { reasonUid: parts[3] } : {}),
      );
    } catch (e) {
      const card = await this.stageCard(me, `${uid}:${seq}`, uz);
      return { ...card, text: `${P.refused(uz, escape(message(e)))}\n\n${card.text}`, fresh: true };
    }
    return this.stageCard(me, `${uid}:${seq}`, uz, P.marked(uz, kind));
  }

  /** «Мои задания»: этапы, за которые человек отвечает. */
  private async mine(me: Me, uz: boolean): Promise<Screen> {
    const { rows } = await this.as(me, uz, () => this.stages.mine(MINE_LIMIT));
    const lines = rows.map((r) => {
      const state = STAGE[r.status];
      return (
        `${state?.mark ?? '•'} <b>${escape(r.orderNumber)}</b> · ${escape(
          short(uz ? r.itemNameUz : r.itemNameRu),
        )}\n` +
        `  ${r.seq}. ${escape(uz ? r.nameUz : r.nameRu)} — ${uz ? state?.uz : state?.ru} · ` +
        `${uz ? 'muddat' : 'срок'} ${day(r.dueDate)}`
      );
    });
    const keyboard: InlineKeyboard = rows.map((r) => [
      {
        text: `${STAGE[r.status]?.mark ?? '•'} ${r.orderNumber} · ${r.seq}. ${
          uz ? r.nameUz : r.nameRu
        }`.slice(0, 60),
        data: CB.prodStage(r.orderUid, r.seq),
        style: BLUE,
      },
    ]);
    keyboard.push(this.row(uz));
    return { text: P.mine(uz, lines), keyboard, flow: null };
  }

  // --- выпуск и брак --------------------------------------------------------

  private async outBegin(
    me: Me,
    uid: string,
    kind: 'good' | 'defect',
    uz: boolean,
  ): Promise<Screen> {
    if (!this.mayManage(me)) {
      return { ...(await this.card(me, uid, uz)), toast: P.noRight(uz) };
    }
    let o: Awaited<ReturnType<ProductionOrdersService['one']>>;
    try {
      o = await this.as(me, uz, () => this.orders.one(uid));
    } catch (e) {
      return this.refusal(uz, e);
    }
    const flow: Flow = {
      kind: 'prod',
      step: kind === 'good' ? 'outQty' : 'defQty',
      uid,
      number: o.number,
      unit: o.unit,
    };
    return {
      text:
        kind === 'good'
          ? P.outStart(
              uz,
              escape(o.number),
              qtyText(o.qtyPlanned, o.unit),
              qtyText(o.qtyProduced, o.unit),
            )
          : P.defStart(uz, escape(o.number)),
      keyboard: [this.backRow(uid, uz)],
      flow,
    };
  }

  /** Куда кладём продукцию: склады компании кнопками. */
  private async askWarehouse(me: Me, flow: Flow, uz: boolean): Promise<Screen> {
    const options = await this.as(me, uz, () => this.write.options());
    const keyboard: InlineKeyboard = options.warehouses.map((w) => [
      { text: (uz ? w.nameUz : w.nameRu).slice(0, 60), data: CB.prodPick(w.code), style: BLUE },
    ]);
    keyboard.push(this.backRow(flow.uid ?? '', uz));
    return {
      text: P.askWarehouse(uz),
      keyboard,
      fresh: true,
      flow: { ...flow, step: 'outWarehouse' },
    };
  }

  private async askDefectReason(me: Me, flow: Flow, uz: boolean): Promise<Screen> {
    const options = await this.as(me, uz, () => this.write.options());
    const keyboard: InlineKeyboard = options.defectReasons
      .slice(0, LIST_LIMIT)
      .map((r) => [
        { text: (uz ? r.nameUz : r.nameRu).slice(0, 60), data: CB.prodPick(r.uid), style: BLUE },
      ]);
    keyboard.push(this.backRow(flow.uid ?? '', uz));
    return {
      text: P.askDefectReason(uz),
      keyboard,
      fresh: true,
      flow: { ...flow, step: 'defReason' },
    };
  }

  /** Выбор кнопкой: склад, ячейка или причина — смотря на каком шаге стоим. */
  private async pick(me: Me, flow: Flow | null, value: string, uz: boolean): Promise<Screen> {
    if (!flow?.uid) return { ...this.home(uz), toast: P.stale(uz), flow: null };
    const options = await this.as(me, uz, () => this.write.options());

    if (flow.step === 'outWarehouse') {
      const w = options.warehouses.find((x) => x.code === value);
      if (!w) return { ...this.home(uz), toast: P.stale(uz), flow: null };
      const bins = w.locations;
      const next: Flow = {
        ...flow,
        warehouseCode: w.code,
        warehouseName: uz ? w.nameUz : w.nameRu,
      };
      if (bins.length === 0) return this.outCheck(me, next, uz);
      const keyboard: InlineKeyboard = bins
        .slice(0, LIST_LIMIT)
        .map((code) => [{ text: code, data: CB.prodPick(code), style: BLUE }]);
      keyboard.push(this.backRow(flow.uid, uz));
      return {
        text: P.askLocation(uz, escape(next.warehouseName ?? '')),
        keyboard,
        flow: { ...next, step: 'outLocation' },
      };
    }

    if (flow.step === 'outLocation') {
      return this.outCheck(me, { ...flow, locationCode: value }, uz);
    }

    if (flow.step === 'defReason') {
      const reason = options.defectReasons.find((r) => r.uid === value);
      if (!reason) return { ...this.home(uz), toast: P.stale(uz), flow: null };
      return this.outCheck(me, {
        ...flow,
        reasonUid: reason.uid,
        reasonName: uz ? reason.nameUz : reason.nameRu,
      }, uz);
    }

    return { ...this.home(uz), toast: P.stale(uz), flow: null };
  }

  /** Экран проверки: что именно сейчас запишется и чем это обернётся. */
  private outCheck(me: Me, flow: Flow, uz: boolean): Screen {
    const defect = flow.step.startsWith('def');
    const label = (r: string, u: string) => (uz ? u : r);
    const lines = [
      `${label('Заказ', 'Buyurtma')}: <b>${escape(flow.number ?? '')}</b>`,
      `${label(defect ? 'Брак' : 'Годного', defect ? 'Brak' : 'Yaroqli')}: <b>${qtyText(
        flow.qty ?? '0',
        flow.unit,
      )}</b>`,
      ...(flow.warehouseName
        ? [`${label('Склад', 'Ombor')}: ${escape(flow.warehouseName)}`]
        : []),
      ...(flow.locationCode
        ? [`${label('Ячейка', 'Yacheyka')}: ${escape(flow.locationCode)}`]
        : []),
      ...(flow.reasonName ? [`${label('Причина', 'Sabab')}: ${escape(flow.reasonName)}`] : []),
      ...(defect ? [] : [`${label('Партия', 'Partiya')}: ${escape(flow.number ?? '')}`]),
    ];
    return {
      text: defect ? P.defConfirm(uz, lines) : P.outConfirm(uz, lines),
      keyboard: [
        [{ text: `✅ ${uz ? 'Yozish' : 'Записать'}`, data: CB.prodSave, style: GREEN }],
        [
          { text: uz ? '🤔 Tushunmadim' : '🤔 Я не понял', data: CB.prodExplain, style: BLUE },
          { text: uz ? '❌ Bekor qilish' : '❌ Отменить', data: CB.prodCancel, style: RED },
        ],
      ],
      fresh: true,
      flow: { ...flow, step: defect ? 'defConfirm' : 'outConfirm' },
    };
  }

  /** «Я не понял»: то же другими словами, и ничего при этом не записывается. */
  private explain(flow: Flow | null, uz: boolean): Screen {
    if (!flow) return { ...this.home(uz), toast: P.stale(uz), flow: null };
    const defect = flow.step.startsWith('def');
    return {
      text: defect ? P.defExplain(uz) : P.outExplain(uz),
      keyboard: [
        [
          {
            text: uz ? '⬅️ Tekshirishga qaytish' : '⬅️ Вернуться к проверке',
            data: CB.prodConfirm,
            style: BLUE,
          },
        ],
        [{ text: uz ? '❌ Bekor qilish' : '❌ Отменить', data: CB.prodCancel, style: RED }],
      ],
      flow,
    };
  }

  private backToConfirm(me: Me, flow: Flow | null, uz: boolean): Screen {
    if (!flow?.uid) return { ...this.home(uz), toast: P.stale(uz), flow: null };
    return this.outCheck(me, flow, uz);
  }

  /** Запись выпуска или брака. Правила проверяет служба, бот только зовёт. */
  private async outSave(me: Me, flow: Flow | null, uz: boolean): Promise<Screen> {
    if (!flow?.uid || !flow.qty) return { ...this.home(uz), toast: P.stale(uz), flow: null };
    if (!this.mayManage(me)) {
      return { ...(await this.card(me, flow.uid, uz)), toast: P.noRight(uz), flow: null };
    }
    const defect = flow.step.startsWith('def');
    try {
      await this.as(me, uz, () =>
        this.outputs.register(flow.uid!, {
          kind: defect ? 'defect' : 'good',
          qty: flow.qty!,
          ...(flow.warehouseCode ? { warehouseCode: flow.warehouseCode } : {}),
          ...(flow.locationCode ? { locationCode: flow.locationCode } : {}),
          ...(flow.reasonUid ? { reasonUid: flow.reasonUid } : {}),
        }),
      );
    } catch (e) {
      const card = await this.card(me, flow.uid, uz, undefined, null);
      return { ...card, text: `${P.refused(uz, escape(message(e)))}\n\n${card.text}`, fresh: true };
    }
    const done = defect
      ? P.defDone(uz, qtyText(flow.qty, flow.unit), escape(flow.number ?? ''))
      : P.outDone(uz, qtyText(flow.qty, flow.unit), escape(flow.number ?? ''));
    return this.card(me, flow.uid, uz, done, null);
  }

  // --- снимок к заданию -----------------------------------------------------

  /**
   * Экран ожидания снимка (ТЗ 4.1, 4.6).
   *
   * Фото брака и замера мастер делает у стана, а не за компьютером: до него от
   * стана идти через весь пролёт, и к тому времени трубу уже увезли. Своего
   * хранилища здесь нет — снимок уходит в те же вложения, которыми живут склад
   * и документы, и в карточке задания он виден тем же списком.
   */
  private async photoBegin(me: Me, uid: string, uz: boolean): Promise<Screen> {
    if (!this.mayManage(me)) {
      return { ...(await this.card(me, uid, uz, undefined, null)), toast: P.noRight(uz) };
    }

    let what = '';
    try {
      const o = await this.as(me, uz, () => this.orders.one(uid));
      what = `${o.number} · ${uz ? o.itemNameUz : o.itemNameRu}`;
    } catch (e) {
      return this.refusal(uz, e);
    }

    const flow: Flow = { kind: 'prod', step: 'photo', uid, photoFor: uid, photoWhat: what };
    return {
      text: P.askPhoto(uz, escape(what)),
      keyboard: [
        [{ text: uz ? '⬅️ Topshiriqqa' : '⬅️ К заданию', data: CB.prodOrder(uid), style: BLUE }],
        [{ text: uz ? '❌ Bekor qilish' : '❌ Отменить', data: CB.prodCancel, style: RED }],
      ],
      fresh: true,
      flow,
    };
  }

  /** Присланный файл: кладём к заданию, которого ждёт разговор. */
  async photo(me: Me, any: SectionFlow, file: Incoming, uz: boolean): Promise<Screen> {
    const flow = any.kind === 'prod' ? (any as Flow) : null;
    if (!flow?.photoFor || flow.step !== 'photo') {
      return { ...this.home(uz), toast: P.stale(uz), flow: null };
    }
    if (!this.mayManage(me)) {
      return { ...this.home(uz), toast: P.noRight(uz), flow: null };
    }

    try {
      await this.as(me, uz, () =>
        this.attachments.add({
          owner: 'production_order',
          ownerUid: flow.photoFor!,
          fileName: file.fileName,
          mimeType: file.mimeType,
          kind: 'photo',
          bytes: file.bytes,
          comment: 'Снимок из Telegram',
        }),
      );
      const count = (
        await this.as(me, uz, () => this.attachments.list('production_order', flow.photoFor!))
      ).length;
      const card = await this.card(me, flow.photoFor, uz, P.photoSaved(uz, count), null);
      return { ...card, fresh: true, flow: null };
    } catch (e) {
      // Отказ службы — словами и на экране ожидания: человек стоит с
      // телефоном и может прислать другой файл, не открывая раздел заново.
      return {
        text: `${P.refused(uz, escape(message(e)))}\n\n${P.askPhoto(uz, escape(flow.photoWhat ?? ''))}`,
        keyboard: [
          [
            {
              text: uz ? '⬅️ Topshiriqqa' : '⬅️ К заданию',
              data: CB.prodOrder(flow.photoFor),
              style: BLUE,
            },
          ],
          [{ text: uz ? '❌ Bekor qilish' : '❌ Отменить', data: CB.prodCancel, style: RED }],
        ],
        fresh: true,
        flow,
      };
    }
  }

  // --- сводки ---------------------------------------------------------------

  /** «Что в цеху сейчас»: та же сводка, что в шапке экрана производства. */
  private async shop(me: Me, uz: boolean): Promise<Screen> {
    const data = await this.as(me, uz, () => this.production.summary('30d'));
    const label = (r: string, u: string) => (uz ? u : r);
    /**
     * Процента загрузки может не быть по двум разным причинам, и назвать не ту
     * — значит отправить человека заводить смены, которые уже заведены:
     * сводка считает мощность только когда компания одна, а у кладовщика их две.
     */
    const many = me.companies.length > 1;
    const lines = [
      `${label('Заказов в работе', 'Ishdagi buyurtmalar')}: <b>${data.orders.inProgress}</b>`,
      `${label('Запланировано', 'Rejalashtirilgan')}: ${data.orders.planned}`,
      `${label('Приостановлено', 'To‘xtatilgan')}: ${data.orders.paused}`,
      `${label('Выпущено за 30 дней', '30 kunda chiqarilgan')}: ${data.orders.produced}`,
      ...(data.orders.overdue > 0
        ? [`${label('Просрочено', 'Muddati o‘tgan')}: <b>${data.orders.overdue}</b>`]
        : []),
      ...(many
        ? [
            `${label('Компании', 'Kompaniyalar')}: ${me.companies
              .map((c) => escape(uz ? c.nameUz : c.nameRu))
              .join(', ')}`,
          ]
        : []),
      ...data.output.map(
        (o) =>
          `${label('Выпуск', 'Chiqarish')}: ${qtyText(o.good, o.unit)}` +
          (Number(o.defect) > 0
            ? ` · ${label('брак', 'brak')} ${qtyText(o.defect, o.unit)}${
                o.defectPercent !== null ? ` (${o.defectPercent}%)` : ''
              }`
            : ''),
      ),
    ];
    const centers = data.workCenters.map(
      (w) =>
        `• ${escape(uz ? w.nameUz : w.nameRu)}: ` +
        (w.loadPercent !== null
          ? `${label('загрузка', 'yuklanish')} ${w.loadPercent}%`
          : P.noLoad(uz, many)) +
        (w.downtimeMin > 0
          ? ` · ${label('простой', 'to‘xtash')} ${w.downtimeMin} ${label('мин', 'daq')}`
          : ''),
    );
    return { text: P.shop(uz, lines, centers), keyboard: [this.row(uz)], flow: null };
  }

  /** Журнал отклонений: из-за чего встали и сколько это стоило времени. */
  private async deviations(me: Me, uz: boolean): Promise<Screen> {
    const data = await this.as(me, uz, () => this.control.deviations('30d', undefined, LIST_LIMIT));
    const totals = data.totals.map(
      (t) =>
        `${DEVIATION[t.kind] ? (uz ? DEVIATION[t.kind].uz : DEVIATION[t.kind].ru) : t.kind}: ` +
        `${t.events} · ${t.minutes} ${uz ? 'daq' : 'мин'}`,
    );
    const lines = data.rows.map((r) => {
      const kind = DEVIATION[r.kind];
      return (
        `• <b>${kind ? (uz ? kind.uz : kind.ru) : r.kind}</b>` +
        (r.orderNumber ? ` · ${escape(r.orderNumber)}` : '') +
        (r.workCenterCode ? ` · ${escape(r.workCenterCode)}` : '') +
        `\n  ${escape(uz ? (r.reasonUz ?? '') : (r.reasonRu ?? '')) || (uz ? 'sababsiz' : 'без причины')}` +
        (r.durationMin > 0 ? ` · ${r.durationMin} ${uz ? 'daq' : 'мин'}` : '')
      );
    });
    return {
      text: P.deviations(uz, totals, lines),
      keyboard: [this.row(uz)],
      flow: null,
    };
  }

  // --- мелочи ---------------------------------------------------------------

  private split(tail: string): [string | undefined, string | undefined] {
    const at = tail.indexOf(':');
    if (at < 0) return [tail, undefined];
    return [tail.slice(0, at), tail.slice(at + 1)];
  }

  private refusal(uz: boolean, e: unknown): Screen {
    this.log.warn(`производство в боте: ${message(e)}`);
    const home = this.home(uz);
    return { ...home, text: `${P.refused(uz, escape(message(e)))}\n\n${home.text}`, flow: null };
  }

  private async refusalOn(me: Me, uid: string, uz: boolean, e: unknown): Promise<string> {
    this.log.warn(`производство в боте: ${message(e)}`);
    const card = await this.card(me, uid, uz, undefined, null);
    return `${P.refused(uz, escape(message(e)))}\n\n${card.text}`;
  }
}

const message = (e: unknown): string => String((e as { message?: string }).message ?? e);

/** Срок без даты — это «когда-нибудь»: прочерк честнее пустого места. */
const day = (value: string | null): string => (value ? showDay(value) : '—');

const money = (value: string, uz: boolean): string =>
  `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value))} ${
    uz ? 'so‘m' : 'сум'
  }`;

/** Буква отметки в кнопке: `s`, `p`, `r`, `f`. */
const MARK_BY_LETTER: Record<string, 'start' | 'pause' | 'resume' | 'finish'> = {
  s: 'start',
  p: 'pause',
  r: 'resume',
  f: 'finish',
};

/**
 * Что можно отметить из этого состояния. Таблица повторяет `NEXT_MARK` службы
 * не для проверки, а для кнопок: служба всё равно скажет «нельзя», но кнопка,
 * на которую всегда отвечают отказом, — это обман.
 */
function allowedMarks(status: string): ('start' | 'pause' | 'resume' | 'finish')[] {
  if (status === 'pending') return ['start'];
  if (status === 'running') return ['pause', 'finish'];
  if (status === 'paused') return ['resume'];
  return [];
}

/** Количество из сообщения: запятая вместо точки, разряды пробелами. */
export function parseQty(raw: string): string | null {
  const text = raw.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
  if (Number(text) <= 0) return null;
  return text;
}
