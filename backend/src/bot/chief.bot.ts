import { Injectable, Logger } from '@nestjs/common';
import { DashboardService, type Period } from '../dashboard/dashboard.service.js';
import { OperationsService } from '../finance/operations.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { DigestService, stamp } from './digest.service.js';
import { asUser, escape, type Me, type Screen, type SectionFlow } from './section.js';
import { currencyMark } from './format.js';
import { C, COMPARE_TITLE, PERIOD } from './chief.texts.js';
import { BLUE, CB, GREEN } from './menu.js';
import type { InlineButton, InlineKeyboard } from './telegram.api.js';

/**
 * Раздел «Сводка» в боте — рабочее место руководителя (ТЗ 11.1, решение
 * заказчика 02.10: в боте весь функционал, нужный сотруднику).
 *
 * Руководитель заходит за двумя ответами: как идут дела и что без него стоит.
 * Поэтому раздел короткий: цифры за срок с объяснением, список ждущих решения
 * — и переход прямо в карточку, где есть кнопки «Согласовать» и «Вернуть».
 *
 * Своих цифр бот не считает. Выручка, отгрузки и запас приходят из
 * `DashboardService` — той же службы, что рисует экран сводки в браузере;
 * отклонения — из `DigestService`, которым собрано приветствие. Иначе телефон
 * и браузер показывали бы руководителю разную выручку, и верить было бы нечему.
 */

/** Сколько строк и кнопок показываем. Больше на телефоне не читается. */
const LIST_LIMIT = 5;

interface Flow extends SectionFlow {
  kind: 'chief';
  step: 'view';
  /** Выбранный срок живёт в разговоре: иначе он сбрасывался бы на каждом экране. */
  period?: string;
}

@Injectable()
export class BotChief {
  private readonly log = new Logger('bot/chief');

  constructor(
    private readonly dashboard: DashboardService,
    private readonly operations: OperationsService,
    private readonly documents: DocumentsService,
    private readonly digest: DigestService,
  ) {}

  private as<T>(me: Me, uz: boolean, fn: () => Promise<T>): Promise<T> {
    return asUser(me, uz, fn);
  }

  // --- разбор нажатий -------------------------------------------------------

  async route(me: Me, any: SectionFlow | null, data: string, uz: boolean): Promise<Screen> {
    const flow = any?.kind === 'chief' ? (any as Flow) : null;
    const period = flow?.period ?? '30';

    if (data === CB.chief) return this.home(me, period, uz);
    if (data.startsWith('c:p:')) return this.home(me, data.slice(4), uz);
    if (data === CB.chiefCompare) return this.compare(me, period, uz);
    if (data === CB.chiefWaiting) return this.waiting(me, period, uz);
    if (data === CB.chiefAlarms) return this.alarms(me, period, uz);

    return { ...(await this.home(me, period, uz)), toast: C.stale(uz) };
  }

  /**
   * Текста в этом разделе нет: руководитель ничего не вводит, он смотрит и
   * решает. Экран на всякое слово не перерисовываем — человек увидел бы, что
   * бот отвечает на «спасибо» простынёй цифр.
   */
  async text(me: Me, any: SectionFlow, _raw: string, uz: boolean): Promise<Screen> {
    const flow = any.kind === 'chief' ? (any as Flow) : null;
    return this.home(me, flow?.period ?? '30', uz);
  }

  // --- цифры ----------------------------------------------------------------

  async home(me: Me, periodCode: string, uz: boolean): Promise<Screen> {
    const chosen = PERIOD.find((p) => p.code === periodCode) ?? PERIOD[1]!;
    let out: Awaited<ReturnType<DashboardService['summary']>>;
    try {
      out = await this.as(me, uz, () => this.dashboard.summary(chosen.api as Period));
    } catch (e) {
      return this.refusal(me, uz, e);
    }
    const name = uz ? chosen.uz : chosen.ru;
    const lines = out.kpis.map((k) => this.kpiLines(k, uz, name));
    // Между показателями пустая строка: у каждого три строки, и слитым
    // списком из двенадцати человек не видит, где кончился один и начался
    // другой.
    const body =
      lines.length === 0 ? C.empty(uz) : `<blockquote>${lines.join('\n\n')}</blockquote>`;
    const text = `${C.head(uz, name)}\n\n${body}\n\n${C.about(uz, name)}\n${C.stamp(uz, stamp())}`;

    return { text, keyboard: this.keyboard(me, chosen.code, uz), flow: this.flow(chosen.code) };
  }

