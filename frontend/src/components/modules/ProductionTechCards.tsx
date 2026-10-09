/**
 * Техкарты производства: справочник норм с версиями (ТЗ 4.1, Э2).
 *
 * Отдельный раздел внутри «Производства», а не вкладка в карточке заказа:
 * карта живёт дольше заказа и описывает не конкретную работу, а правило, по
 * которому её считают.
 *
 * Что здесь важно для человека и потому вынесено в текст экрана:
 *
 * - **действующую карту нельзя править.** По ней уже посчитаны заведённые
 *   заказы, и правка на месте сдвинула бы их норму задним числом. Экран
 *   предлагает «Новая версия» и объясняет, почему;
 *   список версий виден в карточке — переключаться между ними можно;
 * - **на номенклатуре работает одна карта.** Ввод новой в работу уводит
 *   прежнюю в архив, и об этом сказано до нажатия, а не после;
 * - **нормы задаются на одну единицу продукции.** Написано прямо в шапке
 *   редактора: иначе «45 минут» читается как «на весь заказ».
 *
 * Данные берёт прямо у `apiClient`, без провайдера: раздел самостоятельный, и
 * выносить его состояние в общий контекст производства значило бы грузить
 * карты тому, кто пришёл посмотреть заказы.
 */

import React from 'react';
import { AlertCircle, Loader2, Plus, Search, Trash2, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { ApiError, apiClient } from '../../lib/api-client';
import {
  ProductionOptions,
  TechCardDetail,
  TechCardMaterialInput,
  TechCardRow,
  TechCardStageInput,
  TechCardStatus,
} from '../../types/api';
import { formatDate, formatUnit, refName } from '../../lib/formatters';
import { CustomSelect, CustomSelectOption } from '../common/CustomSelect';

const CARD =
  'rounded-xl border border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-[#18181b] shadow-2xs';

const FIELD =
  'w-full h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white ' +
  'dark:bg-zinc-900 text-xs text-zinc-950 dark:text-zinc-50 placeholder:text-zinc-400 ' +
  'focus:outline-hidden focus:border-zinc-400 transition-colors shadow-2xs';

const BTN_BASE =
  'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 ' +
  'disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400';
const BTN_PRIMARY =
  BTN_BASE +
  ' bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 ' +
  'dark:hover:bg-zinc-200 cursor-pointer';
const BTN_GHOST =
  BTN_BASE +
  ' border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 ' +
  'hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer';

const STATUS: Record<TechCardStatus, { ru: string; uz: string }> = {
  draft: { ru: 'Черновик', uz: 'Qoralama' },
  active: { ru: 'В работе', uz: 'Ishda' },
  archived: { ru: 'В архиве', uz: 'Arxivda' },
};

const QTY_RE = /^\d{1,13}([.,]\d{1,6})?$/;

const errorText = (e: ApiError | null, isUz: boolean) =>
  e ? e.message : isUz ? 'Noma’lum xato' : 'Неизвестная ошибка';

/** Минуты человеку: «3 ч 45 мин», а не «225». */
function duration(min: number, isUz: boolean): string {
  if (min <= 0) return isUz ? '0 daq' : '0 мин';
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hh = isUz ? 's' : 'ч';
  const mm = isUz ? 'daq' : 'мин';
  return [h > 0 ? `${h} ${hh}` : '', m > 0 || h === 0 ? `${m} ${mm}` : ''].filter(Boolean).join(' ');
}

const ErrorLine: React.FC<{ text: string }> = ({ text }) => (
  <div className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/30 text-[11px] text-red-700 dark:text-red-300">
    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
    <span className="min-w-0">{text}</span>
  </div>
);

const FieldRow: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children,
}) => (
  <div className="flex flex-col gap-1 min-w-0">
    <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</span>
    {children}
    {hint && <span className="text-[10px] text-zinc-400">{hint}</span>}
  </div>
);

// ---------------------------------------------------------------------------

type Draft = {
  nameRu: string;
  nameUz: string;
  stages: TechCardStageInput[];
  materials: TechCardMaterialInput[];
};

const emptyStage = (seq: number): TechCardStageInput => ({
  seq,
  nameRu: '',
  nameUz: '',
  normDurationMin: 0,
  wastePercent: '0',
});

