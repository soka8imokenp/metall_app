/**
 * Участки цеха (ТЗ 4.1, Э8).
 *
 * Участки до этого захода жили только в данных: их завели один раз при
 * установке, а завод живой — линию переносят, добавляют, выводят в ремонт.
 * Здесь их правят на экране.
 *
 * Ставка часа — та самая цифра, из которой шестой заход считает работу в
 * себестоимости. Пока её не заполнят, в расчёте будут одни материалы, и экран
 * об этом говорит прямо, а не оставляет догадываться.
 *
 * Участок не удаляют: на нём висят закрытые этапы, и выброси его — у прошлых
 * заказов пропадёт, где их делали. Вместо удаления закрывают, и пока на
 * участке есть незакрытая работа, сервер закрыть не даёт.
 */

import React from 'react';
import { Loader2, Plus } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { errorText } from '../../context/DashboardContext';
import { useProduction } from '../../context/ProductionContext';
import { formatNumber, refName } from '../../lib/formatters';
import type { ProductionWorkCenter } from '../../types/api';

const CARD =
  'rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xs';
const BTN =
  'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-40 ' +
  'disabled:cursor-not-allowed cursor-pointer';
const PRIMARY = `${BTN} bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900`;
const GHOST =
  `${BTN} border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 ` +
  'hover:bg-zinc-100 dark:hover:bg-zinc-800';
const INPUT =
  'h-8 w-full px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white ' +
  'dark:bg-zinc-900 text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 ' +
  'focus:outline-hidden focus:border-zinc-400 transition-colors';

/** Число с запятой вместо точки — так его набирают в цеху. */
const num = (v: string) => v.trim().replace(',', '.');

type Draft = {
  code: string;
  nameRu: string;
  nameUz: string;
  capacityPerShift: string;
  costPerHour: string;
  isActive: boolean;
};

const empty: Draft = {
  code: '',
  nameRu: '',
  nameUz: '',
  capacityPerShift: '',
  costPerHour: '',
  isActive: true,
};

