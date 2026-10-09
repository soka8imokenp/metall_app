/**
 * Справочники склада на запись (ТЗ 5.2, 5.3, 5.7, 5.10).
 *
 * До этого этапа номенклатура, склады, зоны, ячейки, причины списания и уровни
 * запаса приходили из сида: завести новую марку стали значило попросить
 * разработчика.
 *
 * Экран показывает ровно то, что разрешает сервер, и не изобретает своих
 * запретов: право `refs.edit` прячет кнопки, а причину отказа — «по позиции уже
 * есть движения», «в ячейке лежит товар» — сервер называет словами, и мы их
 * показываем как есть. Дублировать эти правила на фронте значило бы завести
 * вторую их версию, которая разойдётся с первой.
 */
import React from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import type {
  RefItemRow,
  RefReason,
  RefStockLevel,
  RefWarehouse,
  RefCompanySettings,
} from '../../types/api';
import { apiClient, ApiError } from '../../lib/api-client';
import { useAuth } from '../../context/AuthContext';
import { useWarehouse } from '../../context/WarehouseContext';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, ErrorBox, FIELD, Skeleton } from './warehouse-ui';
import { refName } from '../../lib/formatters';

type Section = 'items' | 'places' | 'reasons' | 'levels' | 'settings';

/**
 * Порог подтверждения платёжки (требование заказчика со встречи 07.10).
 *
 * Три поля, а не одно: порог на одну платёжку от разбивки на мелкие не
 * спасает, поэтому рядом стоит предел на получателя за окно. Пустое поле —
 * ограничения нет; это единственный способ его снять, и подпись об этом
 * говорит прямо, иначе человек поставит нуль и закроет себе все платежи.
 *
 * Числа заказчик называет сам и меняет их здесь, без выкатки.
 */