const fromCard = (card: TechCardDetail): Draft => ({
  nameRu: card.nameRu,
  nameUz: card.nameUz,
  stages: card.stages.map((s) => ({
    seq: s.seq,
    nameRu: s.nameRu,
    nameUz: s.nameUz,
    workCenterCode: s.workCenterCode ?? undefined,
    normDurationMin: s.normDurationMin,
    isParallel: s.isParallel,
    wastePercent: String(Number(s.wastePercent)),
  })),
  materials: card.materials.map((m) => ({
    itemCode: m.itemCode,
    qtyPerUnit: String(Number(m.qtyPerUnit)),
    stageSeq: m.stageSeq ?? undefined,
    isAutoWriteoff: m.isAutoWriteoff,
  })),
});

/** Редактор нормы: этапы и материалы черновика. */
const CardEditor: React.FC<{
  card: TechCardDetail;
  options: ProductionOptions | null;
  isUz: boolean;
  saving: boolean;
  onSave: (draft: Draft) => void;
  onCancel: () => void;
}> = ({ card, options, isUz, saving, onSave, onCancel }) => {
  const [draft, setDraft] = React.useState<Draft>(() => fromCard(card));
  const [wrong, setWrong] = React.useState<string | null>(null);

  const unit = formatUnit(card.unit, isUz ? 'uz' : 'ru');

  const centerOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'Uchastka ko‘rsatilmagan' : 'Участок не указан' },
    ...(options?.workCenters ?? []).map((w) => ({
      value: w.code,
      label: refName(w, isUz),
      sublabel: w.code,
    })),
  ];

  const materialOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'Materialni tanlang' : 'Выберите материал' },
    ...(options?.materials ?? [])
      .filter((m) => m.code !== card.itemCode)
      .map((m) => ({
        value: m.code,
        label: refName(m, isUz),
        sublabel: `${m.code} • ${formatUnit(m.unit, isUz ? 'uz' : 'ru')}`,
      })),
  ];

  const stageOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'Butun buyurtmaga' : 'На весь заказ' },
    ...draft.stages.map((s) => ({
      value: String(s.seq),
      label: `${s.seq}. ${(refName(s, isUz)) || (isUz ? 'nomsiz' : 'без названия')}`,
    })),
  ];

  const setStage = (i: number, patch: Partial<TechCardStageInput>) =>
    setDraft((d) => ({
      ...d,
      stages: d.stages.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    }));

  /** Этап убрали — остальные перенумеровываются: дыра в порядке не бывает. */
  const dropStage = (i: number) =>
    setDraft((d) => {
      const stages = d.stages
        .filter((_, idx) => idx !== i)
        .map((s, idx) => ({ ...s, seq: idx + 1 }));
      const gone = d.stages[i].seq;
      return {
        ...d,
        stages,
        materials: d.materials.map((m) =>
          m.stageSeq === gone
            ? { ...m, stageSeq: undefined }
            : m.stageSeq && m.stageSeq > gone
              ? { ...m, stageSeq: m.stageSeq - 1 }
              : m,
        ),
      };
    });

  const check = (): string | null => {
    if (!draft.nameRu.trim() || !draft.nameUz.trim()) {
      return isUz ? 'Karta nomini ikkala tilda yozing' : 'Напишите название карты на обоих языках';
    }
    if (draft.stages.length === 0) {
      return isUz
        ? 'Kamida bitta bosqich kerak: aks holda normalash uchun hech narsa yo‘q'
        : 'Нужен хотя бы один этап: иначе нормировать нечего';
    }
    for (const s of draft.stages) {
      if (!s.nameRu.trim() || !s.nameUz.trim()) {
        return isUz
          ? `${s.seq}-bosqich nomsiz qoldi`
          : `Этап ${s.seq} остался без названия`;
      }
      if (!Number.isInteger(s.normDurationMin) || s.normDurationMin < 0) {
        return isUz
          ? `${s.seq}-bosqich: norma — butun daqiqa`
          : `Этап ${s.seq}: норма — целое число минут`;
      }
    }
    for (const m of draft.materials) {
      if (!m.itemCode) return isUz ? 'Materialni tanlang' : 'Выберите материал в каждой строке';
      if (!QTY_RE.test(String(m.qtyPerUnit).trim())) {
        return isUz
          ? `${m.itemCode}: sarf — son, masalan 1,08`
          : `${m.itemCode}: норма расхода — число, например 1,08`;
      }
    }
    return null;
  };

  const submit = () => {
    const bad = check();
    setWrong(bad);
    if (bad) return;
    onSave({
      ...draft,
      materials: draft.materials.map((m) => ({
        ...m,
        qtyPerUnit: String(m.qtyPerUnit).replace(',', '.'),
      })),
      stages: draft.stages.map((s) => ({
        ...s,
        wastePercent: String(s.wastePercent ?? '0').replace(',', '.'),
      })),
    });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <div className="shrink-0 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider">
            {isUz ? 'Texkartani tahrirlash' : 'Правка техкарты'}
          </div>
          <div className="text-sm font-bold text-zinc-950 dark:text-zinc-50 break-words">
            {card.itemCode} · v{card.version}
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label={isUz ? 'Yopish' : 'Закрыть'}
          className="p-1 rounded-md text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-50 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
        >
          <X size={13} />
        </button>
      </div>

      <p className="shrink-0 text-[11px] text-zinc-500 border-s-2 border-zinc-200 dark:border-zinc-700 ps-2">
        {isUz
          ? `Normalar bitta birlikka beriladi: 1 ${unit}. Vaqt — daqiqada.`
          : `Нормы задаются на одну единицу продукции: 1 ${unit}. Время — в минутах.`}
      </p>

      <div className="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <FieldRow label={isUz ? 'Nomi (ru)' : 'Название (рус)'}>
            <input
              type="text"
              value={draft.nameRu}
              onChange={(e) => setDraft((d) => ({ ...d, nameRu: e.target.value }))}
              aria-label={isUz ? 'Nomi ruscha' : 'Название по-русски'}
              className={FIELD}
            />
          </FieldRow>
          <FieldRow label={isUz ? 'Nomi (uz)' : 'Название (узб)'}>
            <input
              type="text"
              value={draft.nameUz}
              onChange={(e) => setDraft((d) => ({ ...d, nameUz: e.target.value }))}
              aria-label={isUz ? 'Nomi o‘zbekcha' : 'Название по-узбекски'}
              className={FIELD}
            />
          </FieldRow>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
              {isUz ? 'Bosqichlar' : 'Этапы'}
            </span>
            <span className="text-[10px] text-zinc-400">
              {isUz ? 'Jami' : 'Итого'}:{' '}
              {duration(
                draft.stages.reduce((s, x) => s + (Number(x.normDurationMin) || 0), 0),
                isUz,
              )}
            </span>
          </div>

          {draft.stages.map((s, i) => (
            <div
              key={i}
              className="p-2.5 rounded-lg border border-zinc-100 dark:border-zinc-800 flex flex-col gap-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-mono text-zinc-400">
                  {isUz ? 'Bosqich' : 'Этап'} {s.seq}
                </span>
                <button
                  type="button"
                  onClick={() => dropStage(i)}
                  aria-label={isUz ? 'Bosqichni olib tashlash' : 'Убрать этап'}
                  className="p-1 rounded-md text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  type="text"
                  value={s.nameRu}
                  onChange={(e) => setStage(i, { nameRu: e.target.value })}
                  placeholder={isUz ? 'Nomi (ru)' : 'Название (рус)'}
                  aria-label={`${isUz ? 'Bosqich' : 'Этап'} ${s.seq}: ${isUz ? 'nomi ruscha' : 'название по-русски'}`}
                  className={FIELD}
                />
                <input
                  type="text"
                  value={s.nameUz}
                  onChange={(e) => setStage(i, { nameUz: e.target.value })}
                  placeholder={isUz ? 'Nomi (uz)' : 'Название (узб)'}
                  aria-label={`${isUz ? 'Bosqich' : 'Этап'} ${s.seq}: ${isUz ? 'nomi o‘zbekcha' : 'название по-узбекски'}`}
                  className={FIELD}
                />
              </div>
              {/* Участок — отдельной строкой: втиснутый в треть панели список
                  обрезает название участка до «Участо…», и выбирают наугад. */}
              <FieldRow label={isUz ? 'Uchastka' : 'Участок'}>
                <CustomSelect
                  value={s.workCenterCode ?? ''}
                  onChange={(v) => setStage(i, { workCenterCode: v || undefined })}
                  options={centerOptions}
                  portal
                  ariaLabel={`${isUz ? 'Bosqich' : 'Этап'} ${s.seq}: ${isUz ? 'uchastka' : 'участок'}`}
                />
              </FieldRow>
              <div className="grid grid-cols-2 gap-2">
                <FieldRow label={isUz ? 'Norma, daqiqa' : 'Норма, минут'}>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={String(s.normDurationMin)}
                    onChange={(e) =>
                      setStage(i, {
                        normDurationMin: Number(e.target.value.replace(/\D/g, '')) || 0,
                      })
                    }
                    aria-label={`${isUz ? 'Bosqich' : 'Этап'} ${s.seq}: ${isUz ? 'norma, daqiqa' : 'норма, минут'}`}
                    className={FIELD}
                  />
                </FieldRow>
                <FieldRow label={isUz ? 'Chiqindi, %' : 'Отход, %'}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={String(s.wastePercent ?? '0')}
                    onChange={(e) => setStage(i, { wastePercent: e.target.value })}
                    aria-label={`${isUz ? 'Bosqich' : 'Этап'} ${s.seq}: ${isUz ? 'chiqindi foizi' : 'процент otkhodi'}`}
                    className={FIELD}
                  />
                </FieldRow>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={() =>
              setDraft((d) => ({ ...d, stages: [...d.stages, emptyStage(d.stages.length + 1)] }))
            }
            className={BTN_GHOST + ' self-start'}
          >
            <span className="inline-flex items-center gap-1.5">
              <Plus size={12} />
              {isUz ? 'Bosqich' : 'Этап'}
            </span>
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
            {isUz ? `Materiallar (1 ${unit} uchun)` : `Материалы (на 1 ${unit})`}
          </span>

          {draft.materials.map((m, i) => (
            <div
              key={i}
              className="p-2.5 rounded-lg border border-zinc-100 dark:border-zinc-800 flex flex-col gap-2"
            >
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <CustomSelect
                    value={m.itemCode}
                    onChange={(v) =>
                      setDraft((d) => ({
                        ...d,
                        materials: d.materials.map((x, idx) =>
                          idx === i ? { ...x, itemCode: v } : x,
                        ),
                      }))
                    }
                    options={materialOptions}
                    portal
                    ariaLabel={`${isUz ? 'Material' : 'Материал'} ${i + 1}`}
                  />
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      materials: d.materials.filter((_, idx) => idx !== i),
                    }))
                  }
                  aria-label={isUz ? 'Materialni olib tashlash' : 'Убрать материал'}
                  className="p-1 mt-1 rounded-md text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <FieldRow label={isUz ? `1 ${unit} uchun` : `На 1 ${unit}`}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={String(m.qtyPerUnit)}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        materials: d.materials.map((x, idx) =>
                          idx === i ? { ...x, qtyPerUnit: e.target.value } : x,
                        ),
                      }))
                    }
                    placeholder="1,08"
                    aria-label={`${isUz ? 'Material' : 'Материал'} ${i + 1}: ${isUz ? 'sarf normasi' : 'норма расхода'}`}
                    className={FIELD}
                  />
                </FieldRow>
                <FieldRow label={isUz ? 'Bosqich' : 'Этап'}>
                  <CustomSelect
                    value={m.stageSeq ? String(m.stageSeq) : ''}
                    onChange={(v) =>
                      setDraft((d) => ({
                        ...d,
                        materials: d.materials.map((x, idx) =>
                          idx === i ? { ...x, stageSeq: v ? Number(v) : undefined } : x,
                        ),
                      }))
                    }
                    options={stageOptions}
                    portal
                    ariaLabel={`${isUz ? 'Material' : 'Материал'} ${i + 1}: ${isUz ? 'bosqich' : 'этап'}`}
                  />
                </FieldRow>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                materials: [...d.materials, { itemCode: '', qtyPerUnit: '' }],
              }))
            }
            className={BTN_GHOST + ' self-start'}
          >
            <span className="inline-flex items-center gap-1.5">
              <Plus size={12} />
              {isUz ? 'Material' : 'Материал'}
            </span>
          </button>
        </div>

        {wrong && <ErrorLine text={wrong} />}
      </div>

      <div className="shrink-0 pt-2 border-t border-zinc-100 dark:border-zinc-800/60 flex items-center gap-2">
        <button type="button" onClick={submit} disabled={saving} className={BTN_PRIMARY}>
          <span className="inline-flex items-center gap-1.5">
            {saving && <Loader2 size={12} className="animate-spin" />}
            {isUz ? 'Saqlash' : 'Сохранить'}
          </span>
        </button>
        <button type="button" onClick={onCancel} disabled={saving} className={BTN_GHOST}>
          {isUz ? 'Bekor qilish' : 'Отмена'}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------

