/**
 * Валюты и курсы (ТЗ 6.1-6.3) — два экрана об одном.
 *
 * `RatesStrip` — панелька в финансах: официальный курс ЦБ РУз на сегодня,
 * время последней проверки и кнопка «Обновить» на случай «нужно прямо сейчас».
 * Банк публикует официальный курс раз в рабочий день, поэтому «в реальном
 * времени» здесь значит «на сегодня, проверено столько-то минут назад», а не
 * биржевой тик: другого официального курса для учёта в Узбекистане нет.
 *
 * `CurrencySettings` — вкладка в «Настройках»: справочник валют, ручной ввод
 * курса на дату (ТЗ 6.2 требует его прямо), автозагрузка по валютам и история.
 *
 * Своих правил экран не придумывает: отказы приходят от сервера словами, и мы
 * показываем их как есть.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Plus, RefreshCw } from 'lucide-react';
import type { CbuCurrency, CurrenciesPage, CurrencyRateRow, CurrencyRow } from '../../types/api';
import { apiClient, ApiError } from '../../lib/api-client';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { BTN_GHOST, BTN_PRIMARY, CARD, ErrorBox, FIELD, Skeleton } from './warehouse-ui';
import { CustomDatePicker } from '../common/CustomDatePicker';
import { formatDate, formatNumber, refName } from '../../lib/formatters';

/** Курс печатается с четырьмя знаками: у рубля два знака теряют копейки. */
const rate = (value: string | null, precision = 4) =>
  value === null ? '—' : formatNumber(Number(value), precision);

const clock = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : null;

const SOURCE: Record<string, { ru: string; uz: string }> = {
  'cbu.uz': { ru: 'ЦБ РУз', uz: 'MB' },
  manual: { ru: 'введён руками', uz: 'qo‘lda kiritilgan' },
  demo: { ru: 'демо-значение', uz: 'demo qiymat' },
};

const sourceName = (code: string | null, isUz: boolean) =>
  code ? (SOURCE[code] ? (isUz ? SOURCE[code].uz : SOURCE[code].ru) : code) : '—';

const errorText = (e: unknown, isUz: boolean) =>
  e instanceof ApiError ? e.message : isUz ? 'Xatolik' : 'Ошибка';

/** Общая загрузка справочника: нужна обоим экранам. */
function useCurrencies(pollMs = 0) {
  const [data, setData] = useState<CurrenciesPage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiClient.refs.currencies();
      setData(res.data);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
    if (!pollMs) return;
    // Курс нового дня должен появиться на открытой странице сам. Запрос
    // дешёвый: сервер отдаёт его из базы и в банк идёт только при нужде.
    const timer = window.setInterval(() => void load(), pollMs);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [load, pollMs]);

  return { data, error, busy, setBusy, reload: load };
}

/** Цветная подпись об изменении к предыдущей известной дате. */
const Diff: React.FC<{ row: CurrencyRow }> = ({ row }) => {
  if (row.diff === null || row.diff === 0) return null;
  const up = row.diff > 0;
  return (
    <span
      className={`font-mono text-[10px] ${
        up ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
      }`}
      title={row.prevDate ?? undefined}
    >
      {up ? '▲' : '▼'} {formatNumber(Math.abs(row.diff), 2)}
    </span>
  );
};

/**
 * Панелька курсов в финансах.
 *
 * Стоит над остатками и движением денег, потому что отвечает на вопрос «по
 * какому курсу сейчас считается валютная операция» — а его задают до того, как
 * начинают её заводить.
 */
