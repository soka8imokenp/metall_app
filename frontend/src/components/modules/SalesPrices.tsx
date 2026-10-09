/**
 * Прайс-лист и индивидуальные цены клиентов (ТЗ 9.2).
 *
 * До этого экрана прайс в системе был только в базе: цену в заказе набирали
 * руками, а таблицу `price_list` не читал никто. Здесь он становится рабочим —
 * его видно, правят из интерфейса, и форма заказа берёт цену отсюда.
 *
 * Правило, которое экран обязан показывать, а не прятать: **цена живёт
 * периодом**. Поэтому в клетке стоит не просто цифра, а «с какого числа», новая
 * цена вводится датой, а не правкой на месте, и прошлые цены видно историей.
 * Иначе заказ, выписанный в прошлом месяце, после правки прайса стал бы
 * выписанным мимо прайса, и объяснить это было бы нечем.
 */
import React from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import type { RefPartnerPrice, RefPriceCell, RefPricesPage, RefPriceType } from '../../types/api';
import { apiClient, ApiError } from '../../lib/api-client';
import { useAuth } from '../../context/AuthContext';
import { errorText } from '../../context/DashboardContext';
import { formatNumber, formatUnit, refName } from '../../lib/formatters';
import { BTN_GHOST, BTN_PRIMARY, Empty, ErrorBox, FIELD, Skeleton } from './warehouse-ui';

const today = () => new Date().toISOString().slice(0, 10);

/** Цена с периодом одной строкой: «8 098 200 · с 02.10.2026». */
const cellText = (cell: RefPriceCell | undefined, isUz: boolean) => {
  if (!cell) return isUz ? 'yo‘q' : 'нет';
  const from = cell.validFrom.split('-').reverse().join('.');
  return `${formatNumber(String(cell.price), 0)} · ${isUz ? 'dan' : 'с'} ${from}`;
};

export type PriceItem = { uid: string; code: string; name: string; unit: string; companyUid: string };