  /**
   * Завод и торговый дом рядом (ТЗ 11.1).
   *
   * Руководитель смотрит не «сколько у холдинга», а «кто из двух тянет»: у
   * завода свои показатели, у торгового дома свои, и в общей сумме обе
   * половины невидимы. Поэтому цифры собираются по каждой компании отдельно —
   * и той же службой, что рисует сводку: контекст сужается до одной компании,
   * а считает всё равно `DashboardService`. Своего счёта в боте нет и здесь.
   */
  private async compare(me: Me, periodCode: string, uz: boolean): Promise<Screen> {
    const chosen = PERIOD.find((p) => p.code === periodCode) ?? PERIOD[1]!;
    const name = uz ? chosen.uz : chosen.ru;

    if (me.companies.length < 2) {
      return { ...(await this.home(me, periodCode, uz)), toast: C.compareAlone(uz) };
    }

    const parts: {
      name: string;
      kpis: Awaited<ReturnType<DashboardService['summary']>>['kpis'];
    }[] = [];
    try {
      for (const company of me.companies) {
        // Сужаем и `companyIds`, и список компаний: служба решает по ним, чья
        // это сводка, и с двумя компаниями в контексте вернула бы холдинг.
        const one: Me = { ...me, companyIds: [company.id], companies: [company] };
        const out = await this.as(one, uz, () => this.dashboard.summary(chosen.api as Period));
        parts.push({ name: uz ? company.nameUz : company.nameRu, kpis: out.kpis });
      }
    } catch (e) {
      return this.refusal(me, uz, e);
    }

    // Общие показатели — те, что есть у обеих компаний: их и ставим рядом.
    const shared = Object.keys(COMPARE_TITLE).filter((key) =>
      parts.every((p) => p.kpis.some((k) => k.key === key)),
    );
    const sharedLines = shared.map((key) => {
      const first = parts[0]!.kpis.find((k) => k.key === key)!;
      const title = escape(uz ? COMPARE_TITLE[key]!.uz : COMPARE_TITLE[key]!.ru);
      const rows = parts.map((p) => {
        const kpi = p.kpis.find((k) => k.key === key)!;
        return (
          `   ${escape(p.name)}: <b>${this.number(kpi.value)} ${escape(kpi.unit)}</b>` +
          ` — ${this.change(kpi, uz, name)}`
        );
      });
      return `${this.mark(key)} <b>${title}</b>\n${rows.join('\n')}`;
    });

    // Остальное у каждого своё: у завода выпуск и сырьё, у торгового дома
    // исполнение заказов и запас готовой продукции. Сводить их в одну строку
    // значило бы сравнивать тонны сырья с процентом исполнения.
    const ownLines = parts.flatMap((p) =>
      p.kpis
        .filter((k) => !shared.includes(k.key))
        .map(
          (k) =>
            `${this.mark(k.key)} ${escape(p.name)} · ${escape(uz ? k.titleUz : k.titleRu)}: ` +
            `<b>${this.number(k.value)} ${escape(k.unit)}</b>`,
        ),
    );

    const text =
      `${C.compareHead(uz, name)}\n\n` +
      `<blockquote>${sharedLines.join('\n')}</blockquote>\n\n` +
      `${C.compareOwn(uz)}\n<blockquote>${ownLines.join('\n')}</blockquote>\n\n` +
      `${C.compareAbout(uz)}`;

    return {
      text,
      keyboard: [
        PERIOD.map((p) => ({
          text: `${p.code === chosen.code ? '✅ ' : ''}${uz ? p.uz : p.ru}`,
          data: CB.chiefPeriod(p.code),
          style: BLUE,
        })),
        this.row(chosen.code, uz),
      ],
      flow: this.flow(chosen.code),
    };
  }

  /** Как изменилось против прошлого срока — словами, а не стрелкой. */
  private change(
    kpi: Awaited<ReturnType<DashboardService['summary']>>['kpis'][number],
    uz: boolean,
    periodName: string,
  ): string {
    if (kpi.deltaPercent === null) return C.noCompare(uz);
    const value = Number(kpi.deltaPercent);
    if (value === 0) return C.flat(uz);
    return value > 0
      ? C.up(uz, this.number(kpi.deltaPercent), periodName)
      : C.down(uz, this.number(String(Math.abs(value))), periodName);
  }

  /** Одна цифра человеку: что это, сколько и как изменилось против прошлого срока. */
  private kpiLines(
    kpi: Awaited<ReturnType<DashboardService['summary']>>['kpis'][number],
    uz: boolean,
    periodName: string,
  ): string {
    const title = escape(uz ? kpi.titleUz : kpi.titleRu);
    const value = `${this.number(kpi.value)} ${escape(kpi.unit)}`;
    const change = this.change(kpi, uz, periodName);
    const sub = escape(uz ? kpi.sub1Uz : kpi.sub1Ru);
    return `${this.mark(kpi.key)} <b>${title}</b>: ${value}\n   ${change}\n   ${sub}`;
  }

