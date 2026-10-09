/**
 * CRM Э3 — воронка и сделки (ТЗ 8.3).
 *
 * Доска рисует столько колонок, сколько стадий у компании, в их порядке и под
 * их названиями. До этого этапа колонок было четыре и они были вписаны в
 * вёрстку: «Новые обращения», «КП», «Договор», «Выиграна». Настроить воронку
 * под себя заказчик при этом не мог никак, а ТЗ говорит «стадии настраиваются».
 *
 * Колонки стоят в один ряд: столько долей, сколько стадий. Сетка до этого
 * держала три колонки в ряду, шесть стадий складывались в два этажа, и доска
 * уезжала вниз на 662 точки — при том что справа пустовала половина экрана.
 * Если в заголовке выбраны обе компании, воронка показывается по одной:
 * стадии у них свои, и в одной строке их всё равно не сравнить.
 *
 * Высота доски считается от низа окна: колонки прокручиваются внутри себя,
 * страница целиком — нет. Иначе шапка с поиском уезжает вверх ровно тогда,
 * когда ищешь карточку.
 *
 * Карточка на доске короткая — название, номер, сумма. Всё остальное и все
 * действия живут в окне карточки: на узком экране колонка шириной 320 точек
 * не вмещает четыре кнопки, а без них доска переставала работать с телефона.
 *
 * Перенос мышью включается удержанием (350 мс). Короткое нажатие — открыть
 * карточку, случайный сдвиг при прокрутке переносом не становится: промах
 * здесь не косметика, он пишет в историю переход, которого не было.
 *
 * Заключение и отказ — колонки, но бросок в них не закрывает сделку молча:
 * открывается окно и спрашивает исход. У отказа обязательна причина из
 * справочника, иначе отчёт по причинам собирать не из чего.
 *
 * В конечных колонках лежат последние закрытые сделки, а не один итог: итог
 * не отвечал на «куда уехала сделка, которую я только что закрыл». Остальные
 * закрытые — в списке, и колонка сама говорит, сколько их там. Закрытую не
 * переносят: она история, и отчёт за прошлый месяц от сегодняшнего жеста
 * меняться не должен.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Search, X } from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { errorText } from '../../context/DashboardContext';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import type {
  CrmBoardColumn,
  CrmDealCard,
  CrmDealRow,
  CrmLostReason,
  CrmPartnerOptions,
} from '../../types/api';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, ErrorBox, FIELD, Skeleton } from './warehouse-ui';
import { CustomSelect } from '../common/CustomSelect';
import { formatMoneyShort, refName } from '../../lib/formatters';
import { useSearchJump } from '../../lib/use-search-jump';

const money = (v: string) => Number(v || 0).toLocaleString('ru-RU');

/**
 * Крупные суммы в заголовке колонки: 1,2 млрд читается, 1200000000 — нет.
 *
 * Своё сокращение писало «млрд» и «млн» всегда, в том числе на узбекском
 * экране. Общее живёт в `formatMoneyShort`, знает язык — зовём его.
 */
const short = (v: string, isUz: boolean): string => formatMoneyShort(v, isUz ? 'uz' : 'ru');

/** Размер страницы списка. Остальное догружается кнопкой, а не молча теряется. */
const PAGE = 50;

/** По чему сортируется список. Те же ключи знает сервер. */
type Sort = 'number' | 'title' | 'partner' | 'amount' | 'stage' | 'manager' | 'closed' | 'expected';

/** Числа и даты по первому нажатию интереснее сверху вниз, имена — наоборот. */
const FIRST_DIR: Record<Sort, 'asc' | 'desc'> = {
  number: 'asc',
  title: 'asc',
  partner: 'asc',
  amount: 'desc',
  stage: 'asc',
  manager: 'asc',
  closed: 'desc',
  expected: 'asc',
};

const day = (v: string | null) => (v ? new Date(v).toLocaleDateString('ru-RU') : '—');

/** Удержание до переноса. Короче — переносом становится обычное нажатие. */
const HOLD_MS = 350;

type Drag = {
  deal: CrmDealRow;
  from: string;
  x: number;
  y: number;
  over: string | null;
};