/** Список позиций с действующими ценами. */
export const PricesList: React.FC<{
  isUz: boolean;
  companyUid: string | null;
  selected: string | null;
  onSelect: (item: PriceItem) => void;
  onTotal: (total: number) => void;
}> = ({ isUz, companyUid, selected, onSelect, onTotal }) => {
  const [search, setSearch] = React.useState('');
  const [limit, setLimit] = React.useState(50);
  const [page, setPage] = React.useState<RefPricesPage | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);

  const load = React.useCallback(() => {
    setError(null);
    apiClient.refs
      .prices({ ...(companyUid ? { companyUid } : {}), search, limit })
      .then((res) => {
        setPage(res.data);
        onTotal(res.data.total);
      })
      .catch((e) => setError(e as ApiError));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyUid, search, limit]);

  React.useEffect(load, [load]);
  React.useEffect(() => setLimit(50), [search, companyUid]);

  if (error && !page) return <ErrorBox text={errorText(error, isUz)} onRetry={load} isUz={isUz} />;

  const types = (page?.types ?? []).filter((t) => !companyUid || t.companyUid === companyUid);

  return (
    <div className="flex flex-col min-h-0">
      <div className="p-3 pb-2 shrink-0">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={isUz ? 'Nomenklatura yoki kod' : 'Номенклатура или код'}
          aria-label={isUz ? 'Narxnomada qidirish' : 'Поиск в прайсе'}
          className={FIELD}
        />
        <div className="mt-1.5 text-[11px] text-zinc-500">
          {page
            ? isUz
              ? `${page.rows.length} dan ${page.total} ko‘rsatildi`
              : `показано ${page.rows.length} из ${page.total}`
            : ''}
        </div>
      </div>

      {!page ? (
        <Skeleton />
      ) : page.rows.length === 0 ? (
        <Empty text={isUz ? 'Nomenklatura topilmadi' : 'Позиции не найдены'} />
      ) : (
        <div className="overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800/40">
          {page.rows.map((row) => (
            <button
              key={row.item.uid}
              type="button"
              onClick={() => onSelect(row.item)}
              aria-current={selected === row.item.uid}
              className={`w-full text-left p-3 transition-colors cursor-pointer ${
                selected === row.item.uid
                  ? 'bg-zinc-100 dark:bg-zinc-800/60'
                  : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/40'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] text-zinc-400">{row.item.code}</div>
                  <div className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">
                    {row.item.name}
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    {formatUnit(row.item.unit, isUz ? 'uz' : 'ru')}
                  </div>
                </div>
                <div className="text-right shrink-0 space-y-0.5">
                  {types.map((t) => (
                    <div key={t.uid} className="text-[11px] font-mono text-zinc-600 dark:text-zinc-400">
                      <span className="text-zinc-400 mr-1">{refName(t, isUz).toLowerCase()}</span>
                      {cellText(row.prices[t.uid], isUz)}
                    </div>
                  ))}
                </div>
              </div>
            </button>
          ))}
          {page.total > page.rows.length && (
            <div className="p-3">
              <button type="button" onClick={() => setLimit((l) => l + 50)} className={BTN_GHOST}>
                {isUz ? 'Yana 50 ta' : 'Показать ещё 50'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/** Цены выбранной позиции по типам, с историей и вводом новой цены. */
export const PricePanel: React.FC<{ item: PriceItem; isUz: boolean }> = ({ item, isUz }) => {
  const { session } = useAuth();
  const can = (p: string) => session?.permissions.includes(p) ?? false;

  const [types, setTypes] = React.useState<RefPriceType[] | null>(null);
  const [cells, setCells] = React.useState<Record<string, RefPriceCell> | null>(null);
  const [history, setHistory] = React.useState<Record<string, RefPriceCell[]>>({});
  const [open, setOpen] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<{ typeUid: string; price: string; validFrom: string } | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  const load = React.useCallback(() => {
    setError(null);
    Promise.all([
      apiClient.refs.priceTypes(item.companyUid),
      apiClient.refs.prices({ companyUid: item.companyUid, search: item.code, limit: 50 }),
    ])
      .then(([t, p]) => {
        setTypes(t.data.rows);
        setCells(p.data.rows.find((r) => r.item.uid === item.uid)?.prices ?? {});
      })
      .catch((e) => setError(e as ApiError));
  }, [item.companyUid, item.code, item.uid]);

  React.useEffect(load, [load]);

  const showHistory = (typeUid: string) => {
    setOpen((cur) => (cur === typeUid ? null : typeUid));
    if (history[typeUid]) return;
    apiClient.refs
      .priceHistory(item.uid, typeUid)
      .then((res) => setHistory((h) => ({ ...h, [typeUid]: res.data.rows })))
      .catch((e) => setError(e as ApiError));
  };

  const save = async () => {
    if (!form || busy) return;
    const type = types?.find((t) => t.uid === form.typeUid);
    if (!type) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.refs.setPrice({
        companyUid: item.companyUid,
        itemCode: item.code,
        priceTypeCode: type.code,
        price: Number(form.price.replace(',', '.')),
        validFrom: form.validFrom,
      });
      setForm(null);
      setHistory({});
      load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const drop = async (uid: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.refs.deletePrice(uid);
      setHistory({});
      load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 text-xs">
      <div className="pb-2.5 border-b border-zinc-100 dark:border-zinc-800/60 shrink-0">
        <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider">
          {isUz ? 'Narxnoma' : 'Прайс-лист'}
        </span>
        <div className="text-base font-bold text-zinc-950 dark:text-zinc-50 truncate">
          {item.name}
        </div>
        <div className="text-[11px] text-zinc-500 font-mono">
          {item.code} · {formatUnit(item.unit, isUz ? 'uz' : 'ru')}
        </div>
      </div>

      {error && (
        <div className="mt-2 text-[11px] text-red-700 dark:text-red-300">{errorText(error, isUz)}</div>
      )}

      <div className="mt-2 overflow-y-auto space-y-2 pr-1">
        {!types || !cells ? (
          <Skeleton rows={3} />
        ) : types.length === 0 ? (
          <Empty text={isUz ? 'Narx turlari yo‘q' : 'Типы цен не заведены'} />
        ) : (
          types.map((t) => {
            const cell = cells[t.uid];
            return (
              <div key={t.uid} className="p-2.5 rounded-lg border border-zinc-100 dark:border-zinc-800">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">
                      {refName(t, isUz)}
                    </div>
                    <div className="text-[11px] text-zinc-500 font-mono">{t.code}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono font-bold text-zinc-950 dark:text-zinc-50">
                      {cell ? formatNumber(String(cell.price), 0) : '—'}
                    </div>
                    <div className="text-[10px] text-zinc-500 font-mono">
                      {cell
                        ? `${isUz ? 'dan' : 'с'} ${cell.validFrom.split('-').reverse().join('.')}`
                        : isUz
                          ? 'narx qo‘yilmagan'
                          : 'цена не задана'}
                    </div>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => showHistory(t.uid)}
                    aria-expanded={open === t.uid}
                    className="h-6 px-2 inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-800 text-[10px] font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                  >
                    <ChevronDown size={11} />
                    {isUz ? 'Tarix' : 'История'}
                  </button>
                  {can('refs.edit') && (
                    <button
                      type="button"
                      onClick={() =>
                        setForm({
                          typeUid: t.uid,
                          price: cell ? String(cell.price) : '',
                          validFrom: today(),
                        })
                      }
                      className="h-6 px-2 inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-800 text-[10px] font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                    >
                      <Plus size={11} />
                      {isUz ? 'Yangi narx' : 'Новая цена'}
                    </button>
                  )}
                  {can('refs.edit') && cell && (
                    <button
                      type="button"
                      onClick={() => drop(cell.uid)}
                      disabled={busy}
                      title={
                        isUz
                          ? 'Oxirgi narxni olib tashlash: avvalgisi qayta ochiladi'
                          : 'Снять последнюю цену: предыдущая снова откроется'
                      }
                      className="h-6 px-2 inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-800 text-[10px] font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-40"
                    >
                      <Trash2 size={11} />
                      {isUz ? 'Olib tashlash' : 'Снять'}
                    </button>
                  )}
                </div>

                {form?.typeUid === t.uid && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-[10px] text-zinc-400 uppercase tracking-wider">
                        {isUz ? 'Narx' : 'Цена'}
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={form.price}
                        onChange={(e) => setForm({ ...form, price: e.target.value })}
                        aria-label={isUz ? 'Yangi narx' : 'Новая цена'}
                        className={`${FIELD} font-mono`}
                      />
                    </label>
                    <label className="block">
                      <span className="text-[10px] text-zinc-400 uppercase tracking-wider">
                        {isUz ? 'Qaysi kundan' : 'С какого числа'}
                      </span>
                      <input
                        type="date"
                        value={form.validFrom}
                        onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
                        aria-label={isUz ? 'Amal qilish boshlanishi' : 'Дата начала действия'}
                        className={`${FIELD} font-mono`}
                      />
                    </label>
                    <div className="col-span-2 flex items-center gap-2">
                      <button type="button" onClick={save} disabled={busy} className={BTN_PRIMARY}>
                        {isUz ? 'Saqlash' : 'Сохранить'}
                      </button>
                      <button type="button" onClick={() => setForm(null)} className={BTN_GHOST}>
                        {isUz ? 'Bekor qilish' : 'Отмена'}
                      </button>
                    </div>
                    <p className="col-span-2 text-[11px] text-zinc-500">
                      {isUz
                        ? 'Avvalgi narx bir kun oldin yopiladi: o‘tgan buyurtmalar o‘z narxi bilan qoladi.'
                        : 'Прежняя цена закроется днём раньше: прошлые заказы останутся со своей ценой.'}
                    </p>
                  </div>
                )}

                {open === t.uid && (
                  <div className="mt-2 space-y-1">
                    {(history[t.uid] ?? []).length === 0 ? (
                      <div className="text-[11px] text-zinc-500">
                        {isUz ? 'Tarix bo‘sh' : 'История пуста'}
                      </div>
                    ) : (
                      (history[t.uid] ?? []).map((h) => (
                        <div
                          key={h.uid}
                          className="flex items-center justify-between gap-2 text-[11px] font-mono text-zinc-600 dark:text-zinc-400"
                        >
                          <span>
                            {h.validFrom.split('-').reverse().join('.')} —{' '}
                            {h.validTo ? h.validTo.split('-').reverse().join('.') : isUz ? 'hozir' : 'сейчас'}
                          </span>
                          <span>{formatNumber(String(h.price), 0)}</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

/**
 * Индивидуальные цены клиента (ТЗ 9.2). Живут в карточке клиента: это условие
 * работы с ним, рядом с отсрочкой и лимитом долга, а не свойство номенклатуры.
 */
export const PartnerPricesBlock: React.FC<{
  partnerUid: string;
  companyUid?: string;
  isUz: boolean;
}> = ({ partnerUid, companyUid, isUz }) => {
  const { session } = useAuth();
  const canEdit = session?.permissions.includes('refs.edit') ?? false;

  const [rows, setRows] = React.useState<RefPartnerPrice[] | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [form, setForm] = React.useState<{ itemCode: string; price: string; validFrom: string } | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    setError(null);
    apiClient.refs
      .partnerPrices(partnerUid)
      .then((res) => setRows(res.data.rows))
      .catch((e) => setError(e as ApiError));
  }, [partnerUid]);

  React.useEffect(load, [load]);

  const save = async () => {
    if (!form || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.refs.setPartnerPrice({
        ...(companyUid ? { companyUid } : {}),
        partnerUid,
        itemCode: form.itemCode.trim(),
        price: Number(form.price.replace(',', '.')),
        validFrom: form.validFrom,
      });
      setForm(null);
      load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const drop = async (uid: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.refs.deletePartnerPrice(uid);
      load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 text-xs">
      <p className="text-[11px] text-zinc-500">
        {isUz
          ? 'Mijoz narxi narxnomadan ustun turadi: buyurtmada shu narx qo‘yiladi.'
          : 'Цена клиента перекрывает прайс: в заказе подставится она.'}
      </p>

      {error && (
        <div className="text-[11px] text-red-700 dark:text-red-300">{errorText(error, isUz)}</div>
      )}

      {!rows ? (
        <Skeleton rows={3} />
      ) : rows.length === 0 ? (
        <Empty text={isUz ? 'Shaxsiy narxlar yo‘q' : 'Индивидуальных цен нет'} />
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/40">
          {rows.map((r) => (
            <div key={r.uid} className="py-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-[10px] text-zinc-400">{r.item.code}</div>
                <div className="text-xs text-zinc-900 dark:text-zinc-100 truncate">{r.item.name}</div>
                <div className="text-[10px] text-zinc-500 font-mono">
                  {r.validFrom.split('-').reverse().join('.')} —{' '}
                  {r.validTo ? r.validTo.split('-').reverse().join('.') : isUz ? 'hozir' : 'сейчас'}
                  {!r.isCurrent && (isUz ? ' · amalda emas' : ' · не действует')}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-mono font-bold text-zinc-950 dark:text-zinc-50">
                  {formatNumber(String(r.price), 0)}
                </span>
                {canEdit && r.isCurrent && (
                  <button
                    type="button"
                    onClick={() => drop(r.uid)}
                    disabled={busy}
                    aria-label={isUz ? 'Narxni olib tashlash' : 'Снять цену'}
                    className="p-1 rounded-md text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-40"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {canEdit &&
        (form ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="block col-span-2">
              <span className="text-[10px] text-zinc-400 uppercase tracking-wider">
                {isUz ? 'Nomenklatura kodi' : 'Код номенклатуры'}
              </span>
              <input
                type="text"
                value={form.itemCode}
                onChange={(e) => setForm({ ...form, itemCode: e.target.value })}
                aria-label={isUz ? 'Nomenklatura kodi' : 'Код номенклатуры'}
                className={`${FIELD} font-mono`}
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-zinc-400 uppercase tracking-wider">
                {isUz ? 'Narx' : 'Цена'}
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
                aria-label={isUz ? 'Mijoz narxi' : 'Цена клиента'}
                className={`${FIELD} font-mono`}
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-zinc-400 uppercase tracking-wider">
                {isUz ? 'Qaysi kundan' : 'С какого числа'}
              </span>
              <input
                type="date"
                value={form.validFrom}
                onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
                aria-label={isUz ? 'Amal qilish boshlanishi' : 'Дата начала действия'}
                className={`${FIELD} font-mono`}
              />
            </label>
            <div className="col-span-2 flex items-center gap-2">
              <button type="button" onClick={save} disabled={busy} className={BTN_PRIMARY}>
                {isUz ? 'Saqlash' : 'Сохранить'}
              </button>
              <button type="button" onClick={() => setForm(null)} className={BTN_GHOST}>
                {isUz ? 'Bekor qilish' : 'Отмена'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setForm({ itemCode: '', price: '', validFrom: today() })}
            className={BTN_GHOST}
          >
            {isUz ? 'Narx qo‘shish' : 'Добавить цену'}
          </button>
        ))}
    </div>
  );
};
