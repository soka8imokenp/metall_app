import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { WarehouseService } from '../warehouse/warehouse.service.js';
import { MovesService } from '../warehouse/moves.service.js';
import { WriteService } from '../warehouse/write.service.js';
import { InventoryService } from '../warehouse/inventory.service.js';
import { NeedsService } from '../warehouse/needs.service.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import {
  asUser,
  comingNext,
  escape,
  explainButton,
  homeRow,
  qtyText,
  type Incoming,
  type Me,
  type Screen,
  type SectionFlow,
  understoodButton,
} from './section.js';
import { KIND, W } from './warehouse.texts.js';
import {
  type Flow,
  MOVE_KINDS,
  type MoveKind,
  PARTNER,
  REASON_KINDS,
  SIDES,
  type Step,
  nextStep,
  order,
  parseCost,
  parseQty,
  prevStep,
} from './warehouse.flow.js';
import { BLUE, CB, GREEN, RED } from './menu.js';
import type { InlineButton, InlineKeyboard } from './telegram.api.js';

/**
 * Раздел «Склад» в боте (ТЗ 11.3, решение заказчика 02.10 — весь функционал).
 *
 * Кладовщик работает не за компьютером, а у штабеля, и бот для него — рабочее
 * место целиком: посмотреть остаток, записать приход, списать брак, переложить
 * товар, выдать в цех, пересчитать полку.
 *
 * Правила склада здесь не повторяются. Какое право нужно на списание, можно ли
 * забрать больше, чем лежит, где рождается партия, что делает пересчёт с
 * остатком — всё это в `src/warehouse`, и бот зовёт те же службы, что экран в
 * браузере. Своё у бота только одно: один вопрос на экран вместо формы из
 * двенадцати полей.
 */

/** Буква типа движения в кнопке. Полное имя не влезает в 64 знака. */
const CODE: Record<MoveKind, string> = {
  receipt: 'r',
  write_off: 'w',
  transfer: 't',
  issue_to_production: 'i',
  return_from_production: 'p',
  return_from_client: 'c',
  surplus: 's',
};
const KIND_BY_CODE: Record<string, MoveKind> = Object.fromEntries(
  MOVE_KINDS.map((k) => [CODE[k], k]),
);

/** Право, без которого движение этого типа не заводят. То же, что у службы. */
const RIGHT: Record<MoveKind, string> = {
  receipt: 'warehouse.move',
  transfer: 'warehouse.move',
  issue_to_production: 'warehouse.move',
  return_from_production: 'warehouse.move',
  return_from_client: 'warehouse.move',
  write_off: 'warehouse.writeoff',
  surplus: 'warehouse.writeoff',
};

const COUNT_RIGHT = 'warehouse.inventory';
const APPROVE_RIGHT = 'warehouse.inventory.approve';

/** Сколько строк и кнопок показываем. Больше на телефоне не читается. */
const LIST_LIMIT = 8;
/** Вариантов выбора на экране. Шесть — то, что видно без прокрутки. */
const PICK_LIMIT = 6;