/** Широкий экран: все колонки в ряд. Узкий: по одной, стадии переключателем. */
const useWide = () => {
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );
  useEffect(() => {
    const m = window.matchMedia('(min-width: 1024px)');
    const h = () => setWide(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);
  return wide;
};

export const CrmDeals: React.FC = () => {
  const { locale, company } = useApp();
  const { can } = useAuth();
  const isUz = locale === 'uz';
  const canEdit = can('crm.edit');
  const wide = useWide();

  const [view, setView] = useState<'board' | 'table'>('board');
  const [columns, setColumns] = useState<CrmBoardColumn[] | null>(null);
  const [rows, setRows] = useState<CrmDealRow[] | null>(null);
  const [reasons, setReasons] = useState<CrmLostReason[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [search, setSearch] = useState('');
  useSearchJump('crm', setSearch, 'deals');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [losing, setLosing] = useState<CrmDealRow | null>(null);
  const [winning, setWinning] = useState<CrmDealRow | null>(null);
  const [opened, setOpened] = useState<CrmDealRow | null>(null);
  const [companyUid, setCompanyUid] = useState('');
  const [stageUid, setStageUid] = useState('');
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<Sort>('closed');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [listCompany, setListCompany] = useState('');
  const [managerUid, setManagerUid] = useState('');
  const [options, setOptions] = useState<CrmPartnerOptions | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (view === 'board') {
        const res = await apiClient.crm.board({
          search: search.trim() || undefined,
        });
        setColumns(res.data.stages);
      } else {
        const res = await apiClient.crm.deals({
          search: search.trim() || undefined,
          status: status || undefined,
          companyUid: listCompany || undefined,
          managerUid: managerUid || undefined,
          sort,
          dir,
          limit: PAGE,
        });
        setRows(res.data.rows);
        setTotal(res.data.total);
        // Стадии нужны карточке из списка: без них в ней нет «Следующая
        // стадия», хотя сделка открытая.
        if (!columns) {
          apiClient.crm
            .board({})
            .then((b) => setColumns(b.data.stages))
            .catch(() => {});
        }
      }
    } catch (e) {
      setColumns([]);
      setRows([]);
      setError(e as ApiError);
    }
    // columns читается только чтобы не грузить стадии дважды; в зависимости
    // он не нужен — иначе список перезапрашивался бы от их приезда.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, search, status, listCompany, managerUid, sort, dir, company]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (reasons.length === 0) {
      apiClient.crm
        .lostReasons()
        .then((r) => setReasons(r.data.rows))
        .catch(() => setReasons([]));
    }
  }, [reasons.length]);

  /* Компанию выбирают в шапке — и это другой набор данных, а не вид того же.
     Справочники и свой фильтр по компании сбрасываем: в холдинге их две, в
     отдельной компании выбор не нужен вовсе. */
  useEffect(() => {
    setOptions(null);
    setListCompany('');
    setColumns(null);
  }, [company]);

  useEffect(() => {
    if (options === null) {
      apiClient.crm
        .partnerOptions()
        .then((r) => setOptions(r.data))
        .catch(() => setOptions({ managers: [], companies: [], sources: [], priceTypes: [] }));
    }
  }, [options]);

  /* Догрузка страницы: строки добавляются к показанным, а не заменяют их. */
  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await apiClient.crm.deals({
        search: search.trim() || undefined,
        status: status || undefined,
        companyUid: listCompany || undefined,
        managerUid: managerUid || undefined,
        sort,
        dir,
        limit: PAGE,
        offset: rows?.length ?? 0,
      });
      setRows((prev) => [...(prev ?? []), ...res.data.rows]);
      setTotal(res.data.total);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoadingMore(false);
    }
  };

  const onSort = (key: Sort) => {
    if (key === sort) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(key);
      setDir(FIRST_DIR[key]);
    }
  };

  const act = async (uid: string, run: () => Promise<unknown>) => {
    setBusy(uid);
    setError(null);
    try {
      await run();
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  const companies = useMemo(() => {
    const map = new Map<string, CrmBoardColumn['company']>();
    for (const c of columns ?? []) map.set(c.company.uid, c.company);
    return [...map.values()];
  }, [columns]);

  useEffect(() => {
    if (companies.length && !companies.some((c) => c.uid === companyUid)) {
      setCompanyUid(companies[0]!.uid);
    }
  }, [companies, companyUid]);

  const board = useMemo(
    () => (columns ?? []).filter((c) => c.company.uid === companyUid),
    [columns, companyUid],
  );

  useEffect(() => {
    if (board.length && !board.some((c) => c.uid === stageUid)) setStageUid(board[0]!.uid);
  }, [board, stageUid]);

  /* Открытые стадии компании — по ним и ходит карточка. Компанию берём у
     самой сделки: из списка открывают и ту, чья воронка сейчас не выбрана, и
     перенос по чужим стадиям сервер бы отбил. */
  const openStages = useMemo(
    () =>
      (columns ?? []).filter(
        (c) => !c.isFinal && c.company.uid === (opened?.company.uid ?? companyUid),
      ),
    [columns, opened, companyUid],
  );

  /* Колонки нужны обработчику броска, а он живёт в подписке на окно и видит
     состояние того прогона, в котором подписался. Поэтому через ссылку. */
  const boardStages = useRef(board);
  boardStages.current = board;

  const move = (deal: CrmDealRow, toStage: string) =>
    act(deal.uid, () => apiClient.crm.moveDeal(deal.uid, toStage, deal.version));

  // --- перенос удержанием ----------------------------------------------------

  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const holdRef = useRef<number | null>(null);
  const startRef = useRef({ x: 0, y: 0 });
  const draggedRef = useRef(false);

  const cancelHold = () => {
    if (holdRef.current !== null) {
      clearTimeout(holdRef.current);
      holdRef.current = null;
    }
  };

  const onCardDown = (deal: CrmDealRow, e: React.PointerEvent) => {
    if (!canEdit || e.button !== 0 || !wide) return;
    // Закрытую сделку не берут на перенос: сервер её двигать не даст, и
    // ярлык под курсором обещал бы действие, которого не будет.
    if (deal.status !== 'open') return;
    startRef.current = { x: e.clientX, y: e.clientY };
    draggedRef.current = false;
    cancelHold();
    holdRef.current = window.setTimeout(() => {
      holdRef.current = null;
      draggedRef.current = true;
      setDrag({
        deal,
        from: deal.stage.uid,
        x: startRef.current.x,
        y: startRef.current.y,
        over: null,
      });
    }, HOLD_MS);
  };

  /* Сдвиг до срабатывания удержания — это прокрутка, а не перенос. */
  const onCardMove = (e: React.PointerEvent) => {
    if (holdRef.current === null) return;
    const dx = Math.abs(e.clientX - startRef.current.x);
    const dy = Math.abs(e.clientY - startRef.current.y);
    if (dx > 8 || dy > 8) cancelHold();
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const zone = el?.closest('[data-drop-stage]') as HTMLElement | null;
      const d = dragRef.current;
      if (d)
        setDrag({
          ...d,
          x: e.clientX,
          y: e.clientY,
          over: zone?.dataset.dropStage ?? null,
        });
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      const to =
        d && d.over && d.over !== d.from
          ? boardStages.current.find((c) => c.uid === d.over)
          : undefined;
      if (d && to) {
        // В конечную стадию карточка попадает тем же жестом, но закрытие
        // остаётся действием: сначала спрашиваем, чем всё кончилось.
        if (!to.isFinal) void move(d.deal, to.uid);
        else if (to.code === 'won') setWinning(d.deal);
        else setLosing(d.deal);
      }
      // Нажатие после переноса не должно открывать карточку.
      setTimeout(() => {
        draggedRef.current = false;
      }, 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.deal.uid]);

  useEffect(() => () => cancelHold(), []);

  // --- высота доски ----------------------------------------------------------

  const boardRef = useRef<HTMLDivElement>(null);
  const [boardH, setBoardH] = useState<number>();
  useLayoutEffect(() => {
    if (view !== 'board') return;
    const measure = () => {
      const el = boardRef.current;
      if (!el) return;
      // Низ берём у того, кто на самом деле прокручивает страницу, и за вычетом
      // его нижнего отступа. По innerHeight доска оказывалась на эти отступы
      // выше окна — и страница всё равно прокручивалась.
      let scroller: HTMLElement | null = el.parentElement;
      while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) {
        scroller = scroller.parentElement;
      }
      const bottom = scroller
        ? scroller.getBoundingClientRect().bottom -
          parseFloat(getComputedStyle(scroller).paddingBottom || '0')
        : window.innerHeight;
      setBoardH(Math.max(260, Math.floor(bottom - el.getBoundingClientRect().top - 1)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [view, wide, columns, companyUid]);

  const shown = wide ? board : board.filter((c) => c.uid === stageUid);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isUz ? 'Bitim, raqam yoki mijoz' : 'Сделка, номер или клиент'}
            aria-label={isUz ? 'Bitimlarni qidirish' : 'Поиск сделок'}
            className={`${FIELD} pl-9`}
          />
        </div>
        {view === 'table' && (
          <>
            <div className="w-44 shrink-0">
              <CustomSelect
                ariaLabel={isUz ? 'Holati' : 'Состояние сделки'}
                value={status}
                onChange={setStatus}
                options={[
                  { value: '', label: isUz ? 'Barchasi' : 'Все' },
                  { value: 'open', label: isUz ? 'Ochiq' : 'В работе' },
                  { value: 'won', label: isUz ? 'Tuzilgan' : 'Заключённые' },
                  {
                    value: 'lost',
                    label: isUz ? 'Amalga oshmagan' : 'Несостоявшиеся',
                  },
                ]}
              />
            </div>
            {/* Компания и менеджер — те же два вопроса, что задают доске
                переключателем: «чья воронка» и «чьи сделки». */}
            {(options?.companies.length ?? 0) > 1 && (
              <div className="w-44 shrink-0">
                <CustomSelect
                  ariaLabel={isUz ? 'Kompaniya' : 'Компания'}
                  value={listCompany}
                  onChange={setListCompany}
                  options={[
                    { value: '', label: isUz ? 'Barcha kompaniyalar' : 'Все компании' },
                    ...(options?.companies ?? []).map((c) => ({
                      value: c.uid,
                      label: refName(c, isUz),
                    })),
                  ]}
                />
              </div>
            )}
            <div className="w-44 shrink-0">
              <CustomSelect
                ariaLabel={isUz ? 'Menejer' : 'Менеджер'}
                value={managerUid}
                onChange={setManagerUid}
                options={[
                  { value: '', label: isUz ? 'Barcha menejerlar' : 'Все менеджеры' },
                  ...(options?.managers ?? []).map((m) => ({ value: m.uid, label: m.name })),
                ]}
              />
            </div>
          </>
        )}
        <div className="flex items-center border border-zinc-200 dark:border-zinc-800 rounded-lg p-0.5 bg-zinc-50 dark:bg-zinc-900 shrink-0">
          {(
            [
              ['board', isUz ? 'Voronka' : 'Воронка'],
              ['table', isUz ? 'Ro‘yxat' : 'Список'],
            ] as const
          ).map(([key, text]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => setView(key)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                view === key
                  ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs'
                  : 'text-zinc-500'
              }`}
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      {/* Компания выбирается, а не показывается вся сразу: воронки у них
          разные, и сравнивать их в одной строке всё равно нельзя. */}
      {view === 'board' && companies.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {companies.map((c) => (
            <button
              key={c.uid}
              type="button"
              onClick={() => setCompanyUid(c.uid)}
              aria-pressed={companyUid === c.uid}
              className={`px-2.5 h-7 rounded-lg border text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
                companyUid === c.uid
                  ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                  : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              {refName(c, isUz)}
            </button>
          ))}
        </div>
      )}

      {/* Узкий экран: стадии переключателем. Шесть колонок в 360 точек не
          поместить, а боковая прокрутка прячет правый край доски. */}
      {view === 'board' && !wide && board.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {board.map((c) => (
            <button
              key={c.uid}
              type="button"
              onClick={() => setStageUid(c.uid)}
              aria-pressed={stageUid === c.uid}
              className={`px-2 h-7 rounded-lg border text-[11px] whitespace-nowrap transition-colors cursor-pointer ${
                stageUid === c.uid
                  ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 font-medium'
                  : 'border-zinc-200 dark:border-zinc-800 text-zinc-500'
              }`}
            >
              {refName(c, isUz)} · {c.count}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400 break-words">
          {errorText(error, isUz)}
        </p>
      )}

      {view === 'board' ? (
        columns === null ? (
          <div className={CARD}>
            <Skeleton />
          </div>
        ) : board.length === 0 ? (
          <div className={CARD}>
            <Empty text={isUz ? 'Voronka bo‘sh' : 'Воронка пуста'} />
          </div>
        ) : (
          <div
            ref={boardRef}
            style={{
              height: boardH,
              gridTemplateColumns: wide ? `repeat(${shown.length}, minmax(0, 1fr))` : '1fr',
            }}
            className="grid gap-2 min-w-0"
          >
            {shown.map((col) => (
              <Column
                key={col.uid}
                col={col}
                isUz={isUz}
                canEdit={canEdit}
                busy={busy}
                drag={drag}
                onCardDown={onCardDown}
                onCardMove={onCardMove}
                onShowList={(st) => {
                  setStatus(st);
                  setView('table');
                }}
                onOpen={(d) => {
                  if (draggedRef.current) return;
                  cancelHold();
                  setOpened(d);
                }}
              />
            ))}
          </div>
        )
      ) : rows === null ? (
        <div className={CARD}>
          <Skeleton />
        </div>
      ) : rows.length === 0 ? (
        <div className={CARD}>
          <Empty text={isUz ? 'Bitimlar topilmadi' : 'Сделок не найдено'} />
        </div>
      ) : (
        <DealTable
          rows={rows}
          total={total}
          companies={options?.companies ?? []}
          isUz={isUz}
          sort={sort}
          dir={dir}
          busy={busy}
          loadingMore={loadingMore}
          onSort={onSort}
          onMore={() => void loadMore()}
          onOpen={setOpened}
        />
      )}

      {/* Карточка под курсором: без неё непонятно, что именно переносишь. */}
      {drag && (
        <div
          className="fixed z-50 pointer-events-none rounded-lg border border-zinc-900/20 dark:border-white/20 bg-white dark:bg-zinc-900 shadow-lg px-2.5 py-1.5 text-[11px] text-zinc-900 dark:text-zinc-100 max-w-[16rem] truncate"
          style={{ left: drag.x + 12, top: drag.y + 12 }}
        >
          {drag.deal.number} · {drag.deal.title}
        </div>
      )}

      {opened && (
        <DealDialog
          deal={opened}
          stages={openStages}
          isUz={isUz}
          canEdit={canEdit}
          busy={busy === opened.uid}
          onClose={() => setOpened(null)}
          onMove={async (stage) => {
            await move(opened, stage);
            setOpened(null);
          }}
          onWin={() => {
            setWinning(opened);
            setOpened(null);
          }}
          onLose={() => {
            setLosing(opened);
            setOpened(null);
          }}
        />
      )}

      {winning && (
        <WinDialog
          deal={winning}
          isUz={isUz}
          onClose={() => setWinning(null)}
          onDone={async (comment) => {
            await act(winning.uid, () =>
              apiClient.crm.winDeal(winning.uid, winning.version, comment),
            );
            setWinning(null);
          }}
        />
      )}

      {losing && (
        <LoseDialog
          deal={losing}
          reasons={reasons.filter((r) => r.company.uid === losing.company.uid)}
          isUz={isUz}
          onClose={() => setLosing(null)}
          onDone={async (reasonUid, comment) => {
            await act(losing.uid, () =>
              apiClient.crm.loseDeal(losing.uid, losing.version, reasonUid, comment),
            );
            setLosing(null);
          }}
        />
      )}
    </div>
  );
};

const Column: React.FC<{
  col: CrmBoardColumn;
  isUz: boolean;
  canEdit: boolean;
  busy: string | null;
  drag: Drag | null;
  onCardDown: (deal: CrmDealRow, e: React.PointerEvent) => void;
  onCardMove: (e: React.PointerEvent) => void;
  onShowList: (status: 'won' | 'lost') => void;
  onOpen: (deal: CrmDealRow) => void;
}> = ({ col, isUz, canEdit, busy, drag, onCardDown, onCardMove, onShowList, onOpen }) => {
  /* Бросить можно только в рабочую стадию своей компании: закрытие — действие
     с причиной, а не перенос, и чужая воронка карточке не принадлежит. */
  const droppable = !!drag && drag.deal.company.uid === col.company.uid && drag.from !== col.uid;
  const over = droppable && drag?.over === col.uid;

  return (
    <div
      data-stage={col.uid}
      {...(droppable ? { 'data-drop-stage': col.uid } : {})}
      className={`rounded-xl border bg-zinc-50/60 dark:bg-zinc-900/40 p-2.5 flex flex-col gap-2 min-w-0 min-h-0 transition-colors ${
        over
          ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-100 dark:bg-zinc-800/70'
          : droppable
            ? 'border-dashed border-zinc-400 dark:border-zinc-600'
            : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <div className="flex items-start justify-between gap-2 pb-2 border-b border-zinc-200 dark:border-zinc-800 min-w-0 shrink-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[11px] font-semibold text-zinc-900 dark:text-zinc-100 break-words">
            {refName(col, isUz)}
          </span>
          <span className="text-[10px] text-zinc-500 font-mono tabular-nums">
            {col.count} · {short(col.amount, isUz)} UZS
          </span>
        </div>
      </div>

      {col.isFinal && over && (
        <p className="text-[11px] text-zinc-600 dark:text-zinc-300 break-words shrink-0">
          {isUz
            ? 'Qo‘ying — nima bilan tugaganini so‘raymiz'
            : 'Отпустите — спросим, чем закончилось'}
        </p>
      )}

      {col.deals.length === 0 ? (
        <p className="text-[11px] text-zinc-400 py-1">
          {over && !col.isFinal
            ? isUz
              ? 'Shu yerga qo‘ying'
              : 'Отпустите здесь'
            : col.isFinal
              ? isUz
                ? 'Yopilgan bitim yo‘q'
                : 'Закрытых нет'
              : isUz
                ? 'Bo‘sh'
                : 'Пусто'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5 overflow-y-auto min-h-0 flex-1 -mr-1 pr-1">
          {col.deals.map((d) => (
            <li key={d.uid}>
              <button
                type="button"
                onPointerDown={(e) => onCardDown(d, e)}
                onPointerMove={onCardMove}
                onClick={() => onOpen(d)}
                title={
                  d.status === 'open'
                    ? isUz
                      ? 'Ochish; ushlab turib — ko‘chirish'
                      : 'Открыть; удержать — перенести'
                    : isUz
                      ? 'Ochish'
                      : 'Открыть'
                }
                style={{ touchAction: drag ? 'none' : undefined }}
                className={`w-full text-left rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] p-2 flex flex-col gap-1 min-w-0 transition-opacity hover:border-zinc-300 dark:hover:border-zinc-700 cursor-pointer ${
                  drag?.deal.uid === d.uid ? 'opacity-40' : ''
                } ${busy === d.uid ? 'opacity-50' : ''} ${canEdit ? 'select-none' : ''}`}
              >
                <span className="text-[11px] font-medium text-zinc-900 dark:text-zinc-100 break-words line-clamp-2">
                  {d.title}
                </span>
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <span className="text-[10px] font-mono text-zinc-500 shrink-0">{d.number}</span>
                  <span className="text-[10px] font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-100 truncate">
                    {short(d.amount, isUz)}
                  </span>
                </div>
                {/* У закрытой вместо «что дальше» важно «когда закончилось». */}
                {d.status !== 'open' && d.closedAt && (
                  <span className="text-[10px] text-zinc-400 font-mono tabular-nums">
                    {new Date(d.closedAt).toLocaleDateString('ru-RU')}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Карточками лежат последние: колонка честно говорит, сколько закрытых
          она не показала, и ведёт туда, где они все. */}
      {col.isFinal && col.count > col.deals.length && (
        <button
          type="button"
          onClick={() => onShowList(col.code === 'won' ? 'won' : 'lost')}
          className="text-[10px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 underline underline-offset-2 text-left shrink-0 cursor-pointer"
        >
          {isUz
            ? `yana ${col.count - col.deals.length} — ro‘yxatda`
            : `ещё ${col.count - col.deals.length} — в списке`}
        </button>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Карточка сделки                                                      */
/* ------------------------------------------------------------------ */

const DealDialog: React.FC<{
  deal: CrmDealRow;
  stages: CrmBoardColumn[];
  isUz: boolean;
  canEdit: boolean;
  busy: boolean;
  onClose: () => void;
  onMove: (stageUid: string) => Promise<void>;
  onWin: () => void;
  onLose: () => void;
}> = ({ deal, stages, isUz, canEdit, busy, onClose, onMove, onWin, onLose }) => {
  const [card, setCard] = useState<CrmDealCard | null>(null);
  const at = stages.findIndex((s) => s.uid === deal.stage.uid);

  useEffect(() => {
    let alive = true;
    apiClient.crm
      .deal(deal.uid)
      .then((r) => alive && setCard(r.data))
      .catch(() => alive && setCard(null));
    return () => {
      alive = false;
    };
  }, [deal.uid]);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div
        className={`${CARD} w-full max-w-lg max-h-[90vh] overflow-y-auto p-4 flex flex-col gap-3`}
        role="dialog"
        aria-label={isUz ? 'Bitim kartochkasi' : 'Карточка сделки'}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 break-words">
              {deal.title}
            </span>
            <span className="text-[11px] text-zinc-500 font-mono">{deal.number}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={isUz ? 'Yopish' : 'Закрыть карточку сделки'}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
          <dt className="text-zinc-500">{isUz ? 'Mijoz' : 'Клиент'}</dt>
          <dd className="text-zinc-800 dark:text-zinc-200 break-words">
            {deal.partner?.name ?? '—'}
          </dd>
          <dt className="text-zinc-500">{isUz ? 'Menejer' : 'Менеджер'}</dt>
          <dd className="text-zinc-800 dark:text-zinc-200 break-words">
            {deal.manager?.name ?? '—'}
          </dd>
          <dt className="text-zinc-500">{isUz ? 'Summa' : 'Сумма'}</dt>
          <dd className="text-zinc-800 dark:text-zinc-200 font-mono tabular-nums">
            {money(deal.amount)} {deal.currency}
          </dd>
          <dt className="text-zinc-500">{isUz ? 'Bosqich' : 'Стадия'}</dt>
          <dd className="text-zinc-800 dark:text-zinc-200 break-words">{deal.stage.name}</dd>
          <dt className="text-zinc-500">{isUz ? 'Ehtimollik' : 'Вероятность'}</dt>
          <dd className="text-zinc-800 dark:text-zinc-200 tabular-nums">{deal.probability}%</dd>
          <dt className="text-zinc-500">{isUz ? 'Yopilish sanasi' : 'Ожидаемое закрытие'}</dt>
          <dd className="text-zinc-800 dark:text-zinc-200 tabular-nums">
            {deal.expectedCloseDate
              ? new Date(deal.expectedCloseDate).toLocaleDateString('ru-RU')
              : '—'}
          </dd>
          <dt className="text-zinc-500">{isUz ? 'Buyurtmalar' : 'Заказы'}</dt>
          <dd className="text-zinc-800 dark:text-zinc-200 tabular-nums">{card?.orders ?? '…'}</dd>
        </dl>

        {/* Путь сделки по стадиям — то, из чего считается конверсия в отчётах.
            В карточке он нужен, чтобы видеть, где она застряла, поэтому рядом
            с каждой стадией стоит, сколько дней сделка в ней пролежала. */}
        <div className="flex flex-col gap-1.5">
          {/* Без капители: остальные подписи в карточке обычные, и одна
              заглавными читалась бы как чужая. */}
          <span className="text-[11px] font-medium text-zinc-500">
            {isUz ? 'Yo‘l' : 'Путь по стадиям'}
          </span>
          {card === null ? (
            <span className="text-[11px] text-zinc-400">{isUz ? 'yuklanmoqda…' : 'загружаю…'}</span>
          ) : card.history.length === 0 ? (
            <span className="text-[11px] text-zinc-400">
              {isUz ? 'o‘tishlar yo‘q' : 'переходов не было'}
            </span>
          ) : (
            <ol className="flex flex-col">
              {card.history.map((h, i) => {
                const last = i === card.history.length - 1;
                const until = card.history[i + 1]?.at ?? deal.closedAt ?? undefined;
                const days = Math.max(
                  0,
                  Math.round(
                    (new Date(until ?? Date.now()).getTime() - new Date(h.at).getTime()) / 86400000,
                  ),
                );
                return (
                  <li
                    key={`${h.at}-${i}`}
                    className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-x-2.5"
                  >
                    {/* Ось: закрашенная точка — где сделка сейчас. */}
                    <div className="flex flex-col items-center">
                      <span
                        className={`mt-1 w-2 h-2 rounded-full shrink-0 ${
                          last
                            ? 'bg-zinc-900 dark:bg-zinc-100'
                            : 'border border-zinc-300 dark:border-zinc-600'
                        }`}
                      />
                      {!last && <span className="w-px flex-1 bg-zinc-200 dark:bg-zinc-800" />}
                    </div>
                    <div className={`min-w-0 ${last ? '' : 'pb-3'}`}>
                      <div className="flex flex-wrap items-baseline gap-x-2 min-w-0">
                        <span className="text-[11px] font-medium text-zinc-900 dark:text-zinc-100 break-words">
                          {h.to}
                        </span>
                        <span className="text-[10px] text-zinc-400 break-words">
                          {h.from
                            ? `${isUz ? 'bu yerdan' : 'из'} «${h.from}»`
                            : isUz
                              ? 'bitim ochildi'
                              : 'сделка заведена'}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-500">
                        <span className="font-mono tabular-nums">
                          {new Date(h.at).toLocaleDateString('ru-RU')}
                        </span>
                        {h.user && <span className="break-words">{h.user}</span>}
                        <span className="text-zinc-400 tabular-nums">
                          {last && deal.status === 'open'
                            ? `${isUz ? 'shu yerda' : 'здесь'} ${days} ${isUz ? 'kun' : 'дн.'}`
                            : `${days} ${isUz ? 'kun' : 'дн.'}`}
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {/* Закрытая сделка — история: её не двигают и не закрывают заново,
            поэтому вместо кнопок здесь стоит, когда и чем всё кончилось. */}
        {deal.status !== 'open' && (
          <p className="text-[11px] text-zinc-600 dark:text-zinc-300 break-words">
            {isUz ? 'Yopilgan' : 'Закрыта'}{' '}
            <span className="font-mono tabular-nums">
              {deal.closedAt ? new Date(deal.closedAt).toLocaleDateString('ru-RU') : '—'}
            </span>
            {' · '}
            {deal.status === 'won'
              ? isUz
                ? 'bitim tuzildi'
                : 'сделка заключена'
              : isUz
                ? 'bitim amalga oshmadi'
                : 'сделка не состоялась'}
          </p>
        )}

        {/* Чем закончилась — словами. Для закрытой сделки это главное, что
            читают, и оно обязательно при закрытии. */}
        {card?.closeComment && (
          <div className="flex flex-col gap-0.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 p-2.5">
            <span className="text-[10px] text-zinc-500">
              {deal.lostReason
                ? `${isUz ? 'Rad etish sababi' : 'Причина отказа'}: ${deal.lostReason.name}`
                : isUz
                  ? 'Yakuni'
                  : 'Чем закончилась'}
            </span>
            <span className="text-[11px] text-zinc-800 dark:text-zinc-200 break-words">
              {card.closeComment}
            </span>
          </div>
        )}

        {canEdit && deal.status === 'open' && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy || at <= 0}
                onClick={() => void onMove(stages[at - 1]!.uid)}
                className={`${BTN_GHOST} inline-flex items-center gap-1 whitespace-nowrap`}
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                {isUz ? 'Orqaga' : 'Назад'}
              </button>
              <button
                type="button"
                disabled={busy || at < 0 || at >= stages.length - 1}
                onClick={() => void onMove(stages[at + 1]!.uid)}
                className={`${BTN_GHOST} inline-flex items-center gap-1 whitespace-nowrap`}
              >
                {isUz ? 'Keyingi bosqich' : 'Следующая стадия'}
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={onWin}
                className={`${BTN_PRIMARY} inline-flex items-center gap-1 whitespace-nowrap`}
              >
                <Check className="w-3.5 h-3.5" />
                {isUz ? 'Bitimni tuzish' : 'Заключить сделку'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onLose}
                className={`${BTN_GHOST} whitespace-nowrap`}
              >
                {isUz ? 'Amalga oshmadi' : 'Сделка не состоялась'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const WinDialog: React.FC<{
  deal: CrmDealRow;
  isUz: boolean;
  onClose: () => void;
  onDone: (comment: string) => Promise<void>;
}> = ({ deal, isUz, onClose, onDone }) => {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div
        className={`${CARD} w-full max-w-md p-4 flex flex-col gap-3`}
        role="dialog"
        aria-label={isUz ? 'Bitim tuzildi' : 'Сделка заключена'}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {isUz ? 'Bitim tuzildi' : 'Сделка заключена'}
            </span>
            <span className="text-[11px] text-zinc-500 break-words">
              {deal.number} · {deal.title}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={isUz ? 'Yopish' : 'Закрыть окно заключения'}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-500">
            {isUz ? 'Nima bilan tugadi' : 'Чем закончилась'}
          </span>
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={
              isUz
                ? 'masalan: shartnoma imzolandi, oldindan to‘lov'
                : 'например: подписали договор, аванс 30%'
            }
            aria-label={isUz ? 'Bitim yakuni' : 'Чем закончилась сделка'}
            className={FIELD}
          />
        </label>

        {/* Комментарий обязателен на обоих исходах: через полгода к этому же
            клиенту приходят снова, и «чем кончилось» читают первым. */}
        <p className="text-[11px] text-zinc-400 break-words">
          {isUz
            ? 'Izoh majburiy: keyingi safar shu mijoz bilan nima bo‘lganini shu yerdan o‘qiydilar.'
            : 'Комментарий обязателен: в следующий раз с этим клиентом будут читать именно его.'}
        </p>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy || comment.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              try {
                await onDone(comment.trim());
              } finally {
                setBusy(false);
              }
            }}
            className={`${BTN_PRIMARY} whitespace-nowrap`}
          >
            {isUz ? 'Bitimni tuzish' : 'Заключить сделку'}
          </button>
          <button type="button" onClick={onClose} className={`${BTN_GHOST} whitespace-nowrap`}>
            {isUz ? 'Bekor qilish' : 'Отмена'}
          </button>
        </div>
      </div>
    </div>
  );
};

/** Шапка-сортировка: нажатие меняет ключ, повторное — направление. */
const SortTh: React.FC<{
  k: Sort;
  sort: Sort;
  dir: 'asc' | 'desc';
  onSort: (k: Sort) => void;
  className?: string;
  right?: boolean;
  children: React.ReactNode;
}> = ({ k, sort, dir, onSort, className, right, children }) => (
  <th
    className={className}
    aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
  >
    <button
      type="button"
      onClick={() => onSort(k)}
      className={`inline-flex items-center gap-1 font-medium cursor-pointer hover:text-zinc-900 dark:hover:text-zinc-100 ${
        right ? 'justify-end w-full' : ''
      } ${sort === k ? 'text-zinc-900 dark:text-zinc-100' : ''}`}
    >
      {children}
      {sort === k &&
        (dir === 'asc' ? (
          <ChevronUp className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronDown className="w-3 h-3 shrink-0" />
        ))}
    </button>
  </th>
);

/**
 * Список сделок — то же, что доска, но целиком и в любом порядке.
 *
 * Строка открывает ту же карточку, что доска: экран, с которого ничего нельзя
 * сделать, читают один раз и больше не возвращаются. Закрытые видны вместе с
 * исходом словами — за этим в список и приходят, когда закрытых больше, чем
 * помещается в колонку воронки.
 */
const DealTable: React.FC<{
  rows: CrmDealRow[];
  total: number;
  companies: CrmPartnerOptions['companies'];
  isUz: boolean;
  sort: Sort;
  dir: 'asc' | 'desc';
  busy: string | null;
  loadingMore: boolean;
  onSort: (k: Sort) => void;
  onMore: () => void;
  onOpen: (deal: CrmDealRow) => void;
}> = ({ rows, total, companies, isUz, sort, dir, busy, loadingMore, onSort, onMore, onOpen }) => {
  const outcome = (d: CrmDealRow) =>
    [d.lostReason?.name, d.closeComment].filter(Boolean).join(' · ');
  const open = (d: CrmDealRow) => (isUz ? 'Kartochkani ochish' : `Открыть сделку ${d.number}`);

  /* В холдинге рядом встают сделки двух компаний, а номера у них свои: без
     пометки две разные «СД-0007» в списке не отличить. Одна компания — метки
     нет, она ничего не добавляет. */
  const multi = new Set(rows.map((d) => d.company.uid)).size > 1;
  const companyName = (uid: string, code: string) => {
    const c = companies.find((x) => x.uid === uid);
    return c ? (refName(c, isUz)) : code;
  };

  return (
    <div className={`${CARD} min-w-0`}>
      {/* Ниже lg строка становится карточкой «подпись — значение»: то же
          решение, что в отчётах склада, и по той же причине — прокрутка вбок
          прячет правый край. */}
      <ul className="lg:hidden divide-y divide-zinc-200 dark:divide-zinc-800/60">
        {rows.map((d) => (
          <li key={d.uid}>
            <button
              type="button"
              onClick={() => onOpen(d)}
              aria-label={open(d)}
              className={`w-full text-left px-4 py-3 flex flex-col gap-1 cursor-pointer hover:bg-zinc-50/70 dark:hover:bg-zinc-800/40 ${
                busy === d.uid ? 'opacity-50' : ''
              }`}
            >
              <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
                {d.title}
              </span>
              <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px]">
                <dt className="text-zinc-500">{isUz ? 'Raqam' : 'Номер'}</dt>
                <dd className="font-mono text-zinc-800 dark:text-zinc-200">{d.number}</dd>
                {multi && (
                  <>
                    <dt className="text-zinc-500">{isUz ? 'Kompaniya' : 'Компания'}</dt>
                    <dd className="text-zinc-800 dark:text-zinc-200 break-words">
                      {companyName(d.company.uid, d.company.code)}
                    </dd>
                  </>
                )}
                <dt className="text-zinc-500">{isUz ? 'Mijoz' : 'Клиент'}</dt>
                <dd className="text-zinc-800 dark:text-zinc-200 break-words">
                  {d.partner?.name ?? '—'}
                </dd>
                <dt className="text-zinc-500">{isUz ? 'Summa' : 'Сумма'}</dt>
                <dd className="font-mono tabular-nums text-zinc-800 dark:text-zinc-200">
                  {money(d.amount)} {d.currency}
                </dd>
                <dt className="text-zinc-500">{isUz ? 'Bosqich' : 'Стадия'}</dt>
                <dd className="text-zinc-800 dark:text-zinc-200 break-words">{d.stage.name}</dd>
                <dt className="text-zinc-500">
                  {d.status === 'open'
                    ? isUz
                      ? 'Kutilmoqda'
                      : 'Ожидается'
                    : isUz
                      ? 'Yopilgan'
                      : 'Закрыта'}
                </dt>
                <dd className="font-mono tabular-nums text-zinc-800 dark:text-zinc-200">
                  {day(d.status === 'open' ? d.expectedCloseDate : d.closedAt)}
                </dd>
                {outcome(d) && (
                  <>
                    <dt className="text-zinc-500">{isUz ? 'Yakuni' : 'Исход'}</dt>
                    <dd className="text-zinc-800 dark:text-zinc-200 break-words">{outcome(d)}</dd>
                  </>
                )}
              </dl>
            </button>
          </li>
        ))}
      </ul>

      <div className="hidden lg:block">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 text-zinc-500 font-medium h-9 [&_th]:px-3 [&_th]:py-2">
              <SortTh k="number" sort={sort} dir={dir} onSort={onSort} className="w-24">
                {isUz ? 'Raqam' : 'Номер'}
              </SortTh>
              <SortTh k="title" sort={sort} dir={dir} onSort={onSort}>
                {isUz ? 'Bitim' : 'Сделка'}
              </SortTh>
              <SortTh k="partner" sort={sort} dir={dir} onSort={onSort}>
                {isUz ? 'Mijoz' : 'Клиент'}
              </SortTh>
              <SortTh
                k="amount"
                sort={sort}
                dir={dir}
                onSort={onSort}
                right
                className="text-right w-36"
              >
                {isUz ? 'Summa' : 'Сумма'}
              </SortTh>
              <SortTh k="stage" sort={sort} dir={dir} onSort={onSort} className="w-40">
                {isUz ? 'Bosqich' : 'Стадия'}
              </SortTh>
              <SortTh k="manager" sort={sort} dir={dir} onSort={onSort}>
                {isUz ? 'Menejer' : 'Менеджер'}
              </SortTh>
              {/* Ожидаемая дата уходит первой: на 1024 восемь столбцов тесны,
                  а у закрытых она уже ничего не решает. */}
              <SortTh
                k="expected"
                sort={sort}
                dir={dir}
                onSort={onSort}
                className="w-28 hidden xl:table-cell"
              >
                {isUz ? 'Kutilmoqda' : 'Ожидается'}
              </SortTh>
              <SortTh k="closed" sort={sort} dir={dir} onSort={onSort} className="w-28">
                {isUz ? 'Yopilgan' : 'Закрыта'}
              </SortTh>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800/60 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top">
            {rows.map((d) => (
              <tr
                key={d.uid}
                onClick={() => onOpen(d)}
                className={`hover:bg-zinc-50/70 dark:hover:bg-zinc-800/40 cursor-pointer ${
                  busy === d.uid ? 'opacity-50' : ''
                }`}
              >
                <td className="font-mono whitespace-nowrap">
                  {/* Номер — настоящая кнопка: строку открывают и с клавиатуры. */}
                  <button
                    type="button"
                    aria-label={open(d)}
                    className="text-zinc-900 dark:text-zinc-100 hover:underline cursor-pointer"
                  >
                    {d.number}
                  </button>
                  {multi && (
                    <span className="block text-[10px] text-zinc-400 font-sans break-words">
                      {companyName(d.company.uid, d.company.code)}
                    </span>
                  )}
                </td>
                <td className="text-zinc-900 dark:text-zinc-100 break-words">
                  {d.title}
                  {outcome(d) && (
                    <span className="block text-[10px] text-zinc-500 break-words">
                      {outcome(d)}
                    </span>
                  )}
                </td>
                <td className="text-zinc-600 dark:text-zinc-300 break-words">
                  {d.partner?.name ?? '—'}
                </td>
                <td className="text-right font-mono tabular-nums whitespace-nowrap text-zinc-900 dark:text-zinc-100">
                  {money(d.amount)}
                </td>
                <td className="text-zinc-600 dark:text-zinc-300 break-words">{d.stage.name}</td>
                <td className="text-zinc-500 break-words">{d.manager?.name ?? '—'}</td>
                <td className="text-zinc-500 font-mono tabular-nums whitespace-nowrap hidden xl:table-cell">
                  {day(d.expectedCloseDate)}
                </td>
                <td className="text-zinc-500 font-mono tabular-nums whitespace-nowrap">
                  {day(d.closedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Сколько показано из скольких: раньше список молча обрывался на первой
          странице, и о том, что сделок больше, экран не говорил. */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-t border-zinc-200 dark:border-zinc-800">
        <span className="text-[11px] text-zinc-500 tabular-nums">
          {isUz
            ? `${total} tadan ${rows.length} ta ko‘rsatilgan`
            : `Показано ${rows.length} из ${total}`}
        </span>
        {rows.length < total && (
          <button
            type="button"
            onClick={onMore}
            disabled={loadingMore}
            className={`${BTN_GHOST} whitespace-nowrap`}
          >
            {loadingMore
              ? isUz
                ? 'Yuklanmoqda…'
                : 'Загружаю…'
              : isUz
                ? `Yana ${Math.min(PAGE, total - rows.length)} ta`
                : `Показать ещё ${Math.min(PAGE, total - rows.length)}`}
          </button>
        )}
      </div>
    </div>
  );
};

const LoseDialog: React.FC<{
  deal: CrmDealRow;
  reasons: CrmLostReason[];
  isUz: boolean;
  onClose: () => void;
  onDone: (reasonUid: string, comment: string) => Promise<void>;
}> = ({ deal, reasons, isUz, onClose, onDone }) => {
  const [reasonUid, setReasonUid] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div
        className={`${CARD} w-full max-w-md p-4 flex flex-col gap-3`}
        role="dialog"
        aria-label={isUz ? 'Bitim amalga oshmadi' : 'Сделка не состоялась'}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {isUz ? 'Bitim amalga oshmadi' : 'Сделка не состоялась'}
            </span>
            <span className="text-[11px] text-zinc-500 break-words">
              {deal.number} · {deal.title}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={isUz ? 'Yopish' : 'Закрыть окно отказа'}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Sabab' : 'Причина'}</span>
          <CustomSelect
            ariaLabel={isUz ? 'Rad etish sababi' : 'Причина отказа'}
            value={reasonUid}
            onChange={setReasonUid}
            options={[
              { value: '', label: isUz ? 'tanlang' : 'выберите' },
              ...reasons.map((r) => ({
                value: r.uid,
                label: refName(r, isUz),
              })),
            ]}
          />
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-500">
            {isUz ? 'Nima bo‘ldi' : 'Что произошло'}
          </span>
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={
              isUz ? 'masalan: qo‘shnilarda 3% arzon' : 'например: у соседей на 3% дешевле'
            }
            aria-label={isUz ? 'Izoh' : 'Что произошло со сделкой'}
            className={FIELD}
          />
        </label>

        {/* Причина выбирается из справочника, а не пишется словами: из
            свободной строки отчёт собрался бы из опечаток — «дорого»,
            «Дорого», «дороже конкурента» стали бы тремя причинами. */}
        <p className="text-[11px] text-zinc-400 break-words">
          {isUz
            ? 'Sabab ma’lumotnomadan — hisobot uchun, izoh — tahlil uchun. Ikkalasi ham majburiy.'
            : 'Причина из справочника нужна отчёту, комментарий — разбору. Обязательны оба.'}
        </p>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy || !reasonUid || comment.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              try {
                await onDone(reasonUid, comment.trim());
              } finally {
                setBusy(false);
              }
            }}
            className={`${BTN_PRIMARY} whitespace-nowrap`}
          >
            {isUz ? 'Rad etishni yozish' : 'Записать отказ'}
          </button>
          <button type="button" onClick={onClose} className={`${BTN_GHOST} whitespace-nowrap`}>
            {isUz ? 'Bekor qilish' : 'Отмена'}
          </button>
        </div>
      </div>
    </div>
  );
};
