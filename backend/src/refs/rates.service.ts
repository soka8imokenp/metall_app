import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { writeAudit } from '../common/audit.js';
import { currentContext } from '../common/request-context.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Валюты и курсы (ТЗ 6.1–6.3).
 *
 * Требование 6.2 называет две вещи прямо: «ручной ввод обязателен, автозагрузка
 * — по доступности источника ЦБ РУз». До 03.10.2026 в системе не было ни того,
 * ни другого: курсы приходили только с посевом, и валютная операция считалась
 * по курсу того дня, когда базу посеяли.
 *
 * Здесь оба пути. Загрузка идёт с открытого архива ЦБ РУз, он отдаёт официальный
 * курс на дату — не биржевую цену в моменте: банк публикует курс раз в рабочий
 * день. Поэтому «в реальном времени» для этого источника значит «на сегодня, и
 * мы проверили его столько-то минут назад».
 *
 * Два правила, которые делают загрузку безопасной:
 *   - курс, введённый человеком (`source = 'manual'`), загрузка не затирает:
 *     раз человек поставил его осознанно, банк не спорит;
 *   - банк не опрашивается, когда курс на сегодня уже есть, а после неудачи
 *     следующая попытка — не раньше чем через 15 минут. Иначе каждое открытие
 *     экрана стучалось бы на cbu.uz, а при недоступном сайте — ещё и ждало бы
 *     таймаут на каждом заходе.
 */

/** Открытый архив курсов ЦБ РУз. Ключей и регистрации не требует. */
export const CBU_URL = 'https://cbu.uz/ru/arkhiv-kursov-valyut/json/';

/** Чем берутся данные банка. В прогонах подменяется, чтобы не ходить в сеть. */
export const CBU_FETCH = 'CBU_FETCH';
export type CbuFetch = () => Promise<unknown>;