@Injectable()
export class BotWarehouse {
  private readonly log = new Logger('bot/warehouse');

  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: WarehouseService,
    private readonly moves: MovesService,
    private readonly write: WriteService,
    private readonly inventory: InventoryService,
    private readonly needs: NeedsService,
    // Фото к движению: размер, тип файла и право проверяет служба вложений.
    private readonly attachments: AttachmentsService,
  ) {}

  private as<T>(me: Me, uz: boolean, fn: () => Promise<T>): Promise<T> {
    return asUser(me, uz, fn);
  }

  // --- разбор нажатий -------------------------------------------------------

  async route(me: Me, any: SectionFlow | null, data: string, uz: boolean): Promise<Screen> {
    const flow = any?.kind === 'wh' ? (any as Flow) : null;

    if (data === CB.wh) return { ...this.home(me, uz), flow: null };
    if (data === CB.whReturns) return { ...this.returns(me, uz), flow: null };
    if (data === CB.whStock) {
      return {
        text: W.stockAsk(uz),
        keyboard: [this.row(uz)],
        flow: { kind: 'wh', step: 'stockSearch' } satisfies Flow,
      };
    }
    if (data === CB.whMoves) return this.moveList(me, uz);
    if (data === CB.whNeeds) return this.needsScreen(me, uz);
    if (data === CB.whSheets) return this.sheets(me, uz);
    if (data === CB.whCancel) {
      return { ...this.home(me, uz), toast: W.cancelled(uz), flow: null };
    }
    if (data === CB.whBack) {
      if (!flow || !flow.type) return { ...this.home(me, uz), flow: null };
      const back = prevStep(flow, me.companies.length > 1);
      if (!back) return { ...this.home(me, uz), toast: W.cancelled(uz), flow: null };
      return this.stepScreen(me, { ...flow, step: back }, uz);
    }
    if (data.startsWith('w:ph:')) {
      if (!me.permissions.has('warehouse.move')) {
        return { ...this.home(me, uz), toast: W.noRight(uz), flow: null };
      }
      return this.photoBegin(me, data.slice(5), uz);
    }
    if (data.startsWith('w:n:')) {
      const kind = KIND_BY_CODE[data.slice(4)];
      if (!kind) return { ...this.home(me, uz), toast: W.stale(uz) };
      if (!me.permissions.has(RIGHT[kind])) {
        return { ...this.home(me, uz), toast: W.noRight(uz), flow: null };
      }
      return this.begin(me, kind, uz);
    }
    if (data.startsWith('w:k:')) {
      if (!flow) return { ...this.home(me, uz), toast: W.stale(uz), flow: null };
      return this.pick(me, flow, data.slice(4), uz);
    }
    if (data === CB.whExplain) {
      if (!flow) return { ...this.home(me, uz), toast: W.stale(uz), flow: null };
      return this.explainScreen(me, flow, uz);
    }
    if (data === CB.whConfirm) {
      if (!flow) return { ...this.home(me, uz), toast: W.stale(uz), flow: null };
      return this.stepScreen(me, { ...flow, step: 'confirm' }, uz);
    }
    if (data === CB.whSave) {
      if (!flow || !flow.type) return { ...this.home(me, uz), toast: W.stale(uz), flow: null };
      return this.save(me, flow, uz);
    }
    if (data.startsWith('w:o:')) return this.moveCard(me, data.slice(4), uz);
    if (data.startsWith('w:h:')) return this.sheet(me, data.slice(4), uz);
    if (data.startsWith('w:c:')) return this.countAsk(me, data.slice(4), uz);
    if (data.startsWith('w:q:')) return this.ask(me, data.slice(4), uz);
    if (data.startsWith('w:y:')) return this.apply(me, data.slice(4), uz);

    return { ...this.home(me, uz), toast: W.stale(uz) };
  }

  home(me: Me, uz: boolean): Screen {
    const can = (right: string) => me.permissions.has(right);
    const rows: InlineKeyboard = [
      [
        { text: uz ? '🔍 Qoldiq' : '🔍 Остаток', data: CB.whStock, style: BLUE },
        { text: uz ? '📋 Harakatlar' : '📋 Движения', data: CB.whMoves, style: BLUE },
      ],
    ];
    const pair: InlineButton[] = [];
    if (can('warehouse.move')) {
      pair.push(this.kindButton('receipt', uz), this.kindButton('transfer', uz));
    }
    if (pair.length) rows.push(pair);
    const second: InlineButton[] = [];
    if (can('warehouse.writeoff')) second.push(this.kindButton('write_off', uz));
    if (can('warehouse.move')) second.push(this.kindButton('issue_to_production', uz));
    if (second.length) rows.push(second);
    const third: InlineButton[] = [];
    if (can('warehouse.move')) {
      third.push({ text: uz ? '↩️ Qaytishlar' : '↩️ Возвраты', data: CB.whReturns, style: BLUE });
    }
    if (can('warehouse.writeoff')) third.push(this.kindButton('surplus', uz));
    if (third.length) rows.push(third);
    const fourth: InlineButton[] = [
      { text: uz ? '📉 Nima yetishmaydi' : '📉 Чего не хватает', data: CB.whNeeds, style: BLUE },
    ];
    if (can(COUNT_RIGHT)) {
      fourth.push({ text: uz ? '🧮 Qayta hisob' : '🧮 Пересчёт', data: CB.whSheets, style: BLUE });
    }
    rows.push(fourth);
    rows.push([{ text: uz ? '⬅️ Menyu' : '⬅️ Меню', data: CB.menu, style: BLUE }]);
    return { text: W.home(uz), keyboard: rows };
  }

  private returns(me: Me, uz: boolean): Screen {
    return {
      text: W.returns(uz),
      keyboard: [
        [this.kindButton('return_from_production', uz)],
        [this.kindButton('return_from_client', uz)],
        this.row(uz),
      ],
    };
  }

  private kindButton(kind: MoveKind, uz: boolean): InlineButton {
    return {
      text: `${KIND[kind].mark} ${uz ? KIND[kind].uz : KIND[kind].ru}`,
      data: CB.whNew(CODE[kind]),
      style: BLUE,
    };
  }

  private row(uz: boolean): InlineButton[] {
    return homeRow(CB.wh, 'Склад', 'Ombor', uz);
  }

  // --- мастер движения -----------------------------------------------------

  private async begin(me: Me, type: MoveKind, uz: boolean): Promise<Screen> {
    const many = me.companies.length > 1;
    const flow: Flow = { kind: 'wh', type, step: many ? 'company' : 'item' };
    if (!many && me.companies[0]) {
      flow.companyUid = me.companies[0].uid;
      flow.companyName = uz ? me.companies[0].nameUz : me.companies[0].nameRu;
    }
    return this.stepScreen(me, flow, uz);
  }

  async text(me: Me, any: SectionFlow, raw: string, uz: boolean): Promise<Screen> {
    const flow = any.kind === 'wh' ? (any as Flow) : null;
    if (!flow) return { ...this.home(me, uz), toast: W.stale(uz), flow: null };
    const typed = raw.trim();

    if (flow.step === 'photo') {
      // Написал словами там, где ждут снимок: повторяем просьбу целиком.
      return {
        text: `${W.photoWait(uz)}\n\n${W.askPhoto(uz, escape(flow.photoWhat ?? ''))}`,
        keyboard: [
          [
            {
              text: uz ? '⬅️ Harakatga' : '⬅️ К движению',
              data: CB.whMove(flow.photoFor ?? ''),
              style: BLUE,
            },
          ],
          [{ text: uz ? '❌ Bekor qilish' : '❌ Отменить', data: CB.whCancel, style: RED }],
        ],
        fresh: true,
        flow,
      };
    }

    // Поиск остатка — разговор без мастера: написал название, увидел полки.
    if (flow.step === 'stockSearch') return this.stockFound(me, typed, uz);
    if (flow.step === 'countQty') return this.countSave(me, flow, typed, uz);

    if (flow.step === 'item') {
      const found = await this.items(me, flow, typed);
      if (found.length === 0) {
        return this.stepScreen(me, flow, uz, true, W.itemNotFound(uz, escape(typed)));
      }
      if (found.length === 1) return this.chooseItem(me, flow, found[0]!, uz);
      return this.stepScreen(me, flow, uz, true, undefined, { items: found });
    }

    if (flow.step === 'qty') {
      const qty = parseQty(typed);
      if (!qty) return this.stepScreen(me, flow, uz, true, W.badQty(uz));
      return this.forward(me, { ...flow, qty }, uz);
    }

    if (flow.step === 'serial') {
      // Штучный учёт: номер — это и есть предмет движения, количество всегда 1.
      return this.forward(me, { ...flow, serial: typed.slice(0, 64), qty: '1' }, uz);
    }

    if (flow.step === 'batch') {
      return this.forward(me, { ...flow, batch: typed.slice(0, 64) }, uz);
    }

    if (flow.step === 'cost') {
      const cost = parseCost(typed);
      if (cost === null) return this.stepScreen(me, flow, uz, true, W.badCost(uz));
      return this.forward(me, { ...flow, cost }, uz);
    }

    if (flow.step === 'partner') {
      const found = await this.partners(me, flow, typed);
      if (found.length === 0) {
        return this.stepScreen(me, flow, uz, true, W.partnerNotFound(uz, escape(typed)));
      }
      if (found.length === 1) {
        return this.forward(
          me,
          { ...flow, partnerUid: found[0]!.uid, partnerName: found[0]!.name },
          uz,
        );
      }
      return this.stepScreen(me, flow, uz, true, undefined, { partners: found });
    }

    if (flow.step === 'comment') {
      return this.forward(me, { ...flow, comment: typed.slice(0, 200) }, uz);
    }

    return this.stepScreen(me, flow, uz, true, W.stale(uz));
  }

  /**
   * Номенклатуру выбрали — и только теперь известно, сколько шагов осталось:
   * партия и серийный номер зависят от неё самой.
   */
  private chooseItem(
    me: Me,
    flow: Flow,
    item: { code: string; name: string; unit: string; batches: boolean; serials: boolean },
    uz: boolean,
  ): Promise<Screen> {
    return this.forward(
      me,
      {
        ...flow,
        itemCode: item.code,
        itemName: item.name,
        unit: item.unit,
        trackBatches: item.batches,
        trackSerials: item.serials,
      },
      uz,
    );
  }

  private async pick(me: Me, flow: Flow, value: string, uz: boolean): Promise<Screen> {
    const stale = () => this.stepScreen(me, flow, uz, false, W.stale(uz));

    if (flow.step === 'company') {
      const company = me.companies.find((c) => c.uid === value);
      if (!company) return stale();
      return this.forward(
        me,
        { ...flow, companyUid: company.uid, companyName: uz ? company.nameUz : company.nameRu },
        uz,
      );
    }

    if (flow.step === 'item') {
      const item = (await this.items(me, flow)).find((i) => i.code === value);
      if (!item) return stale();
      return this.chooseItem(me, flow, item, uz);
    }

    if (flow.step === 'batch') {
      if (value === '-') return stale();
      return this.forward(me, { ...flow, batch: value }, uz);
    }

    if (flow.step === 'fromWarehouse' || flow.step === 'toWarehouse') {
      const from = flow.step === 'fromWarehouse';
      const warehouse = (await this.warehouses(me, flow, uz)).find((w) => w.code === value);
      if (!warehouse) return stale();
      // Есть ли на складе ячейки, выясняется здесь — и от этого зависит,
      // будет ли следующий шаг вообще.
      const cells = (await this.locations(me, flow, uz, warehouse.code)).length > 0;
      return this.forward(
        me,
        from
          ? {
              ...flow,
              fromWarehouse: warehouse.code,
              fromWarehouseName: warehouse.name,
              fromCells: cells,
            }
          : {
              ...flow,
              toWarehouse: warehouse.code,
              toWarehouseName: warehouse.name,
              toCells: cells,
            },
        uz,
      );
    }

    if (flow.step === 'fromLocation' || flow.step === 'toLocation') {
      const from = flow.step === 'fromLocation';
      const code = from ? flow.fromWarehouse : flow.toWarehouse;
      const found = (await this.locations(me, flow, uz, code)).find((l) => l.code === value);
      if (!found) return stale();
      return this.forward(
        me,
        from ? { ...flow, fromLocation: found.code } : { ...flow, toLocation: found.code },
        uz,
      );
    }

    if (flow.step === 'cost' && value === '-') {
      // «Не знаю» — это ноль, но осознанный: финансист поправит себестоимость.
      return this.forward(me, { ...flow, cost: '0' }, uz);
    }

    if (flow.step === 'reason') {
      const reason = (await this.reasons(me, flow, uz)).find((r) => r.id === value);
      if (!reason) return stale();
      return this.forward(me, { ...flow, reasonId: reason.id, reasonName: reason.name }, uz);
    }

    if (flow.step === 'partner') {
      if (value === '-') {
        if (await this.partnerNeeded(me, flow)) {
          return this.stepScreen(me, flow, uz, false, W.partnerNeededNew(uz));
        }
        return this.forward(me, { ...flow, partnerUid: undefined }, uz);
      }
      const found = (await this.partners(me, flow)).find((p) => p.uid === value);
      if (!found) return stale();
      return this.forward(me, { ...flow, partnerUid: found.uid, partnerName: found.name }, uz);
    }

    if (flow.step === 'comment' && value === '-') {
      return this.forward(me, { ...flow, comment: undefined }, uz);
    }

    return stale();
  }

  private forward(me: Me, flow: Flow, uz: boolean, fresh = true): Promise<Screen> {
    const step = nextStep(flow, me.companies.length > 1);
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
      partners?: { uid: string; name: string }[];
    },
  ): Promise<Screen> {
    if (!flow.type) return { ...this.home(me, uz), toast: W.stale(uz), flow: null };
    if (flow.step === 'confirm') return this.confirmScreen(me, flow, uz, fresh);

    const many = me.companies.length > 1;
    const steps = order(flow, many);
    const total = steps.length - 1;
    const index = Math.max(steps.indexOf(flow.step) + 1, 1);
    const head = (title: string) =>
      `${W.kindHead(uz, flow.type!)}\n\n${W.step(uz, index, total, title)}`;
    // Чего спрошу после этого вопроса: человек видит, что осталось два ответа,
    // а не неизвестность, и не бросает разговор на середине.
    const ahead = comingNext(
      uz,
      steps.slice(index).map((next) => this.stepTitle(next, uz)),
    );
    const rows: InlineKeyboard = [];
    let body: string;

    if (flow.step === 'company') {
      body = `${head(W.companyTitle(uz))}\n\n${W.askCompany(uz)}`;
      for (const c of me.companies) {
        rows.push([{ text: uz ? c.nameUz : c.nameRu, data: CB.whPick(c.uid), style: BLUE }]);
      }
    } else if (flow.step === 'item') {
      body = `${head(W.itemTitle(uz))}\n\n${W.askItem(uz)}`;
      for (const i of ready?.items ?? (await this.items(me, flow))) {
        rows.push([{ text: `${i.name} · ${i.code}`, data: CB.whPick(i.code), style: BLUE }]);
      }
    } else if (flow.step === 'qty') {
      body = `${head(W.qtyTitle(uz))}\n\n${W.askQty(uz, flow.unit ?? '—')}`;
    } else if (flow.step === 'serial') {
      body = `${head(W.serialTitle(uz))}\n\n${W.askSerial(uz)}`;
    } else if (flow.step === 'batch') {
      const receipt = flow.type === 'receipt';
      body = `${head(W.batchTitle(uz))}\n\n${W.askBatch(uz, receipt)}`;
      for (const b of await this.batches(me, flow)) {
        rows.push([{ text: b, data: CB.whPick(b), style: BLUE }]);
      }
    } else if (flow.step === 'fromWarehouse' || flow.step === 'toWarehouse') {
      const from = flow.step === 'fromWarehouse';
      body = `${head(W.warehouseTitle(uz, from))}\n\n${W.askWarehouse(uz, from)}`;
      for (const w of await this.warehouses(me, flow, uz)) {
        rows.push([{ text: w.name, data: CB.whPick(w.code), style: BLUE }]);
      }
    } else if (flow.step === 'fromLocation' || flow.step === 'toLocation') {
      const from = flow.step === 'fromLocation';
      const code = from ? flow.fromWarehouse : flow.toWarehouse;
      const name = (from ? flow.fromWarehouseName : flow.toWarehouseName) ?? code ?? '—';
      body = `${head(W.locationTitle(uz))}\n\n${W.askLocation(uz, from, escape(name))}`;
      for (const l of await this.locations(me, flow, uz, code)) {
        rows.push([{ text: l.title, data: CB.whPick(l.code), style: BLUE }]);
      }
    } else if (flow.step === 'cost') {
      body = `${head(W.costTitle(uz))}\n\n${W.askCost(uz, flow.unit ?? '—')}`;
      rows.push([{ text: uz ? '🤷 Bilmayman' : '🤷 Не знаю', data: CB.whSkip, style: GREEN }]);
    } else if (flow.step === 'reason') {
      body = `${head(W.reasonTitle(uz))}\n\n${W.askReason(uz)}`;
      for (const r of await this.reasons(me, flow, uz)) {
        rows.push([{ text: r.name, data: CB.whPick(r.id), style: BLUE }]);
      }
    } else if (flow.step === 'partner') {
      const rule = PARTNER[flow.type]!;
      const need = await this.partnerNeeded(me, flow);
      body = `${head(W.partnerTitle(uz))}\n\n${W.askPartner(uz, rule.role, need)}`;
      if (need && !rule.need) body += `\n\n${W.partnerNeededNew(uz)}`;
      for (const p of ready?.partners ?? (await this.partners(me, flow))) {
        rows.push([{ text: p.name, data: CB.whPick(p.uid), style: BLUE }]);
      }
      if (!need) {
        rows.push([
          { text: uz ? '➡️ O‘tkazib yuborish' : '➡️ Пропустить', data: CB.whSkip, style: GREEN },
        ]);
      }
    } else {
      body = `${head(W.commentTitle(uz))}\n\n${W.askComment(uz)}`;
      rows.push([
        { text: uz ? '➡️ O‘tkazib yuborish' : '➡️ Пропустить', data: CB.whSkip, style: GREEN },
      ]);
    }

    rows.push(this.footer(me, flow, uz));
    body += ahead;
    return { text: note ? `${note}\n\n${body}` : body, keyboard: rows, fresh, flow };
  }

  /** Как шаг назван в строке «дальше»: теми же словами, что его заголовок. */
  private stepTitle(step: Step, uz: boolean): string {
    if (step === 'company') return W.companyTitle(uz);
    if (step === 'item') return W.itemTitle(uz);
    if (step === 'qty') return W.qtyTitle(uz);
    if (step === 'serial') return W.serialTitle(uz);
    if (step === 'batch') return W.batchTitle(uz);
    if (step === 'fromWarehouse') return W.warehouseTitle(uz, true);
    if (step === 'toWarehouse') return W.warehouseTitle(uz, false);
    if (step === 'fromLocation' || step === 'toLocation') return W.locationTitle(uz);
    if (step === 'cost') return W.costTitle(uz);
    if (step === 'reason') return W.reasonTitle(uz);
    if (step === 'partner') return W.partnerTitle(uz);
    if (step === 'comment') return W.commentTitle(uz);
    return W.checkTitle(uz);
  }

  /**
   * «Я не понял» на проверке: то же движение словами. Ничего не записывает,
   * разговор остаётся тем же — человек возвращается на свой экран проверки.
   */
  private explainScreen(me: Me, flow: Flow, uz: boolean): Screen {
    const kind = KIND[flow.type!];
    const place =
      flow.toWarehouseName ??
      flow.toWarehouse ??
      flow.fromWarehouseName ??
      flow.fromWarehouse ??
      '—';
    return {
      text: W.explain(uz, {
        kind: uz ? kind.uz : kind.ru,
        item: escape(flow.itemName ?? flow.itemCode ?? '—'),
        qty: flow.serial ? escape(flow.serial) : qtyText(flow.qty ?? '0', flow.unit),
        place: escape(place),
      }),
      keyboard: [[understoodButton(uz, CB.whConfirm)], this.footer(me, flow, uz)],
      flow,
    };
  }

  private footer(me: Me, flow: Flow, uz: boolean): InlineButton[] {
    const back = prevStep(flow, me.companies.length > 1);
    const row: InlineButton[] = [];
    if (back) row.push({ text: uz ? '⬅️ Orqaga' : '⬅️ Назад', data: CB.whBack, style: BLUE });
    row.push({ text: uz ? '❌ Bekor qilish' : '❌ Отменить', data: CB.whCancel, style: RED });
    return row;
  }

  private confirmScreen(me: Me, flow: Flow, uz: boolean, fresh: boolean): Screen {
    const next: Flow = { ...flow, key: flow.key ?? randomUUID() };
    const label = (ru: string, uzs: string) => (uz ? uzs : ru);
    const kind = KIND[flow.type!];
    const lines = [
      `${label('Что делаем', 'Nima qilamiz')}: <b>${kind.mark} ${uz ? kind.uz : kind.ru}</b>`,
      `${label('Товар', 'Tovar')}: ${escape(flow.itemName ?? '—')}`,
      flow.serial
        ? `${label('Номер', 'Raqam')}: <b>${escape(flow.serial)}</b>`
        : `${label('Количество', 'Miqdor')}: <b>${qtyText(flow.qty ?? '0', flow.unit)}</b>`,
      ...(flow.batch ? [`${label('Партия', 'Partiya')}: ${escape(flow.batch)}`] : []),
      ...(flow.fromWarehouse
        ? [
            `${label('Откуда', 'Qayerdan')}: ${escape(flow.fromWarehouseName ?? flow.fromWarehouse)}` +
              (flow.fromLocation ? ` · ${escape(flow.fromLocation)}` : ''),
          ]
        : []),
      ...(flow.toWarehouse
        ? [
            `${label('Куда', 'Qayerga')}: ${escape(flow.toWarehouseName ?? flow.toWarehouse)}` +
              (flow.toLocation ? ` · ${escape(flow.toLocation)}` : ''),
          ]
        : []),
      ...(flow.cost && flow.cost !== '0'
        ? [`${label('Цена за единицу', 'Birlik narxi')}: ${qtyText(flow.cost)}`]
        : []),
      ...(flow.reasonName ? [`${label('Причина', 'Sabab')}: ${escape(flow.reasonName)}`] : []),
      ...(flow.partnerName
        ? [`${label('Контрагент', 'Kim bilan')}: ${escape(flow.partnerName)}`]
        : []),
      ...(flow.comment ? [`${label('Примечание', 'Izoh')}: ${escape(flow.comment)}`] : []),
      `${label('Компания', 'Kompaniya')}: ${escape(flow.companyName ?? '—')}`,
    ];
    return {
      text: W.confirm(uz, lines),
      keyboard: [
        [{ text: uz ? '✅ Yozish' : '✅ Записать', data: CB.whSave, style: GREEN }],
        [explainButton(uz, CB.whExplain)],
        this.footer(me, flow, uz),
      ],
      fresh,
      flow: next,
    };
  }

  private async save(me: Me, flow: Flow, uz: boolean): Promise<Screen> {
    try {
      const move = await this.as(me, uz, () =>
        this.write.create(
          {
            companyUid: flow.companyUid,
            operationType: flow.type!,
            itemCode: flow.itemCode!,
            qty: flow.qty ?? '1',
            ...(flow.batch ? { batchNumber: flow.batch } : {}),
            ...(flow.serial ? { serialNumber: flow.serial } : {}),
            ...(flow.fromWarehouse ? { fromWarehouseCode: flow.fromWarehouse } : {}),
            ...(flow.fromLocation ? { fromLocationCode: flow.fromLocation } : {}),
            ...(flow.toWarehouse ? { toWarehouseCode: flow.toWarehouse } : {}),
            ...(flow.toLocation ? { toLocationCode: flow.toLocation } : {}),
            ...(flow.cost ? { unitCost: flow.cost } : {}),
            ...(flow.reasonId ? { reasonId: flow.reasonId } : {}),
            ...(flow.partnerUid ? { partnerUid: flow.partnerUid } : {}),
            ...(flow.comment ? { comment: flow.comment } : {}),
          },
          flow.key,
        ),
      );
      const kind = KIND[flow.type!];
      const title =
        `${uz ? kind.uz : kind.ru} · ${escape(flow.itemName ?? flow.itemCode ?? '')}` +
        ` · ${flow.serial ? escape(flow.serial) : qtyText(move.qty, flow.unit)}`;
      const keyboard: InlineKeyboard = [
        [
          {
            text: `${kind.mark} ${uz ? 'Yana bitta' : 'Ещё одно'}`,
            data: CB.whNew(CODE[flow.type!]),
            style: GREEN,
          },
        ],
      ];
      // Снимок предлагаем сразу после списания, а не потом из списка: товар
      // ещё лежит перед кладовщиком, а через час его уже увезли.
      if (
        (flow.type === 'write_off' || flow.type === 'surplus') &&
        me.permissions.has('warehouse.move')
      ) {
        keyboard.push([
          {
            text: uz ? '📷 Rasm biriktirish' : '📷 Приложить фото',
            data: CB.whPhoto(move.uid),
            style: BLUE,
          },
        ]);
      }
      keyboard.push([
        { text: uz ? '📋 Harakatlar' : '📋 Движения', data: CB.whMoves, style: BLUE },
      ]);
      keyboard.push(this.row(uz));
      return { text: W.saved(uz, title), keyboard, flow: null };
    } catch (e) {
      return this.refusal(me, uz, e);
    }
  }

  // --- остаток, движения, нехватка -----------------------------------------

  private async stockFound(me: Me, query: string, uz: boolean): Promise<Screen> {
    const out = await this.as(me, uz, () =>
      this.stock.stock({ search: query, criticalOnly: false, limit: LIST_LIMIT }),
    );
    if (out.rows.length === 0) {
      return {
        text: `${W.stockEmpty(uz, escape(query))}\n\n${W.stockAsk(uz)}`,
        keyboard: [this.row(uz)],
        fresh: true,
        flow: { kind: 'wh', step: 'stockSearch' } satisfies Flow,
      };
    }
    const lines = out.rows.map((r) => {
      const cell = r.location ? (r.zone ? `${r.zone}/${r.location}` : r.location) : null;
      const where = `${escape(r.warehouse.code)}${cell ? ` · ${escape(cell)}` : ''}`;
      const extra = [
        r.batch ? escape(r.batch.number ?? '') : null,
        r.serial ? escape(r.serial) : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return (
        `• <b>${escape(r.item.nameRu)}</b> · ${where}${extra ? ` · ${extra}` : ''}\n` +
        `  ${uz ? 'bor' : 'лежит'} ${qtyText(r.qtyOnHand, r.item.unit)}, ` +
        `${uz ? 'erkin' : 'свободно'} ${qtyText(r.qtyAvailable, r.item.unit)}`
      );
    });
    return {
      text: W.stockFound(uz, escape(query), lines),
      keyboard: [this.row(uz)],
      fresh: true,
      // Разговор продолжается: следующее слово — снова поиск.
      flow: { kind: 'wh', step: 'stockSearch' } satisfies Flow,
    };
  }

  private async moveList(me: Me, uz: boolean): Promise<Screen> {
    const out = await this.as(me, uz, () => this.moves.list({ limit: LIST_LIMIT, offset: 0 }));
    const lines = out.rows.map((r) => this.moveLine(r, uz));
    const keyboard: InlineKeyboard = out.rows.map((r) => [
      {
        text: `${this.mark(r)} ${r.item.code} · ${qtyText(r.qty, r.item.unit)}`,
        data: CB.whMove(r.uid),
        style: BLUE,
      },
    ]);
    keyboard.push(this.row(uz));
    return { text: W.moves(uz, lines), keyboard };
  }

  private mark(r: { operationType: string; reversed?: boolean }): string {
    if (r.reversed) return '↩️';
    const kind = KIND[r.operationType as MoveKind];
    return kind?.mark ?? '•';
  }

  private moveLine(r: Record<string, any>, uz: boolean): string {
    const kind = KIND[r.operationType as MoveKind];
    const name = kind ? (uz ? kind.uz : kind.ru) : r.operationType;
    return (
      `${this.mark(r as never)} <b>${escape(name)}</b> · ${escape(r.item.nameRu)} · ` +
      qtyText(r.qty, r.item.unit)
    );
  }

  private async moveCard(me: Me, uid: string, uz: boolean): Promise<Screen> {
    const out = await this.as(me, uz, () => this.moves.list({ uid, limit: 1, offset: 0 }));
    const r = out.rows[0];
    if (!r) return { ...this.home(me, uz), toast: W.stale(uz) };
    const label = (ru: string, uzs: string) => (uz ? uzs : ru);
    const kind = KIND[r.operationType as MoveKind];
    const lines = [
      `${this.mark(r)} <b>${escape(kind ? (uz ? kind.uz : kind.ru) : r.operationType)}</b>`,
      `${label('Товар', 'Tovar')}: ${escape(r.item.nameRu)} (${escape(r.item.code)})`,
      `${label('Количество', 'Miqdor')}: <b>${qtyText(r.qty, r.item.unit)}</b>`,
      ...(r.serial ? [`${label('Номер', 'Raqam')}: ${escape(r.serial)}`] : []),
      ...(r.batch ? [`${label('Партия', 'Partiya')}: ${escape(r.batch.number ?? '')}`] : []),
      ...(r.fromWarehouse
        ? [
            `${label('Откуда', 'Qayerdan')}: ${escape(r.fromWarehouse.code ?? '')}` +
              (r.fromLocation ? ` · ${escape(r.fromLocation)}` : ''),
          ]
        : []),
      ...(r.toWarehouse
        ? [
            `${label('Куда', 'Qayerga')}: ${escape(r.toWarehouse.code ?? '')}` +
              (r.toLocation ? ` · ${escape(r.toLocation)}` : ''),
          ]
        : []),
      ...(r.reason ? [`${label('Причина', 'Sabab')}: ${escape(r.reason)}`] : []),
      ...(r.partner ? [`${label('Контрагент', 'Kim bilan')}: ${escape(r.partner)}`] : []),
      ...(r.docNumber ? [`${label('Документ', 'Hujjat')}: ${escape(r.docNumber)}`] : []),
      ...(r.comment ? [`${label('Примечание', 'Izoh')}: ${escape(r.comment)}`] : []),
      `${label('Кто записал', 'Kim yozdi')}: ${escape(r.author ?? '—')}`,
    ];
    let files = 0;
    try {
      files = (await this.as(me, uz, () => this.attachments.list('stock_move', uid))).length;
    } catch {
      // Права на просмотр вложений может не быть — тогда строки просто нет.
      files = 0;
    }
    if (files > 0) lines.push(W.photoLine(uz, files));

    const keyboard: InlineKeyboard = [];
    if (me.permissions.has('warehouse.move')) {
      keyboard.push([
        {
          text: uz ? '📷 Rasm biriktirish' : '📷 Приложить фото',
          data: CB.whPhoto(uid),
          style: BLUE,
        },
      ]);
    }
    if (r.canReverse) {
      keyboard.push([
        {
          text: uz ? '↩️ Bekor qilish' : '↩️ Отменить движение',
          data: CB.whAsk('v', uid),
          style: RED,
        },
      ]);
    }
    keyboard.push([{ text: uz ? '📋 Harakatlar' : '📋 Движения', data: CB.whMoves, style: BLUE }]);
    keyboard.push(this.row(uz));
    return {
      text: W.moveCard(uz, lines, r.canReverse ? W.moveCanReverse(uz) : W.moveCannotReverse(uz)),
      keyboard,
    };
  }

  private async needsScreen(me: Me, uz: boolean): Promise<Screen> {
    const out = await this.as(me, uz, () =>
      this.needs.purchaseNeeds({ all: false, limit: LIST_LIMIT }),
    );
    const lines = out.rows.map(
      (r) =>
        `${r.state === 'critical' ? '🔴' : '🟡'} <b>${escape(r.item.nameRu)}</b>` +
        `${r.warehouse ? ` · ${escape(r.warehouse.code)}` : ''}\n` +
        `  ${uz ? 'erkin' : 'свободно'} ${qtyText(r.available, r.item.unit)}, ` +
        `${uz ? 'kerak' : 'нужно'} ${qtyText(r.needQty, r.item.unit)}`,
    );
    return { text: W.needs(uz, lines), keyboard: [this.row(uz)] };
  }

  // --- пересчёт -------------------------------------------------------------

  private async sheets(me: Me, uz: boolean): Promise<Screen> {
    if (!me.permissions.has(COUNT_RIGHT)) {
      return { ...this.home(me, uz), toast: W.noRight(uz) };
    }
    const out = await this.as(me, uz, () => this.inventory.list({ limit: LIST_LIMIT }));
    const open = out.rows.filter((r) => ['draft', 'counting', 'review'].includes(r.status));
    const lines = open.map(
      (r) =>
        `🧮 <b>${escape(r.number)}</b> · ${escape(r.warehouse.code)} · ` +
        `${uz ? 'hisoblangan' : 'посчитано'} ${r.counted}/${r.lines}`,
    );
    const keyboard: InlineKeyboard = open.map((r) => [
      {
        text: `🧮 ${r.number} · ${r.counted}/${r.lines}`,
        data: CB.whSheet(r.uid),
        style: BLUE,
      },
    ]);
    keyboard.push(this.row(uz));
    return { text: W.sheets(uz, lines), keyboard };
  }

  private async sheet(me: Me, uid: string, uz: boolean): Promise<Screen> {
    if (!me.permissions.has(COUNT_RIGHT)) {
      return { ...this.home(me, uz), toast: W.noRight(uz) };
    }
    let sheet: Awaited<ReturnType<InventoryService['get']>>;
    try {
      sheet = await this.as(me, uz, () => this.inventory.get(uid));
    } catch (e) {
      return this.refusal(me, uz, e);
    }
    const left = sheet.rows.filter((l) => l.qtyCounted === null);
    const head = W.sheetHead(
      uz,
      escape(sheet.number),
      escape(sheet.warehouse.code),
      sheet.counted,
      sheet.lines,
    );
    const lines = (left.length > 0 ? left : sheet.rows).slice(0, LIST_LIMIT).map((l) => {
      const where = l.location ? ` · ${escape(l.location)}` : '';
      const done =
        l.qtyCounted === null
          ? uz
            ? 'hisoblanmagan'
            : 'не посчитано'
          : `${uz ? 'hisoblangan' : 'посчитано'} ${qtyText(l.qtyCounted, l.item.unit)}` +
            (Number(l.qtyDiff ?? 0) !== 0
              ? ` (${uz ? 'farq' : 'расхождение'} ${qtyText(l.qtyDiff!, l.item.unit)})`
              : '');
      return `• <b>${escape(l.item.nameRu)}</b>${where}\n  ${done}`;
    });
    const keyboard: InlineKeyboard = left.slice(0, LIST_LIMIT).map((l) => [
      {
        text: `🧮 ${l.item.code}${l.location ? ` · ${l.location}` : ''}`,
        data: CB.whLine(l.uid),
        style: BLUE,
      },
    ]);
    if (left.length === 0 && sheet.status !== 'review') {
      keyboard.push([
        {
          text: uz ? '✅ Varaqni yopish' : '✅ Закрыть лист',
          data: CB.whAsk('f', uid),
          style: GREEN,
        },
      ]);
    }
    if (sheet.status === 'review' && me.permissions.has(APPROVE_RIGHT)) {
      keyboard.push([
        { text: uz ? '⚠️ Tasdiqlash' : '⚠️ Утвердить', data: CB.whAsk('a', uid), style: RED },
      ]);
    }
    keyboard.push([{ text: uz ? '🧮 Varaqlar' : '🧮 Листы', data: CB.whSheets, style: BLUE }]);
    keyboard.push(this.row(uz));
    const note = left.length === 0 ? `\n${W.sheetDone(uz)}` : '';
    return { text: `${W.sheet(uz, head, lines)}${note}`, keyboard };
  }

  /**
   * Экран пересчёта одной строки.
   *
   * Ожидаемого количества человек здесь не видит намеренно: увидев его, легко
   * просто переписать это число, и пересчёт перестаёт быть пересчётом. Так же
   * устроен лист на экране в браузере.
   */
  private async countAsk(me: Me, lineUid: string, uz: boolean): Promise<Screen> {
    if (!me.permissions.has(COUNT_RIGHT)) {
      return { ...this.home(me, uz), toast: W.noRight(uz) };
    }
    const found = await this.prisma.withContext(
      me.userId,
      me.companyIds,
      (tx) =>
        tx.$queryRaw<
          {
            sheet_uid: string;
            item_name: string;
            item_code: string;
            unit: string;
            location: string | null;
          }[]
        >`
        SELECT s.uid AS sheet_uid, i.name_ru AS item_name, i.code AS item_code,
               u.code AS unit, loc.code AS location
          FROM inventory_sheet_line l
          JOIN inventory_sheet s ON s.id = l.sheet_id
          JOIN item i ON i.id = l.item_id
          JOIN unit u ON u.id = i.base_unit_id
          LEFT JOIN storage_location loc ON loc.id = l.location_id
         WHERE l.uid = ${lineUid}::uuid`,
    );
    const row = found[0];
    if (!row) return { ...this.home(me, uz), toast: W.stale(uz) };
    const title = `${row.item_name} (${row.item_code})${row.location ? ` · ${row.location}` : ''}`;
    const flow: Flow = {
      kind: 'wh',
      step: 'countQty',
      lineUid,
      sheetUid: row.sheet_uid,
      unit: row.unit,
      lineTitle: title,
    };
    return {
      text: W.askCount(uz, escape(title), row.unit),
      keyboard: [
        [
          {
            text: uz ? '⬅️ Varaqqa' : '⬅️ К листу',
            data: CB.whSheet(row.sheet_uid),
            style: BLUE,
          },
        ],
      ],
      flow,
    };
  }

  private async countSave(me: Me, flow: Flow, raw: string, uz: boolean): Promise<Screen> {
    const qty = parseQty(raw);
    if (!qty) {
      return {
        text: `${W.badQty(uz)}\n\n${W.askCount(uz, escape(flow.lineTitle ?? ''), flow.unit ?? '—')}`,
        keyboard: [this.row(uz)],
        fresh: true,
        flow,
      };
    }
    try {
      const line = await this.as(me, uz, () => this.inventory.count(flow.lineUid!, { qty }));
      const diff = Number(line.qtyDiff ?? 0);
      const sheet = await this.sheet(me, flow.sheetUid!, uz);
      return {
        ...sheet,
        text: `${W.counted(uz, diff === 0 ? null : qtyText(line.qtyDiff!, line.item.unit))}\n\n${sheet.text}`,
        fresh: true,
        flow: null,
      };
    } catch (e) {
      return this.refusal(me, uz, e);
    }
  }

  // --- подтверждения --------------------------------------------------------

  private async ask(me: Me, tail: string, uz: boolean): Promise<Screen> {
    const [what, uid] = this.split(tail);
    if (!what || !uid) return { ...this.home(me, uz), toast: W.stale(uz) };
    const text =
      what === 'v' ? W.askReverse(uz) : what === 'f' ? W.askFinish(uz) : W.askApprove(uz);
    const yes = uz ? 'Ha' : 'Да';
    return {
      text,
      keyboard: [
        [{ text: `✅ ${yes}`, data: CB.whDo(what, uid), style: RED }],
        [
          {
            text: uz ? '⬅️ Orqaga' : '⬅️ Назад',
            data: what === 'v' ? CB.whMove(uid) : CB.whSheet(uid),
            style: BLUE,
          },
        ],
      ],
    };
  }

  private async apply(me: Me, tail: string, uz: boolean): Promise<Screen> {
    const [what, uid] = this.split(tail);
    if (!what || !uid) return { ...this.home(me, uz), toast: W.stale(uz) };
    try {
      if (what === 'v') {
        await this.as(me, uz, () => this.write.reverse(uid));
        const list = await this.moveList(me, uz);
        return { ...list, text: `${W.reversed(uz)}\n\n${list.text}` };
      }
      if (what === 'f') {
        await this.as(me, uz, () => this.inventory.finish(uid));
        return this.sheet(me, uid, uz);
      }
      if (what === 'a') {
        if (!me.permissions.has(APPROVE_RIGHT)) {
          return { ...this.home(me, uz), toast: W.noRight(uz) };
        }
        await this.as(me, uz, () => this.inventory.approve(uid));
        return this.sheet(me, uid, uz);
      }
    } catch (e) {
      return this.refusal(me, uz, e);
    }
    return { ...this.home(me, uz), toast: W.stale(uz) };
  }

  private split(tail: string): [string | undefined, string | undefined] {
    const i = tail.indexOf(':');
    return i < 0 ? [undefined, undefined] : [tail.slice(0, i), tail.slice(i + 1)];
  }

  // --- справочники ----------------------------------------------------------

  /**
   * Номенклатура: сначала то, с чем человек работал последним.
   *
   * Кладовщик весь день принимает одно и то же, и список «последних» экономит
   * ему набор названия на каждом приходе. Поиск — по названию и по коду: код
   * написан на бирке, название человек знает на память.
   */
  private async items(me: Me, flow: Flow, query?: string) {
    const like = query ? `%${query}%` : null;
    const rows = await this.prisma.withContext(
      me.userId,
      me.companyIds,
      (tx) =>
        tx.$queryRaw<
          {
            code: string;
            name_ru: string;
            unit: string;
            track_batches: boolean;
            track_serials: boolean;
          }[]
        >`
        SELECT i.code, i.name_ru, u.code AS unit, i.track_batches, i.track_serials
          FROM item i
          JOIN company co ON co.id = i.company_id
          JOIN unit u ON u.id = i.base_unit_id
          LEFT JOIN stock_move m ON m.item_id = i.id
         WHERE co.uid = ${flow.companyUid ?? null}::uuid
           AND i.is_active
           AND (${like}::text IS NULL OR i.name_ru ILIKE ${like} OR i.code ILIKE ${like})
         GROUP BY i.code, i.name_ru, u.code, i.track_batches, i.track_serials
         ORDER BY max(m.moved_at) DESC NULLS LAST, i.name_ru
         LIMIT ${PICK_LIMIT}`,
    );
    return rows.map((r) => ({
      code: r.code,
      name: r.name_ru,
      unit: r.unit,
      batches: r.track_batches,
      serials: r.track_serials,
    }));
  }

  private async batches(me: Me, flow: Flow) {
    const rows = await this.prisma.withContext(
      me.userId,
      me.companyIds,
      (tx) =>
        tx.$queryRaw<{ number: string }[]>`
        SELECT b.number
          FROM batch b
          JOIN item i ON i.id = b.item_id
          JOIN company co ON co.id = b.company_id
         WHERE co.uid = ${flow.companyUid ?? null}::uuid AND i.code = ${flow.itemCode ?? null}
         ORDER BY b.received_at DESC
         LIMIT ${PICK_LIMIT}`,
    );
    return rows.map((r) => r.number);
  }

  private async warehouses(me: Me, flow: Flow, uz: boolean) {
    const refs = await this.as(me, uz, () => this.write.refs());
    return refs.warehouses
      .filter((w) => w.companyUid === flow.companyUid)
      .map((w) => ({ code: w.code, name: uz ? w.nameUz : w.nameRu }));
  }

  private async locations(me: Me, flow: Flow, uz: boolean, warehouse?: string) {
    if (!warehouse) return [];
    const refs = await this.as(me, uz, () => this.write.refs());
    return refs.locations
      .filter((l) => l.companyUid === flow.companyUid && l.warehouseCode === warehouse)
      .map((l) => ({
        code: `${l.zoneCode}/${l.code}`,
        title: `${uz ? l.zoneNameUz : l.zoneNameRu} · ${l.code}`,
      }));
  }

  private async reasons(me: Me, flow: Flow, uz: boolean) {
    const refs = await this.as(me, uz, () => this.write.refs());
    const kinds = REASON_KINDS[flow.type!] ?? [];
    return refs.reasons
      .filter((r) => r.companyUid === flow.companyUid && kinds.includes(r.kind))
      .map((r) => ({ id: r.id, name: uz ? r.nameUz : r.nameRu }));
  }

  /**
   * Обязателен ли контрагент. У возврата от клиента — всегда (так требует и
   * служба). У прихода — тогда, когда он открывает новую партию: партия без
   * поставщика теряет происхождение, и на вопрос «чей это металл» ответить
   * нечем. Существующей партии поставщик уже назначен, и спрашивать его
   * второй раз значит мешать работе.
   */
  private async partnerNeeded(me: Me, flow: Flow): Promise<boolean> {
    const rule = PARTNER[flow.type!];
    if (!rule) return false;
    if (rule.need) return true;
    if (flow.type !== 'receipt' || !flow.batch) return false;
    return !(await this.batchExists(me, flow));
  }

  private async batchExists(me: Me, flow: Flow): Promise<boolean> {
    const rows = await this.prisma.withContext(
      me.userId,
      me.companyIds,
      (tx) =>
        tx.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one
          FROM batch b
          JOIN item i ON i.id = b.item_id
          JOIN company co ON co.id = b.company_id
         WHERE co.uid = ${flow.companyUid ?? null}::uuid
           AND i.code = ${flow.itemCode ?? null}
           AND b.number = ${flow.batch ?? null}
         LIMIT 1`,
    );
    return rows.length > 0;
  }

  private async partners(me: Me, flow: Flow, query?: string) {
    const rule = PARTNER[flow.type!];
    const like = query ? `%${query}%` : null;
    const role = rule?.role ?? 'supplier';
    const rows = await this.prisma.withContext(
      me.userId,
      me.companyIds,
      (tx) =>
        tx.$queryRaw<{ uid: string; name_ru: string }[]>`
        SELECT p.uid, p.name_ru
          FROM partner p
          JOIN company co ON co.id = p.company_id
         WHERE co.uid = ${flow.companyUid ?? null}::uuid
           AND p.is_active
           AND (${role} = 'supplier' AND p.is_supplier OR ${role} = 'client' AND p.is_client)
           AND (${like}::text IS NULL OR p.name_ru ILIKE ${like})
         ORDER BY p.name_ru
         LIMIT ${PICK_LIMIT}`,
    );
    return rows.map((r) => ({ uid: r.uid, name: r.name_ru }));
  }

  /** Отказ службы склада — человеку её словами: они уже написаны для людей. */
  /**
   * Ждём фотографию к движению.
   *
   * Списание уводит товар в никуда, и через месяц спор «а что там было»
   * решается только снимком. Кладовщик стоит у штабеля с телефоном — для него
   * это самый дешёвый способ оставить доказательство, а для системы —
   * единственный, который не требует компьютера.
   */
  private async photoBegin(me: Me, uid: string, uz: boolean): Promise<Screen> {
    let what = '';
    try {
      const out = await this.as(me, uz, () => this.moves.list({ uid, limit: 1, offset: 0 }));
      const r = out.rows[0];
      if (!r) return { ...this.home(me, uz), toast: W.stale(uz) };
      const kind = KIND[r.operationType as MoveKind];
      what =
        `${kind ? (uz ? kind.uz : kind.ru) : r.operationType} · ` +
        `${r.item.nameRu} · ${qtyText(r.qty, r.item.unit)}`;
    } catch (e) {
      return this.refusal(me, uz, e);
    }
    const flow: Flow = { kind: 'wh', step: 'photo', photoFor: uid, photoWhat: what };
    return {
      text: W.askPhoto(uz, escape(what)),
      keyboard: [
        [{ text: uz ? '⬅️ Harakatga' : '⬅️ К движению', data: CB.whMove(uid), style: BLUE }],
        [{ text: uz ? '❌ Bekor qilish' : '❌ Отменить', data: CB.whCancel, style: RED }],
      ],
      fresh: true,
      flow,
    };
  }

  /** Присланный файл: кладём к движению, которого ждёт разговор. */
  async photo(me: Me, any: SectionFlow, file: Incoming, uz: boolean): Promise<Screen> {
    const flow = any.kind === 'wh' ? (any as Flow) : null;
    if (!flow?.photoFor || flow.step !== 'photo') {
      return { ...this.home(me, uz), toast: W.stale(uz), flow: null };
    }
    if (!me.permissions.has('warehouse.move')) {
      return { ...this.home(me, uz), toast: W.noRight(uz), flow: null };
    }
    try {
      await this.as(me, uz, () =>
        this.attachments.add({
          owner: 'stock_move',
          ownerUid: flow.photoFor!,
          fileName: file.fileName,
          mimeType: file.mimeType,
          kind: 'photo',
          bytes: file.bytes,
          comment: 'Снимок из Telegram',
        }),
      );
      const count = (
        await this.as(me, uz, () => this.attachments.list('stock_move', flow.photoFor!))
      ).length;
      const card = await this.moveCard(me, flow.photoFor, uz);
      return {
        ...card,
        text: `${W.photoSaved(uz, count)}\n\n${card.text}`,
        fresh: true,
        flow: null,
      };
    } catch (e) {
      return this.refusal(me, uz, e);
    }
  }

  private refusal(me: Me, uz: boolean, e: unknown): Screen {
    const message = String((e as { message?: string }).message ?? e);
    this.log.warn(`склад в боте: ${message}`);
    const home = this.home(me, uz);
    return {
      ...home,
      text: `${W.refused(uz, escape(message))}\n\n${home.text}`,
      flow: null,
    };
  }
}
