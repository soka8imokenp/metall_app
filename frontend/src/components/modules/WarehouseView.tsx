/**
 * Склад: остатки по партиям, уровни запаса, путь партии и складские операции.
 *
 * Всё на экране приходит из `/api/v1/warehouse/*`. Главное отличие от того,
 * что было здесь на фикстурах: строка остатка — это партия, а не позиция.
 * У партии свой сертификат, своя себестоимость и свой путь, и «дерево партии»
 * теперь открывает настоящий журнал движений, а не заглушку с одним и тем же
 * идентификатором на всех строках.
 *
 * Запас по складу не сводится в одну цифру количества: труба считается в
 * тоннах, скорлупа в погонных метрах. Складывается только стоимость.
 *
 * Приход, списание и перемещение заводятся тут же, в правой панели. Форма стоит
 * в ней постоянно, а не открывается кнопкой: кладовщик приходит на этот экран
 * именно записывать движение, и лишний шаг «нажми, чтобы начать» ничего не
 * добавляет. Ошибочное движение отменяется сторно из пути партии — журнал
 * движений не правят и не удаляют, в нём остаются оба.
 */

import React from 'react';
import {
  AlertCircle,
  AlertTriangle,
  PackageSearch,
  QrCode,
  Search,
  Undo2,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { errorText } from '../../context/DashboardContext';
import { MOVES_PAGE_SIZE, useWarehouse } from '../../context/WarehouseContext';
import {
  WarehouseBatchTrace,
  WarehouseSerialOption,
  WarehouseSerialTrace,
  WarehouseTraceLink,
  WarehouseMoveKind,
  WarehouseMoveRow,
  WarehouseStockRow,
  WarehouseSummary,
  InventoryStatus,
  InventorySheetRow,
  InventorySheetLineRow,
} from '../../types/api';
import {
  formatDate,
  formatMoneyShort,
  formatNumber,
  formatQty,
  formatUnit,
  plural,
  refName,
  toNumber,
} from '../../lib/formatters';
import { apiClient } from '../../lib/api-client';
import { CustomSelect, type CustomSelectOption } from '../common/CustomSelect';
import { LabelsPanel, ScannerField } from './WarehouseLabels';
import { NeedsPanel } from './WarehouseNeeds';
import { RefsPanel } from './WarehouseRefs';
import { AttachmentsButton, AttachmentsDialog } from './WarehouseAttachments';
import { ReportsPanel } from './WarehouseReports';
import {
  BTN_GHOST,
  BTN_PRIMARY,
  CARD,
  Empty,
  ErrorBox,
  FIELD,
  Skeleton,
} from './warehouse-ui';
import { CustomDatePicker } from '../common/CustomDatePicker';

const OPERATION: Record<string, { ru: string; uz: string }> = {
  receipt: { ru: 'Приход', uz: 'Kirim' },
  shipment: { ru: 'Отгрузка', uz: 'Jo‘natma' },
  transfer: { ru: 'Перемещение', uz: 'Ko‘chirish' },
  write_off: { ru: 'Списание', uz: 'Hisobdan chiqarish' },
  surplus: { ru: 'Оприходование излишка', uz: 'Ortiqchani kirim qilish' },
  issue_to_production: { ru: 'Выдача в цех', uz: 'Sexga berish' },
  output: { ru: 'Выпуск из цеха', uz: 'Sexdan chiqish' },
  return_from_client: { ru: 'Возврат от клиента', uz: 'Mijozdan qaytish' },
  return_from_production: { ru: 'Возврат из цеха', uz: 'Sexdan qaytish' },
};

const label = (
  map: Record<string, { ru: string; uz: string }>,
  key: string,
  isUz: boolean,
): string => (map[key] ? (isUz ? map[key].uz : map[key].ru) : key);

/** Дата и время движения: за смену журнал по одной дате не упорядочить. */
function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${formatDate(iso)}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Сводка
// ---------------------------------------------------------------------------

const Kpi: React.FC<{ title: string; value: string; hint?: string; tone?: 'warn' }> = ({
  title,
  value,
  hint,
  tone,
}) => (
  // На 360 в ряду две карточки, и подпись в одну строку не влезает. Обрезать
  // её нельзя: «Ниже критичес…» и «Стоимость запа…» — это уже не подпись.
  <div className={`${CARD} p-3 flex flex-col gap-1 min-w-0`}>
    <span className="text-[11px] text-zinc-500 leading-tight">{title}</span>
    <span
      className={`text-lg sm:text-xl font-bold font-mono tabular-nums ${
        tone === 'warn'
          ? 'text-amber-700 dark:text-amber-400'
          : 'text-zinc-950 dark:text-zinc-50'
      }`}
    >
      {value}
    </span>
    {hint && <span className="text-[11px] text-zinc-400 leading-tight">{hint}</span>}
  </div>
);

const SummaryCards: React.FC<{ d: WarehouseSummary; isUz: boolean }> = ({ d, isUz }) => {
  const moves = d.moves.reduce((s, m) => s + m.moves, 0);
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Kpi
        title={isUz ? 'Zaxira qiymati' : 'Стоимость запаса'}
        value={formatMoneyShort(d.stock.value, isUz ? 'uz' : 'ru')}
        hint={`${d.stock.warehouses} ${
          isUz ? 'ombor' : plural(d.stock.warehouses, 'склад', 'склада', 'складов')
        }`}
      />
      <Kpi
        title={isUz ? 'Partiyalar' : 'Партий на складе'}
        value={formatNumber(d.stock.batches)}
        hint={`${d.stock.items} ${
          isUz ? 'nomenklatura' : plural(d.stock.items, 'позиция', 'позиции', 'позиций')
        }`}
      />
      <Kpi
        title={isUz ? 'Kritik darajadan past' : 'Ниже критического'}
        value={formatNumber(d.levels.belowCritical)}
        hint={`${isUz ? 'minimumdan past' : 'ниже минимума'}: ${d.levels.belowMin}`}
        tone={d.levels.belowCritical > 0 ? 'warn' : undefined}
      />
      <Kpi
        title={isUz ? 'Davr harakatlari' : 'Движений за период'}
        value={formatNumber(moves)}
        hint={d.moves
          .slice(0, 2)
          .map((m) => `${label(OPERATION, m.operationType, isUz)} ${m.moves}`)
          .join(' · ')}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Складская операция
// ---------------------------------------------------------------------------

/**
 * Подпись — `span`, а не `label`: списки и календарь у нас свои, внутри у них
 * `button`, и клик по `label` прилетел бы к кнопке вторым — список открылся бы
 * и тут же закрылся. Доступность держится на `aria-label` самого поля.
 */
const FieldRow: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children,
}) => (
  <div className="flex flex-col gap-1 min-w-0">
    <span className="text-[10px] text-zinc-400 uppercase tracking-wider">{label}</span>
    {children}
    {hint && <span className="text-[10px] text-zinc-400">{hint}</span>}
  </div>
);

/** Те же маски, что у сервера: круг ради чтения отказа — лишний. */
const QTY_RE = /^\d{1,14}([.,]\d{1,6})?$/;
const COST_RE = /^\d{1,15}([.,]\d{1,4})?$/;

/**
 * Типы, которые заводят с этого экрана, в порядке частоты.
 *
 * Подписи берём из общего `OPERATION`: тем же справочником подписан журнал,
 * и разойтись названиям в форме и в журнале нельзя — человек читает их рядом.
 */
const FORM_KINDS: WarehouseMoveKind[] = [
  'receipt',
  'write_off',
  'transfer',
  'issue_to_production',
  'return_from_production',
  'return_from_client',
  'surplus',
];

/**
 * Право, без которого движение такого типа сервер не примет.
 *
 * Излишек стоит рядом со списанием: у него нет внешнего основания, остаток
 * растёт по слову человека — та же мера доверия, что списать в минус.
 */
const KIND_RIGHT: Record<WarehouseMoveKind, string> = {
  receipt: 'warehouse.move',
  write_off: 'warehouse.writeoff',
  transfer: 'warehouse.move',
  issue_to_production: 'warehouse.move',
  return_from_production: 'warehouse.move',
  return_from_client: 'warehouse.move',
  surplus: 'warehouse.writeoff',
};

/**
 * Стороны движения: та же таблица, что на сервере
 * (`backend/src/warehouse/write.service.ts`, `SIDES`).
 *
 * Форма по ней решает, какие поля показывать, и это не дубль ради удобства:
 * сервер обязан проверять сам, а экран обязан не спрашивать склад отправления
 * у возврата из цеха. Разойдутся — поймает сквозная проверка формы в
 * `qa/warehouse-live`.
 */
const KIND_SIDES: Record<WarehouseMoveKind, { from: boolean; to: boolean }> = {
  receipt: { from: false, to: true },
  write_off: { from: true, to: false },
  transfer: { from: true, to: true },
  issue_to_production: { from: true, to: false },
  return_from_production: { from: false, to: true },
  return_from_client: { from: false, to: true },
  surplus: { from: false, to: true },
};

/**
 * Виды причин по типу операции — зеркало серверного `REASON_KINDS`.
 *
 * Причину спрашиваем там, где остаток меняется без внешнего основания: списание
 * в минус и оприходование излишка в плюс. Виды у них не пересекаются, и это не
 * придирка: «Брак при транспортировке» на найденном товаре объясняет не то, что
 * произошло, а «Излишки по инвентаризации» на списании объясняет обратное.
 * Тип, которого в таблице нет, причину не принимает вовсе.
 */
const REASON_KINDS: Partial<Record<WarehouseMoveKind, string[]>> = {
  write_off: ['write_off', 'defect'],
  surplus: ['inventory'],
};

/**
 * Сегодня — по Ташкенту. `new Date().toISOString()` до 05:00 местного времени
 * отдаёт прошлую дату: ночная смена получала в поле «Дата» вчерашнее число.
 */
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());

interface MoveState {
  companyUid: string;
  kind: WarehouseMoveKind;
  itemCode: string;
  batchNumber: string;
  /** Серийный номер штучной позиции: у прихода новый, у расхода из подбора. */
  serialNumber: string;
  qty: string;
  fromWarehouseCode: string;
  fromLocationCode: string;
  toWarehouseCode: string;
  toLocationCode: string;
  unitCost: string;
  reasonId: string;
  partnerUid: string;
  movedAt: string;
  comment: string;
}

/**
 * Форма движения занимает правую панель целиком.
 *
 * Поля показываются по типу операции, а не все сразу: у прихода нет склада
 * отправления, у перемещения нет причины, а у списания нет цены — её берут с той
 * строки остатка, откуда товар уходит. Форма, спрашивающая всё, заставляла бы
 * человека догадываться, что здесь не заполнять.
 *
 * Списки — наш `CustomSelect` с отрисовкой поверх страницы (`portal`): панель
 * прокручиваемая, и выпадашка на `position: absolute` обрезалась бы её краем.
 */