  /** Значок цифры: руководитель узнаёт строку по нему быстрее, чем по слову. */
  private mark(key: string): string {
    if (key === 'revenue') return '💰';
    if (key === 'shipped_tons') return '🚚';
    if (key === 'produced_tons') return '🏭';
    if (key.endsWith('_stock')) return '📦';
    return 'ℹ️';
  }

  /**
   * Числа из служб приходят с точкой — человеку нужна запятая и разряды.
   *
   * Знаки после запятой оставляем те, что дала служба: она уже решила, что
   * выручка идёт с двумя, а тонны с одним. Своё округление здесь означало бы,
   * что телефон и браузер показывают руководителю разные числа — «99,2» против
   * «99,20» он прочтёт как разные деньги.
   */
  private number(value: string): string {
    const [whole, fraction] = String(value).split('.');
    const parsed = Number(whole);
    if (!Number.isFinite(parsed)) return escape(value);
    const grouped = new Intl.NumberFormat('ru-RU').format(parsed);
    return fraction === undefined ? grouped : `${grouped},${fraction}`;
  }

  private keyboard(me: Me, periodCode: string, uz: boolean): InlineKeyboard {
    const periods: InlineButton[] = PERIOD.map((p) => ({
      // Выбранный срок помечен галочкой: иначе на экране не видно, за что цифры.
      text: `${p.code === periodCode ? '✅ ' : ''}${uz ? p.uz : p.ru}`,
      data: CB.chiefPeriod(p.code),
      style: BLUE,
    }));
    const rows: InlineKeyboard = [periods];
    rows.push([
      {
        text: uz ? '🕓 Qarorni kutmoqda' : '🕓 Ждут решения',
        data: CB.chiefWaiting,
        style: GREEN,
      },
      {
        text: uz ? '⚠️ Nimaga qarash' : '⚠️ На что смотреть',
        data: CB.chiefAlarms,
        style: BLUE,
      },
    ]);
    if (me.companies.length > 1) {
      rows.push([
        {
          text: uz ? '⚖️ Kompaniyalarni solishtirish' : '⚖️ Сравнить компании',
          data: CB.chiefCompare,
          style: BLUE,
        },
      ]);
    }
    rows.push([{ text: uz ? '⬅️ Menyu' : '⬅️ Меню', data: CB.menu, style: BLUE }]);
    return rows;
  }

  private flow(periodCode: string): Flow {
    return { kind: 'chief', step: 'view', period: periodCode };
  }

  private row(periodCode: string, uz: boolean): InlineButton[] {
    return [
      { text: uz ? '⬅️ Xulosa' : '⬅️ Сводка', data: CB.chiefPeriod(periodCode), style: BLUE },
      { text: uz ? '⬅️ Menyu' : '⬅️ Меню', data: CB.menu, style: BLUE },
    ];
  }

  // --- что ждёт решения -----------------------------------------------------