export const ProductionCenters: React.FC = () => {
  const { locale } = useApp();
  const { can } = useAuth();
  const isUz = locale === 'uz';
  const mayManage = can('production.manage');
  const { workCenters, wantWorkCenters, saveWorkCenter, saving, saveError } = useProduction();

  React.useEffect(() => {
    wantWorkCenters();
  }, [wantWorkCenters]);

  /** `null` — форма закрыта, `''` — заводим новый, код — правим этот. */
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Draft>(empty);
  const [wrong, setWrong] = React.useState<string | null>(null);

  const openNew = () => {
    setDraft(empty);
    setWrong(null);
    setEditing('');
  };

  const openEdit = (row: ProductionWorkCenter) => {
    setDraft({
      code: row.code,
      nameRu: row.nameRu,
      nameUz: row.nameUz,
      capacityPerShift: row.capacityPerShift,
      costPerHour: row.costPerHour,
      isActive: row.isActive,
    });
    setWrong(null);
    setEditing(row.code);
  };

  const submit = async () => {
    const code = draft.code.trim().toUpperCase();
    if (!code) {
      setWrong(isUz ? 'Uchastka kodini yozing' : 'Напишите код участка');
      return;
    }
    if (!draft.nameRu.trim()) {
      setWrong(isUz ? 'Ruscha nomni yozing' : 'Напишите название по-русски');
      return;
    }
    const ok = await saveWorkCenter(
      {
        code,
        nameRu: draft.nameRu.trim(),
        nameUz: draft.nameUz.trim() || draft.nameRu.trim(),
        capacityPerShift: num(draft.capacityPerShift) || '0',
        costPerHour: num(draft.costPerHour) || '0',
        isActive: draft.isActive,
      },
      editing ? editing : undefined,
    );
    if (ok) {
      setEditing(null);
      setDraft(empty);
    }
  };

  const rows = workCenters.data ?? [];
  const noRate = rows.filter((r) => r.isActive && Number(r.costPerHour) === 0).length;

  return (
    <div className="flex flex-col gap-3">
      <div className={`${CARD} p-4 flex flex-col gap-3`}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">
              {isUz ? 'Sex uchastkalari' : 'Участки цеха'}
            </h3>
            <p className="text-[11px] text-zinc-500 mt-0.5 break-words">
              {isUz
                ? 'Uchastka — ish bajariladigan joy: etaplar unga bog‘lanadi, smena quvvati va soat stavkasi shu yerdan olinadi'
                : 'Участок — место, где делают работу: к нему привязывают этапы, отсюда берут сменную мощность и ставку часа'}
            </p>
          </div>
          {mayManage && (
            <button type="button" onClick={openNew} className={PRIMARY + ' inline-flex items-center gap-1 shrink-0'}>
              <Plus className="w-3.5 h-3.5" />
              {isUz ? 'Uchastka qo‘shish' : 'Добавить участок'}
            </button>
          )}
        </div>

        {/* Ставка часа нужна себестоимости. Нулевая — не ошибка данных, а
            незаполненный справочник, и сказать об этом надо здесь. */}
        {noRate > 0 && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400 break-words">
            {isUz
              ? `${noRate} uchastkada soat stavkasi 0: tannarxda faqat material hisoblanadi`
              : `У ${noRate} ${noRate === 1 ? 'участка' : 'участков'} ставка часа равна нулю: в себестоимости посчитаются только материалы`}
          </p>
        )}

        {workCenters.error && !workCenters.data ? (
          <p className="text-xs text-red-600 dark:text-red-400 break-words">
            {errorText(workCenters.error, isUz)}
          </p>
        ) : !workCenters.data ? (
          <p className="text-xs text-zinc-400">{isUz ? 'Yuklanmoqda…' : 'Загружаю…'}</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-zinc-500 break-words">
            {isUz ? 'Uchastkalar hali kiritilmagan' : 'Участки пока не заведены'}
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800/60">
            {rows.map((row) => (
              <div key={row.code} className="py-2 flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[11px] font-bold text-zinc-950 dark:text-zinc-50">
                      {row.code}
                    </span>
                    <span className="text-xs text-zinc-700 dark:text-zinc-200 break-words">
                      {refName(row, isUz)}
                    </span>
                    {!row.isActive && (
                      <span className="text-[10px] px-1.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 font-mono">
                        {isUz ? 'yopilgan' : 'закрыт'}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-0.5 break-words">
                    {isUz ? 'Smena quvvati' : 'Сменная мощность'}:{' '}
                    {Number(row.capacityPerShift) > 0
                      ? formatNumber(row.capacityPerShift)
                      : isUz
                      ? 'kiritilmagan'
                      : 'не указана'}
                    {' · '}
                    {isUz ? 'Soat stavkasi' : 'Ставка часа'}:{' '}
                    {Number(row.costPerHour) > 0
                      ? `${formatNumber(row.costPerHour)} ${isUz ? 'so‘m' : 'сум'}`
                      : isUz
                      ? 'kiritilmagan'
                      : 'не указана'}
                    {row.openStages > 0
                      ? ` · ${isUz ? 'yopilmagan etaplar' : 'незакрытых этапов'}: ${row.openStages}`
                      : ''}
                  </p>
                </div>
                {mayManage && (
                  <button type="button" onClick={() => openEdit(row)} className={GHOST + ' shrink-0'}>
                    {isUz ? 'O‘zgartirish' : 'Изменить'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {mayManage && editing !== null && (
        <div className={`${CARD} p-4 flex flex-col gap-3`}>
          <div>
            <h3 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">
              {editing
                ? `${isUz ? 'Uchastka' : 'Участок'} ${editing}`
                : isUz
                ? 'Yangi uchastka'
                : 'Новый участок'}
            </h3>
            <p className="text-[11px] text-zinc-500 mt-0.5 break-words">
              {isUz
                ? 'Kod — uchastkaning kaliti: texkartalarda va etaplarda shu kod ko‘rinadi, shuning uchun uni o‘zgartirmaydilar'
                : 'Код — ключ участка: он виден в техкартах и этапах, поэтому его не меняют'}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-500">{isUz ? 'Kod' : 'Код'}</span>
              <input
                type="text"
                value={draft.code}
                disabled={editing !== ''}
                onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                placeholder="PE-EXTR"
                aria-label={isUz ? 'Uchastka kodi' : 'Код участка'}
                className={INPUT + (editing !== '' ? ' opacity-60' : '')}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-500">
                {isUz ? 'Nomi (ruscha)' : 'Название по-русски'}
              </span>
              <input
                type="text"
                value={draft.nameRu}
                onChange={(e) => setDraft({ ...draft, nameRu: e.target.value })}
                aria-label={isUz ? 'Nomi ruscha' : 'Название по-русски'}
                className={INPUT}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-500">
                {isUz ? 'Nomi (o‘zbekcha)' : 'Название по-узбекски'}
              </span>
              <input
                type="text"
                value={draft.nameUz}
                onChange={(e) => setDraft({ ...draft, nameUz: e.target.value })}
                aria-label={isUz ? 'Nomi o‘zbekcha' : 'Название по-узбекски'}
                className={INPUT}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-500">
                {isUz ? 'Smena quvvati, dona' : 'Сменная мощность, шт'}
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={draft.capacityPerShift}
                onChange={(e) => setDraft({ ...draft, capacityPerShift: e.target.value })}
                aria-label={isUz ? 'Smena quvvati' : 'Сменная мощность'}
                className={INPUT}
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-[11px] text-zinc-500">
                {isUz ? 'Soat stavkasi, so‘m' : 'Ставка часа, сум'}
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={draft.costPerHour}
                onChange={(e) => setDraft({ ...draft, costPerHour: e.target.value })}
                aria-label={isUz ? 'Soat stavkasi' : 'Ставка часа'}
                className={INPUT}
              />
              <span className="text-[11px] text-zinc-500 break-words">
                {isUz
                  ? 'Shu stavkadan tannarxdagi ish hisoblanadi: etapda ishlangan daqiqalar shunga ko‘paytiriladi'
                  : 'Из этой ставки считают работу в себестоимости: отработанные на этапе минуты умножают на неё'}
              </span>
            </label>
          </div>

          {editing !== '' && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!draft.isActive}
                onChange={(e) => setDraft({ ...draft, isActive: !e.target.checked })}
                aria-label={isUz ? 'Uchastkani yopish' : 'Закрыть участок'}
                className="w-3.5 h-3.5 accent-zinc-900 dark:accent-zinc-100 cursor-pointer"
              />
              <span className="text-xs text-zinc-700 dark:text-zinc-200 break-words">
                {isUz
                  ? 'Uchastka yopilgan: yangi etaplarga tanlanmaydi, o‘tgan buyurtmalarda qoladi'
                  : 'Участок закрыт: в новые этапы его не выберут, в прошлых заказах он останется'}
              </span>
            </label>
          )}

          {(wrong || saveError) && (
            <p className="text-xs text-red-600 dark:text-red-400 break-words">
              {wrong ?? errorText(saveError!, isUz)}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={saving}
              className={PRIMARY + ' inline-flex items-center gap-1'}
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {isUz ? 'Saqlash' : 'Сохранить'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setWrong(null);
              }}
              disabled={saving}
              className={GHOST}
            >
              {isUz ? 'Bekor qilish' : 'Отмена'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