const MoveForm: React.FC<{ isUz: boolean }> = ({ isUz }) => {
  const { session, can } = useAuth();
  const { company } = useApp();
  const { refs, save, saving, saveError, lastSaved, stock } = useWarehouse();

  /**
   * Компании — только открытые переключателем наверху. Он же задаёт заголовок
   * `X-Company-Id`, и компания, которую заголовок закрыл, вернула бы на
   * сохранении «компания недоступна» — отказ на выбор, предложенный формой.
   */
  const CODE_BY_SWITCH: Record<string, string> = {
    company_trade: 'trade',
    company_factory: 'plant',
  };
  const onlyCode = CODE_BY_SWITCH[company];
  const companies = (session?.companies ?? []).filter((c) => !onlyCode || c.code === onlyCode);

  // Типы, на которые есть право. Кладовщику без права списания предлагать
  // списание незачем: он узнает об отказе нажатием.
  const kinds = FORM_KINDS.filter((k) => can(KIND_RIGHT[k]));

  const blank = (): MoveState => ({
    companyUid: companies[0]?.uid ?? '',
    kind: kinds[0] ?? 'receipt',
    itemCode: '',
    batchNumber: '',
    serialNumber: '',
    qty: '',
    fromWarehouseCode: '',
    fromLocationCode: '',
    toWarehouseCode: '',
    toLocationCode: '',
    unitCost: '',
    reasonId: '',
    partnerUid: '',
    movedAt: today(),
    comment: '',
  });

  const [state, setState] = React.useState<MoveState>(blank);
  const set = <K extends keyof MoveState>(key: K, value: MoveState[K]) =>
    setState((s) => ({ ...s, [key]: value }));

  const data = refs.data;

  /**
   * Справочник приходит по всем компаниям пользователя сразу, и строки в нём
   * неразличимы на вид: склад «Сергели» есть у торгового дома, «Склад сырья» —
   * у завода, а коды номенклатуры совпадают. Предложить их общим списком значит
   * подставить человеку отказ на сохранении.
   */
  const ofCompany = <T extends { companyUid: string }>(rows: T[] | undefined) =>
    (rows ?? []).filter((r) => r.companyUid === state.companyUid);

  const warehouses = ofCompany(data?.warehouses);
  const items = ofCompany(data?.items);
  const reasons = ofCompany(data?.reasons);
  const partners = ofCompany(data?.partners);

  const item = items.find((i) => i.code === state.itemCode) ?? null;
  const unit = item ? formatUnit(item.unit, isUz ? 'uz' : 'ru') : '';
  /** Штучный учёт: строка остатка, движение и лист пересчёта — на номер. */
  const isSerial = Boolean(item?.trackSerials);

  // Переключатель компаний мог закрыть ту, что выбрана в форме. Форма живёт в
  // панели постоянно и смену компании переживает, поэтому выбор правим руками —
  // иначе справочники отфильтруются в ноль без всяких объяснений.
  const companyKey = companies.map((c) => c.uid).join(',');
  React.useEffect(() => {
    if (companies.length === 0) return;
    if (companies.some((c) => c.uid === state.companyUid)) return;
    set('companyUid', companies[0].uid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyKey, state.companyUid]);

  // Сменили компанию — всё, что выбрано из её справочника, больше не её.
  const prevCompany = React.useRef(state.companyUid);
  React.useEffect(() => {
    if (prevCompany.current === state.companyUid) return;
    prevCompany.current = state.companyUid;
    setState((s) => ({
      ...s,
      itemCode: '',
      batchNumber: '',
      serialNumber: '',
      fromWarehouseCode: '',
      fromLocationCode: '',
      toWarehouseCode: '',
      toLocationCode: '',
      reasonId: '',
      partnerUid: '',
    }));
  }, [state.companyUid]);

  // Штучная позиция выбрана — количество ровно одно. Ставим сами: поле
  // только для чтения, и пустым оно бы просто не дало сохранить.
  React.useEffect(() => {
    if (isSerial && state.qty !== '1') set('qty', '1');
    if (!isSerial && state.serialNumber !== '') set('serialNumber', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSerial]);

  // Сменили тип операции — поля другой стороны и причина к нему не относятся.
  const prevKind = React.useRef(state.kind);
  React.useEffect(() => {
    if (prevKind.current === state.kind) return;
    prevKind.current = state.kind;
    setState((s) => ({
      ...s,
      fromWarehouseCode: KIND_SIDES[s.kind].from ? s.fromWarehouseCode : '',
      fromLocationCode: KIND_SIDES[s.kind].from ? s.fromLocationCode : '',
      toWarehouseCode: KIND_SIDES[s.kind].to ? s.toWarehouseCode : '',
      toLocationCode: KIND_SIDES[s.kind].to ? s.toLocationCode : '',
      // Причину сбрасываем всегда: виды причин у списания и у излишка не
      // пересекаются, и перенесённый выбор сервер отвергнет как чужой.
      reasonId: '',
      unitCost: KIND_SIDES[s.kind].from ? '' : s.unitCost,
      // Контрагента тоже: поставщик прихода и клиент возврата — разные роли, и
      // перенесённый выбор здесь не просто лишний, а неверный.
      partnerUid: '',
    }));
  }, [state.kind]);

  /**
   * Номера для подбора. Только на расходе и только те, что лежат на выбранном
   * складе: на приходе номер новый, и подбирать его не из чего. Запрос идёт
   * отдельно от таблицы остатков — она ограничена двумя сотнями строк и
   * фильтрами экрана, а в форме нужен полный список по этой позиции.
   */
  const [serialOptions, setSerialOptions] = React.useState<WarehouseSerialOption[]>([]);
  const needsPick = isSerial && KIND_SIDES[state.kind].from;
  React.useEffect(() => {
    if (!needsPick || !state.itemCode) {
      setSerialOptions([]);
      return;
    }
    let alive = true;
    apiClient.warehouse
      .getSerials({
        itemCode: state.itemCode,
        warehouseCode: state.fromWarehouseCode || undefined,
        limit: 200,
      })
      .then((r) => {
        if (alive) setSerialOptions(r.data.rows);
      })
      // Молча: подбор — подсказка, а не условие записи. Номер вводится и
      // руками, а красная полоса на месте списка сказала бы, что форма сломана.
      .catch(() => {
        if (alive) setSerialOptions([]);
      });
    return () => {
      alive = false;
    };
  }, [needsPick, state.itemCode, state.fromWarehouseCode, company]);

  const warehouseOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'tanlang' : 'выберите' },
    ...warehouses.map((w) => ({ value: w.code, label: refName(w, isUz), badge: w.code })),
  ];

  /**
   * Ячейки выбранного склада. Подпись — зона и ячейка вместе: код ячейки
   * уникален внутри зоны, а не склада, и «A-01» в двух зонах не ошибка данных.
   * Поэтому и значением уходит `ЗОНА/ЯЧЕЙКА` — сервер по нему не гадает.
   */
  const locations = ofCompany(data?.locations);
  const cellOptions = (warehouseCode: string): CustomSelectOption[] => [
    { value: '', label: isUz ? 'tanlang' : 'выберите' },
    ...locations
      .filter((l) => l.warehouseCode === warehouseCode)
      .map((l) => ({
        value: `${l.zoneCode}/${l.code}`,
        label: `${l.code} · ${isUz ? l.zoneNameUz : l.zoneNameRu}`,
        badge: l.zoneCode,
      })),
  ];
  const hasCells = (warehouseCode: string) =>
    warehouseCode !== '' && locations.some((l) => l.warehouseCode === warehouseCode);

  // Сменили склад — выбранная ячейка принадлежит прежнему. Оставить её значит
  // предложить человеку отказ «ячейка не найдена» уже на сохранении.
  const prevFromWarehouse = React.useRef(state.fromWarehouseCode);
  React.useEffect(() => {
    if (prevFromWarehouse.current === state.fromWarehouseCode) return;
    prevFromWarehouse.current = state.fromWarehouseCode;
    set('fromLocationCode', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.fromWarehouseCode]);

  const prevToWarehouse = React.useRef(state.toWarehouseCode);
  React.useEffect(() => {
    if (prevToWarehouse.current === state.toWarehouseCode) return;
    prevToWarehouse.current = state.toWarehouseCode;
    set('toLocationCode', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.toWarehouseCode]);

  // Состав полей — от сторон движения, а не от перечисления типов: иначе
  // каждый новый тип пришлось бы вписывать в десяток условий подряд.
  const hasFrom = KIND_SIDES[state.kind].from;
  const hasTo = KIND_SIDES[state.kind].to;
  const isWriteOff = state.kind === 'write_off';
  const isTransfer = state.kind === 'transfer';
  /**
   * Причина обязательна там, где остаток меняется без внешнего основания:
   * у списания и у оприходования излишка. Виды причин у них разные — брак и
   * порча против инвентаризации, — и список сужается тем же справочником,
   * которым проверяет сервер.
   */
  const reasonKinds = REASON_KINDS[state.kind];
  const needsReason = reasonKinds !== undefined;
  /** Контрагент: у прихода поставщик, у возврата клиент, и там он обязателен. */
  const isReturnFromClient = state.kind === 'return_from_client';
  const wantsPartner = state.kind === 'receipt' || isReturnFromClient;

  const itemOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'tanlang' : 'выберите' },
    ...items.map((i) => ({
      value: i.code,
      label: refName(i, isUz),
      sublabel: i.code,
      badge: formatUnit(i.unit, isUz ? 'uz' : 'ru'),
    })),
  ];

  // Причины сужены видом под тип операции: общий список предлагал бы списать
  // по инвентаризации и оприходовать по браку — сервер отвергает и то, и другое.
  const reasonOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'tanlang' : 'выберите' },
    ...reasons
      .filter((r) => (reasonKinds ? reasonKinds.includes(r.kind) : false))
      .map((r) => ({ value: r.id, label: refName(r, isUz) })),
  ];

  // Контрагент по роли: возврату нужен клиент, приходу поставщик. Один и тот же
  // контрагент бывает и тем, и другим — тогда он есть в обоих списках.
  const partnerOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'ko‘rsatilmagan' : 'не указан' },
    ...partners
      .filter((p) => (isReturnFromClient ? p.isClient : p.isSupplier))
      .map((p) => ({ value: p.uid, label: refName(p, isUz) })),
  ];

  const kindOptions: CustomSelectOption[] = kinds.map((k) => ({
    value: k,
    label: label(OPERATION, k, isUz),
  }));

  const companyOptions: CustomSelectOption[] = companies.map((c) => ({
    value: c.uid,
    label: refName(c, isUz),
  }));

  /**
   * Строка остатка, с которой товар уходит. Списывается доступное, а не то, что
   * лежит: под заказ товар резервируют, и на полностью зарезервированной строке
   * на складе есть пять тонн, а списать нельзя ни одной. Без подсказки такой
   * отказ читается как поломка формы.
   *
   * Берём из уже загруженной таблицы, второго запроса ради подсказки не делаем.
   * Таблица сужена фильтрами и ограничена двумя сотнями строк, поэтому строки
   * может не оказаться — тогда подсказки нет. Показать ноль было бы враньём.
   */
  const sourceRow = React.useMemo(() => {
    if (!hasFrom || !state.itemCode || !state.fromWarehouseCode) return null;
    const batch = state.batchNumber.trim();
    const serial = state.serialNumber.trim();
    const cell = state.fromLocationCode;
    return (
      (stock.data?.rows ?? []).find(
        (r) =>
          r.item.code === state.itemCode &&
          r.warehouse.code === state.fromWarehouseCode &&
          (batch ? r.batch?.number === batch : r.batch === null) &&
          // Остаток штучной позиции лежит на номере: строка без него — про
          // другую трубу, и подсказка по ней обещала бы чужой остаток.
          (serial ? r.serial === serial : r.serial === null) &&
          // Ячейка в сравнении обязательна: списывается остаток полки, а не
          // склада, и подсказка по складу пообещала бы товар, которого в этой
          // ячейке нет. Ячейку ещё не выбрали — подсказки нет.
          (cell === '' ? false : `${r.zone ?? ''}/${r.location ?? ''}` === cell),
      ) ?? null
    );
  }, [
    hasFrom,
    state.itemCode,
    state.fromWarehouseCode,
    state.fromLocationCode,
    state.batchNumber,
    state.serialNumber,
    stock.data,
  ]);

  const qtyHint = (): string | undefined => {
    const unitPart = unit ? `${isUz ? 'birlik' : 'единица'}: ${unit}` : '';
    if (!sourceRow) return unitPart || undefined;
    const free = `${isUz ? 'mavjud' : 'доступно'}: ${formatQty(sourceRow.qtyAvailable)}`;
    const held =
      Number(sourceRow.qtyReserved) > 0
        ? ` · ${isUz ? 'zaxirada' : 'в резерве'} ${formatQty(sourceRow.qtyReserved)}`
        : '';
    return `${free}${held}${unitPart ? ` · ${unitPart}` : ''}`;
  };

  const problem = (): string | null => {
    if (!state.itemCode) return isUz ? 'Nomenklaturani tanlang' : 'Выберите номенклатуру';
    if (item?.trackBatches && !state.batchNumber.trim()) {
      return isUz ? 'Partiya raqami kerak' : 'Для этой номенклатуры нужен номер партии';
    }
    if (!item?.trackBatches && state.batchNumber.trim()) {
      return isUz ? 'Bu nomenklatura partiyasiz' : 'Эта номенклатура учитывается без партий';
    }
    if (isSerial && !state.serialNumber.trim()) {
      return isUz ? 'Seriya raqami kerak' : 'Для этой номенклатуры нужен серийный номер';
    }
    if (!isSerial && state.serialNumber.trim()) {
      return isUz
        ? 'Bu nomenklatura seriya raqamisiz'
        : 'Эта номенклатура учитывается без серийных номеров';
    }
    // Одно движение — одна штука. Количество формой и подставляется, но
    // человек мог стереть его руками, а сервер такую строку не примет.
    if (isSerial && state.qty.trim().replace(',', '.') !== '1') {
      return isUz ? 'Seriya raqami — bitta dona' : 'Серийный номер — одна штука: количество 1';
    }
    if (!QTY_RE.test(state.qty.trim()) || Number(state.qty.trim().replace(',', '.')) <= 0) {
      return isUz
        ? 'Miqdor — noldan katta son'
        : 'Количество: число больше нуля, до шести знаков после запятой';
    }
    if (hasTo && !state.toWarehouseCode) {
      return isUz ? 'Qabul omborini tanlang' : 'Выберите склад получения';
    }
    if (hasTo && hasCells(state.toWarehouseCode) && !state.toLocationCode) {
      return isUz ? 'Qabul yacheykasini tanlang' : 'Выберите ячейку получения';
    }
    // Приход без цены заводит партию с нулевой себестоимостью, и дальше по этой
    // цене товар спишется и уйдёт в отчёты. Сервер такое принимает, но молча
    // испорченная себестоимость дороже лишнего обязательного поля.
    if (!hasFrom && !COST_RE.test(state.unitCost.trim())) {
      return isUz ? 'Birlik narxi kerak' : 'Нужна цена за единицу';
    }
    if (hasFrom && !state.fromWarehouseCode) {
      return isUz ? 'Chiqarish omborini tanlang' : 'Выберите склад отправления';
    }
    if (hasFrom && hasCells(state.fromWarehouseCode) && !state.fromLocationCode) {
      return isUz ? 'Chiqarish yacheykasini tanlang' : 'Выберите ячейку отправления';
    }
    // Возврат без клиента — товар ниоткуда: по такой строке потом не ответить,
    // кто и по какой отгрузке его вернул. Сервер это тоже не примет.
    if (isReturnFromClient && !state.partnerUid) {
      return isUz ? 'Mijozni tanlang' : 'Выберите контрагента';
    }
    if (needsReason && !state.reasonId) {
      return isUz
        ? 'Sababni tanlang'
        : isWriteOff
          ? 'Списание без причины не принимается'
          : 'Оприходование излишка без причины не принимается';
    }
    if (isTransfer && (!state.fromWarehouseCode || !state.toWarehouseCode)) {
      return isUz ? 'Ikki ombor kerak' : 'Нужны склад отправления и склад получения';
    }
    // Перекладка внутри склада — обычная работа: товар переставили с открытой
    // площадки под навес. Не движется ничего только тогда, когда совпала и
    // ячейка.
    if (
      isTransfer &&
      state.fromWarehouseCode === state.toWarehouseCode &&
      state.fromLocationCode === state.toLocationCode
    ) {
      return isUz
        ? 'Ombor va yacheyka bir xil'
        : hasCells(state.fromWarehouseCode)
          ? 'Ячейки перемещения должны различаться'
          : 'Склады перемещения должны различаться';
    }
    // Нехватку ловит и сервер, но сказать об этом до нажатия честнее: остаток
    // для строки уже на экране, а резерв объясняет отказ, который иначе выглядит
    // как поломка. Считаем только когда строка нашлась в загруженной таблице.
    if (sourceRow && Number(state.qty.trim().replace(',', '.')) > Number(sourceRow.qtyAvailable)) {
      const held =
        Number(sourceRow.qtyReserved) > 0
          ? isUz
            ? ` (zaxirada ${formatQty(sourceRow.qtyReserved)})`
            : ` (в резерве ${formatQty(sourceRow.qtyReserved)})`
          : '';
      return isUz
        ? `Mavjud faqat ${formatQty(sourceRow.qtyAvailable)}${held}`
        : `Доступно только ${formatQty(sourceRow.qtyAvailable)}${held}`;
    }
    return null;
  };

  const invalid = problem();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (invalid || saving) return;

    const uid = await save({
      companyUid: state.companyUid,
      operationType: state.kind,
      itemCode: state.itemCode,
      ...(state.batchNumber.trim() ? { batchNumber: state.batchNumber.trim() } : {}),
      ...(state.serialNumber.trim() ? { serialNumber: state.serialNumber.trim() } : {}),
      qty: state.qty.trim().replace(',', '.'),
      ...(hasFrom ? { fromWarehouseCode: state.fromWarehouseCode } : {}),
      ...(hasFrom && state.fromLocationCode ? { fromLocationCode: state.fromLocationCode } : {}),
      ...(hasTo ? { toWarehouseCode: state.toWarehouseCode } : {}),
      ...(hasTo && state.toLocationCode ? { toLocationCode: state.toLocationCode } : {}),
      ...(hasFrom ? {} : { unitCost: state.unitCost.trim().replace(',', '.') }),
      ...(needsReason ? { reasonId: state.reasonId } : {}),
      ...(wantsPartner && state.partnerUid ? { partnerUid: state.partnerUid } : {}),
      // Дату отправляем только тогда, когда человек выбрал не сегодняшнюю:
      // день без времени ставит движение на начало дня, и приход, записанный
      // в 15:40, уезжал в журнале ниже всего записанного за день — человек не
      // находил того, что только что записал. Сегодня в поле означает
      // «сейчас», и время ставит сервер.
      ...(state.movedAt && state.movedAt !== today() ? { movedAt: state.movedAt } : {}),
      ...(state.comment.trim() ? { comment: state.comment.trim() } : {}),
    });

    // Записалось — очищаем количество и комментарий, остальное оставляем:
    // приход обычно принимают партиями по одной накладной, и выбирать склад с
    // номенклатурой заново на каждой строке — работа впустую.
    if (uid) setState((s) => ({ ...s, qty: isSerial ? '1' : '', serialNumber: '', comment: '' }));
  };

  if (kinds.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 text-center text-[11px] text-zinc-400">
        {isUz
          ? 'Ombor operatsiyalariga huquq yo‘q: faqat ko‘rish'
          : 'Прав на складские операции нет: экран только для чтения'}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex-1 flex flex-col justify-between overflow-hidden gap-3">
      <div className="shrink-0 pb-2.5 border-b border-zinc-100 dark:border-zinc-800/60">
        <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider">
          {isUz ? 'Ombor operatsiyasi' : 'Складская операция'}
        </span>
        <div className="text-base font-bold text-zinc-950 dark:text-zinc-50">
          {label(OPERATION, state.kind, isUz)}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pr-1 space-y-2.5">
        {refs.error && !data && <ErrorBox text={errorText(refs.error, isUz)} isUz={isUz} />}

        {/* Тип операции был переключателем, пока типов было три. Их семь:
            в ряд они не помещаются даже на 1440, а на 360 превращались бы
            в лесенку из обрезанных слов. Выбранный тип при этом не спрятан —
            он крупно написан в заголовке формы над списком. */}
        <FieldRow label={isUz ? 'Operatsiya turi' : 'Тип операции'}>
          <CustomSelect
            portal
            ariaLabel={isUz ? 'Operatsiya turi' : 'Тип операции'}
            value={state.kind}
            onChange={(v) => set('kind', v as WarehouseMoveKind)}
            options={kindOptions}
          />
        </FieldRow>

        {companies.length > 1 && (
          <FieldRow label={isUz ? 'Kompaniya' : 'Компания'}>
            <CustomSelect
              portal
              ariaLabel={isUz ? 'Kompaniya' : 'Компания'}
              value={state.companyUid}
              onChange={(v) => set('companyUid', v)}
              options={companyOptions}
            />
          </FieldRow>
        )}

        {/* Номенклатура — единственный список формы, который не пролистывают
            глазами: позиций триста, и называются они одинаково до последних
            знаков. Поэтому здесь поиск, полные названия и отдельное окно
            посреди страницы, а у склада, типа операции и причины — нет. */}
        <FieldRow label={isUz ? 'Nomenklatura' : 'Номенклатура'}>
          <CustomSelect
            searchable
            searchPlaceholder={
              isUz ? 'nomi, o‘lchami yoki kodi' : 'название, размер или код'
            }
            searchEmptyText={isUz ? 'hech narsa topilmadi' : 'ничего не нашлось'}
            closeLabel={isUz ? 'Yopish' : 'Закрыть'}
            ariaLabel={isUz ? 'Nomenklatura' : 'Номенклатура'}
            value={state.itemCode}
            onChange={(v) => set('itemCode', v)}
            options={itemOptions}
          />
        </FieldRow>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {/* Партию спрашиваем только у партионной номенклатуры: у остальной
              сервер её не примет, и пустое поле рядом читалось бы как забытое. */}
          {item?.trackBatches && (
            <FieldRow
              label={isUz ? 'Partiya' : 'Партия'}
              hint={
                state.kind === 'receipt'
                  ? isUz
                    ? 'yangi raqam partiyani ochadi'
                    : 'новый номер заведёт партию'
                  : isUz
                    ? 'mavjud partiya'
                    : 'только существующая'
              }
            >
              <input
                type="text"
                value={state.batchNumber}
                onChange={(e) => set('batchNumber', e.target.value)}
                placeholder="СР-00054"
                aria-label={isUz ? 'Partiya' : 'Партия'}
                className={`${FIELD} font-mono`}
              />
            </FieldRow>
          )}

          {/* Номер спрашиваем у штучной позиции: на приходе новый, на расходе
              из подбора. Свободный ввод оставлен и там: список ограничен
              двумя сотнями строк, а номер с бирки набирается быстрее, чем
              ищется в длинном списке. */}
          {isSerial && (
            <FieldRow
              label={isUz ? 'Seriya raqami' : 'Серийный номер'}
              hint={
                needsPick
                  ? serialOptions.length > 0
                    ? isUz
                      ? `omborda ${serialOptions.length} ta`
                      : `на складе ${serialOptions.length}`
                    : isUz
                      ? 'omborda yo‘q'
                      : 'на складе нет ни одного'
                  : isUz
                    ? 'yangi raqam'
                    : 'новый номер'
              }
            >
              {needsPick ? (
                <CustomSelect
                  portal
                  ariaLabel={isUz ? 'Seriya raqami' : 'Серийный номер'}
                  value={state.serialNumber}
                  onChange={(v) => set('serialNumber', v)}
                  options={[
                    { value: '', label: isUz ? 'tanlang' : 'выберите' },
                    ...serialOptions.map((o) => ({
                      value: o.number,
                      label: o.number,
                      badge: o.location ?? o.warehouseCode,
                    })),
                  ]}
                />
              ) : (
                <input
                  type="text"
                  value={state.serialNumber}
                  onChange={(e) => set('serialNumber', e.target.value)}
                  placeholder="SN-530-2026-0013"
                  aria-label={isUz ? 'Seriya raqami' : 'Серийный номер'}
                  className={`${FIELD} font-mono`}
                />
              )}
            </FieldRow>
          )}

          <FieldRow
            label={isUz ? 'Miqdor' : 'Количество'}
            hint={qtyHint()}
          >
            {/* У штучной позиции количество не спрашивают: одно движение —
                одна труба, и поле для ввода тут предлагало бы записать то,
                чего сервер не примет. */}
            <input
              type="text"
              inputMode="decimal"
              value={state.qty}
              onChange={(e) => set('qty', e.target.value)}
              readOnly={isSerial}
              placeholder="12.5"
              aria-label={isUz ? 'Miqdor' : 'Количество'}
              className={`${FIELD} font-mono`}
            />
          </FieldRow>

          {hasFrom && (
            <FieldRow label={isUz ? 'Qaysi ombordan' : 'Склад отправления'}>
              <CustomSelect
                portal
                ariaLabel={isUz ? 'Qaysi ombordan' : 'Склад отправления'}
                value={state.fromWarehouseCode}
                onChange={(v) => set('fromWarehouseCode', v)}
                options={warehouseOptions}
              />
            </FieldRow>
          )}

          {/* Ячейка идёт следом за своим складом, а не отдельным блоком внизу:
              это уточнение того же выбора. Склада не выбрали или ячеек у него
              нет — поля нет вовсе, пустой список выбирать нечем. */}
          {hasFrom && hasCells(state.fromWarehouseCode) && (
            <FieldRow label={isUz ? 'Qaysi yacheykadan' : 'Ячейка отправления'}>
              <CustomSelect
                portal
                ariaLabel={isUz ? 'Qaysi yacheykadan' : 'Ячейка отправления'}
                value={state.fromLocationCode}
                onChange={(v) => set('fromLocationCode', v)}
                options={cellOptions(state.fromWarehouseCode)}
              />
            </FieldRow>
          )}

          {hasTo && (
            <FieldRow label={isUz ? 'Qabul qiluvchi ombor' : 'Склад получения'}>
              <CustomSelect
                portal
                ariaLabel={isUz ? 'Qabul qiluvchi ombor' : 'Склад получения'}
                value={state.toWarehouseCode}
                onChange={(v) => set('toWarehouseCode', v)}
                options={warehouseOptions}
              />
            </FieldRow>
          )}

          {hasTo && hasCells(state.toWarehouseCode) && (
            <FieldRow label={isUz ? 'Qabul yacheykasi' : 'Ячейка получения'}>
              <CustomSelect
                portal
                ariaLabel={isUz ? 'Qabul yacheykasi' : 'Ячейка получения'}
                value={state.toLocationCode}
                onChange={(v) => set('toLocationCode', v)}
                options={cellOptions(state.toWarehouseCode)}
              />
            </FieldRow>
          )}

          {/* Цену спрашиваем там, где у движения нет стороны отправления:
              приход, возврат из цеха, возврат от клиента, излишек. Где товар
              откуда-то уходит, она берётся с той строки остатка — назначить её
              заново значит переписать историю закупки. */}
          {!hasFrom && (
            <FieldRow
              label={isUz ? 'Birlik narxi' : 'Цена за единицу'}
              hint={unit ? `${isUz ? 'so‘m' : 'сум'} / ${unit}` : undefined}
            >
              <input
                type="text"
                inputMode="decimal"
                value={state.unitCost}
                onChange={(e) => set('unitCost', e.target.value)}
                placeholder="8450000.00"
                aria-label={isUz ? 'Birlik narxi' : 'Цена за единицу'}
                className={`${FIELD} font-mono`}
              />
            </FieldRow>
          )}

          {needsReason && (
            <FieldRow label={isUz ? 'Sabab' : 'Причина'}>
              <CustomSelect
                portal
                ariaLabel={isUz ? 'Sabab' : 'Причина'}
                value={state.reasonId}
                onChange={(v) => set('reasonId', v)}
                options={reasonOptions}
              />
            </FieldRow>
          )}

          {wantsPartner && (
            <FieldRow
              label={
                isReturnFromClient
                  ? isUz
                    ? 'Mijoz'
                    : 'Клиент'
                  : isUz
                    ? 'Yetkazib beruvchi'
                    : 'Поставщик'
              }
            >
              <CustomSelect
                portal
                ariaLabel={
                  isReturnFromClient
                    ? isUz
                      ? 'Mijoz'
                      : 'Клиент'
                    : isUz
                      ? 'Yetkazib beruvchi'
                      : 'Поставщик'
                }
                value={state.partnerUid}
                onChange={(v) => set('partnerUid', v)}
                options={isReturnFromClient ? partnerOptions.slice(1) : partnerOptions}
              />
            </FieldRow>
          )}

          <FieldRow label={isUz ? 'Sana' : 'Дата'}>
            <CustomDatePicker
              portal
              ariaLabel={isUz ? 'Sana' : 'Дата'}
              value={state.movedAt}
              onChange={(v) => set('movedAt', v)}
            />
          </FieldRow>
        </div>

        <FieldRow label={isUz ? 'Izoh' : 'Комментарий'}>
          <input
            type="text"
            value={state.comment}
            maxLength={500}
            onChange={(e) => set('comment', e.target.value)}
            aria-label={isUz ? 'Izoh' : 'Комментарий'}
            className={FIELD}
          />
        </FieldRow>
      </div>

      <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800/60 shrink-0 space-y-2">
        {saveError && (
          <div
            role="alert"
            className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/30 text-[11px] text-red-700 dark:text-red-300"
          >
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span className="min-w-0 break-words">{saveError.message}</span>
          </div>
        )}
        {/* Записанное движение подтверждаем словами: остаток в таблице слева
            изменился, но на 360 таблицы в этот момент не видно. */}
        {!saveError && lastSaved && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 text-[11px] text-emerald-800 dark:text-emerald-300">
            <span className="min-w-0 break-words">
              {isUz ? 'Yozildi' : 'Записано'}: {label(OPERATION, lastSaved.kind, isUz)}{' '}
              {formatQty(lastSaved.qty)} · {lastSaved.itemCode}
            </span>
          </div>
        )}
        {invalid && <div className="text-[11px] text-zinc-500">{invalid}</div>}

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={saving || invalid !== null} className={BTN_PRIMARY}>
            {saving ? (isUz ? 'Yozilmoqda…' : 'Записываю…') : isUz ? 'Yozish' : 'Записать'}
          </button>
          <button
            type="button"
            onClick={() => setState(blank())}
            disabled={saving}
            className={BTN_GHOST}
          >
            {isUz ? 'Tozalash' : 'Сбросить'}
          </button>
          <span className="text-[10px] text-zinc-400">
            {isUz ? 'Qoldiq darhol o‘zgaradi' : 'Остаток изменится сразу'}
          </span>
        </div>
      </div>
    </form>
  );
};