  /**
   * Одним списком то, что стоит без решения этого человека — и сразу переход в
   * карточку нужного раздела.
   *
   * Список собран по правам, а не по статусам: согласующему нужны отправленные
   * операции, проводящему — уже согласованные. Показывать то, что человек всё
   * равно не может сдвинуть, значит превращать список в упрёк.
   */
  private async waiting(me: Me, periodCode: string, uz: boolean): Promise<Screen> {
    const canFinance = me.permissions.has('finance.approve') || me.permissions.has('finance.post');
    const canDocuments = me.permissions.has('documents.approve');
    if (!canFinance && !canDocuments) {
      return {
        text: `${C.waitingHead(uz)}\n\n${C.waitingNoRight(uz)}`,
        keyboard: [this.row(periodCode, uz)],
        flow: this.flow(periodCode),
      };
    }

    const lines: string[] = [];
    const keyboard: InlineKeyboard = [];

    if (canFinance) {
      const statuses: ('pending_approval' | 'approved')[] = [];
      if (me.permissions.has('finance.approve')) statuses.push('pending_approval');
      if (me.permissions.has('finance.post')) statuses.push('approved');
      const rows = (
        await this.as(me, uz, () =>
          Promise.all(
            statuses.map((status) => this.operations.list({ status, limit: LIST_LIMIT })),
          ),
        )
      )
        .flatMap((b) => b.rows)
        .slice(0, LIST_LIMIT);
      if (rows.length > 0) {
        lines.push(`<b>${C.financeGroup(uz)}</b>`);
        for (const r of rows) {
          const what = escape(
            r.cashflowItem?.nameRu ?? (r.type === 'income' ? 'поступление' : 'расход'),
          );
          lines.push(`• ${escape(r.number)} · ${this.money(r.amount, r.currency, uz)} · ${what}`);
          keyboard.push([
            {
              text: `💵 ${r.number} · ${this.money(r.amount, r.currency, uz)}`,
              // Кнопка ведёт в карточку раздела «Финансы»: решение принимают
              // там, где для него есть кнопки и объяснение статуса.
              data: CB.finOp(r.uid),
              style: BLUE,
            },
          ]);
        }
      }
    }

    if (canDocuments) {
      const out = await this.as(me, uz, () =>
        this.documents.list({ status: 'pending_approval', limit: LIST_LIMIT }),
      );
      if (out.rows.length > 0) {
        lines.push(`<b>${C.documentsGroup(uz)}</b>`);
        for (const d of out.rows) {
          const partner = d.partner?.name ?? (uz ? d.type.nameUz : d.type.nameRu);
          lines.push(
            `• ${escape(d.number)} · ${this.money(d.amountTotal, d.currency ?? 'UZS', uz)} · ` +
              escape(partner),
          );
          keyboard.push([
            { text: `📄 ${d.number} · ${escape(partner)}`, data: CB.docOne(d.uid), style: BLUE },
          ]);
        }
      }
    }

    keyboard.push(this.row(periodCode, uz));
    const text =
      lines.length === 0
        ? `${C.waitingHead(uz)}\n\n${C.waitingNone(uz)}`
        : `${C.waitingHead(uz)}\n\n<blockquote>${lines.join('\n')}</blockquote>\n\n` +
          C.waitingAbout(uz);
    return { text, keyboard, flow: this.flow(periodCode) };
  }

  /**
   * Сводка округляет суммы до целых: в списке решений копейки не нужны. Валюта
   * подписывается на языке человека той же таблицей, что у остальных разделов,
   * — иначе одна система в двух местах называет сум по-разному.
   */
  private money(amount: string | number, currency: string, uz: boolean): string {
    const shown = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(
      Number(amount),
    );
    return `${shown} ${escape(currencyMark(currency, uz))}`;
  }

  // --- отклонения -----------------------------------------------------------

  /**
   * Те же строки, что в приветствии, но полным списком: экран открывают
   * намеренно, и прятать половину тревог здесь незачем.
   */
  private async alarms(me: Me, periodCode: string, uz: boolean): Promise<Screen> {
    let found: Awaited<ReturnType<DigestService['all']>>;
    try {
      found = await this.digest.all(me.userId, me.companyIds, me.permissions);
    } catch (e) {
      return this.refusal(me, uz, e);
    }
    const alarms = found.filter((l) => l.severity !== 'info');
    const keyboard: InlineKeyboard = [];
    const jump: InlineButton[] = [];
    if (me.permissions.has('finance.view')) {
      jump.push({ text: uz ? '💰 Qarzlar' : '💰 Долги', data: CB.finDebts, style: BLUE });
    }
    if (me.permissions.has('warehouse.view')) {
      jump.push({
        text: uz ? '📉 Nima yetishmaydi' : '📉 Чего не хватает',
        data: CB.whNeeds,
        style: BLUE,
      });
    }
    if (jump.length) keyboard.push(jump);
    if (me.permissions.has('documents.view')) {
      keyboard.push([
        {
          text: uz ? '📄 Tasdiqlashni kutmoqda' : '📄 Ждут согласования',
          data: CB.docTab('wait'),
          style: BLUE,
        },
      ]);
    }
    keyboard.push(this.row(periodCode, uz));

    const text =
      alarms.length === 0
        ? `${C.alarmsHead(uz)}\n\n${C.alarmsNone(uz)}`
        : `${C.alarmsHead(uz)}\n\n<blockquote>${alarms
            .map((l) => `${DigestService.mark(l.severity)} ${uz ? l.uz : l.ru}`)
            .join('\n')}</blockquote>\n\n${C.alarmsAbout(uz)}`;
    return { text, keyboard, flow: this.flow(periodCode) };
  }

  /** Отказ службы — человеку её словами: они уже написаны для людей. */
  private refusal(me: Me, uz: boolean, e: unknown): Screen {
    const message = String((e as { message?: string }).message ?? e);
    this.log.warn(`сводка в боте: ${message}`);
    return {
      text: `${C.refused(uz, escape(message))}\n\n${C.alarmsAbout(uz)}`,
      keyboard: [[{ text: uz ? '⬅️ Menyu' : '⬅️ Меню', data: CB.menu, style: BLUE }]],
      flow: null,
    };
  }
}