function ApprovalLimits({
  row,
  isUz,
  busy,
  canSettings,
  act,
}: {
  row: RefCompanySettings;
  isUz: boolean;
  busy: boolean;
  canSettings: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const asText = (v: number | null) => (v === null ? '' : String(v));
  const [single, setSingle] = React.useState(asText(row.approvalLimitSingle));
  const [period, setPeriod] = React.useState(asText(row.approvalLimitPeriod));
  const [days, setDays] = React.useState(String(row.approvalPeriodDays));

  // Пришёл ответ сервера — поля показывают то, что в базе, а не то, что
  // человек набрал до сохранения.
  React.useEffect(() => {
    setSingle(asText(row.approvalLimitSingle));
    setPeriod(asText(row.approvalLimitPeriod));
    setDays(String(row.approvalPeriodDays));
  }, [row.approvalLimitSingle, row.approvalLimitPeriod, row.approvalPeriodDays]);

  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const changed =
    single !== asText(row.approvalLimitSingle) ||
    period !== asText(row.approvalLimitPeriod) ||
    days !== String(row.approvalPeriodDays);
  const bad =
    [single, period].some((v) => v.trim() !== '' && !Number.isFinite(Number(v))) ||
    !Number.isFinite(Number(days)) ||
    Number(days) < 1 ||
    Number(days) > 366;

  const label = (ru: string, uz: string) => (
    <span className="text-[11px] text-zinc-500">{isUz ? uz : ru}</span>
  );

  return (
    <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800/60 space-y-2">
      <p className="text-[11px] text-zinc-500">
        {isUz
          ? 'Yirik to‘lovni tasdiqlash. Chegaradan oshgan to‘lovni «To‘lovlarni tasdiqlash» huquqi bilan tasdiqlab bo‘lmaydi: «Yirik to‘lovlarni tasdiqlash» huquqi kerak. Bo‘sh maydon - chegara yo‘q.'
          : 'Подтверждение крупных платежей. Платёж, вышедший за порог, нельзя утвердить правом «Согласование платежей» - нужно «Подтверждение крупных платежей». Пустое поле означает, что ограничения нет.'}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="min-w-0 flex flex-col gap-1">
          {label('Порог одной платёжки', 'Bitta to‘lov chegarasi')}
          <input
            type="number"
            min={0}
            inputMode="numeric"
            value={single}
            disabled={busy || !canSettings}
            onChange={(e) => setSingle(e.target.value)}
            placeholder={isUz ? 'chegara yo‘q' : 'нет порога'}
            className={FIELD}
          />
        </label>
        <label className="min-w-0 flex flex-col gap-1">
          {label('Предел на получателя за окно', 'Oluvchiga davr uchun chegara')}
          <input
            type="number"
            min={0}
            inputMode="numeric"
            value={period}
            disabled={busy || !canSettings}
            onChange={(e) => setPeriod(e.target.value)}
            placeholder={isUz ? 'chegara yo‘q' : 'нет предела'}
            className={FIELD}
          />
        </label>
        <label className="min-w-0 flex flex-col gap-1">
          {label('Окно, дней', 'Davr, kun')}
          <input
            type="number"
            min={1}
            max={366}
            inputMode="numeric"
            value={days}
            disabled={busy || !canSettings}
            onChange={(e) => setDays(e.target.value)}
            className={FIELD}
          />
        </label>
      </div>
      <p className="text-[11px] text-zinc-500">
        {isUz
          ? 'Davr chegarasi bitta oluvchiga oynadagi barcha to‘lovlarni, kelishishda turganlarini ham qo‘shadi.'
          : 'Предел за окно складывает все платежи одному получателю, включая те, что ещё ждут согласования: иначе разбивка на мелкие проходит мимо порога.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !canSettings || !changed || bad}
          onClick={() =>
            act(async () => {
              await apiClient.refs.setSettings({
                companyUid: row.companyUid,
                approvalLimitSingle: num(single),
                approvalLimitPeriod: num(period),
                approvalPeriodDays: Number(days),
              });
            })
          }
          className={BTN_PRIMARY}
        >
          {isUz ? 'Saqlash' : 'Сохранить'}
        </button>
        {bad && (
          <span className="text-[11px] text-red-600 dark:text-red-400">
            {isUz ? 'Davr 1 dan 366 kungacha.' : 'Окно - от 1 до 366 дней.'}
          </span>
        )}
      </div>
    </div>
  );
}

/** Что делает кнопка добавления в каждом разделе и о чём сам раздел. */
const SECTION_HINT: Record<Section, { addRu: string; addUz: string; ru: string; uz: string }> = {
  items: {
    addRu: 'Добавить позицию',
    addUz: 'Nomenklatura qo‘shish',
    ru: 'Код и базовая единица замораживаются, как только по позиции прошло движение: по ним читается история.',
    uz: 'Harakat o‘tgach, kod va asosiy birlik qotadi: tarix shular orqali o‘qiladi.',
  },
  places: {
    addRu: 'Добавить склад',
    addUz: 'Ombor qo‘shish',
    ru: 'Склад и ячейку с остатком нельзя ни удалить, ни выключить — товар исчез бы из подбора, оставшись в отчёте.',
    uz: 'Qoldiqli ombor va katakni o‘chirib ham, olib tashlab ham bo‘lmaydi.',
  },
  reasons: {
    addRu: 'Добавить причину',
    addUz: 'Sabab qo‘shish',
    ru: 'Причина, которой уже пользовались, выключается, а не удаляется: иначе прошлые списания останутся без основания.',
    uz: 'Ishlatilgan sabab o‘chiriladi emas, faqat faolsizlantiriladi.',
  },
  levels: {
    addRu: 'Добавить уровень',
    addUz: 'Daraja qo‘shish',
    ru: 'Уровень на склад перекрывает уровень компании, а не складывается с ним. Критический не больше минимального.',
    uz: 'Ombor darajasi kompaniya darajasini almashtiradi, qo‘shilmaydi.',
  },
  settings: {
    addRu: '',
    addUz: '',
    ru: 'Метод списания действует с момента смены и вперёд: проведённые движения не пересчитываются.',
    uz: 'Usul o‘zgargan paytdan boshlab amal qiladi: o‘tkazilgan harakatlar qayta hisoblanmaydi.',
  },
};

const SECTIONS: [Section, string, string][] = [
  ['items', 'Номенклатура', 'Nomenklatura'],
  ['places', 'Места хранения', 'Saqlash joylari'],
  ['reasons', 'Причины списания', 'Hisobdan chiqarish sabablari'],
  ['levels', 'Уровни запаса', 'Zaxira darajalari'],
  ['settings', 'Учёт', 'Hisob'],
];

/** ТЗ 5.7. Подпись объясняет не название метода, а его последствие. */
const COSTING_METHODS: [string, string, string, string, string][] = [
  [
    'fifo',
    'FIFO по партиям',
    'Partiyalar bo‘yicha FIFO',
    'Списывается цена той партии, которая названа в документе.',
    'Hujjatda ko‘rsatilgan partiya narxi hisobdan chiqariladi.',
  ],
  [
    'weighted_average',
    'Средневзвешенная',
    'O‘rtacha tortilgan',
    'Списывается средняя цена по складу, взвешенная по количеству.',
    'Ombor bo‘yicha miqdorga tortilgan o‘rtacha narx hisobdan chiqariladi.',
  ],
];

/** ТЗ 9.2: что делать с ценой ниже себестоимости. */
const BELOW_COST_MODES: [string, string, string, string, string][] = [
  [
    'block',
    'Запретить',
    'Taqiqlash',
    'Сервер не примет такую строку ни у кого, включая руководителя.',
    'Server bunday qatorni hech kimdan qabul qilmaydi.',
  ],
  [
    'approve',
    'Разрешить по праву',
    'Huquq bo‘yicha ruxsat',
    'Пропустит того, кому выдано право «Продажа ниже себестоимости».',
    '«Tannarxdan past sotish» huquqi berilganlarga ruxsat beradi.',
  ],
];

const ITEM_TYPES: [string, string, string][] = [
  ['goods', 'Товар', 'Tovar'],
  ['raw', 'Сырьё', 'Xomashyo'],
  ['component', 'Комплектующие', 'Butlovchi'],
  ['semi', 'Полуфабрикат', 'Yarim tayyor'],
  ['finished', 'Готовая продукция', 'Tayyor mahsulot'],
];

const REASON_KINDS: [string, string, string][] = [
  ['write_off', 'Списание', 'Hisobdan chiqarish'],
  ['defect', 'Брак', 'Brak'],
  ['downtime', 'Простой', 'To‘xtash'],
  ['inventory', 'Инвентаризация', 'Inventarizatsiya'],
];

/** Единицы заведены сидом и общие для всех компаний: их правка — не этот этап. */
const UNITS = ['t', 'kg', 'm', 'pm', 'pcs', 'm3'];

const errorText = (e: unknown, isUz: boolean): string =>
  e instanceof ApiError ? e.message : isUz ? 'Kutilmagan xatolik' : 'Неожиданная ошибка';

const label = (rows: [string, string, string][], key: string, isUz: boolean): string => {
  const row = rows.find((r) => r[0] === key);
  return row ? (isUz ? row[2] : row[1]) : key;
};

const numOrUndef = (v: string): number | undefined => {
  const t = v.replace(',', '.').trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

/** Поле формы: подпись сверху, значение снизу — так же, как в форме операции. */
const Field: React.FC<{ label: string; children: React.ReactNode; wide?: boolean }> = ({
  label,
  children,
  wide,
}) => (
  <label className={`flex flex-col gap-1 min-w-0 ${wide ? 'sm:col-span-2' : ''}`}>
    <span className="text-[11px] text-zinc-500">{label}</span>
    {children}
  </label>
);

const Dialog: React.FC<{
  title: string;
  isUz: boolean;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ title, isUz, onClose, children }) => (
  <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-y-auto p-4">
    <div className={`${CARD} w-full max-w-3xl my-4`} role="dialog" aria-label={title}>
      <div className="px-4 py-3 flex items-center justify-between gap-2 border-b border-zinc-200 dark:border-zinc-800">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
          {title}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={isUz ? 'Yopish' : 'Закрыть'}
          className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="px-4 py-3">{children}</div>
    </div>
  </div>
);

// --- номенклатура -----------------------------------------------------------

interface ItemFormState {
  code: string;
  nameRu: string;
  itemType: string;
  baseUnit: string;
  trackBatches: boolean;
  trackSerials: boolean;
  minQty: string;
  criticalQty: string;
  steelGrade: string;
  pipeType: string;
  diameterMm: string;
  wallThicknessMm: string;
  lengthMm: string;
  weightKgPerUnit: string;
  gost: string;
  units: { unit: string; factor: string }[];
}

const emptyItemForm = (): ItemFormState => ({
  code: '',
  nameRu: '',
  itemType: 'goods',
  baseUnit: 't',
  trackBatches: false,
  trackSerials: false,
  minQty: '',
  criticalQty: '',
  steelGrade: '',
  pipeType: '',
  diameterMm: '',
  wallThicknessMm: '',
  lengthMm: '',
  weightKgPerUnit: '',
  gost: '',
  units: [],
});

const formFromItem = (r: RefItemRow): ItemFormState => ({
  code: r.code,
  nameRu: r.nameRu,
  itemType: r.itemType,
  baseUnit: r.baseUnit,
  trackBatches: r.trackBatches,
  trackSerials: r.trackSerials,
  minQty: r.minQty ?? '',
  criticalQty: r.criticalQty ?? '',
  steelGrade: r.attributes.steelGrade ?? '',
  pipeType: r.attributes.pipeType ?? '',
  diameterMm: r.attributes.diameterMm ?? '',
  wallThicknessMm: r.attributes.wallThicknessMm ?? '',
  lengthMm: r.attributes.lengthMm ?? '',
  weightKgPerUnit: r.attributes.weightKgPerUnit ?? '',
  gost: r.attributes.gost ?? '',
  units: r.units.map((u) => ({ unit: u.unit, factor: u.factor })),
});

const ItemForm: React.FC<{
  edit: RefItemRow | null;
  isUz: boolean;
  onDone: () => void;
  onClose: () => void;
}> = ({ edit, isUz, onDone, onClose }) => {
  const [f, setF] = React.useState<ItemFormState>(edit ? formFromItem(edit) : emptyItemForm());
  const [error, setError] = React.useState<unknown>(null);
  const [saving, setSaving] = React.useState(false);

  const set = <K extends keyof ItemFormState>(k: K, v: ItemFormState[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));

  // Код и базовая единица у позиции с историей не правятся: код напечатан на
  // этикетках, а смена единицы пересчитала бы прошлые количества. Сервер это
  // отклонит, а поле должно быть закрыто заранее — иначе человек заполнит
  // форму и узнает об отказе только на сохранении.
  const frozen = (edit?.moves ?? 0) > 0;

  const submit = async () => {
    setSaving(true);
    setError(null);
    const payload = {
      nameRu: f.nameRu.trim(),
      itemType: f.itemType,
      trackBatches: f.trackBatches,
      trackSerials: f.trackSerials,
      minQty: numOrUndef(f.minQty) ?? 0,
      criticalQty: numOrUndef(f.criticalQty) ?? 0,
      steelGrade: f.steelGrade.trim() || undefined,
      pipeType: f.pipeType.trim() || undefined,
      diameterMm: numOrUndef(f.diameterMm),
      wallThicknessMm: numOrUndef(f.wallThicknessMm),
      lengthMm: numOrUndef(f.lengthMm),
      weightKgPerUnit: numOrUndef(f.weightKgPerUnit),
      gost: f.gost.trim() || undefined,
      units: f.units
        .filter((u) => u.unit && numOrUndef(u.factor) !== undefined)
        .map((u) => ({ unit: u.unit, factor: numOrUndef(u.factor)! })),
    };

    try {
      if (edit) {
        await apiClient.refs.updateItem(edit.uid, {
          ...payload,
          ...(frozen ? {} : { code: f.code.trim(), baseUnit: f.baseUnit }),
        });
      } else {
        await apiClient.refs.createItem({
          ...payload,
          code: f.code.trim(),
          baseUnit: f.baseUnit,
        });
      }
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={
        edit
          ? `${isUz ? 'Nomenklatura' : 'Позиция'} ${edit.code}`
          : isUz
            ? 'Yangi nomenklatura'
            : 'Новая позиция'
      }
      isUz={isUz}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        {error !== null && <ErrorBox text={errorText(error, isUz)} isUz={isUz} />}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label={isUz ? 'Kod' : 'Код'}>
            <input
              aria-label={isUz ? 'Kod' : 'Код'}
              className={FIELD}
              value={f.code}
              disabled={frozen}
              onChange={(e) => set('code', e.target.value)}
            />
          </Field>
          <Field label={isUz ? 'Nomi' : 'Наименование'} wide>
            <input
              aria-label={isUz ? 'Nomi' : 'Наименование'}
              className={FIELD}
              value={f.nameRu}
              onChange={(e) => set('nameRu', e.target.value)}
            />
          </Field>

          <Field label={isUz ? 'Turi' : 'Тип'}>
            <select
              aria-label={isUz ? 'Nomenklatura turi' : 'Тип позиции'}
              className={FIELD}
              value={f.itemType}
              onChange={(e) => set('itemType', e.target.value)}
            >
              {ITEM_TYPES.map(([v, ru, uz]) => (
                <option key={v} value={v}>
                  {isUz ? uz : ru}
                </option>
              ))}
            </select>
          </Field>
          <Field label={isUz ? 'Asosiy birlik' : 'Базовая единица'}>
            <select
              aria-label={isUz ? 'Asosiy birlik' : 'Базовая единица'}
              className={FIELD}
              value={f.baseUnit}
              disabled={frozen}
              onChange={(e) => set('baseUnit', e.target.value)}
            >
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </Field>
          <Field label={isUz ? 'Hisob' : 'Учёт'}>
            <div className="flex items-center gap-3 h-8">
              <label className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={f.trackBatches}
                  onChange={(e) => set('trackBatches', e.target.checked)}
                />
                {isUz ? 'Partiyalar' : 'Партии'}
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={f.trackSerials}
                  onChange={(e) => set('trackSerials', e.target.checked)}
                />
                {isUz ? 'Raqamlar' : 'Номера'}
              </label>
            </div>
          </Field>

          <Field label={isUz ? 'Eng kam qoldiq' : 'Минимальный уровень'}>
            <input
              aria-label={isUz ? 'Eng kam qoldiq' : 'Минимальный уровень'}
              className={FIELD}
              value={f.minQty}
              onChange={(e) => set('minQty', e.target.value)}
            />
          </Field>
          <Field label={isUz ? 'Kritik qoldiq' : 'Критический уровень'}>
            <input
              aria-label={isUz ? 'Kritik qoldiq' : 'Критический уровень'}
              className={FIELD}
              value={f.criticalQty}
              onChange={(e) => set('criticalQty', e.target.value)}
            />
          </Field>
          <Field label="ГОСТ">
            <input
              aria-label="ГОСТ"
              className={FIELD}
              value={f.gost}
              onChange={(e) => set('gost', e.target.value)}
            />
          </Field>
        </div>

        <span className="text-[11px] font-medium text-zinc-500">
          {isUz ? 'Metall prokat tavsiflari' : 'Характеристики металлопроката'}
        </span>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label={isUz ? 'Po‘lat markasi' : 'Марка стали'}>
            <input
              aria-label={isUz ? 'Po‘lat markasi' : 'Марка стали'}
              className={FIELD}
              value={f.steelGrade}
              onChange={(e) => set('steelGrade', e.target.value)}
            />
          </Field>
          <Field label={isUz ? 'Quvur turi' : 'Вид проката'}>
            <input
              aria-label={isUz ? 'Quvur turi' : 'Вид проката'}
              className={FIELD}
              value={f.pipeType}
              onChange={(e) => set('pipeType', e.target.value)}
            />
          </Field>
          <Field label={isUz ? 'Diametr, mm' : 'Диаметр, мм'}>
            <input
              aria-label={isUz ? 'Diametr, mm' : 'Диаметр, мм'}
              className={FIELD}
              value={f.diameterMm}
              onChange={(e) => set('diameterMm', e.target.value)}
            />
          </Field>
          <Field label={isUz ? 'Devor, mm' : 'Толщина стенки, мм'}>
            <input
              aria-label={isUz ? 'Devor, mm' : 'Толщина стенки, мм'}
              className={FIELD}
              value={f.wallThicknessMm}
              onChange={(e) => set('wallThicknessMm', e.target.value)}
            />
          </Field>
          <Field label={isUz ? 'Uzunlik, mm' : 'Длина, мм'}>
            <input
              aria-label={isUz ? 'Uzunlik, mm' : 'Длина, мм'}
              className={FIELD}
              value={f.lengthMm}
              onChange={(e) => set('lengthMm', e.target.value)}
            />
          </Field>
          <Field label={isUz ? 'Og‘irlik, kg' : 'Вес, кг за единицу'}>
            <input
              aria-label={isUz ? 'Og‘irlik, kg' : 'Вес, кг за единицу'}
              className={FIELD}
              value={f.weightKgPerUnit}
              onChange={(e) => set('weightKgPerUnit', e.target.value)}
            />
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-medium text-zinc-500">
            {isUz
              ? 'Qayta hisoblash koeffitsiyentlari (asosiy birlikka)'
              : 'Коэффициенты пересчёта (в базовую единицу)'}
          </span>
          {f.units.map((u, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                aria-label={isUz ? 'Birlik' : 'Единица'}
                className={FIELD + ' max-w-[7rem]'}
                value={u.unit}
                onChange={(e) =>
                  set(
                    'units',
                    f.units.map((x, j) => (i === j ? { ...x, unit: e.target.value } : x)),
                  )
                }
              >
                <option value="">—</option>
                {UNITS.filter((x) => x !== f.baseUnit).map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
              <input
                aria-label={isUz ? 'Koeffitsiyent' : 'Коэффициент'}
                className={FIELD + ' max-w-[10rem]'}
                value={u.factor}
                placeholder={`1 ${u.unit || '?'} = ? ${f.baseUnit}`}
                onChange={(e) =>
                  set(
                    'units',
                    f.units.map((x, j) => (i === j ? { ...x, factor: e.target.value } : x)),
                  )
                }
              />
              <button
                type="button"
                aria-label={isUz ? 'Koeffitsiyentni olib tashlash' : 'Убрать коэффициент'}
                onClick={() => set('units', f.units.filter((_, j) => j !== i))}
                className="p-1.5 rounded-md text-zinc-400 hover:text-red-600 transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => set('units', [...f.units, { unit: '', factor: '' }])}
            className={BTN_GHOST + ' self-start'}
          >
            <Plus className="w-3 h-3 inline-block mr-1" />
            {isUz ? 'Koeffitsiyent' : 'Коэффициент'}
          </button>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            disabled={saving || f.code.trim() === '' || f.nameRu.trim() === ''}
            onClick={() => void submit()}
            className={BTN_PRIMARY}
          >
            {saving ? (isUz ? 'Saqlanmoqda…' : 'Сохраняю…') : isUz ? 'Saqlash' : 'Сохранить'}
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST}>
            {isUz ? 'Bekor qilish' : 'Отмена'}
          </button>
          {frozen && (
            <span className="text-[11px] text-zinc-400">
              {isUz
                ? 'Harakatlar bor: kod va asosiy birlik o‘zgarmaydi'
                : `Движений ${edit?.moves}: код и базовая единица закрыты`}
            </span>
          )}
        </div>
      </div>
    </Dialog>
  );
};

// --- панель справочников ----------------------------------------------------

export const RefsPanel: React.FC<{ isUz: boolean }> = ({ isUz }) => {
  const { can } = useAuth();
  const { reloadRefs } = useWarehouse();
  const mayEdit = can('refs.edit');
  // Метод списания — не справочник: его меняет тот, кто отвечает за цифры.
  const canSettings = can('settings.edit');

  const [section, setSection] = React.useState<Section>('items');
  const [search, setSearch] = React.useState('');
  const [showOff, setShowOff] = React.useState(false);

  const [items, setItems] = React.useState<RefItemRow[] | null>(null);
  const [places, setPlaces] = React.useState<RefWarehouse[] | null>(null);
  const [reasons, setReasons] = React.useState<RefReason[] | null>(null);
  const [levels, setLevels] = React.useState<RefStockLevel[] | null>(null);
  const [settings, setSettings] = React.useState<RefCompanySettings[] | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);

  const [itemForm, setItemForm] = React.useState<{ open: boolean; edit: RefItemRow | null }>({
    open: false,
    edit: null,
  });
  const [newPlace, setNewPlace] = React.useState<
    | { kind: 'warehouse' }
    | { kind: 'zone'; warehouseUid: string; title: string }
    | { kind: 'location'; zoneUid: string; title: string }
    | null
  >(null);
  const [newReason, setNewReason] = React.useState(false);
  const [newLevel, setNewLevel] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      if (section === 'items') {
        const res = await apiClient.refs.items({ search, all: showOff });
        setItems(res.data.rows);
      } else if (section === 'places') {
        const res = await apiClient.refs.places(showOff);
        setPlaces(res.data.rows);
      } else if (section === 'reasons') {
        const res = await apiClient.refs.reasons(showOff);
        setReasons(res.data.rows);
      } else if (section === 'settings') {
        const res = await apiClient.refs.settings();
        setSettings(res.data.rows);
      } else {
        const res = await apiClient.refs.levels();
        setLevels(res.data.rows);
      }
    } catch (e) {
      setError(e);
    }
  }, [section, search, showOff]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /** Любое действие: выполнить, показать причину отказа, перечитать список. */
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      // Подбор в форме операции держит свой список складов, ячеек и позиций:
      // без этого заведённая позиция появится в нём только после перезагрузки
      // страницы, и человек решит, что она не сохранилась.
      reloadRefs();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="tabpanel"
      aria-label={isUz ? 'Ma’lumotnomalar' : 'Справочники'}
      className="flex flex-col min-w-0"
    >
      {itemForm.open && (
        <ItemForm
          edit={itemForm.edit}
          isUz={isUz}
          onClose={() => setItemForm({ open: false, edit: null })}
          onDone={() => {
            setItemForm({ open: false, edit: null });
            void load();
            reloadRefs();
          }}
        />
      )}

      {newPlace && (
        <PlaceForm
          target={newPlace}
          isUz={isUz}
          onClose={() => setNewPlace(null)}
          onDone={() => {
            setNewPlace(null);
            void load();
            reloadRefs();
          }}
        />
      )}

      {newReason && (
        <ReasonForm
          isUz={isUz}
          onClose={() => setNewReason(false)}
          onDone={() => {
            setNewReason(false);
            void load();
            reloadRefs();
          }}
        />
      )}

      {newLevel && (
        <LevelForm
          isUz={isUz}
          items={items ?? []}
          places={places ?? []}
          onClose={() => setNewLevel(false)}
          onDone={() => {
            setNewLevel(false);
            void load();
          }}
        />
      )}

      <div className="px-4 py-2.5 flex flex-wrap items-center gap-2 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-1">
          {SECTIONS.map(([key, ru, uz]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={section === key}
              onClick={() => setSection(key)}
              className={`h-7 px-3 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                section === key
                  ? 'bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900'
                  : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              {isUz ? uz : ru}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 ms-auto">
          {section === 'items' && (
            <input
              aria-label={isUz ? 'Qidirish' : 'Поиск по справочнику'}
              className={FIELD + ' w-full sm:w-56 min-w-0'}
              placeholder={isUz ? 'Kod, nom, marka' : 'Код, наименование, марка стали'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}
          {section !== 'levels' && section !== 'settings' && (
            <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 whitespace-nowrap shrink-0">
              <input
                type="checkbox"
                checked={showOff}
                onChange={(e) => setShowOff(e.target.checked)}
              />
              {isUz ? 'O‘chirilganlar' : 'Показать выключенные'}
            </label>
          )}
          {mayEdit && section !== 'settings' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (section === 'items') setItemForm({ open: true, edit: null });
                else if (section === 'places') setNewPlace({ kind: 'warehouse' });
                else if (section === 'reasons') setNewReason(true);
                else setNewLevel(true);
              }}
              className={BTN_PRIMARY + ' h-7 whitespace-nowrap shrink-0'}
            >
              <Plus className="w-3 h-3 inline-block mr-1" />
              {isUz ? SECTION_HINT[section].addUz : SECTION_HINT[section].addRu}
            </button>
          )}
        </div>
      </div>

      {/* Правило раздела стоит на экране, а не в голове у того, кто правит:
          «почему нельзя удалить» человек спрашивает ровно в тот момент,
          когда удаление не сработало. */}
      <p className="px-4 pt-2.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
        {isUz ? SECTION_HINT[section].uz : SECTION_HINT[section].ru}
      </p>

      {error !== null && <ErrorBox text={errorText(error, isUz)} onRetry={() => void load()} isUz={isUz} />}

      {section === 'settings' &&
        (settings === null ? (
          <Skeleton />
        ) : (
          <div className="m-3 space-y-3">
            {settings.map((row) => (
              <div key={row.companyUid} className={CARD + ' p-4 space-y-3'}>
                <div>
                  <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                    {row.companyName}
                    <span className="ms-2 text-[10px] font-mono uppercase text-zinc-400">
                      {row.companyCode}
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-0.5">
                    {isUz
                      ? 'Hisobdan chiqarish usuli tannarxni belgilaydi va o‘zgartirilgan paytdan boshlab amal qiladi: o‘tkazilgan harakatlar qayta hisoblanmaydi.'
                      : 'Метод списания задаёт себестоимость расхода и действует с момента смены: проведённые движения не пересчитываются.'}
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {COSTING_METHODS.map(([key, ru, uz, hintRu, hintUz]) => {
                    const on = row.costingMethod === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={on}
                        disabled={busy || !canSettings || on}
                        onClick={() =>
                          act(async () => {
                            await apiClient.refs.setSettings({
                              companyUid: row.companyUid,
                              costingMethod: key,
                            });
                          })
                        }
                        className={`min-w-0 text-start p-3 rounded-lg border transition-colors ${
                          on
                            ? 'border-zinc-900 dark:border-zinc-100'
                            : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-400'
                        } ${!canSettings && !on ? 'opacity-60' : ''}`}
                      >
                        <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                          {isUz ? uz : ru}
                          {on && (
                            <span className="ms-2 text-[10px] font-mono uppercase text-zinc-500">
                              {isUz ? 'tanlangan' : 'выбран'}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-zinc-500 mt-1">
                          {isUz ? hintUz : hintRu}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* ТЗ 9.2. Решение про убыточную продажу принимает компания, а
                    не каждый менеджер в своём заказе: либо такую строку не
                    принимает сервер вовсе, либо её проводит тот, кому выдано
                    право. Правило действует вперёд: выписанные заказы не
                    перепроверяются. */}
                <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800/60">
                  <p className="text-[11px] text-zinc-500 mb-2">
                    {isUz
                      ? 'Chegirmali narx tannarxdan past bo‘lsa nima qilish kerak.'
                      : 'Что делать, если цена со скидкой ниже себестоимости.'}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {BELOW_COST_MODES.map(([key, ru, uz, hintRu, hintUz]) => {
                      const on = row.belowCostMode === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={on}
                          disabled={busy || !canSettings || on}
                          onClick={() =>
                            act(async () => {
                              await apiClient.refs.setSettings({
                                companyUid: row.companyUid,
                                belowCostMode: key,
                              });
                            })
                          }
                          className={`min-w-0 text-start p-3 rounded-lg border transition-colors ${
                            on
                              ? 'border-zinc-900 dark:border-zinc-100'
                              : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-400'
                          } ${!canSettings && !on ? 'opacity-60' : ''}`}
                        >
                          <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                            {isUz ? uz : ru}
                            {on && (
                              <span className="ms-2 text-[10px] font-mono uppercase text-zinc-500">
                                {isUz ? 'tanlangan' : 'выбран'}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-zinc-500 mt-1">
                            {isUz ? hintUz : hintRu}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <ApprovalLimits
                  row={row}
                  isUz={isUz}
                  busy={busy}
                  canSettings={canSettings}
                  act={act}
                />
              </div>
            ))}
            {!canSettings && (
              <p className="text-[11px] text-zinc-500 px-1">
                {isUz
                  ? 'Usulni o‘zgartirish huquqi yo‘q.'
                  : 'Менять метод может тот, у кого есть право на настройки учёта.'}
              </p>
            )}
          </div>
        ))}

      {section === 'items' &&
        (items === null ? (
          <Skeleton />
        ) : items.length === 0 ? (
          <Empty text={isUz ? 'Nomenklatura topilmadi' : 'Позиций не найдено'} />
        ) : (
          <ItemsTable
            rows={items}
            isUz={isUz}
            mayEdit={mayEdit}
            busy={busy}
            onEdit={(r) => setItemForm({ open: true, edit: r })}
            onToggle={(r) => act(() => apiClient.refs.updateItem(r.uid, { isActive: !r.isActive }))}
            onDelete={(r) => act(() => apiClient.refs.deleteItem(r.uid))}
          />
        ))}

      {section === 'places' &&
        (places === null ? (
          <Skeleton />
        ) : places.length === 0 ? (
          <Empty text={isUz ? 'Omborlar yo‘q' : 'Складов нет'} />
        ) : (
          <PlacesTree
            rows={places}
            isUz={isUz}
            mayEdit={mayEdit}
            busy={busy}
            onAddZone={(w) =>
              setNewPlace({ kind: 'zone', warehouseUid: w.uid, title: `${w.code} · ${refName(w, isUz)}` })
            }
            onAddLocation={(z, w) =>
              setNewPlace({ kind: 'location', zoneUid: z.uid, title: `${w.code} · ${z.code}` })
            }
            onToggleWarehouse={(w) =>
              act(() => apiClient.refs.updateWarehouse(w.uid, { isActive: !w.isActive }))
            }
            onToggleLocation={(l) =>
              act(() => apiClient.refs.updateLocation(l.uid, { isActive: !l.isActive }))
            }
            onDeleteLocation={(l) => act(() => apiClient.refs.deleteLocation(l.uid))}
          />
        ))}

      {section === 'reasons' &&
        (reasons === null ? (
          <Skeleton />
        ) : reasons.length === 0 ? (
          <Empty text={isUz ? 'Sabablar yo‘q' : 'Причин нет'} />
        ) : (
          <ReasonsTable
            rows={reasons}
            isUz={isUz}
            mayEdit={mayEdit}
            busy={busy}
            onToggle={(r) =>
              act(() => apiClient.refs.updateReason(r.uid, { isActive: !r.isActive }))
            }
            onDelete={(r) => act(() => apiClient.refs.deleteReason(r.uid))}
          />
        ))}

      {section === 'levels' &&
        (levels === null ? (
          <Skeleton />
        ) : levels.length === 0 ? (
          <Empty
            text={
              isUz
                ? 'Ombor bo‘yicha daraja belgilanmagan'
                : 'Уровней на склад не задано: работает уровень компании'
            }
          />
        ) : (
          <LevelsTable
            rows={levels}
            isUz={isUz}
            mayEdit={mayEdit}
            busy={busy}
            onDelete={(r) => act(() => apiClient.refs.deleteLevel(r.uid))}
          />
        ))}
    </div>
  );
};

// --- таблицы разделов -------------------------------------------------------

const Toggle: React.FC<{ active: boolean; isUz: boolean; busy: boolean; onClick: () => void }> = ({
  active,
  isUz,
  busy,
  onClick,
}) => (
  <button
    type="button"
    disabled={busy}
    onClick={onClick}
    className={BTN_GHOST + ' h-7'}
    title={
      active
        ? isUz
          ? 'O‘chirish: tanlovdan yo‘qoladi, tarixda qoladi'
          : 'Выключить: исчезнет из подбора, в истории останется'
        : isUz
          ? 'Yoqish'
          : 'Включить'
    }
  >
    {active ? (isUz ? 'O‘chirish' : 'Выключить') : isUz ? 'Yoqish' : 'Включить'}
  </button>
);

const ItemsTable: React.FC<{
  rows: RefItemRow[];
  isUz: boolean;
  mayEdit: boolean;
  busy: boolean;
  onEdit: (r: RefItemRow) => void;
  onToggle: (r: RefItemRow) => void;
  onDelete: (r: RefItemRow) => void;
}> = ({ rows, isUz, mayEdit, busy, onEdit, onToggle, onDelete }) => (
  <>
    {/* Узкий экран: те же данные карточками — у таблицы восемь колонок */}
    <ul className="lg:hidden divide-y divide-zinc-200 dark:divide-zinc-800/60">
      {rows.map((r) => (
        <li key={r.uid} className="px-4 py-3 flex flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
              {refName(r, isUz)}
            </span>
            <span className="font-mono text-[11px] text-zinc-500 shrink-0">{r.code}</span>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
            <span>{label(ITEM_TYPES, r.itemType, isUz)}</span>
            <span className="font-mono">{r.baseUnit}</span>
            {r.attributes.steelGrade && <span>{r.attributes.steelGrade}</span>}
            {r.units.length > 0 && (
              <span className="font-mono">
                {r.units.map((u) => `${u.unit}×${u.factor}`).join(' · ')}
              </span>
            )}
            {!r.isActive && <span className="text-amber-600">{isUz ? 'o‘chiq' : 'выключена'}</span>}
          </div>
          {mayEdit && (
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => onEdit(r)} className={BTN_GHOST + ' h-7'}>
                {isUz ? 'Tahrirlash' : 'Править'}
              </button>
              <Toggle active={r.isActive} isUz={isUz} busy={busy} onClick={() => onToggle(r)} />
              {r.moves === 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onDelete(r)}
                  aria-label={isUz ? 'O‘chirib tashlash' : 'Удалить позицию'}
                  className="p-1.5 rounded-md text-zinc-400 hover:text-red-600 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>

    <div className="hidden lg:block">
      <table className="w-full text-left text-xs border-collapse">
        <thead>
          <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 text-zinc-500 font-medium h-9">
            <th className="px-2 py-2">{isUz ? 'Kod' : 'Код'}</th>
            <th className="px-2 py-2">{isUz ? 'Nomi' : 'Наименование'}</th>
            <th className="px-2 py-2">{isUz ? 'Turi' : 'Тип'}</th>
            <th className="px-2 py-2">{isUz ? 'Birlik' : 'Единица'}</th>
            <th className="px-2 py-2">{isUz ? 'Tavsiflar' : 'Характеристики'}</th>
            <th className="px-2 py-2 text-right">{isUz ? 'Min / kritik' : 'Мин / крит'}</th>
            <th className="px-2 py-2 text-center">{isUz ? 'Harakatlar' : 'Движений'}</th>
            <th className="px-2 py-2 text-center">{isUz ? 'Amal' : 'Действие'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.uid}
              className={`border-b border-zinc-100 dark:border-zinc-800/60 ${
                r.isActive ? '' : 'text-zinc-400 dark:text-zinc-500'
              }`}
            >
              <td className="px-2 py-2 font-mono whitespace-nowrap">{r.code}</td>
              <td className="px-2 py-2">
                <div className="flex flex-col">
                  <span className="text-zinc-900 dark:text-zinc-100">{refName(r, isUz)}</span>
                  <span className="text-[10px] text-zinc-400">
                    {[
                      r.trackBatches ? (isUz ? 'partiyalar' : 'партии') : null,
                      r.trackSerials ? (isUz ? 'raqamlar' : 'номера') : null,
                      r.isActive ? null : isUz ? 'o‘chiq' : 'выключена',
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </span>
                </div>
              </td>
              <td className="px-2 py-2">{label(ITEM_TYPES, r.itemType, isUz)}</td>
              <td className="px-2 py-2">
                <div className="flex flex-col">
                  <span className="font-mono">{r.baseUnit}</span>
                  {r.units.length > 0 && (
                    <span className="text-[10px] text-zinc-400 font-mono">
                      {r.units.map((u) => `${u.unit}×${u.factor}`).join(' · ')}
                    </span>
                  )}
                </div>
              </td>
              <td className="px-2 py-2 text-zinc-600 dark:text-zinc-400 break-words">
                {[
                  r.attributes.steelGrade,
                  r.attributes.diameterMm ? `⌀${r.attributes.diameterMm}` : null,
                  r.attributes.wallThicknessMm ? `×${r.attributes.wallThicknessMm}` : null,
                  r.attributes.gost,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </td>
              <td className="px-2 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                {r.minQty ?? '0'} / {r.criticalQty ?? '0'}
              </td>
              <td className="px-2 py-2 text-center tabular-nums text-zinc-500">{r.moves}</td>
              <td className="px-2 py-2 text-center whitespace-nowrap">
                {mayEdit ? (
                  <div className="inline-flex items-center gap-1">
                    <button type="button" onClick={() => onEdit(r)} className={BTN_GHOST + ' h-7'}>
                      {isUz ? 'Tahrirlash' : 'Править'}
                    </button>
                    <Toggle active={r.isActive} isUz={isUz} busy={busy} onClick={() => onToggle(r)} />
                    {r.moves === 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onDelete(r)}
                        aria-label={isUz ? 'O‘chirib tashlash' : 'Удалить позицию'}
                        className="p-1.5 rounded-md text-zinc-400 hover:text-red-600 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
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
);

const PlacesTree: React.FC<{
  rows: RefWarehouse[];
  isUz: boolean;
  mayEdit: boolean;
  busy: boolean;
  onAddZone: (w: RefWarehouse) => void;
  onAddLocation: (z: RefWarehouse['zones'][number], w: RefWarehouse) => void;
  onToggleWarehouse: (w: RefWarehouse) => void;
  onToggleLocation: (l: RefWarehouse['zones'][number]['locations'][number]) => void;
  onDeleteLocation: (l: RefWarehouse['zones'][number]['locations'][number]) => void;
}> = ({ rows, isUz, mayEdit, busy, onAddZone, onAddLocation, onToggleWarehouse, onToggleLocation, onDeleteLocation }) => (
  <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
    {rows.map((w) => (
      <li key={w.uid} className="px-4 py-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 break-words">
              <span className="font-mono">{w.code}</span> · {refName(w, isUz)}
            </span>
            <span className="text-[11px] text-zinc-500 break-words">
              {[w.company.code, w.address, w.isActive ? null : isUz ? 'o‘chiq' : 'выключен']
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
          {mayEdit && (
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => onAddZone(w)} className={BTN_GHOST + ' h-7'}>
                <Plus className="w-3 h-3 inline-block mr-1" />
                {isUz ? 'Zona' : 'Зона'}
              </button>
              <Toggle active={w.isActive} isUz={isUz} busy={busy} onClick={() => onToggleWarehouse(w)} />
            </div>
          )}
        </div>

        <ul className="flex flex-col gap-2 ps-3 border-s border-zinc-200 dark:border-zinc-800">
          {w.zones.length === 0 && (
            <li className="text-[11px] text-zinc-400">{isUz ? 'Zona yo‘q' : 'Зон нет'}</li>
          )}
          {w.zones.map((z) => (
            <li key={z.uid} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-zinc-700 dark:text-zinc-300">
                  <span className="font-mono">{z.code}</span> · {refName(z, isUz)}
                </span>
                {mayEdit && (
                  <button
                    type="button"
                    onClick={() => onAddLocation(z, w)}
                    className={BTN_GHOST + ' h-7'}
                  >
                    <Plus className="w-3 h-3 inline-block mr-1" />
                    {isUz ? 'Yacheyka' : 'Ячейка'}
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {z.locations.length === 0 && (
                  <span className="text-[11px] text-zinc-400">
                    {isUz ? 'Yacheyka yo‘q' : 'Ячеек нет'}
                  </span>
                )}
                {z.locations.map((l) => (
                  <span
                    key={l.uid}
                    className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] ${
                      l.isActive
                        ? 'border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300'
                        : 'border-amber-300 text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    <span className="font-mono">{l.code}</span>
                    {l.hasStock && (
                      <span className="text-zinc-400" title={isUz ? 'Tovar bor' : 'Лежит товар'}>
                        ●
                      </span>
                    )}
                    {mayEdit && (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onToggleLocation(l)}
                          className="text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-100 cursor-pointer"
                          aria-label={
                            l.isActive
                              ? `${isUz ? 'O‘chirish' : 'Выключить ячейку'} ${l.code}`
                              : `${isUz ? 'Yoqish' : 'Включить ячейку'} ${l.code}`
                          }
                        >
                          {l.isActive ? '⏻' : '↺'}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onDeleteLocation(l)}
                          aria-label={`${isUz ? 'O‘chirib tashlash' : 'Удалить ячейку'} ${l.code}`}
                          className="text-zinc-400 hover:text-red-600 cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </>
                    )}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </li>
    ))}
  </ul>
);

const ReasonsTable: React.FC<{
  rows: RefReason[];
  isUz: boolean;
  mayEdit: boolean;
  busy: boolean;
  onToggle: (r: RefReason) => void;
  onDelete: (r: RefReason) => void;
}> = ({ rows, isUz, mayEdit, busy, onToggle, onDelete }) => (
  <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
    {rows.map((r) => (
      <li key={r.uid} className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col min-w-0">
          <span
            className={`text-xs ${
              r.isActive ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-400'
            } break-words`}
          >
            {refName(r, isUz)}
          </span>
          <span className="text-[11px] text-zinc-500">
            {label(REASON_KINDS, r.kind, isUz)} · {r.company.code} ·{' '}
            {isUz ? 'qo‘llanilgan' : 'использована'}: {r.moves}
            {r.isActive ? '' : ` · ${isUz ? 'o‘chiq' : 'выключена'}`}
          </span>
        </div>
        {mayEdit && (
          <div className="flex items-center gap-2">
            <Toggle active={r.isActive} isUz={isUz} busy={busy} onClick={() => onToggle(r)} />
            {r.moves === 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onDelete(r)}
                aria-label={isUz ? 'Sababni o‘chirib tashlash' : 'Удалить причину'}
                className="p-1.5 rounded-md text-zinc-400 hover:text-red-600 transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </li>
    ))}
  </ul>
);

const LevelsTable: React.FC<{
  rows: RefStockLevel[];
  isUz: boolean;
  mayEdit: boolean;
  busy: boolean;
  onDelete: (r: RefStockLevel) => void;
}> = ({ rows, isUz, mayEdit, busy, onDelete }) => (
  <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
    {rows.map((r) => (
      <li key={r.uid} className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col min-w-0">
          <span className="text-xs text-zinc-900 dark:text-zinc-100 break-words">
            <span className="font-mono">{r.item.code}</span> · {refName(r.item, isUz)}
          </span>
          <span className="text-[11px] text-zinc-500">
            {r.warehouse.code} · {isUz ? 'min' : 'мин'} {r.minQty} / {isUz ? 'kritik' : 'крит'}{' '}
            {r.criticalQty} {r.item.unit}
            {r.comment ? ` · ${r.comment}` : ''}
          </span>
        </div>
        {mayEdit && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onDelete(r)}
            aria-label={isUz ? 'Darajani o‘chirish' : 'Удалить уровень'}
            className="p-1.5 rounded-md text-zinc-400 hover:text-red-600 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </li>
    ))}
  </ul>
);

// --- формы мест, причин и уровней -------------------------------------------

const PlaceForm: React.FC<{
  target:
    | { kind: 'warehouse' }
    | { kind: 'zone'; warehouseUid: string; title: string }
    | { kind: 'location'; zoneUid: string; title: string };
  isUz: boolean;
  onClose: () => void;
  onDone: () => void;
}> = ({ target, isUz, onClose, onDone }) => {
  const [code, setCode] = React.useState('');
  const [name, setName] = React.useState('');
  const [extra, setExtra] = React.useState('');
  const [error, setError] = React.useState<unknown>(null);
  const [saving, setSaving] = React.useState(false);

  const title =
    target.kind === 'warehouse'
      ? isUz
        ? 'Yangi ombor'
        : 'Новый склад'
      : target.kind === 'zone'
        ? `${isUz ? 'Yangi zona' : 'Новая зона'} · ${target.title}`
        : `${isUz ? 'Yangi yacheyka' : 'Новая ячейка'} · ${target.title}`;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      if (target.kind === 'warehouse') {
        await apiClient.refs.createWarehouse({
          code: code.trim(),
          nameRu: name.trim(),
          address: extra.trim() || undefined,
        });
      } else if (target.kind === 'zone') {
        await apiClient.refs.createZone({
          warehouseUid: target.warehouseUid,
          code: code.trim(),
          nameRu: name.trim(),
        });
      } else {
        await apiClient.refs.createLocation({
          zoneUid: target.zoneUid,
          code: code.trim(),
          barcode: extra.trim() || undefined,
        });
      }
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const needName = target.kind !== 'location';

  return (
    <Dialog title={title} isUz={isUz} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error !== null && <ErrorBox text={errorText(error, isUz)} isUz={isUz} />}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label={isUz ? 'Kod' : 'Код'}>
            <input
              aria-label={isUz ? 'Kod' : 'Код'}
              className={FIELD}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          {needName && (
            <Field label={isUz ? 'Nomi' : 'Наименование'} wide>
              <input
                aria-label={isUz ? 'Nomi' : 'Наименование'}
                className={FIELD}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          )}
          {target.kind === 'warehouse' && (
            <Field label={isUz ? 'Manzil' : 'Адрес'} wide>
              <input
                aria-label={isUz ? 'Manzil' : 'Адрес'}
                className={FIELD}
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
              />
            </Field>
          )}
          {target.kind === 'location' && (
            <Field label={isUz ? 'Shtrix-kod' : 'Штрихкод ячейки'} wide>
              <input
                aria-label={isUz ? 'Shtrix-kod' : 'Штрихкод ячейки'}
                className={FIELD}
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
              />
            </Field>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={saving || code.trim() === '' || (needName && name.trim() === '')}
            onClick={() => void submit()}
            className={BTN_PRIMARY}
          >
            {saving ? (isUz ? 'Saqlanmoqda…' : 'Сохраняю…') : isUz ? 'Saqlash' : 'Сохранить'}
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST}>
            {isUz ? 'Bekor qilish' : 'Отмена'}
          </button>
        </div>
      </div>
    </Dialog>
  );
};

const ReasonForm: React.FC<{ isUz: boolean; onClose: () => void; onDone: () => void }> = ({
  isUz,
  onClose,
  onDone,
}) => {
  const [kind, setKind] = React.useState('write_off');
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<unknown>(null);
  const [saving, setSaving] = React.useState(false);

  return (
    <Dialog title={isUz ? 'Yangi sabab' : 'Новая причина'} isUz={isUz} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error !== null && <ErrorBox text={errorText(error, isUz)} isUz={isUz} />}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label={isUz ? 'Turi' : 'Вид'}>
            <select
              aria-label={isUz ? 'Sabab turi' : 'Вид причины'}
              className={FIELD}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              {REASON_KINDS.map(([v, ru, uz]) => (
                <option key={v} value={v}>
                  {isUz ? uz : ru}
                </option>
              ))}
            </select>
          </Field>
          <Field label={isUz ? 'Nomi' : 'Наименование'} wide>
            <input
              aria-label={isUz ? 'Sabab nomi' : 'Наименование причины'}
              className={FIELD}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={saving || name.trim() === ''}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                await apiClient.refs.createReason({ kind, nameRu: name.trim() });
                onDone();
              } catch (e) {
                setError(e);
              } finally {
                setSaving(false);
              }
            }}
            className={BTN_PRIMARY}
          >
            {saving ? (isUz ? 'Saqlanmoqda…' : 'Сохраняю…') : isUz ? 'Saqlash' : 'Сохранить'}
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST}>
            {isUz ? 'Bekor qilish' : 'Отмена'}
          </button>
        </div>
      </div>
    </Dialog>
  );
};

/**
 * Уровень на склад перекрывает уровень компании, а не дополняет его: об этом
 * сказано прямо в форме — иначе заведённая строка выглядит «ещё одним минимумом»,
 * а на деле отключает компанийский по этой позиции.
 */
const LevelForm: React.FC<{
  isUz: boolean;
  items: RefItemRow[];
  places: RefWarehouse[];
  onClose: () => void;
  onDone: () => void;
}> = ({ isUz, items, places, onClose, onDone }) => {
  const [itemUid, setItemUid] = React.useState('');
  const [warehouseUid, setWarehouseUid] = React.useState('');
  const [minQty, setMinQty] = React.useState('');
  const [criticalQty, setCriticalQty] = React.useState('');
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<unknown>(null);
  const [saving, setSaving] = React.useState(false);
  const [options, setOptions] = React.useState<{ items: RefItemRow[]; places: RefWarehouse[] }>({
    items,
    places,
  });

  // Раздел уровней открывают, не заходя в номенклатуру и места: списки для
  // подбора могут быть ещё не загружены, и тогда форма грузит их сама.
  React.useEffect(() => {
    if (options.items.length > 0 && options.places.length > 0) return;
    void (async () => {
      try {
        const [i, p] = await Promise.all([apiClient.refs.items({}), apiClient.refs.places()]);
        setOptions({ items: i.data.rows, places: p.data.rows });
      } catch (e) {
        setError(e);
      }
    })();
  }, [options.items.length, options.places.length]);

  return (
    <Dialog
      title={isUz ? 'Ombor bo‘yicha daraja' : 'Уровень запаса на склад'}
      isUz={isUz}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        {error !== null && <ErrorBox text={errorText(error, isUz)} isUz={isUz} />}
        <span className="text-[11px] text-zinc-500">
          {isUz
            ? 'Bu daraja kompaniya darajasini almashtiradi, qo‘shmaydi'
            : 'Этот уровень перекрывает уровень компании по этой позиции, а не складывается с ним'}
        </span>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label={isUz ? 'Nomenklatura' : 'Позиция'}>
            <select
              aria-label={isUz ? 'Nomenklatura' : 'Позиция'}
              className={FIELD}
              value={itemUid}
              onChange={(e) => setItemUid(e.target.value)}
            >
              <option value="">—</option>
              {options.items.map((i) => (
                <option key={i.uid} value={i.uid}>
                  {i.code} · {refName(i, isUz)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={isUz ? 'Ombor' : 'Склад'}>
            <select
              aria-label={isUz ? 'Ombor' : 'Склад'}
              className={FIELD}
              value={warehouseUid}
              onChange={(e) => setWarehouseUid(e.target.value)}
            >
              <option value="">—</option>
              {options.places.map((w) => (
                <option key={w.uid} value={w.uid}>
                  {w.code} · {refName(w, isUz)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={isUz ? 'Eng kam' : 'Минимальный'}>
            <input
              aria-label={isUz ? 'Eng kam daraja' : 'Минимальный уровень'}
              className={FIELD}
              value={minQty}
              onChange={(e) => setMinQty(e.target.value)}
            />
          </Field>
          <Field label={isUz ? 'Kritik' : 'Критический'}>
            <input
              aria-label={isUz ? 'Kritik daraja' : 'Критический уровень'}
              className={FIELD}
              value={criticalQty}
              onChange={(e) => setCriticalQty(e.target.value)}
            />
          </Field>
          <Field label={isUz ? 'Izoh' : 'Комментарий'} wide>
            <input
              aria-label={isUz ? 'Izoh' : 'Комментарий к уровню'}
              className={FIELD}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={saving || itemUid === '' || warehouseUid === ''}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                await apiClient.refs.setLevel({
                  itemUid,
                  warehouseUid,
                  minQty: numOrUndef(minQty) ?? 0,
                  criticalQty: numOrUndef(criticalQty) ?? 0,
                  comment: comment.trim() || undefined,
                });
                onDone();
              } catch (e) {
                setError(e);
              } finally {
                setSaving(false);
              }
            }}
            className={BTN_PRIMARY}
          >
            {saving ? (isUz ? 'Saqlanmoqda…' : 'Сохраняю…') : isUz ? 'Saqlash' : 'Сохранить'}
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST}>
            {isUz ? 'Bekor qilish' : 'Отмена'}
          </button>
        </div>
      </div>
    </Dialog>
  );
};