// ---------------------------------------------------------------------------
// Путь партии
// ---------------------------------------------------------------------------

/** Подписи звеньев цепочки. Материал и продукция — не типы движения. */
const TRACE_KIND: Record<string, { ru: string; uz: string }> = {
  ...OPERATION,
  material: { ru: 'Материал', uz: 'Material' },
};

const PAYMENT: Record<string, { ru: string; uz: string }> = {
  paid: { ru: 'оплачен', uz: 'to‘langan' },
  partial: { ru: 'оплачен частично', uz: 'qisman to‘langan' },
  unpaid: { ru: 'не оплачен', uz: 'to‘lanmagan' },
};

/**
 * Одно звено цепочки: слева что это и когда, справа количество.
 *
 * Партия материала или выпущенной продукции — кнопка: ответ на «из чего это
 * сделано» почти всегда тянет следующий вопрос «а та партия откуда», и
 * заставлять искать её руками в таблице значит обрывать цепочку на середине.
 */
const TraceLink: React.FC<{
  link: WarehouseTraceLink;
  unit: string;
  isUz: boolean;
  onOpen: (uid: string) => void;
}> = ({ link, unit, isUz, onOpen }) => (
  <li className="px-4 py-2 flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
      <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
        {label(TRACE_KIND, link.kind, isUz)}
      </span>
      {link.item && (
        <span className="text-[11px] text-zinc-500 break-words">
          <span className="font-mono">{link.item.code}</span> · {link.item.name}
        </span>
      )}
      {link.batch && (
        <button
          type="button"
          onClick={() => onOpen(link.batch!.uid)}
          className="text-[11px] font-mono text-blue-700 dark:text-blue-400 underline underline-offset-2 hover:no-underline cursor-pointer"
        >
          {link.batch.number}
        </button>
      )}
      {link.docNumber && !link.batch && (
        <span className="text-[11px] text-zinc-500 font-mono">{link.docNumber}</span>
      )}
      {link.salesOrder && (
        <span className="text-[11px] text-zinc-500 font-mono">{link.salesOrder}</span>
      )}
      {link.partner && <span className="text-[11px] text-zinc-500 break-words">{link.partner}</span>}
      {link.payment && (
        // Оплата — часть ответа приёмки, а не справка: «отгружено, не оплачено»
        // и «отгружено, оплачено» — разные новости для того, кто смотрит.
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded ${
            link.payment.status === 'paid'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
              : link.payment.status === 'partial'
                ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'
                : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300'
          }`}
        >
          {label(PAYMENT, link.payment.status, isUz)}
        </span>
      )}
    </div>
    <div className="flex items-baseline gap-2 shrink-0">
      <span className="text-[11px] text-zinc-500 tabular-nums">{formatDate(link.at)}</span>
      <span className="text-xs font-mono tabular-nums text-zinc-900 dark:text-zinc-100">
        {formatQty(link.qty)} {formatUnit(unit, isUz ? 'uz' : 'ru')}
      </span>
    </div>
  </li>
);

const TracePanel: React.FC<{
  trace: WarehouseBatchTrace;
  isUz: boolean;
  onClose: () => void;
}> = ({ trace, isUz, onClose }) => {
  const { batch, balances, moves, upstream, downstream } = trace;
  const { can } = useAuth();
  /** Сертификат качества партии — вложение той же природы (ТЗ 5.6). */
  const [showFiles, setShowFiles] = React.useState(false);
  const { reverseMove, reversing, reverseError, setTraceUid } = useWarehouse();

  /**
   * Сторно предлагаем только там, где сервер его примет.
   *
   * Движения отгрузки и цеха сюда не входят: они — след документа, и отменять
   * их надо документом, иначе склад и продажи начнут рассказывать разное.
   * Уже отменённое движение и саму отмену сервер тоже не примет.
   */
  const canReverse = (m: WarehouseBatchTrace['moves'][number]): boolean => {
    if (m.reversed || m.reversalOf !== null) return false;
    if (m.docType !== null) return false;
    const right = KIND_RIGHT[m.operationType as WarehouseMoveKind];
    return right !== undefined && can(right);
  };

  return (
    <div className={`${CARD} overflow-hidden`}>
      {/* Крестик держим в одном ряду с номером партии: перенесённый на
          следующую строку, он читается как кнопка самой партии. */}
      <div className="px-4 py-3 flex items-start justify-between gap-2 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-bold text-zinc-950 dark:text-zinc-50 font-mono">
            {batch.number}
          </span>
          <span className="text-[11px] text-zinc-500 truncate">
            {batch.item.code} · {batch.item.name}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Файлы партии — сам сертификат качества, а не только его номер
              (ТЗ 5.6): номер рядом в реквизитах, скан лежит здесь. */}
          <AttachmentsButton onOpen={() => setShowFiles(true)} isUz={isUz} compact />
          <button
            type="button"
            onClick={onClose}
            aria-label={isUz ? 'Yopish' : 'Закрыть'}
            className="h-7 w-7 inline-flex items-center justify-center rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {showFiles && (
        <AttachmentsDialog
          owner="batch"
          uid={batch.uid}
          title={`${isUz ? 'Partiya' : 'Партия'} ${batch.number}`}
          canEdit={can('warehouse.move')}
          isUz={isUz}
          onClose={() => setShowFiles(false)}
        />
      )}

      <div className="px-4 py-3 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Kelib chiqishi' : 'Происхождение'}</span>
          <span className="text-zinc-900 dark:text-zinc-100 break-words">
            {batch.productionOrder
              ? `${isUz ? 'Sex, buyurtma' : 'Цех, заказ'} ${batch.productionOrder}`
              : (batch.supplier ?? (isUz ? 'noma’lum' : 'не указано'))}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Sertifikat' : 'Сертификат'}</span>
          <span className="text-zinc-900 dark:text-zinc-100 font-mono break-words">
            {batch.certificateNumber ?? '—'}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Tannarx' : 'Себестоимость'}</span>
          <span className="text-zinc-900 dark:text-zinc-100 font-mono tabular-nums">
            {formatMoneyShort(batch.unitCost, isUz ? 'uz' : 'ru')} /{' '}
            {formatUnit(batch.item.unit, isUz ? 'uz' : 'ru')}
          </span>
        </div>
      </div>

      <div className="px-4 py-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] border-b border-zinc-200 dark:border-zinc-800">
        <span className="text-zinc-500">{isUz ? 'Hozir omborda' : 'Сейчас на складе'}:</span>
        {balances.length === 0 ? (
          <span className="text-zinc-400">{isUz ? 'qoldiq yo‘q' : 'остатка нет'}</span>
        ) : (
          // Строка на ячейку, а не на склад: партия после перекладки лежит
          // на двух полках, и склад одной цифрой прячет, где её искать.
          balances.map((b) => (
            <span
              key={`${b.warehouse}:${b.location ?? '-'}`}
              className="text-zinc-700 dark:text-zinc-300"
            >
              {b.warehouse}
              {b.location ? <span className="font-mono text-zinc-500"> {b.location}</span> : ''}:{' '}
              <span className="font-mono tabular-nums">
                {formatQty(b.qtyOnHand)} {formatUnit(batch.item.unit, isUz ? 'uz' : 'ru')}
              </span>
            </span>
          ))
        )}
      </div>

      {/* Два конца цепочки идут до журнала: приёмка спрашивает «откуда и куда»,
          а журнал движений отвечает «что с ним делали» — это другой вопрос. */}
      <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-zinc-500 uppercase tracking-wide">
        {isUz ? 'Qayerdan kelgan' : 'Откуда пришло'}
      </div>
      {upstream.length === 0 ? (
        <div className="px-4 pb-2 text-[11px] text-zinc-400">
          {isUz ? 'kelib chiqishi ko‘rsatilmagan' : 'происхождение не записано'}
        </div>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
          {upstream.map((l, i) => (
            <TraceLink
              key={l.uid ?? `up:${i}`}
              link={l}
              unit={batch.item.unit}
              isUz={isUz}
              onOpen={setTraceUid}
            />
          ))}
        </ul>
      )}

      <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-zinc-500 uppercase tracking-wide border-t border-zinc-200 dark:border-zinc-800">
        {isUz ? 'Qayerga ketgan' : 'Куда ушло'}
      </div>
      {downstream.length === 0 ? (
        <div className="px-4 pb-2 text-[11px] text-zinc-400">
          {isUz ? 'hali hech qayerga' : 'пока никуда'}
        </div>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
          {downstream.map((l, i) => (
            <TraceLink
              key={l.uid ?? `down:${i}`}
              link={l}
              unit={batch.item.unit}
              isUz={isUz}
              onOpen={setTraceUid}
            />
          ))}
        </ul>
      )}

      {reverseError && (
        <div
          role="alert"
          className="mx-4 my-2 flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/30 text-[11px] text-red-700 dark:text-red-300"
        >
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span className="min-w-0 break-words">{reverseError.message}</span>
        </div>
      )}

      <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-zinc-500 uppercase tracking-wide border-t border-zinc-200 dark:border-zinc-800">
        {isUz ? 'Harakatlar jurnali' : 'Журнал движений'}
      </div>
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60 max-h-72 overflow-y-auto">
        {moves.map((m) => (
          <li key={m.uid} className="px-4 py-2 flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
              <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
                {label(OPERATION, m.operationType, isUz)}
              </span>
              <span className="text-[11px] text-zinc-500 font-mono">{m.docNumber ?? '—'}</span>
              {m.partner && (
                <span className="text-[11px] text-zinc-500 break-words">{m.partner}</span>
              )}
              {m.reason && (
                <span className="text-[11px] text-amber-700 dark:text-amber-400">{m.reason}</span>
              )}
              {/* Отменённое движение и саму отмену помечаем в журнале: иначе
                  пара строк «+7 и −7» читается как две разные операции. */}
              {m.reversalOf && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
                  {isUz ? 'storno' : 'сторно'}
                </span>
              )}
              {m.reversed && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
                  {isUz ? 'bekor qilingan' : 'отменено'}
                </span>
              )}
            </div>
            <div className="flex items-baseline gap-2 shrink-0">
              <span
                className={`text-xs font-mono tabular-nums ${
                  m.toWarehouse
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-zinc-700 dark:text-zinc-300'
                }`}
              >
                {m.toWarehouse ? '+' : '−'}
                {formatQty(m.qty)} {formatUnit(batch.item.unit, isUz ? 'uz' : 'ru')}
              </span>
              <span className="text-[11px] text-zinc-400 tabular-nums">
                {formatDateTime(m.movedAt)}
              </span>
              {canReverse(m) && (
                <button
                  type="button"
                  onClick={() => reverseMove(m.uid)}
                  disabled={reversing !== null}
                  title={
                    isUz
                      ? 'Teskari harakat bilan bekor qilish'
                      : 'Отменить зеркальным движением: строка журнала останется'
                  }
                  className="h-6 px-2 inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 text-[10px] font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  <Undo2 className="w-3 h-3" />
                  {reversing === m.uid
                    ? isUz
                      ? 'Bekor qilinmoqda…'
                      : 'Отменяю…'
                    : isUz
                      ? 'Storno'
                      : 'Сторно'}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Путь серийного номера
// ---------------------------------------------------------------------------

/** Состояние штуки словами: enum базы человеку ничего не говорит. */
const SERIAL_STATE: Record<string, { ru: string; uz: string; tone: string }> = {
  in_stock: {
    ru: 'на складе',
    uz: 'omborda',
    tone: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300',
  },
  in_production: {
    ru: 'в производстве',
    uz: 'ishlab chiqarishda',
    tone: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300',
  },
  shipped: {
    ru: 'отгружена',
    uz: 'jo‘natilgan',
    tone: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300',
  },
  written_off: {
    ru: 'списана',
    uz: 'hisobdan chiqarilgan',
    tone: 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300',
  },
};

/**
 * Путь одной штуки.
 *
 * Отдельная панель, а не карточка партии: у штучной позиции партии нет, и
 * вопрос к ней другой — не «сколько осталось», а «где эта труба сейчас».
 * Поэтому наверху состояние и место, а не список остатков по складам.
 */
const SerialPanel: React.FC<{
  trace: WarehouseSerialTrace;
  isUz: boolean;
  onClose: () => void;
}> = ({ trace, isUz, onClose }) => {
  const { serial, place, moves } = trace;
  const { setTraceUid } = useWarehouse();
  const state = SERIAL_STATE[serial.state];
  const unit = formatUnit(serial.item.unit, isUz ? 'uz' : 'ru');

  return (
    <div className={`${CARD} overflow-hidden`}>
      <div className="px-4 py-3 flex items-start justify-between gap-2 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex flex-col min-w-0 gap-1">
          <div className="flex flex-wrap items-baseline gap-2 min-w-0">
            <span className="text-sm font-bold text-zinc-950 dark:text-zinc-50 font-mono break-all">
              {serial.number}
            </span>
            {state && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${state.tone}`}>
                {isUz ? state.uz : state.ru}
              </span>
            )}
          </div>
          <span className="text-[11px] text-zinc-500 break-words">
            {serial.item.code} · {serial.item.name}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={isUz ? 'Yopish' : 'Закрыть'}
          className="h-7 w-7 inline-flex items-center justify-center rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Hozir' : 'Сейчас'}</span>
          {/* Уехавшая или списанная штука места не имеет, и «—» тут честнее
              последнего склада: по нему её пошли бы искать. */}
          <span className="text-zinc-900 dark:text-zinc-100 break-words">
            {place ? (
              <>
                {place.warehouse}
                {place.location && (
                  <span className="font-mono text-zinc-500"> {place.location}</span>
                )}
                <span className="font-mono tabular-nums text-zinc-500">
                  {' '}
                  · {formatQty(place.qty)} {unit}
                </span>
              </>
            ) : (
              <span className="text-zinc-400">{isUz ? 'omborda yo‘q' : 'на складе нет'}</span>
            )}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Partiya' : 'Партия выпуска'}</span>
          {serial.batch ? (
            <button
              type="button"
              onClick={() => setTraceUid(serial.batch!.uid)}
              className="self-start font-mono text-xs text-zinc-900 dark:text-zinc-100 underline decoration-dotted underline-offset-2 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors cursor-pointer break-all"
            >
              {serial.batch.number}
            </button>
          ) : (
            <span className="text-zinc-400 text-xs">—</span>
          )}
        </div>
      </div>

      <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-zinc-500 uppercase tracking-wide">
        {isUz ? 'Harakatlar jurnali' : 'Журнал движений'}
      </div>
      {moves.length === 0 ? (
        <div className="px-4 pb-3 text-[11px] text-zinc-400">
          {isUz ? 'harakatlar yo‘q' : 'движений нет'}
        </div>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60 max-h-72 overflow-y-auto">
          {moves.map((m) => (
            <li
              key={m.uid}
              className="px-4 py-2 flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3"
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
                <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
                  {label(OPERATION, m.operationType, isUz)}
                </span>
                <span className="text-[11px] text-zinc-500 font-mono">{m.docNumber ?? '—'}</span>
                {m.partner && (
                  <span className="text-[11px] text-zinc-500 break-words">{m.partner}</span>
                )}
                {m.reason && (
                  <span className="text-[11px] text-amber-700 dark:text-amber-400">{m.reason}</span>
                )}
                {m.reversalOf && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
                    {isUz ? 'storno' : 'сторно'}
                  </span>
                )}
                {m.reversed && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
                    {isUz ? 'bekor qilingan' : 'отменено'}
                  </span>
                )}
              </div>
              <div className="flex items-baseline gap-2 shrink-0">
                <span
                  className={`text-xs font-mono tabular-nums ${
                    m.toWarehouse
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-zinc-700 dark:text-zinc-300'
                  }`}
                >
                  {m.toWarehouse ? '+' : '−'}
                  {formatQty(m.qty)} {unit}
                </span>
                <span className="text-[11px] text-zinc-400 tabular-nums">
                  {formatDateTime(m.movedAt)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Строка остатка
// ---------------------------------------------------------------------------

/**
 * Типоразмер: у трубы это Ø × стенка, у арматуры и листа стенки нет вовсе.
 * Подставлять туда ноль нельзя — «Ø12×0» читается как труба с нулевой
 * стенкой, то есть как ошибка данных.
 */
const sizeText = (r: WarehouseStockRow): string => {
  if (!r.item.diameterMm) return '';
  const d = `Ø${formatNumber(r.item.diameterMm)}`;
  return r.item.wallThicknessMm
    ? ` · ${d}×${formatNumber(r.item.wallThicknessMm)}`
    : ` · ${d}`;
};

const levelHint = (r: WarehouseStockRow, isUz: boolean): string | null => {
  if (r.isBelowCritical) {
    return `${isUz ? 'kritik' : 'критический'} ${formatQty(r.criticalQty)}`;
  }
  if (r.isBelowMin) return `${isUz ? 'minimum' : 'минимум'} ${formatQty(r.minQty)}`;
  return null;
};

/**
 * Почему строка подсвечена — целиком, но подсказкой, а не в ячейке.
 *
 * С уровнем сравнивается доступное, а не наличие (ТЗ 5.10), и без этого числа
 * «минимум 250» на строке, где лежит 313, читается как ошибка счёта. В самой
 * же ячейке ему места нет: она с `whitespace-nowrap`, и вторая строчка
 * растягивает колонку остатка, выдавливая за край таблицы себестоимость и
 * кнопку пути партии.
 */
const levelTitle = (r: WarehouseStockRow, isUz: boolean): string | undefined => {
  if (!r.isBelowMin) return undefined;
  const scope =
    r.levelScope === 'warehouse'
      ? isUz
        ? 'ombor darajasi'
        : 'уровень склада'
      : isUz
        ? 'kompaniya darajasi'
        : 'уровень компании';
  return isUz
    ? `${scope}: minimum ${formatQty(r.minQty)}, kritik ${formatQty(r.criticalQty)}; mavjud ${formatQty(r.levelAvailable)} (qoldiq minus faol zaxiralar)`
    : `${scope}: минимум ${formatQty(r.minQty)}, критический ${formatQty(r.criticalQty)}; доступно ${formatQty(r.levelAvailable)} (наличие минус активные резервы)`;
};

const StockCard: React.FC<{
  r: WarehouseStockRow;
  isUz: boolean;
  marked: boolean;
  onToggle: () => void;
  onTrace: () => void;
}> = ({ r, isUz, marked, onToggle, onTrace }) => {
  const unit = formatUnit(r.item.unit, isUz ? 'uz' : 'ru');
  const hint = levelHint(r, isUz);
  const why = levelTitle(r, isUz);
  return (
    <li
      className={`px-4 py-3 flex flex-col gap-2 ${
        r.isBelowCritical ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''
      }`}
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          {/* Отметка к печати этикетки (ТЗ 5.9) */}
          <input
            type="checkbox"
            checked={marked}
            onChange={onToggle}
            aria-label={`${isUz ? 'Yorliqqa belgilash' : 'Отметить к печати'}: ${r.item.code}`}
            className="w-3.5 h-3.5 shrink-0 cursor-pointer self-center"
          />
          <span className="text-xs font-mono font-medium text-zinc-900 dark:text-zinc-100 shrink-0">
            {r.item.code}
          </span>
          {hint && (
            <span title={why} className="text-[10px] text-amber-700 dark:text-amber-400 shrink-0">
              {hint}
            </span>
          )}
        </div>
        <span className="text-xs text-zinc-700 dark:text-zinc-300 break-words">
          {refName(r.item, isUz)}
        </span>
        <span className="text-[11px] text-zinc-400 break-words">
          {refName(r.warehouse, isUz)}
          {r.zone && r.location ? ` · ${r.zone}/${r.location}` : ''}
          {r.batch ? ` · ${r.batch.number}` : ''}
          {r.serial ? ` · №${r.serial}` : ''}
        </span>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-[11px] text-zinc-500">
          {isUz ? 'Qoldiq' : 'Остаток'}:{' '}
          <span className="font-mono tabular-nums text-zinc-800 dark:text-zinc-200">
            {formatQty(r.qtyOnHand)} {unit}
          </span>
        </span>
        <span className="text-[11px] text-zinc-500">
          {isUz ? 'Zaxira' : 'Резерв'}:{' '}
          <span className="font-mono tabular-nums">{formatQty(r.qtyReserved)}</span>
        </span>
        <span className="text-[11px] text-zinc-500">
          {isUz ? 'Mavjud' : 'Доступно'}:{' '}
          <span className="font-mono tabular-nums font-bold text-zinc-950 dark:text-zinc-50">
            {formatQty(r.qtyAvailable)} {unit}
          </span>
        </span>
      </div>

      {(r.batch || r.serial) && (
        <button
          type="button"
          onClick={onTrace}
          className="self-start h-7 px-2.5 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-[11px] font-medium text-zinc-800 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
        >
          <PackageSearch className="w-3 h-3" />
          {r.batch
            ? isUz
              ? 'Partiya yo‘li'
              : 'Путь партии'
            : isUz
              ? 'Raqam yo‘li'
              : 'Путь номера'}
        </button>
      )}
    </li>
  );
};

// ---------------------------------------------------------------------------
// Журнал движений
// ---------------------------------------------------------------------------

/**
 * Журнал движений: весь склад по времени, а не путь одной партии.
 *
 * Фильтры здесь свои — тип операции, позиция, партия и период; склад берётся
 * из общего фильтра над картой, чтобы на экране не оказалось двух списков
 * складов, которые человек читает как ошибку.
 *
 * Отмена стоит рядом со строкой, но предлагается не всегда: право на отмену,
 * движение под документом, сторно и уже отменённое считает сервер и присылает
 * готовый признак `canReverse`. Экран его не пересчитывает — иначе два места
 * решали бы одно и то же и однажды разошлись.
 */
const MovesPanel: React.FC<{ isUz: boolean }> = ({ isUz }) => {
  const { can } = useAuth();
  /** Открытое окно вложений: одно на панель, владелец — та строка, что нажали. */
  const [attachTo, setAttachTo] = React.useState<WarehouseMoveRow | null>(null);
  const {
    moves,
    movesFilters,
    setMovesFilter,
    resetMovesFilters,
    movesPage,
    setMovesPage,
    reloadMoves,
    reverseMove,
    reversing,
    reverseError,
  } = useWarehouse();

  const rows = moves.data?.rows ?? [];
  const total = moves.data?.total ?? 0;
  const pageSize = moves.data?.limit ?? MOVES_PAGE_SIZE;
  const from = total === 0 ? 0 : movesPage * pageSize + 1;
  const to = Math.min(total, movesPage * pageSize + rows.length);
  const hasFilters =
    Boolean(movesFilters.operationType) ||
    Boolean(movesFilters.itemCode) ||
    Boolean(movesFilters.batchNumber) ||
    Boolean(movesFilters.from) ||
    Boolean(movesFilters.to) ||
    Boolean(movesFilters.search);

  const typeOptions: CustomSelectOption[] = [
    { value: 'all', label: isUz ? 'Barcha operatsiyalar' : 'Все операции' },
    ...Object.keys(OPERATION).map((k) => ({ value: k, label: label(OPERATION, k, isUz) })),
  ];

  return (
    <div
      role="tabpanel"
      aria-label={isUz ? 'Harakatlar jurnali' : 'Журнал движений'}
      className="flex flex-col min-w-0"
    >
      {attachTo && (
        <AttachmentsDialog
          owner="stock_move"
          uid={attachTo.uid}
          title={`${label(OPERATION, attachTo.operationType, isUz)} · ${attachTo.item.code}`}
          canEdit={can('warehouse.move')}
          isUz={isUz}
          onClose={() => setAttachTo(null)}
        />
      )}
      {/* Фильтры журнала */}
      <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex flex-col gap-2">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={movesFilters.search}
              onChange={(e) => setMovesFilter('search', e.target.value)}
              placeholder={
                isUz
                  ? 'Kod, nom, partiya, izoh yoki kontragent'
                  : 'Код, наименование, партия, комментарий или контрагент'
              }
              aria-label={isUz ? 'Jurnalda qidirish' : 'Поиск в журнале'}
              className={FIELD + ' h-9 pl-9'}
            />
          </div>
          <div className="w-full sm:w-52 shrink-0">
            <CustomSelect
              value={movesFilters.operationType ?? 'all'}
              onChange={(v) =>
                setMovesFilter('operationType', v === 'all' ? null : (v as typeof movesFilters.operationType))
              }
              options={typeOptions}
              ariaLabel={isUz ? 'Operatsiya turi' : 'Тип операции'}
            />
          </div>
        </div>

        {/* Календари фильтра рисуются поверх страницы (`portal`). Внутри блока
            фильтров календарь лежит абсолютом в своей строке, и всё, что идёт
            в разметке ниже - таблица журнала и её шапка - перекрывает его:
            на 360 по числу можно попасть только там, где под ним пусто. */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1 min-w-0">
            <CustomDatePicker
              portal
              value={movesFilters.from}
              onChange={(v) => setMovesFilter('from', v)}
              placeholder={isUz ? 'Sanadan' : 'Дата с'}
              ariaLabel={isUz ? 'Sanadan' : 'Дата с'}
            />
          </div>
          <div className="flex-1 min-w-0">
            <CustomDatePicker
              portal
              value={movesFilters.to}
              onChange={(v) => setMovesFilter('to', v)}
              placeholder={isUz ? 'Sanagacha' : 'Дата по'}
              ariaLabel={isUz ? 'Sanagacha' : 'Дата по'}
            />
          </div>
          <input
            type="text"
            value={movesFilters.batchNumber}
            onChange={(e) => setMovesFilter('batchNumber', e.target.value)}
            placeholder={isUz ? 'Partiya raqami' : 'Номер партии'}
            aria-label={isUz ? 'Partiya raqami' : 'Номер партии'}
            className={FIELD + ' h-9 flex-1 min-w-0'}
          />
          <button
            type="button"
            onClick={resetMovesFilters}
            disabled={!hasFilters}
            className={BTN_GHOST + ' h-9 shrink-0'}
          >
            {isUz ? 'Tozalash' : 'Сбросить'}
          </button>
        </div>
      </div>

      {reverseError && (
        <div className="px-4 pt-3">
          <ErrorBox text={errorText(reverseError, isUz)} isUz={isUz} />
        </div>
      )}

      {moves.error ? (
        <ErrorBox text={errorText(moves.error, isUz)} onRetry={reloadMoves} isUz={isUz} />
      ) : moves.isLoading && rows.length === 0 ? (
        <Skeleton />
      ) : rows.length === 0 ? (
        <Empty
          text={
            hasFilters
              ? isUz
                ? 'Filtrga mos harakat yo‘q'
                : 'Движений по фильтру нет'
              : isUz
                ? 'Harakatlar jurnali bo‘sh'
                : 'Журнал движений пуст'
          }
        />
      ) : (
        <>
          {/* Узкий экран: те же данные карточками, у таблицы девять колонок */}
          <ul className="lg:hidden divide-y divide-zinc-200 dark:divide-zinc-800/60">
            {rows.map((m) => (
              <li key={m.uid} className="px-4 py-3 flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
                    {label(OPERATION, m.operationType, isUz)}
                  </span>
                  <span className="text-[11px] text-zinc-400 tabular-nums shrink-0">
                    {formatDateTime(m.movedAt)}
                  </span>
                </div>
                <div className="text-[11px] text-zinc-700 dark:text-zinc-300 break-words">
                  <span className="font-mono">{m.item.code}</span> ·{' '}
                  {refName(m.item, isUz)}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                  <span className="font-mono tabular-nums text-zinc-900 dark:text-zinc-100">
                    {formatQty(m.qty)} {formatUnit(m.item.unit, isUz ? 'uz' : 'ru')}
                  </span>
                  {m.batch && <span className="font-mono">{m.batch.number}</span>}
                  {m.serial && <span className="font-mono">№{m.serial}</span>}
                  <span>
                    {refName(m.fromWarehouse, isUz) || '—'} → {refName(m.toWarehouse, isUz) || '—'}
                  </span>
                </div>
                {(m.fromLocation || m.toLocation) && (
                  <div className="text-[10px] text-zinc-400 font-mono">
                    {m.fromLocation ?? '—'} → {m.toLocation ?? '—'}
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[10px] text-zinc-400 break-words min-w-0">
                    {[m.docNumber, m.partner, m.reason, m.author].filter(Boolean).join(' · ') || '—'}
                  </span>
                  <MoveMark m={m} isUz={isUz} />
                  <AttachmentsButton onOpen={() => setAttachTo(m)} isUz={isUz} />
                  {m.canReverse && (
                    <button
                      type="button"
                      onClick={() => reverseMove(m.uid)}
                      disabled={reversing === m.uid}
                      className={BTN_GHOST + ' h-7 shrink-0'}
                    >
                      <Undo2 className="w-3 h-3 inline-block mr-1" />
                      {isUz ? 'Storno' : 'Сторно'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <div className="hidden lg:block overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 text-zinc-500 font-medium h-9">
                  <th className="px-2 py-2">{isUz ? 'Sana' : 'Дата'}</th>
                  <th className="px-2 py-2">{isUz ? 'Operatsiya' : 'Операция'}</th>
                  {/* Партия стоит под кодом, автор — под документом: девяти
                      колонок рядом с постоянной панелью формы не хватает
                      ширины, и последние две уезжают под неё. По той же причине
                      здесь `px-2`, а не общий `px-3`: семь колонок с датой,
                      складами и ячейками в сумме на восемь пикселей шире
                      прокрутчика, и колонка «Действие» уезжала за край. */}
                  <th className="px-2 py-2">
                    {isUz ? 'Nomenklatura, partiya' : 'Номенклатура, партия'}
                  </th>
                  <th className="px-2 py-2">{isUz ? 'Qayerdan → qayerga' : 'Откуда → куда'}</th>
                  <th className="px-2 py-2 text-right">{isUz ? 'Miqdor' : 'Количество'}</th>
                  <th className="px-2 py-2">{isUz ? 'Hujjat, muallif' : 'Документ, автор'}</th>
                  <th className="px-2 py-2 text-center">{isUz ? 'Amal' : 'Действие'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
                {rows.map((m) => (
                  <tr
                    key={m.uid}
                    className={`h-10 hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40 transition-colors ${
                      m.reversalOf || m.reversed ? 'text-zinc-400 dark:text-zinc-500' : ''
                    }`}
                  >
                    <td className="px-2 py-2 tabular-nums whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                      {formatDateTime(m.movedAt)}
                    </td>
                    {/* Без `nowrap`: «Оприходование излишка» в одну строку
                        забирало 167px и выдавливало последнюю колонку под
                        правую панель. Подпись переносится, таблица влезает. */}
                    <td className="px-2 py-2">
                      <div className="flex flex-col">
                        <span className="text-zinc-900 dark:text-zinc-100 font-medium">
                          {label(OPERATION, m.operationType, isUz)}
                        </span>
                        <MoveMark m={m} isUz={isUz} />
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex flex-col">
                        <span className="font-mono text-zinc-900 dark:text-zinc-100">
                          {m.item.code}
                        </span>
                        <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                          {m.batch?.number ?? '—'}
                          {m.serial && ` №${m.serial}`}
                        </span>
                        <span className="text-[10px] text-zinc-400">
                          {refName(m.item, isUz)}
                        </span>
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex flex-col">
                        <span className="text-zinc-700 dark:text-zinc-300">
                          {refName(m.fromWarehouse, isUz) || '—'} → {refName(m.toWarehouse, isUz) || '—'}
                        </span>
                        {(m.fromLocation || m.toLocation) && (
                          <span className="text-[10px] text-zinc-400 font-mono">
                            {m.fromLocation ?? '—'} → {m.toLocation ?? '—'}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums whitespace-nowrap text-zinc-900 dark:text-zinc-100">
                      {formatQty(m.qty)}{' '}
                      <span className="text-zinc-400">
                        {formatUnit(m.item.unit, isUz ? 'uz' : 'ru')}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex flex-col">
                        <span className="text-zinc-700 dark:text-zinc-300">
                          {[m.docNumber, m.partner, m.reason].filter(Boolean).join(' · ') || '—'}
                        </span>
                        <span className="text-[10px] text-zinc-400">{m.author ?? '—'}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-center whitespace-nowrap">
                      {/* Скрепка стоит слева от сторно: вложение есть у любой
                          строки, а сторно — только у той, что сервер примет. */}
                      <AttachmentsButton onOpen={() => setAttachTo(m)} isUz={isUz} compact />
                      {m.canReverse ? (
                        <button
                          type="button"
                          onClick={() => reverseMove(m.uid)}
                          disabled={reversing === m.uid}
                          title={
                            isUz
                              ? 'Teskari harakat yoziladi'
                              : 'Запишется встречное движение, строка журнала останется'
                          }
                          className="px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 text-[11px] font-medium text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {isUz ? 'Storno' : 'Сторно'}
                        </button>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Страницы. Счётчик от сервера, а не длина массива: иначе «1861» на
          экране превратится в «50» и человек решит, что склад пуст. */}
      {total > 0 && (
        <div className="px-4 py-2.5 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-2">
          <span className="text-[11px] text-zinc-400 tabular-nums">
            {from}–{to} {isUz ? 'dan' : 'из'} {formatNumber(total)}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMovesPage(Math.max(0, movesPage - 1))}
              disabled={movesPage === 0 || moves.isLoading}
              className={BTN_GHOST + ' h-7'}
            >
              {isUz ? 'Oldingi' : 'Назад'}
            </button>
            <button
              type="button"
              onClick={() => setMovesPage(movesPage + 1)}
              disabled={to >= total || moves.isLoading}
              className={BTN_GHOST + ' h-7'}
            >
              {isUz ? 'Keyingi' : 'Далее'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/** Пометка «сторно» или «отменено»: без неё зачёркнутая строка ничего не объясняет. */
const MoveMark: React.FC<{ m: WarehouseMoveRow; isUz: boolean }> = ({ m, isUz }) => {
  if (m.reversalOf) {
    return (
      <span className="text-[10px] text-amber-700 dark:text-amber-400">
        {isUz ? 'Storno' : 'сторно'}
      </span>
    );
  }
  if (m.reversed) {
    return (
      <span className="text-[10px] text-amber-700 dark:text-amber-400">
        {isUz ? 'bekor qilingan' : 'отменено'}
      </span>
    );
  }
  if (m.docType) {
    return (
      <span className="text-[10px] text-zinc-400">
        {isUz ? 'hujjat bo‘yicha' : 'по документу'}
      </span>
    );
  }
  return null;
};

// ---------------------------------------------------------------------------
// Резервы
// ---------------------------------------------------------------------------

/**
 * Резервы: кому обещан товар, который ещё на складе.
 *
 * Отдельная вкладка, а не колонка в остатках, потому что в остатке от резерва
 * видно одно число. Оно не объясняет ни кому обещано, ни до какого срока, ни
 * кем — а снимать резерв приходится именно по этим признакам.
 *
 * Движения у резерва нет, и в журнале его искать бессмысленно: товар не поехал.
 * Поэтому и ставится он не формой движения, а здесь же, над списком.
 *
 * Что резервировать — выбирают строкой остатка, а не набором кода и партии
 * руками: партия у резерва обязательна (остаток партионной позиции весь разложен
 * по партиям), и список доступного сразу показывает, сколько ещё можно обещать.
 */
const ReservationsPanel: React.FC<{ isUz: boolean }> = ({ isUz }) => {
  const { can } = useAuth();
  const {
    reservations,
    reloadReservations,
    reserve,
    reserving,
    reserveError,
    clearReserveError,
    releaseReservation,
    releasing,
    stock,
    refs,
  } = useWarehouse();

  const [target, setTarget] = React.useState('');
  const [qty, setQty] = React.useState('');
  const [expiresAt, setExpiresAt] = React.useState('');
  const [orderNumber, setOrderNumber] = React.useState('');
  const [touched, setTouched] = React.useState(false);

  const mayReserve = can('warehouse.move');
  const rows = reservations.data?.rows ?? [];

  /**
   * Что можно обещать: строки остатка, сложенные по складу и партии.
   *
   * Складываем, потому что остаток разложен по ячейкам, а резерв ячейку не
   * выбирает — товар к отгрузке успеют переложить. Без сложения одна и та же
   * партия стояла бы в списке дважды с разным доступным.
   */
  const targets = React.useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        warehouseCode: string;
        warehouseName: string;
        itemCode: string;
        itemName: string;
        batch: string;
        unit: string;
        available: number;
      }
    >();
    for (const r of stock.data?.rows ?? []) {
      // Без партии резерв сервер не примет: непартионной номенклатуры в
      // остатках нет, а если появится — её партия будет пустой и здесь.
      if (!r.batch) continue;
      const key = `${r.warehouse.code}|${r.item.code}|${r.batch.number}`;
      const found = map.get(key);
      if (found) found.available += toNumber(r.qtyAvailable);
      else {
        map.set(key, {
          key,
          warehouseCode: r.warehouse.code,
          warehouseName: refName(r.warehouse, isUz),
          itemCode: r.item.code,
          itemName: refName(r.item, isUz),
          batch: r.batch.number,
          unit: formatUnit(r.item.unit, isUz ? 'uz' : 'ru'),
          available: toNumber(r.qtyAvailable),
        });
      }
    }
    return [...map.values()].sort((a, b) => a.itemCode.localeCompare(b.itemCode));
  }, [stock.data, isUz]);

  const chosen = targets.find((t) => t.key === target);
  const targetOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'Partiyani tanlang' : 'Выберите партию' },
    ...targets.map((t) => ({
      value: t.key,
      label: `${t.itemCode} · ${t.batch} · ${t.warehouseName} — ${
        isUz ? 'mavjud' : 'доступно'
      } ${formatQty(t.available)} ${t.unit}`,
    })),
  ];

  const qtyNumber = toNumber(qty.replace(',', '.'));
  const qtyOk = QTY_RE.test(qty.trim()) && qtyNumber > 0;
  const problem = !chosen
    ? isUz
      ? 'Partiya tanlanmagan'
      : 'Партия не выбрана'
    : !qtyOk
      ? isUz
        ? 'Miqdor: noldan katta son'
        : 'Количество: число больше нуля'
      : null;

  // Компанию берём по складу из справочников формы: у кладовщика их бывает две,
  // и коды складов у них свои. Сервер иначе поставит резерв в первую доступную.
  const companyUid = refs.data?.warehouses.find((w) => w.code === chosen?.warehouseCode)?.companyUid;

  const submit = async () => {
    setTouched(true);
    if (problem || !chosen) return;
    const uid = await reserve({
      ...(companyUid ? { companyUid } : {}),
      itemCode: chosen.itemCode,
      batchNumber: chosen.batch,
      warehouseCode: chosen.warehouseCode,
      qty: qty.trim().replace(',', '.'),
      ...(expiresAt ? { expiresAt } : {}),
      ...(orderNumber.trim() ? { salesOrderNumber: orderNumber.trim() } : {}),
    });
    if (uid) {
      setQty('');
      setOrderNumber('');
      setTouched(false);
    }
  };

  return (
    <div
      role="tabpanel"
      aria-label={isUz ? 'Zaxiralar' : 'Резервы'}
      className="flex flex-col min-w-0"
    >
      {/* Постановка резерва. Одной строкой над списком: полей четыре, и
          отдельная панель ради них отняла бы у списка половину ширины. */}
      {mayReserve && (
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex flex-col gap-2">
          <div className="flex flex-col lg:flex-row lg:items-end gap-2">
            <div className="flex-1 min-w-0">
              <FieldRow label={isUz ? 'Nomenklatura va partiya' : 'Номенклатура и партия'}>
                {/* Тот же случай, что и в форме операции: строк здесь по
                    числу партий на складах, и отличаются они хвостом
                    названия и номером партии. */}
                <CustomSelect
                  searchable
                  searchPlaceholder={
                    isUz ? 'nomi, o‘lchami yoki partiya' : 'название, размер или партия'
                  }
                  searchEmptyText={isUz ? 'hech narsa topilmadi' : 'ничего не нашлось'}
                  closeLabel={isUz ? 'Yopish' : 'Закрыть'}
                  value={target}
                  onChange={(v) => {
                    setTarget(v);
                    clearReserveError();
                  }}
                  options={targetOptions}
                  ariaLabel={isUz ? 'Nomenklatura va partiya' : 'Номенклатура и партия'}
                />
              </FieldRow>
            </div>
            <div className="w-full lg:w-28 shrink-0">
              <FieldRow label={isUz ? 'Miqdor' : 'Количество'}>
                <input
                  type="text"
                  inputMode="decimal"
                  value={qty}
                  onChange={(e) => {
                    setQty(e.target.value);
                    clearReserveError();
                  }}
                  placeholder={chosen ? chosen.unit : '0'}
                  aria-label={isUz ? 'Miqdor' : 'Количество'}
                  className={FIELD}
                />
              </FieldRow>
            </div>
            <div className="w-full lg:w-40 shrink-0">
              <FieldRow label={isUz ? 'Muddati' : 'Срок'}>
                <CustomDatePicker
                  portal
                  value={expiresAt}
                  onChange={setExpiresAt}
                  placeholder={isUz ? 'Muddatsiz' : 'Без срока'}
                  ariaLabel={isUz ? 'Zaxira muddati' : 'Срок резерва'}
                />
              </FieldRow>
            </div>
            <div className="w-full lg:w-40 shrink-0">
              <FieldRow label={isUz ? 'Buyurtma' : 'Заказ'}>
                <input
                  type="text"
                  value={orderNumber}
                  onChange={(e) => {
                    setOrderNumber(e.target.value);
                    clearReserveError();
                  }}
                  placeholder={isUz ? 'Raqami' : 'Номер'}
                  aria-label={isUz ? 'Buyurtma raqami' : 'Номер заказа'}
                  className={FIELD}
                />
              </FieldRow>
            </div>
            <button
              type="button"
              onClick={submit}
              disabled={reserving}
              className={BTN_PRIMARY + ' h-8 shrink-0'}
            >
              {reserving
                ? isUz
                  ? 'Saqlanmoqda…'
                  : 'Сохраняю…'
                : isUz
                  ? 'Zaxiraga olish'
                  : 'Зарезервировать'}
            </button>
          </div>

          {/* Свободное показываем до отправки: обещать сверх него можно только с
              правом «sales.order.oversell», и узнавать об этом из отказа поздно. */}
          {chosen && qtyOk && qtyNumber > chosen.available && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              {isUz
                ? `Mavjud faqat ${formatQty(chosen.available)} ${chosen.unit}: ortiqcha zaxira uchun «sales.order.oversell» huquqi kerak`
                : `Свободно только ${formatQty(chosen.available)} ${chosen.unit}: резерв сверх свободного требует права «sales.order.oversell»`}
            </p>
          )}
          {touched && problem && (
            <p role="alert" className="text-[11px] text-red-600 dark:text-red-400">
              {problem}
            </p>
          )}
        </div>
      )}

      {reserveError && (
        <div className="px-4 pt-3">
          <ErrorBox text={errorText(reserveError, isUz)} isUz={isUz} />
        </div>
      )}

      {reservations.error ? (
        <ErrorBox
          text={errorText(reservations.error, isUz)}
          onRetry={reloadReservations}
          isUz={isUz}
        />
      ) : reservations.isLoading && rows.length === 0 ? (
        <Skeleton />
      ) : rows.length === 0 ? (
        <Empty text={isUz ? 'Faol zaxira yo‘q' : 'Активных резервов нет'} />
      ) : (
        <>
          {/* Узкий экран: те же данные карточками */}
          <ul className="lg:hidden divide-y divide-zinc-200 dark:divide-zinc-800/60">
            {rows.map((r) => (
              <li key={r.uid} className="px-4 py-3 flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words min-w-0">
                    <span className="font-mono">{r.item.code}</span> ·{' '}
                    {refName(r.item, isUz)}
                  </span>
                  <span className="text-xs font-mono tabular-nums font-bold text-zinc-950 dark:text-zinc-50 shrink-0">
                    {formatQty(r.qty)} {formatUnit(r.item.unit, isUz ? 'uz' : 'ru')}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                  <span className="font-mono">{r.batch ?? '—'}</span>
                  <span>{refName(r.warehouse, isUz)}</span>
                  {r.expiresAt && (
                    <span className="tabular-nums">
                      {isUz ? 'muddati' : 'до'} {formatDate(r.expiresAt)}
                    </span>
                  )}
                  {r.overSold && (
                    <span className="text-amber-700 dark:text-amber-400">
                      {isUz ? 'omborda yetmaydi' : 'больше, чем на складе'}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[10px] text-zinc-400 break-words min-w-0">
                    {[r.orderNumber, r.partner, r.author].filter(Boolean).join(' · ') || '—'}
                  </span>
                  {mayReserve && (
                    <button
                      type="button"
                      onClick={() => releaseReservation(r.uid)}
                      disabled={releasing === r.uid}
                      className={BTN_GHOST + ' h-7 shrink-0'}
                    >
                      {isUz ? 'Bekor qilish' : 'Снять'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <div className="hidden lg:block overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 text-zinc-500 font-medium h-9">
                  <th className="px-2 py-2">
                    {isUz ? 'Nomenklatura, partiya' : 'Номенклатура, партия'}
                  </th>
                  <th className="px-2 py-2">{isUz ? 'Ombor' : 'Склад'}</th>
                  <th className="px-2 py-2 text-right">{isUz ? 'Zaxira' : 'Резерв'}</th>
                  <th className="px-2 py-2">{isUz ? 'Muddati' : 'Срок'}</th>
                  <th className="px-2 py-2">{isUz ? 'Buyurtma, xaridor' : 'Заказ, покупатель'}</th>
                  <th className="px-2 py-2">{isUz ? 'Kim, qachon' : 'Кто, когда'}</th>
                  <th className="px-2 py-2 text-center">{isUz ? 'Amal' : 'Действие'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
                {rows.map((r) => (
                  <tr
                    key={r.uid}
                    className="h-10 hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40 transition-colors"
                  >
                    <td className="px-2 py-2 font-medium text-zinc-900 dark:text-zinc-100">
                      <div className="flex flex-col">
                        <span className="font-mono">{r.item.code}</span>
                        <span className="text-[10px] text-zinc-400 font-normal font-mono">
                          {r.batch ?? '—'}
                        </span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-zinc-800 dark:text-zinc-200">
                      {refName(r.warehouse, isUz)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums font-bold text-zinc-950 dark:text-zinc-50 whitespace-nowrap">
                      <div className="flex flex-col items-end">
                        <span>
                          {formatQty(r.qty)} {formatUnit(r.item.unit, isUz ? 'uz' : 'ru')}
                        </span>
                        {r.overSold && (
                          <span className="text-[10px] font-normal text-amber-700 dark:text-amber-400">
                            {isUz ? 'omborda yetmaydi' : 'больше, чем на складе'}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2 tabular-nums text-zinc-600 dark:text-zinc-400">
                      {r.expiresAt ? formatDate(r.expiresAt) : '—'}
                    </td>
                    <td className="px-2 py-2 text-zinc-700 dark:text-zinc-300">
                      <div className="flex flex-col">
                        <span className="font-mono">{r.orderNumber ?? '—'}</span>
                        <span className="text-[10px] text-zinc-400">{r.partner ?? '—'}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-zinc-500">
                      <div className="flex flex-col">
                        <span>{r.author ?? '—'}</span>
                        <span className="text-[10px] text-zinc-400 tabular-nums">
                          {formatDate(r.createdAt)}
                        </span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-center">
                      {mayReserve ? (
                        <button
                          type="button"
                          onClick={() => releaseReservation(r.uid)}
                          disabled={releasing === r.uid}
                          title={
                            isUz
                              ? 'Zaxirani bekor qilish: tovar yana mavjud bo‘ladi'
                              : 'Снять резерв: товар снова станет доступным'
                          }
                          className={BTN_GHOST + ' h-7 whitespace-nowrap'}
                        >
                          {isUz ? 'Bekor qilish' : 'Снять'}
                        </button>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Инвентаризация
// ---------------------------------------------------------------------------

/**
 * Состояния листа. Цвет несёт тот же смысл, что и слово: пока лист открыт, он
 * ни на что не повлиял, и на остаток человек смотреть не должен.
 */
const SHEET_STATUS: Record<InventoryStatus, { ru: string; uz: string; tone: string }> = {
  draft: { ru: 'Черновик', uz: 'Qoralama', tone: 'text-zinc-500' },
  counting: { ru: 'Считают', uz: 'Sanoqda', tone: 'text-sky-700 dark:text-sky-400' },
  review: { ru: 'На утверждении', uz: 'Tasdiqlashda', tone: 'text-amber-700 dark:text-amber-400' },
  approved: { ru: 'Утверждён', uz: 'Tasdiqlangan', tone: 'text-emerald-700 dark:text-emerald-400' },
  cancelled: { ru: 'Отменён', uz: 'Bekor qilingan', tone: 'text-zinc-400' },
};

/** Место пересчёта: склад целиком или одна его зона. */
const sheetPlace = (s: InventorySheetRow, isUz: boolean) =>
  s.zone
    ? `${refName(s.warehouse, isUz)} · ${s.zone}`
    : `${refName(s.warehouse, isUz)} · ${isUz ? 'butun ombor' : 'весь склад'}`;

/**
 * Факт по строке листа.
 *
 * Своё состояние на ячейку, а не общая карта в панели: у полки считают по одной
 * строке, и перерисовывать из-за набранной цифры всю таблицу на двести строк
 * незачем. Записывается по Enter или кнопкой — не по уходу из поля: случайный
 * щелчок мимо не должен записывать недосчитанное.
 */
const CountCell: React.FC<{
  line: InventorySheetLineRow;
  editable: boolean;
  busy: boolean;
  isUz: boolean;
  onCount: (qty: string) => void;
}> = ({ line, editable, busy, isUz, onCount }) => {
  const current = line.qtyCounted ?? '';
  const [value, setValue] = React.useState(current);
  // Строку переписал кто-то другой или лист перечитан — показываем записанное.
  React.useEffect(() => setValue(line.qtyCounted ?? ''), [line.qtyCounted]);

  const text = value.trim().replace(',', '.');
  const ok = QTY_RE.test(text) && toNumber(text) >= 0;
  const dirty = text !== current;

  if (!editable) {
    return (
      <span className="font-mono tabular-nums text-zinc-900 dark:text-zinc-100">
        {line.qtyCounted === null ? '—' : formatQty(line.qtyCounted)}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1.5 justify-end">
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && ok && dirty) onCount(text);
        }}
        placeholder={isUz ? 'fakt' : 'факт'}
        aria-label={`${isUz ? 'Fakt' : 'Факт'} ${line.item.code}`}
        className={FIELD + ' w-24 text-right'}
      />
      <button
        type="button"
        onClick={() => onCount(text)}
        disabled={busy || !ok || !dirty}
        title={isUz ? 'Faktni yozish' : 'Записать факт'}
        className={BTN_GHOST + ' h-8 px-2 shrink-0'}
      >
        {busy ? '…' : isUz ? 'Yozish' : 'Записать'}
      </button>
    </div>
  );
};

/**
 * Инвентаризация (ТЗ 5.8).
 *
 * Одна вкладка на два разных занятия: выбрать лист и стоять с ним у полки.
 * Разводить их по экранам нельзя — с полки человек возвращается к списку, чтобы
 * взять следующую зону, и переход между ними должен быть в один щелчок.
 *
 * Учётное количество в строке — снимок на момент создания листа, а не текущий
 * остаток. Поэтому пересчёт и показывает расхождение: остаток с тех пор могли
 * сдвинуть, и лист об этом честно не знает.
 */
const InventoryPanel: React.FC<{ isUz: boolean }> = ({ isUz }) => {
  const { can } = useAuth();
  const {
    sheets,
    reloadSheets,
    sheetStatus,
    setSheetStatus,
    sheetUid,
    setSheetUid,
    sheet,
    reloadSheet,
    createSheet,
    countLine,
    finishSheet,
    approveSheet,
    cancelSheet,
    sheetBusy,
    sheetError,
    clearSheetError,
    refs,
  } = useWarehouse();

  const mayCount = can('warehouse.inventory');
  const mayApprove = can('warehouse.inventory.approve');

  const [warehouseCode, setWarehouseCode] = React.useState('');
  const [zoneCode, setZoneCode] = React.useState('');
  const [blockMode, setBlockMode] = React.useState<'block' | 'mark'>('mark');
  const [comment, setComment] = React.useState('');

  const warehouseOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'Omborni tanlang' : 'Выберите склад' },
    ...(refs.data?.warehouses ?? []).map((w) => ({
      value: w.code,
      label: refName(w, isUz),
    })),
  ];

  // Зоны берём из справочника ячеек: отдельного списка зон сервер не отдаёт, а
  // ячейка уже несёт свою зону. Дубли убираем — ячеек в зоне по три.
  const zoneOptions: CustomSelectOption[] = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const l of refs.data?.locations ?? []) {
      if (l.warehouseCode !== warehouseCode) continue;
      if (!seen.has(l.zoneCode)) seen.set(l.zoneCode, isUz ? l.zoneNameUz : l.zoneNameRu);
    }
    return [
      { value: '', label: isUz ? 'Butun ombor' : 'Весь склад' },
      ...[...seen.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([code, name]) => ({ value: code, label: `${code} — ${name}` })),
    ];
  }, [refs.data, warehouseCode, isUz]);

  const companyUid = refs.data?.warehouses.find((w) => w.code === warehouseCode)?.companyUid;

  const submit = async () => {
    if (!warehouseCode) return;
    const uid = await createSheet({
      ...(companyUid ? { companyUid } : {}),
      warehouseCode,
      ...(zoneCode ? { zoneCode } : {}),
      blockMode,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    });
    if (uid) {
      setComment('');
      setZoneCode('');
    }
  };

  const statusOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'Barcha holatlar' : 'Все состояния' },
    ...(Object.keys(SHEET_STATUS) as InventoryStatus[]).map((k) => ({
      value: k,
      label: isUz ? SHEET_STATUS[k].uz : SHEET_STATUS[k].ru,
    })),
  ];

  const rows = sheets.data?.rows ?? [];
  const open = sheet.data;

  // --- открытый лист --------------------------------------------------------
  if (sheetUid) {
    const status = open ? SHEET_STATUS[open.status] : null;
    const countable = mayCount && open !== null && ['draft', 'counting'].includes(open.status);
    const lines = open?.rows ?? [];
    const left = lines.filter((l) => l.qtyCounted === null).length;

    return (
      <div role="tabpanel" aria-label={isUz ? 'Inventarizatsiya' : 'Инвентаризация'} className="flex flex-col min-w-0">
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setSheetUid(null)} className={BTN_GHOST + ' h-8'}>
            {isUz ? '← Ro‘yxatga' : '← К списку'}
          </button>
          {open && (
            <>
              <span className="text-xs font-mono font-bold text-zinc-950 dark:text-zinc-50">
                {open.number}
              </span>
              <span className="text-xs text-zinc-600 dark:text-zinc-400">
                {sheetPlace(open, isUz)}
              </span>
              <span className={`text-[11px] font-medium ${status!.tone}`}>
                {isUz ? status!.uz : status!.ru}
              </span>
              <span className="text-[11px] text-zinc-400 tabular-nums">
                {isUz ? 'sanalgan' : 'посчитано'} {open.counted}/{open.lines}
                {open.diffLines > 0 && (
                  <>
                    {' · '}
                    {isUz ? 'farq' : 'расхождений'} {open.diffLines}
                  </>
                )}
              </span>

              <div className="flex items-center gap-1.5 sm:ml-auto">
                {mayCount && open.status === 'counting' && (
                  <button
                    type="button"
                    onClick={() => finishSheet(open.uid)}
                    disabled={sheetBusy !== null}
                    title={
                      isUz
                        ? 'Sanoq tugadi: varaq tasdiqlashga o‘tadi'
                        : 'Считать закончили: лист уйдёт на утверждение'
                    }
                    className={BTN_GHOST + ' h-8'}
                  >
                    {isUz ? 'Sanoq tugadi' : 'Посчитали'}
                  </button>
                )}
                {mayApprove && open.status === 'review' && (
                  <button
                    type="button"
                    onClick={() => approveSheet(open.uid)}
                    disabled={sheetBusy !== null}
                    title={
                      isUz
                        ? 'Farqlar jurnalga harakat bo‘lib tushadi'
                        : 'Расхождения уйдут в журнал движениями'
                    }
                    className={BTN_PRIMARY + ' h-8'}
                  >
                    {sheetBusy === 'approve'
                      ? isUz
                        ? 'Tasdiqlanmoqda…'
                        : 'Утверждаю…'
                      : isUz
                        ? 'Tasdiqlash'
                        : 'Утвердить'}
                  </button>
                )}
                {mayCount && ['draft', 'counting', 'review'].includes(open.status) && (
                  <button
                    type="button"
                    onClick={() => cancelSheet(open.uid)}
                    disabled={sheetBusy !== null}
                    title={
                      isUz ? 'Varaqni bekor qilish: qoldiq o‘zgarmaydi' : 'Отменить лист: остаток не изменится'
                    }
                    className={BTN_GHOST + ' h-8'}
                  >
                    {isUz ? 'Bekor qilish' : 'Отменить'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* Непосчитанные строки не пустят лист на утверждение: «товара нет» — это
            ноль, а не пропуск, и поставить его человек должен осознанно. */}
        {open && countable && left > 0 && (
          <p className="px-4 pt-3 text-[11px] text-amber-700 dark:text-amber-400">
            {isUz
              ? `Sanalmagan qator: ${left}. Tovar joyida bo‘lmasa — nol qo‘ying`
              : `Не посчитано строк: ${left}. Если товара нет на месте — ставьте ноль`}
          </p>
        )}

        {sheetError && (
          <div className="px-4 pt-3">
            <ErrorBox text={errorText(sheetError, isUz)} isUz={isUz} />
          </div>
        )}

        {sheet.error ? (
          <ErrorBox text={errorText(sheet.error, isUz)} onRetry={reloadSheet} isUz={isUz} />
        ) : sheet.isLoading && lines.length === 0 ? (
          <Skeleton />
        ) : lines.length === 0 ? (
          <Empty text={isUz ? 'Varaqda qator yo‘q' : 'В листе нет строк'} />
        ) : (
          <>
            {/* Узкий экран: строка листа карточкой. У полки считают с телефона,
                и таблица в десять колонок там не читается. */}
            <ul className="lg:hidden divide-y divide-zinc-200 dark:divide-zinc-800/60">
              {lines.map((l) => (
                <li key={l.uid} className="px-4 py-3 flex flex-col gap-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words min-w-0">
                      <span className="font-mono">{l.item.code}</span> ·{' '}
                      {refName(l.item, isUz)}
                    </span>
                    <span className="text-[11px] text-zinc-400 tabular-nums shrink-0">#{l.seq}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                    <span className="font-mono">{l.location ?? '—'}</span>
                    <span className="font-mono">
                      {l.batch ?? (l.serial ? `№${l.serial}` : '—')}
                    </span>
                    <span className="tabular-nums">
                      {isUz ? 'hisobda' : 'учётно'} {formatQty(l.qtyExpected)}{' '}
                      {formatUnit(l.item.unit, isUz ? 'uz' : 'ru')}
                    </span>
                    {l.qtyDiff !== null && toNumber(l.qtyDiff) !== 0 && (
                      <span
                        className={
                          toNumber(l.qtyDiff) > 0
                            ? 'text-emerald-700 dark:text-emerald-400 tabular-nums'
                            : 'text-red-600 dark:text-red-400 tabular-nums'
                        }
                      >
                        {toNumber(l.qtyDiff) > 0 ? '+' : ''}
                        {formatQty(l.qtyDiff)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-end">
                    <CountCell
                      line={l}
                      editable={countable}
                      busy={sheetBusy === `count:${l.uid}`}
                      isUz={isUz}
                      onCount={(qty) => countLine(l.uid, qty)}
                    />
                  </div>
                </li>
              ))}
            </ul>

            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 text-zinc-500 font-medium h-9">
                    <th className="px-2 py-2 text-right">№</th>
                    <th className="px-2 py-2">{isUz ? 'Nomenklatura, partiya' : 'Номенклатура, партия'}</th>
                    <th className="px-2 py-2">{isUz ? 'Joy' : 'Ячейка'}</th>
                    <th className="px-2 py-2 text-right">{isUz ? 'Hisobda' : 'Учётно'}</th>
                    <th className="px-2 py-2 text-right">{isUz ? 'Fakt' : 'Факт'}</th>
                    <th className="px-2 py-2 text-right">{isUz ? 'Farq' : 'Расхождение'}</th>
                    <th className="px-2 py-2">{isUz ? 'Kim, qachon' : 'Кто, когда'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
                  {lines.map((l) => {
                    const diff = l.qtyDiff === null ? null : toNumber(l.qtyDiff);
                    return (
                      <tr
                        key={l.uid}
                        className="h-10 hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40 transition-colors"
                      >
                        <td className="px-2 py-2 text-right tabular-nums text-zinc-400">{l.seq}</td>
                        <td className="px-2 py-2 font-medium text-zinc-900 dark:text-zinc-100">
                          <div className="flex flex-col">
                            <span className="font-mono">{l.item.code}</span>
                            <span className="text-[10px] text-zinc-400 font-normal font-mono">
                              {l.batch ?? (l.serial ? `№${l.serial}` : '—')}
                            </span>
                          </div>
                        </td>
                        <td className="px-2 py-2 font-mono text-zinc-700 dark:text-zinc-300">
                          {l.location ?? '—'}
                        </td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                          {formatQty(l.qtyExpected)} {formatUnit(l.item.unit, isUz ? 'uz' : 'ru')}
                        </td>
                        <td className="px-2 py-2 text-right whitespace-nowrap">
                          <CountCell
                            line={l}
                            editable={countable}
                            busy={sheetBusy === `count:${l.uid}`}
                            isUz={isUz}
                            onCount={(qty) => countLine(l.uid, qty)}
                          />
                        </td>
                        <td
                          className={`px-2 py-2 text-right font-mono tabular-nums whitespace-nowrap ${
                            diff === null || diff === 0
                              ? 'text-zinc-400'
                              : diff > 0
                                ? 'text-emerald-700 dark:text-emerald-400 font-bold'
                                : 'text-red-600 dark:text-red-400 font-bold'
                          }`}
                        >
                          {diff === null ? '—' : `${diff > 0 ? '+' : ''}${formatQty(l.qtyDiff!)}`}
                        </td>
                        <td className="px-2 py-2 text-zinc-500">
                          <div className="flex flex-col">
                            <span>{l.countedBy ?? '—'}</span>
                            <span className="text-[10px] text-zinc-400 tabular-nums">
                              {l.countedAt ? formatDate(l.countedAt) : '—'}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    );
  }

  // --- список листов --------------------------------------------------------
  return (
    <div role="tabpanel" aria-label={isUz ? 'Inventarizatsiya' : 'Инвентаризация'} className="flex flex-col min-w-0">
      {mayCount && (
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex flex-col gap-2">
          {/* Полей пять, и «растянуть первое» тут не работает: три списка рядом
              с кнопкой съедают всю строку, а поле склада схлопывается в ноль
              вместе со своей подписью. Поэтому спискам ширина задана, тянется
              только комментарий, а на узкой карте строка переносится. */}
          <div className="flex flex-col lg:flex-row lg:flex-wrap lg:items-end gap-2">
            <div className="w-full lg:w-56 shrink-0">
              <FieldRow label={isUz ? 'Ombor' : 'Склад'}>
                <CustomSelect
                  value={warehouseCode}
                  onChange={(v) => {
                    setWarehouseCode(v);
                    setZoneCode('');
                    clearSheetError();
                  }}
                  options={warehouseOptions}
                  ariaLabel={isUz ? 'Ombor' : 'Склад'}
                />
              </FieldRow>
            </div>
            <div className="w-full lg:w-48 shrink-0">
              <FieldRow label={isUz ? 'Zona' : 'Зона'}>
                <CustomSelect
                  value={zoneCode}
                  onChange={(v) => {
                    setZoneCode(v);
                    clearSheetError();
                  }}
                  options={zoneOptions}
                  ariaLabel={isUz ? 'Zona' : 'Зона'}
                />
              </FieldRow>
            </div>
            <div className="w-full lg:w-56 shrink-0">
              <FieldRow label={isUz ? 'Sanoq vaqtida' : 'На время пересчёта'}>
                <CustomSelect
                  value={blockMode}
                  onChange={(v) => setBlockMode(v as 'block' | 'mark')}
                  options={[
                    { value: 'mark', label: isUz ? 'Ishlashga ruxsat, belgilash' : 'Работать, но помечать' },
                    { value: 'block', label: isUz ? 'Operatsiyalarni to‘xtatish' : 'Остановить операции' },
                  ]}
                  ariaLabel={isUz ? 'Sanoq vaqtidagi rejim' : 'Режим на время пересчёта'}
                />
              </FieldRow>
            </div>
            <div className="w-full lg:flex-1 lg:min-w-36">
              <FieldRow label={isUz ? 'Izoh' : 'Комментарий'}>
                <input
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder={isUz ? 'Ixtiyoriy' : 'Необязательно'}
                  aria-label={isUz ? 'Izoh' : 'Комментарий'}
                  className={FIELD}
                />
              </FieldRow>
            </div>
            <button
              type="button"
              onClick={submit}
              disabled={sheetBusy !== null || !warehouseCode}
              className={BTN_PRIMARY + ' h-8 shrink-0'}
            >
              {sheetBusy === 'create'
                ? isUz
                  ? 'Ochilmoqda…'
                  : 'Создаю…'
                : isUz
                  ? 'Yangi varaq'
                  : 'Новый лист'}
            </button>
          </div>
          {/* Режим выбирают до подсчёта, а не после: остановка склада на время
              пересчёта — решение о работе смены, и задним числом его не примешь. */}
          <p className="text-[11px] text-zinc-400">
            {blockMode === 'block'
              ? isUz
                ? 'Bu joy bo‘yicha operatsiyalar varaq tasdiqlanmaguncha rad etiladi'
                : 'Операции по этому месту будут отвергаться до утверждения листа'
              : isUz
                ? 'Operatsiyalar o‘tadi, lekin jurnalda «sanoq vaqtida» deb belgilanadi'
                : 'Операции пройдут, но в журнале будут помечены «во время пересчёта»'}
          </p>
        </div>
      )}

      <div className="px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-800 flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-56">
          <CustomSelect
            value={sheetStatus ?? ''}
            onChange={(v) => setSheetStatus((v || null) as InventoryStatus | null)}
            options={statusOptions}
            ariaLabel={isUz ? 'Holat' : 'Состояние'}
          />
        </div>
      </div>

      {sheetError && (
        <div className="px-4 pt-3">
          <ErrorBox text={errorText(sheetError, isUz)} isUz={isUz} />
        </div>
      )}

      {sheets.error ? (
        <ErrorBox text={errorText(sheets.error, isUz)} onRetry={reloadSheets} isUz={isUz} />
      ) : sheets.isLoading && rows.length === 0 ? (
        <Skeleton />
      ) : rows.length === 0 ? (
        <Empty text={isUz ? 'Inventarizatsiya varaqlari yo‘q' : 'Листов инвентаризации нет'} />
      ) : (
        <>
          <ul className="lg:hidden divide-y divide-zinc-200 dark:divide-zinc-800/60">
            {rows.map((s) => (
              <li key={s.uid} className="px-4 py-3 flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-mono font-bold text-zinc-950 dark:text-zinc-50">
                    {s.number}
                  </span>
                  <span className={`text-[11px] font-medium shrink-0 ${SHEET_STATUS[s.status].tone}`}>
                    {isUz ? SHEET_STATUS[s.status].uz : SHEET_STATUS[s.status].ru}
                  </span>
                </div>
                <span className="text-[11px] text-zinc-500 break-words">{sheetPlace(s, isUz)}</span>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500 tabular-nums">
                  <span>
                    {isUz ? 'sanalgan' : 'посчитано'} {s.counted}/{s.lines}
                  </span>
                  {s.diffLines > 0 && (
                    <span className="text-amber-700 dark:text-amber-400">
                      {isUz ? 'farq' : 'расхождений'} {s.diffLines} ·{' '}
                      {formatMoneyShort(s.diffCost, isUz ? 'uz' : 'ru')}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[10px] text-zinc-400">
                    {[s.author, formatDate(s.createdAt)].filter(Boolean).join(' · ')}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSheetUid(s.uid)}
                    className={BTN_GHOST + ' h-7 shrink-0'}
                  >
                    {isUz ? 'Ochish' : 'Открыть'}
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <div className="hidden lg:block overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 text-zinc-500 font-medium h-9">
                  <th className="px-2 py-2">{isUz ? 'Raqam' : 'Номер'}</th>
                  <th className="px-2 py-2">{isUz ? 'Joy' : 'Место'}</th>
                  <th className="px-2 py-2">{isUz ? 'Holat' : 'Состояние'}</th>
                  <th className="px-2 py-2 text-right">{isUz ? 'Sanalgan' : 'Посчитано'}</th>
                  <th className="px-2 py-2 text-right">{isUz ? 'Farq' : 'Расхождение'}</th>
                  <th className="px-2 py-2">{isUz ? 'Kim, qachon' : 'Кто, когда'}</th>
                  <th className="px-2 py-2 text-center">{isUz ? 'Amal' : 'Действие'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
                {rows.map((s) => (
                  <tr
                    key={s.uid}
                    className="h-10 hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40 transition-colors"
                  >
                    <td className="px-2 py-2 font-mono font-bold text-zinc-950 dark:text-zinc-50">
                      {s.number}
                    </td>
                    <td className="px-2 py-2 text-zinc-800 dark:text-zinc-200">
                      {sheetPlace(s, isUz)}
                    </td>
                    <td className={`px-2 py-2 font-medium ${SHEET_STATUS[s.status].tone}`}>
                      {isUz ? SHEET_STATUS[s.status].uz : SHEET_STATUS[s.status].ru}
                      {s.blockMode === 'block' &&
                        ['draft', 'counting', 'review'].includes(s.status) && (
                          <span className="block text-[10px] font-normal text-zinc-400">
                            {isUz ? 'operatsiyalar to‘xtatilgan' : 'операции остановлены'}
                          </span>
                        )}
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                      {s.counted}/{s.lines}
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                      {s.diffLines === 0 ? (
                        <span className="text-zinc-400">—</span>
                      ) : (
                        <div className="flex flex-col items-end">
                          <span className="font-bold text-zinc-950 dark:text-zinc-50">
                            {s.diffLines}
                          </span>
                          <span
                            className={`text-[10px] font-normal ${
                              toNumber(s.diffCost) < 0
                                ? 'text-red-600 dark:text-red-400'
                                : 'text-emerald-700 dark:text-emerald-400'
                            }`}
                          >
                            {formatMoneyShort(s.diffCost, isUz ? 'uz' : 'ru')}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-zinc-500">
                      <div className="flex flex-col">
                        <span>{s.approvedBy ?? s.author ?? '—'}</span>
                        <span className="text-[10px] text-zinc-400 tabular-nums">
                          {formatDate(s.approvedAt ?? s.createdAt)}
                        </span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-center">
                      <button
                        type="button"
                        onClick={() => setSheetUid(s.uid)}
                        className={BTN_GHOST + ' h-7 whitespace-nowrap'}
                      >
                        {isUz ? 'Ochish' : 'Открыть'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Экран
// ---------------------------------------------------------------------------

export const WarehouseView: React.FC = () => {
  const { locale } = useApp();
  const isUz = locale === 'uz';
  const {
    summary,
    search,
    setSearch,
    warehouseUid,
    setWarehouseUid,
    criticalOnly,
    setCriticalOnly,
    stock,
    reloadStock,
    traceUid,
    setTraceUid,
    trace,
    serialNumber,
    setSerialNumber,
    serialTrace,
    tab,
    setTab,
    moves,
    reservations,
    sheets,
    needs,
    report,
    labelKeys,
    toggleLabelKey,
    clearLabelKeys,
  } = useWarehouse();

  const [labelsOpen, setLabelsOpen] = React.useState(false);

  /**
   * Форма операции стоит рядом только там, где ею пользуются по ходу чтения:
   * остатки, журнал, резервы, инвентаризация. Отчёт, потребность в закупке и
   * справочники — чтение и правка ширины экрана, и отдавать им на 340
   * пикселей меньше значит заставить читать таблицу боком.
   */
  const formBeside = !['needs', 'reports', 'refs'].includes(tab);

  const rows = stock.data?.rows ?? [];
  const marked = new Set(labelKeys);
  const warehouses = summary.data?.warehouses ?? [];

  const warehouseOptions = [
    { value: 'all', label: isUz ? 'Barcha omborlar' : 'Все склады' },
    ...warehouses.map((w) => ({ value: w.uid, label: refName(w, isUz) })),
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Сводка */}
      {summary.error ? (
        <div className={CARD}>
          <ErrorBox text={errorText(summary.error, isUz)} isUz={isUz} />
        </div>
      ) : summary.data ? (
        <SummaryCards d={summary.data} isUz={isUz} />
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-hidden>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`${CARD} p-3 h-[76px] animate-pulse`} />
          ))}
        </div>
      )}

      {/* Предупреждение об уровнях: не украшение, а повод нажать фильтр */}
      {summary.data && summary.data.levels.belowCritical > 0 && !criticalOnly && (
        <div className="rounded-xl border border-amber-300/70 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0" />
            <span className="text-xs text-amber-900 dark:text-amber-200 break-words">
              {isUz
                ? `${summary.data.levels.belowCritical} ta nomenklatura kritik darajadan past`
                : `${summary.data.levels.belowCritical} ${plural(
                    summary.data.levels.belowCritical,
                    'позиция',
                    'позиции',
                    'позиций',
                  )} ниже критического уровня`}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setCriticalOnly(true)}
            className="h-7 px-3 rounded-lg border border-amber-400/70 dark:border-amber-700 text-[11px] font-medium text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors cursor-pointer shrink-0"
          >
            {isUz ? 'Ko‘rsatish' : 'Показать'}
          </button>
        </div>
      )}

      {/* Сканер (ТЗ 5.9). Он стоит над фильтрами и виден на всех вкладках:
          подносят сканер к трубе не «на вкладке остатков», а просто подносят,
          и искать поле по вкладкам кладовщику незачем. */}
      <div className="w-full sm:max-w-md">
        <ScannerField isUz={isUz} />
      </div>

      {/* Фильтры. Склад общий для обоих видов — он и наверху. Поиск по
          остаткам и «только критические» относятся только к остаткам: в
          журнале свой поиск и свои фильтры, два поля с одним словом
          «поиск» на экране читаются как ошибка. */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        {tab === 'stock' && (
          <div className="relative flex-1 min-w-0">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                isUz
                  ? 'Kod, nom, partiya yoki seriya raqami'
                  : 'Код, наименование, партия или серийный номер'
              }
              aria-label={isUz ? 'Qidirish' : 'Поиск'}
              className="w-full h-9 pl-9 pr-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 outline-none focus:border-zinc-400 dark:focus:border-zinc-600 transition-colors"
            />
          </div>
        )}

        <div className={tab === 'stock' ? 'w-full sm:w-56 shrink-0' : 'w-full sm:w-56 sm:mr-auto'}>
          <CustomSelect
            value={warehouseUid ?? 'all'}
            onChange={(v) => setWarehouseUid(v === 'all' ? null : v)}
            options={warehouseOptions}
          />
        </div>

        {tab === 'stock' && (
          <button
            type="button"
            onClick={() => setCriticalOnly(!criticalOnly)}
            aria-pressed={criticalOnly}
            className={`h-9 px-3 inline-flex items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer shrink-0 ${
              criticalOnly
                ? 'border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200'
                : 'border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            {isUz ? 'Faqat kritik' : 'Только критические'}
          </button>
        )}
      </div>

      {/* Путь выбранного номера: та же полоса экрана, что и у партии, —
          открыть можно только что-то одно, кнопка у строки одна. */}
      {serialNumber && (
        <>
          {serialTrace.error ? (
            <div className={CARD}>
              <ErrorBox text={errorText(serialTrace.error, isUz)} isUz={isUz} />
            </div>
          ) : serialTrace.data ? (
            <SerialPanel
              trace={serialTrace.data}
              isUz={isUz}
              onClose={() => setSerialNumber(null)}
            />
          ) : (
            <div className={`${CARD} h-24 animate-pulse`} aria-hidden />
          )}
        </>
      )}

      {/* Путь выбранной партии */}
      {traceUid && (
        <>
          {trace.error ? (
            <div className={CARD}>
              <ErrorBox text={errorText(trace.error, isUz)} isUz={isUz} />
            </div>
          ) : trace.data ? (
            <TracePanel trace={trace.data} isUz={isUz} onClose={() => setTraceUid(null)} />
          ) : (
            <div className={`${CARD} h-24 animate-pulse`} aria-hidden />
          )}
        </>
      )}

      {/*
        Остатки и форма операции стоят рядом, а не друг под другом: набирая
        приход, кладовщик сверяется с остатком той же партии — он должен видеть
        оба. Места форме отведено фиксированно, таблице — всё остальное:
        у таблицы десять колонок, и делить ширину пополам ей нельзя.

        Порядок в разметке задан сеткой, а не порядком тегов: на узком экране
        форма идёт первой (за ней сюда и приходят), на широком — справа.

        Рядом с отчётами, потребностью и справочниками формы нет. Не потому,
        что тесно, а потому, что она там не нужна: отчёт читают, а не
        набирают приход. Её 340 пикселей — это две колонки таблицы, из-за
        которых отчёт уезжал вбок на любом экране.
      */}
      <div
        className={`grid grid-cols-1 gap-4 items-start ${
          formBeside ? 'lg:grid-cols-[minmax(0,1fr)_340px]' : ''
        }`}
      >
      {formBeside && (
        <div className={`${CARD} overflow-hidden lg:col-start-2 lg:row-start-1 lg:sticky lg:top-4 flex flex-col p-4 max-h-[calc(100vh-2rem)]`}>
          <MoveForm isUz={isUz} />
        </div>
      )}

      {/* Остатки */}
      <div className={`${CARD} overflow-hidden lg:col-start-1 lg:row-start-1 min-w-0`}>
        {/* Остатки и журнал — два взгляда на одно: «сколько есть сейчас» и
            «как к этому пришли». Разными экранами их разводить нельзя: сверяя
            остаток, кладовщик тут же смотрит, кто и когда его изменил. */}
        <div
          role="tablist"
          aria-label={isUz ? 'Ombor ko‘rinishi' : 'Вид склада'}
          className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 dark:border-zinc-800"
        >
          {/* Вкладок четыре, и в 360px строкой они не помещаются. Без переноса
              ряд кнопок становится шире карточки, браузер прокручивает её к
              выбранной вкладке — и вместе с кнопками уезжает влево вся панель
              под ними. Перенос, а не прокрутка: прокрученную вкладку человек на
              телефоне просто не находит. */}
          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                ['stock', isUz ? 'Qoldiqlar' : 'Остатки по партиям'],
                ['moves', isUz ? 'Harakatlar jurnali' : 'Журнал движений'],
                ['reservations', isUz ? 'Zaxiralar' : 'Резервы'],
                ['inventory', isUz ? 'Inventarizatsiya' : 'Инвентаризация'],
                ['needs', isUz ? 'Xarid ehtiyoji' : 'Потребность в закупке'],
                ['reports', isUz ? 'Hisobotlar' : 'Отчёты'],
                ['refs', isUz ? 'Ma’lumotnomalar' : 'Справочники'],
              ] as const
            ).map(([key, text]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`h-7 px-3 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  tab === key
                    ? 'bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900'
                    : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                {text}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {tab === 'stock' && (
              <button
                type="button"
                disabled={labelKeys.length === 0}
                onClick={() => setLabelsOpen(true)}
                className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-[11px] font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                <QrCode className="w-3.5 h-3.5" />
                {isUz ? 'Yorliqlar' : 'Этикетки'}
                {labelKeys.length > 0 ? ` (${labelKeys.length})` : ''}
              </button>
            )}
          <span className="text-[11px] text-zinc-400 tabular-nums">
            {isUz ? 'Yozuvlar' : 'Записей'}:{' '}
            {formatNumber(
              tab === 'moves'
                ? (moves.data?.total ?? 0)
                : tab === 'reservations'
                  ? (reservations.data?.total ?? 0)
                  : tab === 'inventory'
                    ? (sheets.data?.total ?? 0)
                    : tab === 'needs'
                      ? (needs.data?.total ?? 0)
                      : tab === 'reports'
                        ? (report.data?.total ?? 0)
                        : rows.length,
            )}
          </span>
          </div>
        </div>

        {tab === 'moves' ? (
          <MovesPanel isUz={isUz} />
        ) : tab === 'reservations' ? (
          <ReservationsPanel isUz={isUz} />
        ) : tab === 'inventory' ? (
          <InventoryPanel isUz={isUz} />
        ) : tab === 'needs' ? (
          <NeedsPanel isUz={isUz} />
        ) : tab === 'reports' ? (
          <ReportsPanel isUz={isUz} />
        ) : tab === 'refs' ? (
          <RefsPanel isUz={isUz} />
        ) : stock.error ? (
          <ErrorBox text={errorText(stock.error, isUz)} onRetry={reloadStock} isUz={isUz} />
        ) : stock.isLoading && rows.length === 0 ? (
          <Skeleton />
        ) : rows.length === 0 ? (
          <Empty
            text={
              criticalOnly
                ? isUz
                  ? 'Kritik darajadan past nomenklatura yo‘q'
                  : 'Позиций ниже критического уровня нет'
                : isUz
                  ? 'Qoldiq topilmadi'
                  : 'Остатков не найдено'
            }
          />
        ) : (
          <>
            {/* На узком экране таблица не читается: те же данные карточками */}
            <ul className="lg:hidden divide-y divide-zinc-200 dark:divide-zinc-800/60">
              {rows.map((r) => (
                <StockCard
                  key={r.key}
                  r={r}
                  isUz={isUz}
                  marked={marked.has(r.key)}
                  onToggle={() => toggleLabelKey(r.key)}
                  onTrace={() => (r.batch ? setTraceUid(r.batch.uid) : setSerialNumber(r.serial))}
                />
              ))}
            </ul>

            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 text-zinc-500 font-medium h-9">
                    {/* Партия стоит под кодом, марка — под наименованием. Десять
                        колонок рядом с постоянной панелью формы шире экрана на
                        168 пикселей: себестоимость и кнопка «Путь» уезжали под
                        панель, и строка выглядела полной, пока не потянешь
                        таблицу вбок. По той же причине здесь `px-2`. */}
                    {/* Отметка к печати этикетки (ТЗ 5.9). Чекбокс в шапке
                        отмечает всю видимую выборку и снимает её же: печатают
                        обычно весь приход целиком, а не строку за строкой. */}
                    <th className="px-2 py-2 w-8">
                      <input
                        type="checkbox"
                        className="w-3.5 h-3.5 align-middle cursor-pointer"
                        aria-label={
                          isUz ? 'Barcha qatorlarni belgilash' : 'Отметить все строки'
                        }
                        checked={rows.length > 0 && rows.every((r) => marked.has(r.key))}
                        onChange={(e) => {
                          if (!e.target.checked) {
                            clearLabelKeys();
                            return;
                          }
                          rows.forEach((r) => {
                            if (!marked.has(r.key)) toggleLabelKey(r.key);
                          });
                        }}
                      />
                    </th>
                    <th className="px-2 py-2">{isUz ? 'Kod, partiya' : 'Код, партия / №'}</th>
                    <th className="px-2 py-2">{isUz ? 'Nomenklatura, marka' : 'Номенклатура, марка'}</th>
                    <th className="px-2 py-2">{isUz ? 'Ombor / Yacheyka' : 'Склад / Ячейка'}</th>
                    <th className="px-2 py-2 text-right">{isUz ? 'Qoldiq' : 'Остаток'}</th>
                    <th className="px-2 py-2 text-right">{isUz ? 'Zaxira' : 'Резерв'}</th>
                    <th className="px-2 py-2 text-right">{isUz ? 'Mavjud' : 'Доступно'}</th>
                    <th className="px-2 py-2 text-right">{isUz ? 'Tannarx' : 'Себестоимость'}</th>
                    <th className="px-2 py-2 text-center">{isUz ? 'Yo‘li' : 'Путь'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
                  {rows.map((r) => {
                    const unit = formatUnit(r.item.unit, isUz ? 'uz' : 'ru');
                    const hint = levelHint(r, isUz);
                    const why = levelTitle(r, isUz);
                    return (
                      <tr
                        key={r.key}
                        className={`h-10 hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40 transition-colors ${
                          r.isBelowCritical ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''
                        }`}
                      >
                        <td className="px-2 py-2">
                          <input
                            type="checkbox"
                            className="w-3.5 h-3.5 align-middle cursor-pointer"
                            aria-label={`${isUz ? 'Yorliqqa belgilash' : 'Отметить к печати'}: ${r.item.code}`}
                            checked={marked.has(r.key)}
                            onChange={() => toggleLabelKey(r.key)}
                          />
                        </td>
                        {/* Код переносится по дефисам, а не держит строку:
                            у трубы он собран из типоразмера, стандарта и
                            марки («TR-1020X10-20295-85-09G2S»), и запрет
                            переноса растягивал колонку на 218px - последние
                            колонки уезжали за край таблицы. Обрезать его
                            нельзя: по коду позицию и ищут. */}
                        <td className="px-2 py-2 font-mono font-medium text-zinc-900 dark:text-zinc-100">
                          <div className="flex flex-col">
                            <span>{r.item.code}</span>
                            {/* У штучной позиции партии нет вовсе: на её месте
                                стоит номер трубы, и прочерк тут говорил бы, что
                                строка ничем не помечена. */}
                            <span className="text-[10px] text-zinc-400 font-normal">
                              {r.batch?.number ?? (r.serial ? `№${r.serial}` : '—')}
                            </span>
                          </div>
                        </td>
                        <td className="px-2 py-2 font-medium text-zinc-900 dark:text-zinc-100">
                          <div className="flex flex-col">
                            <span>{refName(r.item, isUz)}</span>
                            <span className="text-[10px] text-zinc-400 font-normal font-mono">
                              {r.item.steelGrade ?? '—'}
                              {sizeText(r)}
                              {r.item.pipeType ? ` · ${r.item.pipeType}` : ''}
                            </span>
                          </div>
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex flex-col">
                            <span className="text-zinc-800 dark:text-zinc-200">
                              {refName(r.warehouse, isUz)}
                            </span>
                            <span className="text-[10px] text-zinc-400 font-mono">
                              {r.zone && r.location ? `${r.zone} / ${r.location}` : '—'}
                            </span>
                          </div>
                        </td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
                          <div className="flex flex-col items-end">
                            <span>
                              {formatQty(r.qtyOnHand)} {unit}
                            </span>
                            {hint && (
                              <span
                                title={why}
                                className="text-[10px] text-amber-700 dark:text-amber-400"
                              >
                                {hint}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums text-zinc-500 whitespace-nowrap">
                          {formatQty(r.qtyReserved)}
                        </td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums font-bold text-zinc-950 dark:text-zinc-50 whitespace-nowrap">
                          {formatQty(r.qtyAvailable)} {unit}
                        </td>
                        {/* Цена за единицу, и единица здесь разная: труба в
                            тоннах, скорлупа в метрах. Без подписи колонка
                            читается как стоимость всей строки. */}
                        <td className="px-2 py-2 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
                          {formatMoneyShort(r.unitCost, isUz ? 'uz' : 'ru')}
                          <span className="text-zinc-400">/{unit}</span>
                        </td>
                        <td className="px-2 py-2 text-center">
                          {r.batch || r.serial ? (
                            <button
                              type="button"
                              onClick={() =>
                                r.batch ? setTraceUid(r.batch.uid) : setSerialNumber(r.serial)
                              }
                              title={
                                r.batch
                                  ? isUz
                                    ? 'Partiyaning to‘liq yo‘li'
                                    : 'Весь путь партии по журналу движений'
                                  : isUz
                                    ? 'Raqamning to‘liq yo‘li'
                                    : 'Весь путь этой штуки по журналу движений'
                              }
                              className="px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 text-[11px] font-medium text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer whitespace-nowrap"
                            >
                              {isUz ? 'Yo‘li' : 'Путь'}
                            </button>
                          ) : (
                            <span className="text-zinc-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      </div>

      {labelsOpen && <LabelsPanel isUz={isUz} onClose={() => setLabelsOpen(false)} />}
    </div>
  );
};