/** Карточка нормы: что в ней, какие версии и что с ней можно сделать. */
const CardPanel: React.FC<{
  card: TechCardDetail;
  isUz: boolean;
  mayManage: boolean;
  saving: boolean;
  onEdit: () => void;
  onAction: (kind: 'activate' | 'archive' | 'new-version') => void;
  onOpen: (uid: string) => void;
}> = ({ card, isUz, mayManage, saving, onEdit, onAction, onOpen }) => {
  const unit = formatUnit(card.unit, isUz ? 'uz' : 'ru');

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <div className="shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-bold text-sm text-zinc-950 dark:text-zinc-50">
            {card.itemCode} · v{card.version}
          </span>
          <span className="text-[10px] px-1.5 rounded border border-zinc-200 dark:border-zinc-800 text-zinc-500">
            {isUz ? STATUS[card.status].uz : STATUS[card.status].ru}
          </span>
        </div>
        <p className="text-[11px] text-zinc-600 dark:text-zinc-400 mt-1 break-words">
          {isUz ? card.itemNameUz : card.itemNameRu}
        </p>
        <p className="text-[10px] text-zinc-400 mt-0.5">
          {refName(card, isUz)} • {isUz ? 'normalar 1' : 'нормы на 1'} {unit}
        </p>
        {card.validFrom && (
          <p className="text-[10px] text-zinc-400 mt-0.5">
            {card.status === 'archived'
              ? isUz
                ? 'Amal qilgan: '
                : 'Действовала с '
              : isUz
                ? 'Amal qiladi: '
                : 'Действует с '}
            {formatDate(card.validFrom)}
          </p>
        )}

        {card.versions.length > 1 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-zinc-400">{isUz ? 'Versiyalar:' : 'Версии:'}</span>
            {card.versions.map((v) => (
              <button
                key={v.uid}
                type="button"
                onClick={() => onOpen(v.uid)}
                aria-current={v.uid === card.uid}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors cursor-pointer ${
                  v.uid === card.uid
                    ? 'border-zinc-900 dark:border-zinc-100 text-zinc-950 dark:text-zinc-50'
                    : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                v{v.version}
                {v.status === 'active' ? ' •' : ''}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-zinc-400 uppercase tracking-wider">
              {isUz ? 'Bosqichlar' : 'Этапы'}
            </span>
            <span className="text-[10px] font-mono text-zinc-500">
              {duration(card.totalDurationMin, isUz)}
            </span>
          </div>
          {card.stages.length === 0 ? (
            <p className="text-[11px] text-zinc-400">
              {isUz ? 'Bosqich yo‘q' : 'Этапов пока нет'}
            </p>
          ) : (
            card.stages.map((s) => (
              <div key={s.seq} className="flex items-start gap-2 text-[11px]">
                <span className="w-5 shrink-0 text-center rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 font-mono">
                  {s.seq}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-zinc-900 dark:text-zinc-100 break-words">
                    {refName(s, isUz)}
                  </div>
                  <div className="text-[10px] text-zinc-500 font-mono break-words">
                    {duration(s.normDurationMin, isUz)}
                    {s.workCenterCode
                      ? ` • ${isUz ? s.workCenterNameUz : s.workCenterNameRu}`
                      : ''}
                    {Number(s.wastePercent) > 0
                      ? ` • ${isUz ? 'chiqindi' : 'отход'} ${Number(s.wastePercent)}%`
                      : ''}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] text-zinc-400 uppercase tracking-wider">
            {isUz ? `Materiallar (1 ${unit} uchun)` : `Материалы (на 1 ${unit})`}
          </span>
          {card.materials.length === 0 ? (
            <p className="text-[11px] text-zinc-400">
              {isUz ? 'Material yozilmagan' : 'Материалы не заданы'}
            </p>
          ) : (
            card.materials.map((m) => (
              <div key={m.itemCode} className="flex items-start justify-between gap-2 text-[11px]">
                <span className="text-zinc-900 dark:text-zinc-100 break-words min-w-0">
                  {isUz ? m.itemNameUz : m.itemNameRu}
                  {m.stageSeq ? (
                    <span className="text-zinc-400">
                      {' '}
                      • {isUz ? 'bosqich' : 'этап'} {m.stageSeq}
                    </span>
                  ) : null}
                </span>
                <span className="font-mono tabular-nums text-zinc-500 shrink-0">
                  {Number(m.qtyPerUnit)} {formatUnit(m.unit, isUz ? 'uz' : 'ru')}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {mayManage && (
        <div className="shrink-0 pt-2.5 border-t border-zinc-100 dark:border-zinc-800/60 space-y-2">
          {/* Что произойдёт — до нажатия, а не в ответе об ошибке. */}
          <p className="text-[11px] text-zinc-500">
            {card.status === 'draft'
              ? isUz
                ? 'Qoralama hech narsani normalamaydi. Ishga kiritilsa, shu nomenklaturadagi oldingi karta arxivga o‘tadi.'
                : 'Черновик пока ничего не нормирует. Введёте в работу — прежняя карта по этой номенклатуре уйдёт в архив.'
              : card.status === 'active'
                ? isUz
                  ? 'Karta ishda: unga tayangan buyurtmalar bor. Tahrir — faqat yangi versiya orqali.'
                  : 'Карта в работе: по ней уже считают заведённые заказы. Правка — только новой версией.'
                : isUz
                  ? 'Karta arxivda: yangi buyurtmalarga olinmaydi.'
                  : 'Карта в архиве: в новые заказы она не берётся.'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {card.status === 'draft' && (
              <>
                <button type="button" onClick={onEdit} disabled={saving} className={BTN_GHOST}>
                  {isUz ? 'Tahrirlash' : 'Править'}
                </button>
                <button
                  type="button"
                  onClick={() => onAction('activate')}
                  disabled={saving}
                  className={BTN_PRIMARY}
                >
                  {isUz ? 'Ishga kiritish' : 'Ввести в работу'}
                </button>
              </>
            )}
            {card.status === 'active' && (
              <button
                type="button"
                onClick={() => onAction('new-version')}
                disabled={saving}
                className={BTN_PRIMARY}
              >
                {isUz ? 'Yangi versiya' : 'Новая версия'}
              </button>
            )}
            {card.status !== 'archived' && (
              <button
                type="button"
                onClick={() => onAction('archive')}
                disabled={saving}
                className={BTN_GHOST}
              >
                {isUz ? 'Arxivga' : 'В архив'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------

const STATUS_FILTER: { value: '' | TechCardStatus; ru: string; uz: string }[] = [
  { value: '', ru: 'Все карты', uz: 'Barcha kartalar' },
  { value: 'active', ru: 'В работе', uz: 'Ishda' },
  { value: 'draft', ru: 'Черновики', uz: 'Qoralamalar' },
  { value: 'archived', ru: 'Архив', uz: 'Arxiv' },
];

/** Раздел целиком: список слева, карточка или редактор справа. */
export const ProductionTechCards: React.FC = () => {
  const { locale } = useApp();
  const isUz = locale === 'uz';
  const { can } = useAuth();
  const mayManage = can('production.manage');

  const [status, setStatus] = React.useState<'' | TechCardStatus>('');
  const [search, setSearch] = React.useState('');
  const [rows, setRows] = React.useState<TechCardRow[] | null>(null);
  const [listError, setListError] = React.useState<ApiError | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [card, setCard] = React.useState<TechCardDetail | null>(null);
  const [options, setOptions] = React.useState<ProductionOptions | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [newItemCode, setNewItemCode] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<ApiError | null>(null);
  const [nonce, setNonce] = React.useState(0);

  const reload = () => setNonce((n) => n + 1);

  React.useEffect(() => {
    let dead = false;
    apiClient.production
      .getTechCards({ status: status || null })
      .then(({ data }) => {
        if (!dead) {
          setRows(data.rows);
          setListError(null);
        }
      })
      .catch((e) => {
        if (!dead) setListError(e instanceof ApiError ? e : null);
      });
    return () => {
      dead = true;
    };
  }, [status, nonce]);

  React.useEffect(() => {
    if (!selected) {
      setCard(null);
      return;
    }
    let dead = false;
    apiClient.production
      .getTechCard(selected)
      .then(({ data }) => {
        if (!dead) setCard(data);
      })
      .catch(() => {
        if (!dead) setCard(null);
      });
    return () => {
      dead = true;
    };
  }, [selected, nonce]);

  // Справочники нужны только тому, кто открыл форму или редактор.
  React.useEffect(() => {
    if ((!editing && !creating) || options) return;
    let dead = false;
    apiClient.production
      .getOptions()
      .then(({ data }) => {
        if (!dead) setOptions(data);
      })
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [editing, creating, options]);

  const run = async <T,>(call: () => Promise<{ data: T }>): Promise<T | null> => {
    if (saving) return null;
    setSaving(true);
    setSaveError(null);
    try {
      const { data } = await call();
      reload();
      return data;
    } catch (e) {
      setSaveError(e instanceof ApiError ? e : null);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const shown = (rows ?? []).filter((c) => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return (
      c.itemCode.toLowerCase().includes(term) ||
      (isUz ? c.itemNameUz : c.itemNameRu).toLowerCase().includes(term)
    );
  });

  const itemOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'Mahsulotni tanlang' : 'Выберите продукцию' },
    ...(options?.items ?? []).map((i) => ({
      value: i.code,
      label: refName(i, isUz),
      sublabel: i.code,
    })),
  ];

  const renderPanel = () => {
    if (creating) {
      return (
        <div className="flex-1 min-h-0 flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2 shrink-0">
            <div className="min-w-0">
              <div className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider">
                {isUz ? 'Texkarta' : 'Техкарта'}
              </div>
              <div className="text-sm font-bold text-zinc-950 dark:text-zinc-50">
                {isUz ? 'Yangi norma' : 'Новая норма'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setCreating(false)}
              aria-label={isUz ? 'Yopish' : 'Закрыть'}
              className="p-1 rounded-md text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-50 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <X size={13} />
            </button>
          </div>

          <p className="text-[11px] text-zinc-500 border-s-2 border-zinc-200 dark:border-zinc-700 ps-2 shrink-0">
            {isUz
              ? 'Karta qoralama bo‘lib tug‘iladi. Bosqich va materiallarni keyingi qadamda yozasiz.'
              : 'Карта рождается черновиком. Этапы и материалы впишете следующим шагом.'}
          </p>

          <div className="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-2.5">
            <FieldRow
              label={isUz ? 'Nima uchun norma' : 'На что норма'}
              hint={
                isUz
                  ? 'Ro‘yxatda zavod ishlab chiqaradigan mahsulot bor'
                  : 'В списке только то, что завод производит сам'
              }
            >
              <CustomSelect
                value={newItemCode}
                onChange={setNewItemCode}
                options={itemOptions}
                portal
                ariaLabel={isUz ? 'Mahsulot' : 'Продукция'}
              />
            </FieldRow>
            {saveError && <ErrorLine text={errorText(saveError, isUz)} />}
          </div>

          <div className="shrink-0 pt-2 border-t border-zinc-100 dark:border-zinc-800/60 flex items-center gap-2">
            <button
              type="button"
              disabled={saving || !newItemCode}
              className={BTN_PRIMARY}
              onClick={async () => {
                const item = (options?.items ?? []).find((i) => i.code === newItemCode);
                if (!item) return;
                const made = await run(() =>
                  apiClient.production.createTechCard({
                    itemCode: newItemCode,
                    nameRu: `Техкарта: ${item.nameRu}`,
                    nameUz: `Texkarta: ${item.nameUz}`,
                  }),
                );
                if (made) {
                  setCreating(false);
                  setNewItemCode('');
                  setSelected(made.uid);
                  setEditing(true);
                }
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                {saving && <Loader2 size={12} className="animate-spin" />}
                {isUz ? 'Yaratish' : 'Завести'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              disabled={saving}
              className={BTN_GHOST}
            >
              {isUz ? 'Bekor qilish' : 'Отмена'}
            </button>
          </div>
        </div>
      );
    }

    if (!selected || !card) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <p className="text-xs text-zinc-400">
            {isUz ? 'Ro‘yxatdan kartani tanlang' : 'Выберите карту из списка'}
          </p>
          {mayManage && (
            <button type="button" onClick={() => setCreating(true)} className={BTN_PRIMARY}>
              <span className="inline-flex items-center gap-1.5">
                <Plus size={12} />
                {isUz ? 'Yangi texkarta' : 'Новая техкарта'}
              </span>
            </button>
          )}
        </div>
      );
    }

    if (editing && card.canEdit) {
      return (
        <CardEditor
          card={card}
          options={options}
          isUz={isUz}
          saving={saving}
          onCancel={() => setEditing(false)}
          onSave={async (draft) => {
            const done = await run(() =>
              apiClient.production.updateTechCard(card.uid, {
                nameRu: draft.nameRu,
                nameUz: draft.nameUz,
                stages: draft.stages,
                materials: draft.materials,
              }),
            );
            if (done) setEditing(false);
          }}
        />
      );
    }

    return (
      <div className="flex-1 min-h-0 flex flex-col gap-2">
        {saveError && <ErrorLine text={errorText(saveError, isUz)} />}
        <CardPanel
          card={card}
          isUz={isUz}
          mayManage={mayManage}
          saving={saving}
          onEdit={() => setEditing(true)}
          onOpen={(uid) => {
            setSelected(uid);
            setEditing(false);
          }}
          onAction={async (kind) => {
            const call =
              kind === 'activate'
                ? () => apiClient.production.activateTechCard(card.uid)
                : kind === 'archive'
                  ? () => apiClient.production.archiveTechCard(card.uid)
                  : () => apiClient.production.newTechCardVersion(card.uid);
            const done = await run(call);
            if (done && kind === 'new-version') {
              setSelected(done.uid);
              setEditing(true);
            }
          }}
        />
      </div>
    );
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
      <div
        className={`lg:col-span-8 h-[540px] ${CARD} overflow-hidden flex flex-col justify-between`}
      >
        <div className="p-3 border-b border-zinc-100 dark:border-zinc-800/60 bg-zinc-50/50 dark:bg-zinc-900/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
          <h3 className="text-xs font-semibold text-zinc-950 dark:text-zinc-50 shrink-0">
            {isUz ? 'Texkartalar' : 'Технологические карты'}
          </h3>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
            {mayManage && (
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  setCreating(true);
                }}
                className="h-8 px-3 rounded-lg text-xs font-medium bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 cursor-pointer w-full sm:w-auto"
              >
                <span className="inline-flex items-center justify-center gap-1.5">
                  <Plus size={12} />
                  {isUz ? 'Karta' : 'Карта'}
                </span>
              </button>
            )}
            <CustomSelect
              value={status}
              onChange={(v) => setStatus(v as '' | TechCardStatus)}
              options={STATUS_FILTER.map((o) => ({
                value: o.value,
                label: isUz ? o.uz : o.ru,
              }))}
              className="w-full sm:w-44"
            />
            <div className="relative w-full sm:w-auto">
              <Search
                size={12}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400"
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={isUz ? 'Mahsulot...' : 'Продукция...'}
                aria-label={isUz ? 'Kartalarni qidirish' : 'Поиск карт'}
                className="h-8 w-full sm:w-48 pl-7 pr-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-hidden focus:border-zinc-400 transition-colors shadow-2xs"
              />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto w-full">
          {listError ? (
            <div className="p-4">
              <ErrorLine text={errorText(listError, isUz)} />
            </div>
          ) : shown.length === 0 ? (
            <p className="p-4 text-xs text-zinc-400">
              {isUz ? 'Karta topilmadi' : 'Карт не найдено'}
            </p>
          ) : (
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800/40">
              {shown.map((c) => (
                <button
                  key={c.uid}
                  type="button"
                  onClick={() => {
                    setSelected(c.uid);
                    setEditing(false);
                    setCreating(false);
                  }}
                  aria-current={c.uid === selected}
                  className={`w-full text-left px-4 py-2.5 transition-colors cursor-pointer ${
                    c.uid === selected
                      ? 'bg-zinc-100 dark:bg-zinc-800/60'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/40'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs font-semibold text-zinc-950 dark:text-zinc-50">
                          {c.itemCode}
                        </span>
                        <span className="text-[10px] font-mono text-zinc-400">v{c.version}</span>
                        <span className="text-[10px] px-1.5 rounded border border-zinc-200 dark:border-zinc-800 text-zinc-500">
                          {isUz ? STATUS[c.status].uz : STATUS[c.status].ru}
                        </span>
                      </div>
                      <div className="text-[11px] text-zinc-600 dark:text-zinc-400 break-words">
                        {isUz ? c.itemNameUz : c.itemNameRu}
                      </div>
                    </div>
                    <div className="text-[10px] font-mono text-zinc-500 text-right shrink-0">
                      <div>
                        {c.stagesCount} {isUz ? 'bosqich' : 'эт.'} · {c.materialsCount}{' '}
                        {isUz ? 'material' : 'мат.'}
                      </div>
                      <div>{duration(c.totalDurationMin, isUz)}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 py-2 border-t border-zinc-100 dark:border-zinc-800/60 bg-zinc-50/30 dark:bg-zinc-900/20 text-xs text-zinc-400 flex items-center justify-between gap-2 font-mono shrink-0">
          <span className="truncate">
            {isUz ? 'Normalar 1 birlikka' : 'Нормы заданы на одну единицу продукции'}
          </span>
          <span className="shrink-0">
            {isUz ? 'Yozuvlar:' : 'Записей:'} {shown.length}
          </span>
        </div>
      </div>

      <div className={`lg:col-span-4 h-[540px] ${CARD} p-4 sm:p-5 flex flex-col justify-between`}>
        {renderPanel()}
      </div>
    </div>
  );
};
