import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Copy,
  Download,
  KeyRound,
  Link2,
  Plug,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { useApp } from '../../context/AppContext';
import type {
  ExchangeDirection,
  ExchangeEvent,
  ExchangeFacets,
  ExchangeImportReport,
  ExchangeMessage,
  ExchangeStatus,
  ExchangeSubscription,
  ExchangeSystem,
  ExchangeSystemKey,
} from '../../types/api';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, ErrorBox, FIELD, Skeleton } from './warehouse-ui';

/**
 * Обмен с внешними системами (ТЗ 12).
 *
 * Три вещи на одном экране, потому что их и разбирают вместе: подключения с
 * ключами и подписками, журнал обменов с повтором неудачных, круг
 * «выгрузил — поправил — загрузил» по номенклатуре.
 *
 * Конкретных коннекторов (1С, REGOS, банк, телефония) здесь нет: по ним нет ни
 * доступов, ни документации. Это каркас — чужая программа подключается ключом и
 * подпиской, без правки кода.
 */

const when = (iso: string | null, isUz: boolean) =>
  iso
    ? new Date(iso).toLocaleString(isUz ? 'uz-UZ' : 'ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/** Цвет состояния обмена. «Попытки кончились» краснее, чем «не вышло»: оно само не повторится. */
const STATUS_TONE: Record<ExchangeStatus, string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  failed: 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300',
  dead: 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
};

const LABEL = 'text-[11px] font-medium text-zinc-500 dark:text-zinc-400';
const MONO = 'font-mono text-[11px] break-all';

type Pane = 'systems' | 'journal' | 'files';

export const AdminExchange: React.FC = () => {
  const { locale } = useApp();
  const isUz = locale === 'uz';
  const [pane, setPane] = useState<Pane>('systems');

  const PANES: { id: Pane; ru: string; uz: string }[] = [
    { id: 'systems', ru: 'Подключения', uz: 'Ulanishlar' },
    { id: 'journal', ru: 'Журнал обменов', uz: 'Almashinuv jurnali' },
    { id: 'files', ru: 'Файлы', uz: 'Fayllar' },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Внутренние разделы — flex-полоса, а не подогнанные координаты. */}
      <div className="flex flex-wrap items-center gap-1.5" role="tablist">
        {PANES.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={pane === p.id}
            onClick={() => setPane(p.id)}
            className={
              pane === p.id
                ? BTN_PRIMARY
                : BTN_GHOST
            }
          >
            {isUz ? p.uz : p.ru}
          </button>
        ))}
      </div>
      {pane === 'systems' && <Systems isUz={isUz} />}
      {pane === 'journal' && <Journal isUz={isUz} />}
      {pane === 'files' && <Files isUz={isUz} />}
    </div>
  );
};

// --- подключения -------------------------------------------------------------