export const cbuFetchLive: CbuFetch = async () => {
  // Таймаут обязателен: без него недоступный сайт банка держал бы запрос
  // экрана до таймаута узла, а курс нужен не настолько срочно.
  const res = await fetch(CBU_URL, {
    signal: AbortSignal.timeout(8_000),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`ЦБ РУз ответил ${res.status}`);
  return res.json();
};

export interface CbuRate {
  code: string;
  rate: number;
  rateDate: string;
  nameRu: string;
  nameUz: string;
}

/** Символы валют: банк их не отдаёт, а на экране «$» понятнее, чем «USD». */
const SYMBOLS: Record<string, string> = {
  UZS: 'сўм',
  USD: '$',
  EUR: '€',
  RUB: '₽',
  GBP: '£',
  KZT: '₸',
  CNY: '¥',
  JPY: '¥',
  TRY: '₺',
  KGS: 'с',
  AED: 'د.إ',
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Разбор ответа банка.
 *
 * Номинал приводится к одной единице: тенге банк публикует за 100, и строка
 * «2185» без деления превратила бы тенге в стоимость доллара. Строку без кода,
 * курса или даты пропускаем молча — это не наша ошибка и не повод терять
 * остальные курсы; а вот ответ, в котором не осталось ни одного курса, — повод
 * отказаться и сказать об этом словами.
 */
export function parseCbu(payload: unknown): CbuRate[] {
  if (!Array.isArray(payload)) {
    throw new Error('ЦБ РУз вернул не список курсов');
  }
  const out: CbuRate[] = [];
  for (const raw of payload) {
    const row = raw as Record<string, unknown>;
    const code = String(row.Ccy ?? '').trim().toUpperCase();
    const rate = Number(String(row.Rate ?? '').replace(',', '.'));
    const nominal = Number(String(row.Nominal ?? '1').replace(/\s/g, '')) || 0;
    const date = String(row.Date ?? '').trim();
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date);
    if (!/^[A-Z]{3}$/.test(code) || !Number.isFinite(rate) || rate <= 0) continue;
    if (nominal <= 0 || !m) continue;
    out.push({
      code,
      rate: rate / nominal,
      rateDate: `${m[3]}-${m[2]}-${m[1]}`,
      nameRu: String(row.CcyNm_RU ?? code).trim(),
      nameUz: String(row.CcyNm_UZ ?? code).trim(),
    });
  }
  if (out.length === 0) throw new Error('ЦБ РУз не дал ни одного курса');
  return out;
}

/**
 * Сегодня по Ташкенту.
 *
 * Сессия базы живёт в UTC (см. PrismaService), поэтому `current_date` после
 * 19:00 по Ташкенту показывает ещё вчерашний день — и курс «на сегодня»
 * полночи считался бы отсутствующим. Выражение подставляется в текст запроса, а
 * не параметром: параметр Prisma уходит в SQL строкой и датой не становится.
 */
const TODAY = `(now() AT TIME ZONE 'Asia/Tashkent')::date`;

/** Валюта так, как её показывают экраны: веб-панель и бот берут одно и то же. */
export interface CurrencyView {
  code: string;
  nameRu: string;
  nameUz: string;
  symbol: string;
  precision: number;
  autoload: boolean;
  isBase: boolean;
  rate: string | null;
  rateDate: string | null;
  source: string | null;
  updatedAt: string | null;
  diff: number | null;
  prevDate: string | null;
  /** Курс есть, но не на сегодня: банк не ответил или ещё не опубликовал. */
  stale: boolean;
  operations: number;
}

interface CurrencyRow {
  code: string;
  name_ru: string;
  name_uz: string;
  symbol: string;
  precision: number;
  autoload: boolean;
  rate: string | null;
  rate_date: string | null;
  source: string | null;
  updated_at: Date | null;
  prev_rate: string | null;
  prev_date: string | null;
  used: bigint;
}

@Injectable()
export class RatesService {
  private readonly log = new Logger('rates');
  /** До этого времени банк не трогаем: прошлая попытка курс на сегодня не дала. */
  private backoffUntil = 0;
  private lastError: string | null = null;
  private readonly BACKOFF_MS = 15 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CBU_FETCH) private readonly fetchCbu: CbuFetch,
  ) {}

  /** Учётные валюты компаний, доступных в этом запросе. */
  private async baseCurrencies(tx: Tx): Promise<string[]> {
    const rows = await tx.$queryRaw<{ base_currency: string }[]>`
      SELECT DISTINCT base_currency FROM company`;
    return rows.map((r) => r.base_currency);
  }

  /**
   * Справочник целиком: валюта, последний известный курс, его дата и источник,
   * изменение к предыдущей известной дате.
   *
   * Перед выдачей сам доберёт курс на сегодня, если его нет: человек не должен
   * помнить про кнопку, а операция в валюте не должна считаться по вчерашнему.
   */
  async list(): Promise<{
    rows: CurrencyView[];
    today: string;
    checkedAt: string | null;
    sourceError: string | null;
    sourceUrl: string;
  }> {
    await this.ensureFresh();
    return this.prisma.withTenant(async (tx) => {
      const base = await this.baseCurrencies(tx);
      const rows = await tx.$queryRaw<CurrencyRow[]>`
        SELECT c.code, c.name_ru, c.name_uz, c.symbol, c.precision, c.autoload,
               r.rate::text AS rate, r.rate_date::text AS rate_date, r.source,
               r.created_at AS updated_at,
               p.rate::text AS prev_rate, p.rate_date::text AS prev_date,
               (SELECT count(*) FROM finance_operation o WHERE o.currency_id = c.id)::bigint AS used
          FROM currency c
          LEFT JOIN LATERAL (
            SELECT rr.rate, rr.rate_date, rr.source, rr.created_at
              FROM currency_rate rr
             WHERE rr.currency_id = c.id AND rr.rate_date <= ${Prisma.raw(TODAY)}
             ORDER BY rr.rate_date DESC LIMIT 1) r ON true
          LEFT JOIN LATERAL (
            SELECT pp.rate, pp.rate_date
              FROM currency_rate pp
             WHERE pp.currency_id = c.id AND pp.rate_date < r.rate_date
             ORDER BY pp.rate_date DESC LIMIT 1) p ON true
         ORDER BY c.code`;
      const today = await this.today(tx);
      const checked = rows
        .map((r) => r.updated_at)
        .filter((d): d is Date => !!d)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      return {
        today,
        checkedAt: checked ? checked.toISOString() : null,
        sourceError: this.lastError,
        sourceUrl: CBU_URL,
        rows: rows.map((r) => {
          const isBase = base.includes(r.code);
          return {
            code: r.code,
            nameRu: r.name_ru || r.code,
            nameUz: r.name_uz || r.code,
            symbol: r.symbol,
            precision: r.precision,
            autoload: r.autoload,
            isBase,
            /** У учётной валюты курса нет: она сама себе единица. */
            rate: isBase ? null : r.rate,
            rateDate: isBase ? null : r.rate_date,
            source: isBase ? null : r.source,
            updatedAt: isBase || !r.updated_at ? null : r.updated_at.toISOString(),
            diff: isBase || !r.rate || !r.prev_rate ? null : Number(r.rate) - Number(r.prev_rate),
            prevDate: isBase ? null : r.prev_date,
            stale: !isBase && r.rate_date !== null && r.rate_date !== today,
            operations: Number(r.used),
          };
        }),
      };
    });
  }

  private async today(tx: Tx): Promise<string> {
    const rows = await tx.$queryRaw<{ d: string }[]>`SELECT ${Prisma.raw(TODAY)}::text AS d`;
    return rows[0]!.d;
  }

  /** История курса по дням: новые сверху. */
  async history(code: string, limit: number) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        { rate: string; rate_date: string; source: string | null; created_at: Date }[]
      >`
        SELECT r.rate::text AS rate, r.rate_date::text AS rate_date, r.source, r.created_at
          FROM currency_rate r JOIN currency c ON c.id = r.currency_id
         WHERE c.code = ${code}
         ORDER BY r.rate_date DESC
         LIMIT ${limit}`;
      return {
        rows: rows.map((r) => ({
          rate: r.rate,
          rateDate: r.rate_date,
          source: r.source,
          updatedAt: r.created_at.toISOString(),
        })),
      };
    });
  }

  /**
   * Курс руками (ТЗ 6.2). Это решение человека, поэтому оно идёт в журнал
   * действий и помечается источником `manual` — загрузка его не перепишет.
   */
  async setRate(code: string, input: { rateDate: string; rate: number }) {
    const rate = Number(input.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new BadRequestException(MSG.ratePositive());
    }
    if (rate > 1e9) {
      throw new BadRequestException(say('Курс слишком большой: проверьте, не лишний ли это ноль', 'Kurs juda katta: ortiqcha nol yo‘qmi, tekshirib ko‘ring'));
    }
    if (!DAY.test(input.rateDate) || Number.isNaN(Date.parse(input.rateDate))) {
      throw new BadRequestException(say('Дата курса — днём, например 2026-10-03', 'Kurs sanasi — kun bilan, masalan 2026-10-03'));
    }

    return this.prisma.withTenant(async (tx) => {
      const cur = await tx.$queryRaw<{ id: bigint; code: string }[]>`
        SELECT id, code FROM currency WHERE code = ${code}`;
      if (cur.length === 0) throw new NotFoundException(MSG.currencyNotFound(code));
      const base = await this.baseCurrencies(tx);
      if (base.includes(code)) {
        throw new BadRequestException(say(
          `${code} — учётная валюта компании, курса у неё нет: она сама себе единица`, `${code} — kompaniyaning hisob valyutasi, uning kursi yo‘q: u o‘ziga o‘zi birlik`));
      }
      const today = await this.today(tx);
      // Курс на послезавтра и дальше — почти наверняка опечатка в дате: банк
      // публикует на сегодня и на завтра.
      if (input.rateDate > this.shift(today, 2)) {
        throw new BadRequestException(say('Курс на будущую дату вводить нельзя', 'Kelgusi sanaga kurs kiritib bo‘lmaydi'));
      }

      const was = await tx.$queryRaw<{ rate: string; source: string | null }[]>`
        SELECT rate::text AS rate, source FROM currency_rate
         WHERE currency_id = ${cur[0]!.id} AND rate_date = ${input.rateDate}::date`;

      await tx.$queryRawUnsafe(
        `INSERT INTO currency_rate (currency_id, rate_date, rate, source, created_at)
         VALUES ($1, $2::date, $3::numeric, 'manual', now())
         ON CONFLICT (currency_id, rate_date)
         DO UPDATE SET rate = EXCLUDED.rate, source = 'manual', created_at = now()`,
        cur[0]!.id,
        input.rateDate,
        rate.toFixed(8),
      );

      await writeAudit(tx, {
        companyId: await this.auditCompany(tx),
        entityType: 'currency_rate',
        entityId: `${code}:${input.rateDate}`,
        action: 'rate',
        changes: {
          currency: { from: null, to: code },
          date: { from: null, to: input.rateDate },
          rate: { from: was[0]?.rate ?? null, to: rate.toFixed(8) },
          source: { from: was[0]?.source ?? null, to: 'manual' },
        },
      });

      return { code, rateDate: input.rateDate, rate: rate.toFixed(8), source: 'manual' };
    });
  }

  /** Включить или выключить автозагрузку курса этой валюты. */
  async setAutoload(code: string, autoload: boolean) {
    return this.prisma.withTenant(async (tx) => {
      const cur = await tx.$queryRaw<{ id: bigint; autoload: boolean }[]>`
        SELECT id, autoload FROM currency WHERE code = ${code}`;
      if (cur.length === 0) throw new NotFoundException(MSG.currencyNotFound(code));
      const base = await this.baseCurrencies(tx);
      if (base.includes(code) && autoload) {
        throw new BadRequestException(say(`${code} — учётная валюта, курс для неё не загружается`, `${code} — hisob valyutasi, unga kurs yuklanmaydi`));
      }
      await tx.$queryRaw`UPDATE currency SET autoload = ${autoload} WHERE id = ${cur[0]!.id}`;
      await writeAudit(tx, {
        companyId: await this.auditCompany(tx),
        entityType: 'currency',
        entityId: code,
        action: 'update',
        changes: { autoload: { from: cur[0]!.autoload, to: autoload } },
      });
      return { code, autoload };
    });
  }

  /**
   * Новая валюта — по коду из списка банка. Название, символ и курс берём
   * оттуда же: заводить валюту руками по буквам значит получить «Евро», «ЕВРО»
   * и «euro» в одном справочнике.
   */
  async addCurrency(code: string) {
    const up = code.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(up)) throw new BadRequestException(say('Код валюты — три латинские буквы', 'Valyuta kodi — uch lotin harfi'));

    let found: CbuRate | undefined;
    try {
      found = parseCbu(await this.fetchCbu()).find((r) => r.code === up);
    } catch (e) {
      throw new BadRequestException(say(
        `Список валют у ЦБ РУз не получен (${(e as Error).message}): попробуйте позже`, `O‘zbekiston Markaziy bankidan valyutalar ro‘yxati olinmadi (${(e as Error).message}): keyinroq urinib ko‘ring`));
    }
    if (!found) throw new NotFoundException(say(`ЦБ РУз не публикует курс ${up}`, `O‘zbekiston Markaziy banki ${up} kursini e’lon qilmaydi`));

    return this.prisma.withTenant(async (tx) => {
      const exists = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM currency WHERE code = ${up}`;
      if (exists.length > 0) throw new BadRequestException(say(`Валюта ${up} уже заведена`, `${up} valyutasi allaqachon kiritilgan`));

      const made = await tx.$queryRaw<{ id: bigint }[]>`
        INSERT INTO currency (code, symbol, precision, name_ru, name_uz, autoload)
        VALUES (${up}, ${SYMBOLS[up] ?? up}, 2, ${found!.nameRu}, ${found!.nameUz}, true)
        RETURNING id`;
      await tx.$queryRawUnsafe(
        `INSERT INTO currency_rate (currency_id, rate_date, rate, source, created_at)
         VALUES ($1, $2::date, $3::numeric, 'cbu.uz', now())
         ON CONFLICT (currency_id, rate_date) DO NOTHING`,
        made[0]!.id,
        found!.rateDate,
        found!.rate.toFixed(8),
      );
      await writeAudit(tx, {
        companyId: await this.auditCompany(tx),
        entityType: 'currency',
        entityId: up,
        action: 'create',
        changes: {
          code: { from: null, to: up },
          name: { from: null, to: found!.nameRu },
          rate: { from: null, to: found!.rate.toFixed(8) },
        },
      });
      return { code: up, nameRu: found!.nameRu, rate: found!.rate.toFixed(8) };
    });
  }

  /** Какие валюты банк публикует, а у нас их ещё нет — для формы «добавить». */
  async available() {
    let rows: CbuRate[] = [];
    let error: string | null = null;
    try {
      rows = parseCbu(await this.fetchCbu());
    } catch (e) {
      error = (e as Error).message;
    }
    const have = await this.prisma.withTenant(
      (tx) => tx.$queryRaw<{ code: string }[]>`SELECT code FROM currency`,
    );
    const known = new Set(have.map((h) => h.code));
    return {
      error,
      rows: rows
        .filter((r) => !known.has(r.code))
        .map((r) => ({ code: r.code, nameRu: r.nameRu, nameUz: r.nameUz, rate: r.rate })),
    };
  }

  /**
   * Загрузка курсов с ЦБ РУз.
   *
   * `force` — нажатая человеком кнопка: спрашиваем банк даже если курс на
   * сегодня уже есть. Без него загрузку зовёт расписание и сам экран.
   */
  async sync(options: { force?: boolean; userDriven?: boolean } = {}) {
    const started = Date.now();
    let fetched: CbuRate[];
    try {
      fetched = parseCbu(await this.fetchCbu());
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.backoffUntil = started + this.BACKOFF_MS;
      this.log.warn(`курсы с ЦБ РУз не получены: ${this.lastError}`);
      if (options.force) {
        throw new BadRequestException(say(`ЦБ РУз не ответил: ${this.lastError}`, `O‘zbekiston Markaziy banki javob bermadi: ${this.lastError}`));
      }
      return { saved: 0, kept: 0, skipped: 0, date: null, error: this.lastError };
    }

    const result = await this.prisma.withTenant(async (tx) => {
      const targets = await tx.$queryRaw<{ id: bigint; code: string }[]>`
        SELECT id, code FROM currency WHERE autoload`;
      let saved = 0;
      let kept = 0;
      const changed: string[] = [];
      let date: string | null = null;

      for (const t of targets) {
        const row = fetched.find((r) => r.code === t.code);
        if (!row) continue;
        date = row.rateDate;
        const out = await tx.$queryRawUnsafe<{ id: bigint }[]>(
          `INSERT INTO currency_rate (currency_id, rate_date, rate, source, created_at)
           VALUES ($1, $2::date, $3::numeric, 'cbu.uz', now())
           ON CONFLICT (currency_id, rate_date)
           DO UPDATE SET rate = EXCLUDED.rate, source = 'cbu.uz', created_at = now()
            WHERE currency_rate.source IS DISTINCT FROM 'manual'
           RETURNING currency_rate.id`,
          t.id,
          row.rateDate,
          row.rate.toFixed(8),
        );
        if (out.length > 0) {
          saved += 1;
          changed.push(`${t.code} ${row.rate.toFixed(2)}`);
        } else {
          // Строку с источником `manual` загрузка не трогает: курс поставил
          // человек, и переписать его молча нельзя.
          kept += 1;
        }
      }

      // В журнал действий идёт только нажатая кнопка. Загрузку по расписанию
      // туда писать нельзя: это строка каждый день без человека за ней, а
      // откуда курс — и так видно в самом справочнике (источник и время).
      if (options.userDriven && changed.length > 0) {
        await writeAudit(tx, {
          companyId: await this.auditCompany(tx),
          entityType: 'currency_rate',
          entityId: `cbu:${date}`,
          action: 'rate',
          changes: {
            source: { from: null, to: 'cbu.uz' },
            date: { from: null, to: date },
            rates: { from: null, to: changed.join(', ') },
          },
        });
      }

      return { saved, kept, skipped: targets.length - saved - kept, date };
    });

    // Удачная загрузка снимает паузу: причина, по которой банк не трогали,
    // исчезла. Без этого одна неудача глушила автозагрузку на 15 минут даже
    // после того, как курс уже пришёл кнопкой.
    if (result.saved > 0) this.backoffUntil = 0;

    this.log.log(
      `курсы ЦБ РУз на ${result.date}: записано ${result.saved}, ` +
        `оставлено ручных ${result.kept} (${Date.now() - started} мс)`,
    );
    return { ...result, error: null as string | null };
  }

  /**
   * Добрать курс на сегодня, если его нет.
   *
   * Зовётся при каждом чтении справочника и по расписанию. Банк при этом
   * опрашивается редко: пока курс на сегодня лежит в базе, в сеть не ходим
   * вовсе, а после неудачной попытки ждём 15 минут.
   */
  async ensureFresh(): Promise<void> {
    if (process.env.RATES_AUTOLOAD === 'off') return;
    if (Date.now() < this.backoffUntil) return;

    const missing = await this.prisma.withTenant(
      (tx) => tx.$queryRaw<{ code: string }[]>`
        SELECT c.code FROM currency c
         WHERE c.autoload
           AND NOT EXISTS (
             SELECT 1 FROM currency_rate r
              WHERE r.currency_id = c.id AND r.rate_date = ${Prisma.raw(TODAY)})
         LIMIT 1`,
    );
    if (missing.length === 0) return;

    const res = await this.sync();
    // Банк мог ответить, но курса на сегодня ещё не опубликовать (выходной,
    // раннее утро). Это не ошибка, но и дёргать его каждую минуту незачем.
    if (res.saved === 0) this.backoffUntil = Date.now() + this.BACKOFF_MS;
  }

  /**
   * Компания для записи в журнал. Справочник валют общий, а журнал ведётся по
   * компаниям — пишем в ту, в которой человек работает сейчас.
   */
  private async auditCompany(tx: Tx): Promise<bigint> {
    const ctx = currentContext();
    if (ctx?.companyIds?.length) return ctx.companyIds[0]!;
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM company ORDER BY id LIMIT 1`;
    return rows[0]!.id;
  }

  private shift(iso: string, days: number): string {
    return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  }
}
