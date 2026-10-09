import { Injectable, Logger } from '@nestjs/common';
import { RatesService } from '../refs/rates.service.js';
import { asUser, escape, type Me, type Screen } from './section.js';
import { BLUE, CB, backRow } from './menu.js';
import { currencyMark, showDay } from './format.js';
import { R, flagOf } from './rates.texts.js';

/**
 * «💱 Курс валют» — экран, который видит каждый вошедший (решение клиента
 * 03.10.2026: «кнопку для всех, думаю там всем может пригодиться»).
 *
 * Права здесь нет сознательно: официальный курс ЦБ РУз — не данные компании, а
 * открытая цифра с сайта банка, и кладовщику она так же нужна, как финансисту.
 * Правом закрыта только кнопка «Обновить»: она пишет в справочник, а это уже
 * правка общих данных.
 *
 * Своего курса бот не считает и в банк сам не ходит: и экран, и загрузка — та
 * же служба, что рисует панель курса в браузере. Иначе бот и система однажды
 * ответили бы разное на один вопрос.
 */
@Injectable()
export class BotRates {
  private readonly log = new Logger('bot');

  constructor(private readonly rates: RatesService) {}

  /** Право на кнопку «Обновить» — то же, что у справочников в вебе. */
  private mayRefresh(me: Me): boolean {
    return me.permissions.has('refs.edit');
  }

  async route(me: Me, data: string, uz: boolean): Promise<Screen> {
    if (data === CB.ratesSync) {
      if (!this.mayRefresh(me)) {
        return { ...(await this.screen(me, uz)), toast: R.refreshFailed(uz) };
      }
      try {
        const res = await asUser(me, uz, () =>
          this.rates.sync({ force: true, userDriven: true }),
        );
        return {
          ...(await this.screen(me, uz)),
          toast: res.date ? R.refreshed(uz, showDay(res.date)) : R.refreshFailed(uz),
        };
      } catch (e) {
        // Недоступный банк — не повод показать человеку ошибку сервера:
        // экран остаётся на последнем известном курсе.
        this.log.warn(`курс по кнопке не обновился: ${(e as Error).message}`);
        return { ...(await this.screen(me, uz)), toast: R.refreshFailed(uz) };
      }
    }
    return this.screen(me, uz);
  }

  /** Сам экран: валюты, курс к суму, когда проверяли и чем это грозит. */
  async screen(me: Me, uz: boolean): Promise<Screen> {
    const data = await asUser(me, uz, () => this.rates.list());
    const parts: string[] = [R.title(uz), ''];

    const foreign = data.rows.filter((r) => !r.isBase);
    const base = data.rows.find((r) => r.isBase);

    parts.push(R.head(uz, showDay(data.today)), '');

    for (const row of foreign) {
      const name = escape(uz ? row.nameUz : row.nameRu);
      const mark = currencyMark(row.code, uz);
      if (!row.rate) {
        parts.push(`${flagOf(row.code)} <b>${name}</b>${R.noRate(uz)}`, '');
        continue;
      }
      const value = this.money(row.rate, base?.code ?? 'UZS', uz);
      let line = R.line(uz, flagOf(row.code), name, mark, value);
      if (row.diff !== null && Math.abs(row.diff) >= 0.01) {
        line += R.change(uz, row.diff > 0, this.number(Math.abs(row.diff)));
      }
      // Курс не сегодняшний — говорим прямо, а не делаем вид, что он свежий.
      if (row.stale && row.rateDate) line += R.onDay(uz, showDay(row.rateDate));
      parts.push(line, '');
    }

    if (base) {
      parts.push(R.base(uz, flagOf(base.code), escape(uz ? base.nameUz : base.nameRu)), '');
    }

    parts.push(R.why(uz));
    if (data.sourceError) parts.push('', R.bankSilent(uz, escape(data.sourceError)));
    if (data.checkedAt) parts.push('', R.checked(uz, this.clock(data.checkedAt)));

    const keyboard = [
      ...(this.mayRefresh(me)
        ? [[{ text: R.refresh(uz), data: CB.ratesSync, style: BLUE }]]
        : []),
      backRow(uz),
    ];

    return { text: parts.join('\n'), keyboard, flow: null };
  }

  /** Курс печатается с двумя знаками: копейки рубля иначе теряются. */
  private money(rate: string, baseCode: string, uz: boolean): string {
    return `${this.number(Number(rate))} ${currencyMark(baseCode, uz)}`;
  }

  private number(value: number): string {
    return new Intl.NumberFormat('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  /** Время по Ташкенту: человек смотрит на свои часы, а не на часовой пояс базы. */
  private clock(iso: string): string {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Asia/Tashkent',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  }
}