export const RatesStrip: React.FC = () => {
  const { locale } = useApp();
  const { session } = useAuth();
  const isUz = locale === 'uz';
  const mayEdit = session?.permissions.includes('refs.edit') ?? false;
  const { data, error, busy, setBusy, reload } = useCurrencies(5 * 60_000);
  const [note, setNote] = useState<string | null>(null);

  const sync = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await apiClient.refs.syncCurrencies(true);
      setNote(
        isUz
          ? `${res.data.date ?? ''} kursi yangilandi` +
            (res.data.kept > 0 ? `, qo‘lda kiritilganlar qoldirildi: ${res.data.kept}` : '')
          : `Курс на ${res.data.date ? formatDate(res.data.date) : 'сегодня'} обновлён` +
            (res.data.kept > 0 ? `, введённые руками оставлены: ${res.data.kept}` : ''),
      );
      await reload();
    } catch (e) {
      setNote(errorText(e, isUz));
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) {
    return (
      <div className={CARD}>
        <ErrorBox text={errorText(error, isUz)} onRetry={reload} isUz={isUz} />
      </div>
    );
  }

  const shown = (data?.rows ?? []).filter((r) => !r.isBase);
  const base = (data?.rows ?? []).find((r) => r.isBase);
  const stale = shown.some((r) => r.stale);

  return (
    <div className={`${CARD} p-3 sm:px-4 flex flex-col gap-2`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 min-w-0">
        <span className="text-[11px] font-mono text-zinc-400 uppercase tracking-wider w-full sm:w-auto">
          {isUz ? 'Markaziy bank kursi' : 'Курс ЦБ РУз'}
          {base ? ` · 1 → ${base.code}` : ''}
        </span>

        {!data ? (
          <span className="text-[11px] text-zinc-400 font-mono">
            {isUz ? 'yuklanmoqda…' : 'загрузка…'}
          </span>
        ) : shown.length === 0 ? (
          <span className="text-[11px] text-zinc-400">
            {isUz ? 'Valyuta kursi kerak emas' : 'Валютных курсов не заведено'}
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 min-w-0">
            {shown.map((r) => (
              <span key={r.code} className="flex flex-wrap items-baseline gap-1.5 min-w-0">
                <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
                  {r.code}
                </span>
                <span className="font-mono text-sm font-bold text-zinc-950 dark:text-zinc-50 tabular-nums">
                  {rate(r.rate, 2)}
                </span>
                <Diff row={r} />
                {r.stale && r.rateDate && (
                  <span className="text-[10px] font-mono text-amber-600 dark:text-amber-400">
                    {isUz ? 'sana' : 'на'} {formatDate(r.rateDate)}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto sm:ms-auto">
          <span className="text-[10px] font-mono text-zinc-400">
            {data?.checkedAt
              ? `${isUz ? 'tekshirildi' : 'проверено'} ${clock(data.checkedAt)}`
              : ''}
          </span>
          {mayEdit && (
            <button
              type="button"
              onClick={() => void sync()}
              disabled={busy}
              className={`${BTN_GHOST} h-7 px-2.5 text-[11px] inline-flex items-center gap-1.5 disabled:opacity-50`}
              title={isUz ? 'Markaziy bankdan olish' : 'Загрузить курс с сайта ЦБ РУз'}
            >
              <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
              {isUz ? 'Yangilash' : 'Обновить'}
            </button>
          )}
        </div>
      </div>

      {(data?.sourceError || stale || note) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-zinc-500 dark:text-zinc-400 pt-1.5 border-t border-zinc-100 dark:border-zinc-800/60">
          {data?.sourceError && (
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <AlertTriangle size={11} />
              {isUz
                ? `MB javob bermadi (${data.sourceError}) — oxirgi ma’lum kurs ko‘rsatilgan`
                : `ЦБ РУз не ответил (${data.sourceError}) — показан последний известный курс`}
            </span>
          )}
          {!data?.sourceError && stale && (
            <span className="text-amber-600 dark:text-amber-400">
              {isUz
                ? 'Bugungi kurs hali e’lon qilinmagan: oxirgi ma’lumi ishlatiladi'
                : 'Курса на сегодня у банка ещё нет: считаем по последнему известному'}
            </span>
          )}
          {note && <span className="text-zinc-600 dark:text-zinc-300">{note}</span>}
        </div>
      )}
    </div>
  );
};

/** Справочник валют и курсов в «Настройках». */
export const CurrencySettings: React.FC = () => {
  const { locale } = useApp();
  const { session } = useAuth();
  const isUz = locale === 'uz';
  const mayEdit = session?.permissions.includes('refs.edit') ?? false;
  const { data, error, busy, setBusy, reload } = useCurrencies();

  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<CurrencyRateRow[]>([]);
  const [form, setForm] = useState<{ date: string; value: string }>({ date: '', value: '' });
  const [note, setNote] = useState<string | null>(null);
  const [fail, setFail] = useState<string | null>(null);
  const [available, setAvailable] = useState<CbuCurrency[] | null>(null);

  const openCard = async (row: CurrencyRow) => {
    const next = open === row.code ? null : row.code;
    setOpen(next);
    setNote(null);
    setFail(null);
    if (!next) return;
    setForm({ date: data?.today ?? '', value: row.rate ? Number(row.rate).toFixed(4) : '' });
    try {
      const res = await apiClient.refs.currencyRates(row.code, 30);
      setHistory(res.data.rows);
    } catch (e) {
      setFail(errorText(e, isUz));
    }
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setNote(null);
    setFail(null);
    try {
      await fn();
      setNote(ok);
      await reload();
      if (open) {
        const res = await apiClient.refs.currencyRates(open, 30);
        setHistory(res.data.rows);
      }
    } catch (e) {
      setFail(errorText(e, isUz));
    } finally {
      setBusy(false);
    }
  };

  const loadAvailable = async () => {
    setFail(null);
    try {
      const res = await apiClient.refs.availableCurrencies();
      setAvailable(res.data.rows);
      if (res.data.error) setFail(res.data.error);
    } catch (e) {
      setFail(errorText(e, isUz));
    }
  };

  if (error && !data) {
    return (
      <div className={CARD}>
        <ErrorBox text={errorText(error, isUz)} onRetry={reload} isUz={isUz} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className={`${CARD} p-4 flex flex-col gap-3`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
              {isUz ? 'Valyutalar va kurslar' : 'Валюты и курсы'}
            </div>
            {/* «Что это и зачем» — одной строкой, без пересказа ТЗ. */}
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 max-w-prose break-words">
              {isUz
                ? 'Operatsiya summasi valyutada va hisob valyutasida saqlanadi: kurs o‘tkazilgan payt qotadi va keyin qayta hisoblanmaydi. Ya’ni bugungi kurs faqat bugundan keyingi yozuvlarga ta’sir qiladi.'
                : 'Сумма операции хранится и в валюте, и в учётной валюте компании: курс фиксируется при проведении и задним числом не пересчитывается. Значит сегодняшний курс повлияет только на то, что проведут после него.'}
            </p>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 break-words">
              {isUz ? 'Manba' : 'Источник'}:{' '}
              <span className="font-mono break-all">{data?.sourceUrl ?? 'cbu.uz'}</span>
              {data?.checkedAt
                ? ` · ${isUz ? 'tekshirildi' : 'проверено'} ${clock(data.checkedAt)}`
                : ''}
              {' · '}
              {isUz
                ? 'bank rasmiy kursni ish kunida bir marta e’lon qiladi'
                : 'банк публикует официальный курс раз в рабочий день'}
            </p>
          </div>

          {mayEdit && (
            <div className="flex flex-wrap items-center gap-2 min-w-0 w-full sm:w-auto">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(
                    () => apiClient.refs.syncCurrencies(true),
                    isUz ? 'Kurslar yangilandi' : 'Курсы загружены с ЦБ РУз',
                  )
                }
                className={`${BTN_PRIMARY} h-8 px-3 text-xs inline-flex items-center gap-1.5 disabled:opacity-50`}
              >
                <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
                {isUz ? 'MB dan yuklash' : 'Обновить с ЦБ РУз'}
              </button>
              <button
                type="button"
                onClick={() => (available ? setAvailable(null) : void loadAvailable())}
                className={`${BTN_GHOST} h-8 px-3 text-xs inline-flex items-center gap-1.5`}
              >
                <Plus size={13} />
                {isUz ? 'Valyuta qo‘shish' : 'Добавить валюту'}
              </button>
            </div>
          )}
        </div>

        {(note || fail) && (
          <div
            className={`text-[11px] font-mono rounded-lg px-3 py-2 ${
              fail
                ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
                : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
            }`}
          >
            {fail ?? note}
          </div>
        )}

        {available && (
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 flex flex-col gap-2">
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {isUz
                ? 'Nomi, belgisi va kursi bankdan olinadi'
                : 'Название, символ и курс берутся из списка банка'}
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
              {available.length === 0 && (
                <span className="text-[11px] text-zinc-400">
                  {isUz ? 'Qo‘shadigan valyuta yo‘q' : 'Добавлять нечего: все валюты банка заведены'}
                </span>
              )}
              {available.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(() => apiClient.refs.addCurrency(c.code), `${c.code}: ${c.nameRu}`)
                  }
                  className={`${BTN_GHOST} h-7 px-2 text-[11px] font-mono disabled:opacity-50`}
                  title={refName(c, isUz)}
                >
                  {c.code} {formatNumber(c.rate, 2)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {!data ? (
        <div className={CARD}>
          <Skeleton rows={3} />
        </div>
      ) : (
        <div className={`${CARD} divide-y divide-zinc-100 dark:divide-zinc-800/60`}>
          {data.rows.map((row) => (
            <div key={row.code} className="p-3 sm:p-4 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0">
                <span className="font-mono text-sm font-bold text-zinc-950 dark:text-zinc-50 w-12 shrink-0">
                  {row.code}
                </span>
                <span className="text-xs text-zinc-600 dark:text-zinc-300 min-w-0 truncate">
                  {refName(row, isUz)}{' '}
                  <span className="text-zinc-400">{row.symbol}</span>
                </span>

                {row.isBase ? (
                  <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    {isUz
                      ? 'hisob valyutasi: kursi yo‘q'
                      : 'учётная валюта компании: курса у неё нет'}
                  </span>
                ) : (
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
                    <span className="font-mono text-sm tabular-nums text-zinc-900 dark:text-zinc-100">
                      {rate(row.rate)}
                    </span>
                    <Diff row={row} />
                    <span className="text-[10px] font-mono text-zinc-400 whitespace-nowrap">
                      {row.rateDate ? formatDate(row.rateDate) : isUz ? 'kurs yo‘q' : 'курса нет'} ·{' '}
                      {sourceName(row.source, isUz)}
                    </span>
                    {row.stale && (
                      <span className="text-[10px] font-mono text-amber-600 dark:text-amber-400">
                        {isUz ? 'bugungi emas' : 'не на сегодня'}
                      </span>
                    )}
                  </span>
                )}

                <div className="flex items-center gap-2 ms-auto shrink-0">
                  {!row.isBase && mayEdit && (
                    <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={row.autoload}
                        disabled={busy}
                        onChange={(e) =>
                          void act(
                            () => apiClient.refs.setCurrencyAutoload(row.code, e.target.checked),
                            e.target.checked
                              ? isUz
                                ? `${row.code}: avtomatik yuklash yoqildi`
                                : `${row.code}: автозагрузка включена`
                              : isUz
                                ? `${row.code}: avtomatik yuklash o‘chirildi`
                                : `${row.code}: автозагрузка выключена`,
                          )
                        }
                        className="accent-zinc-900 dark:accent-zinc-100"
                      />
                      {isUz ? 'MB dan avtomatik' : 'Автозагрузка'}
                    </label>
                  )}
                  {!row.isBase && (
                    <button
                      type="button"
                      onClick={() => void openCard(row)}
                      aria-expanded={open === row.code}
                      className={`${BTN_GHOST} h-7 px-2.5 text-[11px]`}
                    >
                      {open === row.code
                        ? isUz
                          ? 'Yopish'
                          : 'Закрыть'
                        : isUz
                          ? 'Kurs va tarix'
                          : 'Курс и история'}
                    </button>
                  )}
                </div>
              </div>

              {open === row.code && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-1">
                  <div className="flex flex-col gap-2 min-w-0">
                    <div className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">
                      {isUz ? 'Kursni qo‘lda kiritish' : 'Ввести курс руками'}
                    </div>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      {isUz
                        ? 'Masalan, bank sanasi uchun kurs e’lon qilmagan bo‘lsa. Qo‘lda kiritilgan kursni avtomatik yuklash o‘chirmaydi.'
                        : 'Нужен, когда банк на эту дату курс не публиковал — например, за выходной. Введённый руками курс автозагрузка не затирает.'}
                    </p>
                    {mayEdit ? (
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="flex flex-col gap-1 min-w-[150px]">
                          <span className="text-[10px] text-zinc-400 uppercase tracking-wider">
                            {isUz ? 'Sana' : 'Дата'}
                          </span>
                          <CustomDatePicker
                            value={form.date}
                            onChange={(v) => setForm((f) => ({ ...f, date: v }))}
                          />
                        </label>
                        <label className="flex flex-col gap-1 min-w-[150px]">
                          <span className="text-[10px] text-zinc-400 uppercase tracking-wider">
                            {isUz ? 'Kurs' : 'Курс'}
                          </span>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={form.value}
                            onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                            placeholder="11772.95"
                            className={FIELD}
                            aria-label={isUz ? 'Kurs qiymati' : 'Значение курса'}
                          />
                        </label>
                        <button
                          type="button"
                          disabled={busy || !form.date || !form.value.trim()}
                          onClick={() =>
                            void act(
                              () =>
                                apiClient.refs.setCurrencyRate(row.code, {
                                  rateDate: form.date,
                                  rate: Number(form.value.replace(/\s/g, '').replace(',', '.')),
                                }),
                              isUz
                                ? `${row.code}: kurs saqlandi`
                                : `${row.code}: курс на ${formatDate(form.date)} сохранён`,
                            )
                          }
                          className={`${BTN_PRIMARY} h-9 px-3 text-xs inline-flex items-center gap-1.5 disabled:opacity-50`}
                        >
                          <Check size={13} />
                          {isUz ? 'Saqlash' : 'Сохранить'}
                        </button>
                      </div>
                    ) : (
                      <div className="text-[11px] text-zinc-400">
                        {isUz
                          ? 'Kurs kiritish uchun «Ma’lumotnomalarni tahrirlash» huquqi kerak'
                          : 'Чтобы вводить курс, нужно право «Правка справочников»'}
                      </div>
                    )}
                    {row.operations > 0 && (
                      <div className="text-[10px] text-zinc-400">
                        {isUz
                          ? `Bu valyutada ${row.operations} operatsiya bor: o‘tkazilganlari qayta hisoblanmaydi`
                          : `В этой валюте ${row.operations} операций: проведённые не пересчитываются`}
                      </div>
                    )}
                  </div>

                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 mb-1.5">
                      {isUz ? 'Tarix' : 'История курса'}
                    </div>
                    <div className="max-h-48 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800/60">
                      {history.length === 0 && (
                        <div className="text-[11px] text-zinc-400 py-2">
                          {isUz ? 'Yozuv yo‘q' : 'Записей нет'}
                        </div>
                      )}
                      {history.map((h) => (
                        <div
                          key={h.rateDate}
                          className="flex items-center justify-between gap-2 py-1.5 text-[11px] font-mono"
                        >
                          <span className="text-zinc-500">{formatDate(h.rateDate)}</span>
                          <span className="text-zinc-900 dark:text-zinc-100 tabular-nums">
                            {rate(h.rate)}
                          </span>
                          <span className="text-zinc-400 w-28 text-right truncate">
                            {sourceName(h.source, isUz)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