const Systems: React.FC<{ isUz: boolean }> = ({ isUz }) => {
  const [rows, setRows] = useState<ExchangeSystem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  /**
   * Выданный ключ живёт только здесь, в состоянии экрана. Сервер его больше не
   * отдаст: это и значит «показываем один раз». Поэтому карточка с ключом не
   * закрывается сама и просит подтвердить, что ключ сохранили.
   */
  const [issued, setIssued] = useState<ExchangeSystemKey | null>(null);
  const [form, setForm] = useState<{ code: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows((await apiClient.exchange.systems()).data.rows);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const create = async () => {
    if (!form) return;
    setBusy(true);
    try {
      const res = await apiClient.exchange.createSystem({
        code: form.code.trim().toLowerCase(),
        name: form.name.trim(),
        withSecret: true,
      });
      setIssued(res.data);
      setForm(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (uid: string) => {
    setBusy(true);
    try {
      setIssued((await apiClient.exchange.rotateKey(uid, true)).data);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: ExchangeSystem) => {
    try {
      await apiClient.exchange.patchSystem(s.uid, { isActive: !s.isActive });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  if (error) return <ErrorBox text={error} onRetry={load} isUz={isUz} />;
  if (!rows) return <div className={CARD}><Skeleton /></div>;

  return (
    <div className="flex flex-col gap-3">
      {issued && <IssuedKey data={issued} isUz={isUz} onClose={() => setIssued(null)} />}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={LABEL}>
          {isUz ? `Ulanishlar: ${rows.length}` : `Подключений: ${rows.length}`}
        </span>
        <button
          type="button"
          className={BTN_PRIMARY}
          onClick={() => setForm({ code: '', name: '' })}
        >
          <Plug className="inline h-3.5 w-3.5 mr-1" aria-hidden />
          {isUz ? 'Ulanish qo‘shish' : 'Добавить подключение'}
        </button>
      </div>

      {form && (
        <div className={`${CARD} p-3 flex flex-col gap-2`}>
          {/* Поля в сетку: на 360 они идут друг под другом, на 1440 — рядом. */}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className={LABEL}>{isUz ? 'Tizim kodi' : 'Код системы'}</span>
              <input
                className={FIELD}
                value={form.code}
                placeholder="1c, regos, bank"
                onChange={(e) => setForm({ ...form, code: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>{isUz ? 'Nomi' : 'Название'}</span>
              <input
                className={FIELD}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
          </div>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            {isUz
              ? 'Kalit va imzo siri faqat bir marta ko‘rsatiladi.'
              : 'Ключ и секрет подписи будут показаны один раз.'}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={busy || form.code.trim().length < 2 || form.name.trim().length < 2}
              onClick={create}
            >
              {isUz ? 'Yaratish' : 'Завести'}
            </button>
            <button type="button" className={BTN_GHOST} onClick={() => setForm(null)}>
              {isUz ? 'Bekor qilish' : 'Отмена'}
            </button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className={CARD}>
          <Empty
            text={
              isUz
                ? 'Hali ulanish yo‘q. Chet tizim kalit va obuna bilan qo‘shiladi.'
                : 'Подключений пока нет. Чужая система добавляется ключом и подпиской.'
            }
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((s) => (
            <div key={s.uid} className={`${CARD} p-3 flex flex-col gap-2`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-xs font-medium text-zinc-950 dark:text-zinc-50 truncate">
                    {s.name}
                  </span>
                  <span className={`${MONO} text-zinc-500 dark:text-zinc-400`}>
                    {s.code} · …{s.keyTail}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {!s.isActive && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                      {isUz ? 'O‘chirilgan' : 'Выключено'}
                    </span>
                  )}
                  {s.problems > 0 && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300">
                      <AlertTriangle className="inline h-3 w-3 mr-0.5" aria-hidden />
                      {s.problems}
                    </span>
                  )}
                  <button
                    type="button"
                    className={BTN_GHOST}
                    onClick={() => setOpen(open === s.uid ? null : s.uid)}
                  >
                    {isUz ? `Obunalar (${s.subscriptions})` : `Подписки (${s.subscriptions})`}
                  </button>
                  <button
                    type="button"
                    className={BTN_GHOST}
                    disabled={busy}
                    onClick={() => rotate(s.uid)}
                  >
                    <KeyRound className="inline h-3.5 w-3.5 mr-1" aria-hidden />
                    {isUz ? 'Kalitni yangilash' : 'Перевыпустить ключ'}
                  </button>
                  <button type="button" className={BTN_GHOST} onClick={() => toggle(s)}>
                    {s.isActive ? (isUz ? 'O‘chirish' : 'Выключить') : isUz ? 'Yoqish' : 'Включить'}
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                <span>
                  {isUz ? 'Imzo' : 'Подпись'}: {s.hasSecret ? (isUz ? 'bor' : 'есть') : isUz ? 'yo‘q' : 'нет'}
                </span>
                <span>
                  {isUz ? 'Oxirgi murojaat' : 'Последнее обращение'}: {when(s.lastUsedAt, isUz)}
                </span>
                <span>
                  {isUz ? 'Murojaatlar' : 'Обращений'}: {s.usedCount}
                </span>
                <span>{isUz ? s.companyNameUz : s.companyNameRu}</span>
              </div>
              {open === s.uid && <Subscriptions systemUid={s.uid} isUz={isUz} onChange={load} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Карточка выданного ключа. Единственное место, где он виден.
 *
 * Закрывается только кнопкой «Я сохранил»: исчезни она сама по таймеру или при
 * переходе на другой раздел — ключ пропал бы вместе с ней, и подключение
 * пришлось бы перевыпускать.
 */
const IssuedKey: React.FC<{ data: ExchangeSystemKey; isUz: boolean; onClose: () => void }> = ({
  data,
  isUz,
  onClose,
}) => {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (what: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
    } catch {
      setCopied(null);
    }
  };

  const Row: React.FC<{ title: string; value: string; name: string }> = ({
    title,
    value,
    name,
  }) => (
    <div className="flex flex-col gap-1">
      <span className={LABEL}>{title}</span>
      <div className="flex items-start gap-2">
        <code className={`${MONO} flex-1 px-2 py-1.5 rounded-lg bg-white dark:bg-zinc-900 border border-amber-300 dark:border-amber-500/40`}>
          {value}
        </code>
        <button type="button" className={BTN_GHOST} onClick={() => copy(name, value)}>
          <Copy className="inline h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">{isUz ? 'Nusxalash' : 'Скопировать'}</span>
        </button>
      </div>
      {copied === name && (
        <span className="text-[11px] text-emerald-700 dark:text-emerald-400">
          {isUz ? 'Nusxalandi' : 'Скопировано'}
        </span>
      )}
    </div>
  );

  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-3 flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden />
        <p className="text-xs text-amber-900 dark:text-amber-200">
          {isUz
            ? `«${data.name}» uchun kalit. U faqat shu yerda ko‘rinadi — saqlab oling, server uni boshqa bermaydi.`
            : `Ключ для «${data.name}». Он виден только здесь — сохраните его, сервер его больше не отдаст.`}
        </p>
      </div>
      <Row title={isUz ? 'Kirish kaliti' : 'Ключ доступа'} value={data.key} name="key" />
      {data.secret && (
        <Row title={isUz ? 'Imzo siri' : 'Секрет подписи'} value={data.secret} name="secret" />
      )}
      <div className="flex flex-col gap-1">
        <span className={LABEL}>{isUz ? 'Kiruvchi so‘rov manzili' : 'Адрес для входящих'}</span>
        <code className={`${MONO} px-2 py-1.5 rounded-lg bg-white dark:bg-zinc-900 border border-amber-300 dark:border-amber-500/40`}>
          POST /api/v1/hooks/{data.code}
        </code>
        <span className="text-[11px] text-amber-800 dark:text-amber-300">
          {isUz
            ? 'Sarlavhalar: X-Exchange-Key, X-Exchange-Signature, X-Exchange-Message-Id.'
            : 'Заголовки: X-Exchange-Key, X-Exchange-Signature, X-Exchange-Message-Id.'}
        </span>
      </div>
      <button type="button" className={BTN_PRIMARY + ' self-start'} onClick={onClose}>
        {isUz ? 'Saqlab oldim' : 'Я сохранил ключ'}
      </button>
    </div>
  );
};

const Subscriptions: React.FC<{ systemUid: string; isUz: boolean; onChange: () => void }> = ({
  systemUid,
  isUz,
  onChange,
}) => {
  const [rows, setRows] = useState<ExchangeSubscription[] | null>(null);
  const [events, setEvents] = useState<ExchangeEvent[]>([]);
  const [event, setEvent] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [subs, cat] = await Promise.all([
        apiClient.exchange.subscriptions(systemUid),
        apiClient.exchange.events(),
      ]);
      setRows(subs.data.rows);
      setEvents(cat.data.rows);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [systemUid]);
  useEffect(() => void load(), [load]);

  const add = async () => {
    try {
      await apiClient.exchange.putSubscription(systemUid, { event, url: url.trim() });
      setUrl('');
      setEvent('');
      await load();
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const drop = async (uid: string) => {
    try {
      await apiClient.exchange.removeSubscription(uid);
      await load();
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div className="border-t border-zinc-200 dark:border-zinc-800/60 pt-2 flex flex-col gap-2">
      {error && <ErrorBox text={error} onRetry={load} isUz={isUz} />}
      {!rows ? (
        <Skeleton rows={2} />
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          {isUz
            ? 'Obuna yo‘q: tizim hodisalar haqida xabar bermaydi.'
            : 'Подписок нет: система ничего не сообщает об этих событиях.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((s) => (
            <li key={s.uid} className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="font-medium text-zinc-950 dark:text-zinc-50">
                {isUz ? s.nameUz : s.nameRu}
              </span>
              <code className={`${MONO} text-zinc-500 dark:text-zinc-400 flex-1 min-w-0`}>
                {s.url}
              </code>
              <span className="text-zinc-500 dark:text-zinc-400">
                {isUz ? `yuborilgan: ${s.sent}` : `отправлено: ${s.sent}`}
              </span>
              <button type="button" className={BTN_GHOST} onClick={() => drop(s.uid)}>
                <Trash2 className="inline h-3 w-3" aria-hidden />
                <span className="sr-only">{isUz ? 'O‘chirish' : 'Удалить'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] sm:items-end">
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{isUz ? 'Hodisa' : 'Событие'}</span>
          <select className={FIELD} value={event} onChange={(e) => setEvent(e.target.value)}>
            <option value="">{isUz ? '— tanlang —' : '— выберите —'}</option>
            {events.map((e) => (
              <option key={e.value} value={e.value}>
                {(isUz ? e.nameUz : e.nameRu) + ` (${e.count})`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{isUz ? 'Manzil' : 'Адрес'}</span>
          <input
            className={FIELD}
            value={url}
            placeholder="https://…"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <button
          type="button"
          className={BTN_GHOST}
          disabled={!event || url.trim().length < 8}
          onClick={add}
        >
          <Link2 className="inline h-3.5 w-3.5 mr-1" aria-hidden />
          {isUz ? 'Obuna qilish' : 'Подписать'}
        </button>
      </div>
    </div>
  );
};

// --- журнал обменов ----------------------------------------------------------

const Journal: React.FC<{ isUz: boolean }> = ({ isUz }) => {
  const [rows, setRows] = useState<ExchangeMessage[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(50);
  const [facets, setFacets] = useState<ExchangeFacets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<{
    systemUid: string;
    direction: '' | ExchangeDirection;
    status: '' | ExchangeStatus;
    search: string;
  }>({ systemUid: '', direction: '', status: '', search: '' });
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.exchange.messages({
        systemUid: filter.systemUid || undefined,
        direction: filter.direction || undefined,
        status: filter.status || undefined,
        search: filter.search.trim() || undefined,
        limit,
      });
      setRows(res.data.rows);
      setTotal(res.data.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [filter, limit]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    apiClient.exchange
      .facets()
      .then((r) => setFacets(r.data))
      .catch(() => setFacets(null));
  }, []);

  const retry = async (uid: string) => {
    setRetrying(uid);
    try {
      await apiClient.exchange.retry(uid);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setRetrying(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{isUz ? 'Tizim' : 'Система'}</span>
          <select
            className={FIELD}
            value={filter.systemUid}
            onChange={(e) => setFilter({ ...filter, systemUid: e.target.value })}
          >
            <option value="">{isUz ? 'Barchasi' : 'Все'}</option>
            {facets?.systems.map((s) => (
              <option key={s.uid} value={s.uid}>
                {s.name} ({s.count})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{isUz ? 'Yo‘nalish' : 'Направление'}</span>
          <select
            className={FIELD}
            value={filter.direction}
            onChange={(e) =>
              setFilter({ ...filter, direction: e.target.value as '' | ExchangeDirection })
            }
          >
            <option value="">{isUz ? 'Barchasi' : 'Все'}</option>
            <option value="in">{isUz ? 'Kiruvchi' : 'Входящие'}</option>
            <option value="out">{isUz ? 'Chiquvchi' : 'Исходящие'}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{isUz ? 'Holat' : 'Состояние'}</span>
          <select
            className={FIELD}
            value={filter.status}
            onChange={(e) => setFilter({ ...filter, status: e.target.value as '' | ExchangeStatus })}
          >
            <option value="">{isUz ? 'Barchasi' : 'Все'}</option>
            {facets?.statuses.map((s) => (
              <option key={s.value} value={s.value}>
                {(isUz ? s.nameUz : s.nameRu) + ` (${s.count})`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{isUz ? 'Qidirish' : 'Поиск'}</span>
          <input
            className={FIELD}
            value={filter.search}
            placeholder={isUz ? 'hodisa, id, xato' : 'событие, id, ошибка'}
            onChange={(e) => setFilter({ ...filter, search: e.target.value })}
          />
        </label>
      </div>

      {error && <ErrorBox text={error} onRetry={load} isUz={isUz} />}

      <div className={CARD}>
        {!rows ? (
          <Skeleton />
        ) : rows.length === 0 ? (
          <Empty text={isUz ? 'Almashinuv topilmadi' : 'Обменов не найдено'} />
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
            {rows.map((m) => (
              <li key={m.uid} className="px-3 py-2.5 flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  {m.direction === 'in' ? (
                    <ArrowDownToLine
                      className="h-3.5 w-3.5 shrink-0 text-sky-700 dark:text-sky-400"
                      aria-label={isUz ? 'Kiruvchi' : 'Входящий'}
                    />
                  ) : (
                    <ArrowUpFromLine
                      className="h-3.5 w-3.5 shrink-0 text-violet-700 dark:text-violet-400"
                      aria-label={isUz ? 'Chiquvchi' : 'Исходящий'}
                    />
                  )}
                  <span className="text-xs font-medium text-zinc-950 dark:text-zinc-50">
                    {isUz ? m.nameUz : m.nameRu}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${STATUS_TONE[m.status]}`}>
                    {isUz ? m.statusUz : m.statusRu}
                  </span>
                  {m.attempts > 0 && (
                    <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      {isUz ? `urinish: ${m.attempts}` : `попыток: ${m.attempts}`}
                    </span>
                  )}
                  <span className="text-[11px] text-zinc-500 dark:text-zinc-400 ml-auto">
                    {m.systemCode} · {when(m.createdAt, isUz)}
                  </span>
                </div>

                {m.lastError && (
                  <p className="text-[11px] text-rose-700 dark:text-rose-400 break-words">
                    {m.lastError}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={BTN_GHOST}
                    onClick={() => setOpenRow(openRow === m.uid ? null : m.uid)}
                  >
                    {isUz ? 'Tanasi' : 'Тела запроса и ответа'}
                  </button>
                  {/* Повтор только для того, что ещё можно повторить. */}
                  {m.direction === 'out' && m.status !== 'done' && (
                    <button
                      type="button"
                      className={BTN_GHOST}
                      disabled={retrying === m.uid}
                      onClick={() => retry(m.uid)}
                    >
                      <RefreshCw className="inline h-3.5 w-3.5 mr-1" aria-hidden />
                      {isUz ? 'Qayta yuborish' : 'Повторить'}
                    </button>
                  )}
                  {m.httpStatus !== null && (
                    <span className={`${MONO} text-zinc-500 dark:text-zinc-400`}>
                      HTTP {m.httpStatus}
                    </span>
                  )}
                  {m.externalId && (
                    <span className={`${MONO} text-zinc-500 dark:text-zinc-400`}>
                      id: {m.externalId}
                    </span>
                  )}
                </div>

                {openRow === m.uid && (
                  <div className="grid gap-2 lg:grid-cols-2">
                    <Body title={isUz ? 'So‘rov' : 'Запрос'} text={m.requestBody} isUz={isUz} />
                    <Body title={isUz ? 'Javob' : 'Ответ'} text={m.responseBody} isUz={isUz} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={LABEL}>
          {isUz
            ? `${rows?.length ?? 0} dan ${total} ko‘rsatildi`
            : `показано ${rows?.length ?? 0} из ${total}`}
        </span>
        {rows && rows.length < total && (
          <button type="button" className={BTN_GHOST} onClick={() => setLimit(limit + 50)}>
            {isUz ? 'Yana 50 ta' : 'Показать ещё 50'}
          </button>
        )}
      </div>
    </div>
  );
};

/** Тело запроса или ответа. Сервер уже обрезал его — об этом и написано в конце. */
const Body: React.FC<{ title: string; text: string | null; isUz: boolean }> = ({
  title,
  text,
  isUz,
}) => (
  <div className="flex flex-col gap-1 min-w-0">
    <span className={LABEL}>{title}</span>
    <pre
      className={`${MONO} max-h-48 overflow-auto whitespace-pre-wrap px-2 py-1.5 rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300`}
    >
      {text ?? (isUz ? 'yo‘q' : 'нет')}
    </pre>
  </div>
);

// --- файлы -------------------------------------------------------------------

const Files: React.FC<{ isUz: boolean }> = ({ isUz }) => {
  const [report, setReport] = useState<ExchangeImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const picker = useRef<HTMLInputElement>(null);

  const download = async (format: 'xlsx' | 'csv') => {
    setError(null);
    try {
      const { blob, filename } = await apiClient.exchange.itemsFile(format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      setReport((await apiClient.exchange.importItems(file, { dryRun })).data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = '';
    }
  };

  const lines = useMemo(() => report?.rejected ?? [], [report]);

  return (
    <div className="flex flex-col gap-3">
      <div className={`${CARD} p-3 flex flex-col gap-2`}>
        <span className="text-xs font-medium text-zinc-950 dark:text-zinc-50">
          {isUz ? 'Nomenklaturani yuklab olish' : 'Выгрузка номенклатуры'}
        </span>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          {isUz
            ? 'Shu fayl qaytib o‘qiladi: yuklab oling, tuzating va qaytaring.'
            : 'Этот же файл читается загрузкой: выгрузите, поправьте и верните.'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN_GHOST} onClick={() => download('xlsx')}>
            <Download className="inline h-3.5 w-3.5 mr-1" aria-hidden />
            XLSX
          </button>
          <button type="button" className={BTN_GHOST} onClick={() => download('csv')}>
            <Download className="inline h-3.5 w-3.5 mr-1" aria-hidden />
            CSV
          </button>
        </div>
      </div>

      <div className={`${CARD} p-3 flex flex-col gap-2`}>
        <span className="text-xs font-medium text-zinc-950 dark:text-zinc-50">
          {isUz ? 'Nomenklaturani yuklash' : 'Загрузка номенклатуры'}
        </span>
        <label className="flex items-center gap-2 text-[11px] text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          {isUz
            ? 'Sinov o‘tkazish: bazaga yozmasdan protokolni ko‘rish'
            : 'Проверочный прогон: протокол без записи в базу'}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={picker}
            type="file"
            accept=".csv,.xlsx,text/csv"
            className="sr-only"
            id="exchange-items-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <label htmlFor="exchange-items-file" className={BTN_PRIMARY + ' cursor-pointer'}>
            <Upload className="inline h-3.5 w-3.5 mr-1" aria-hidden />
            {isUz ? 'Faylni tanlash' : 'Выбрать файл'}
          </label>
          {busy && (
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {isUz ? 'o‘qilmoqda…' : 'читаем…'}
            </span>
          )}
        </div>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          {isUz
            ? 'Xatoli satr qo‘llanmaydi: protokolda sabab satr raqami bilan ko‘rsatiladi.'
            : 'Строка с ошибкой не применяется: причина названа по номеру строки.'}
        </p>
      </div>

      {error && <ErrorBox text={error} isUz={isUz} />}

      {report && (
        <div className={`${CARD} p-3 flex flex-col gap-2`}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            <span className="text-xs font-medium text-zinc-950 dark:text-zinc-50">
              {report.fileName ?? (isUz ? 'fayl' : 'файл')}
            </span>
            {report.dryRun && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300">
                {isUz ? 'sinov' : 'проверочный прогон'}
              </span>
            )}
            <span className="text-zinc-500 dark:text-zinc-400">
              {isUz ? `satrlar: ${report.total}` : `строк: ${report.total}`}
            </span>
            <span className="text-emerald-700 dark:text-emerald-400">
              {isUz ? `qabul: ${report.acceptedCount}` : `принято: ${report.acceptedCount}`}
            </span>
            <span className={report.rejectedCount > 0 ? 'text-rose-700 dark:text-rose-400' : ''}>
              {isUz ? `rad etildi: ${report.rejectedCount}` : `отклонено: ${report.rejectedCount}`}
            </span>
          </div>
          {lines.length > 0 && (
            <ul className="flex flex-col gap-1">
              {lines.map((l) => (
                <li key={`${l.line}-${l.code}`} className="flex flex-wrap items-baseline gap-2 text-[11px]">
                  <span className={`${MONO} text-zinc-500 dark:text-zinc-400 shrink-0`}>
                    {isUz ? `${l.line}-satr` : `строка ${l.line}`}
                  </span>
                  {l.code && (
                    <code className={`${MONO} text-zinc-700 dark:text-zinc-300`}>{l.code}</code>
                  )}
                  <span className="text-rose-700 dark:text-rose-400">
                    {isUz ? l.reasonUz : l.reasonRu}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
