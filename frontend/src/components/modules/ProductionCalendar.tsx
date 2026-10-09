/**
 * Производственный календарь (ТЗ 4.1, Э7): смены, рабочая неделя, выходные.
 *
 * Экран отвечает на три вопроса цеха: по каким дням завод работает, в какие
 * смены и что с ближайшими днями — где праздник, а где вышли в субботу.
 * Отсюда же берутся сроки заказов в рабочих днях и загрузка участков.
 */

import React from 'react';
import { Loader2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { errorText } from '../../context/DashboardContext';
import { useProduction } from '../../context/ProductionContext';
import { minutesText } from './ProductionControl';
import { refName } from '../../lib/formatters';

const CARD =
  'rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xs';
const BTN =
  'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-40 ' +
  'disabled:cursor-not-allowed cursor-pointer';
const PRIMARY = `${BTN} bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900`;
const GHOST =
  `${BTN} border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 ` +
  'hover:bg-zinc-100 dark:hover:bg-zinc-800';

const WEEK = [
  { iso: 1, ru: 'Пн', uz: 'Du' },
  { iso: 2, ru: 'Вт', uz: 'Se' },
  { iso: 3, ru: 'Ср', uz: 'Cho' },
  { iso: 4, ru: 'Чт', uz: 'Pa' },
  { iso: 5, ru: 'Пт', uz: 'Ju' },
  { iso: 6, ru: 'Сб', uz: 'Sha' },
  { iso: 7, ru: 'Вс', uz: 'Ya' },
];

const dayText = (day: string, isUz: boolean) =>
  new Date(`${day}T00:00:00`).toLocaleDateString(isUz ? 'uz-UZ' : 'ru-RU', {
    day: '2-digit',
    month: 'short',
    weekday: 'short',
  });

export const ProductionCalendar: React.FC = () => {
  const { locale } = useApp();
  const { can } = useAuth();
  const isUz = locale === 'uz';
  const mayManage = can('production.manage');
  const {
    calendar,
    wantCalendar,
    setWorkWeek,
    setCalendarDay,
    clearCalendarDay,
    saveShift,
    saving,
    saveError,
  } = useProduction();

  React.useEffect(() => {
    wantCalendar();
  }, [wantCalendar]);

  const [shiftForm, setShiftForm] = React.useState<null | { uid?: string }>(null);
  const [code, setCode] = React.useState('');
  const [nameRu, setNameRu] = React.useState('');
  const [nameUz, setNameUz] = React.useState('');
  const [startsAt, setStartsAt] = React.useState('08:00');
  const [endsAt, setEndsAt] = React.useState('16:00');
  const [dayForm, setDayForm] = React.useState<null | { day: string; isWorking: boolean }>(null);
  const [why, setWhy] = React.useState('');

  const data = calendar.data;

  const openShift = (uid?: string) => {
    const s = data?.shifts.find((x) => x.uid === uid);
    setShiftForm({ uid });
    setCode(s?.code ?? '');
    setNameRu(s?.nameRu ?? '');
    setNameUz(s?.nameUz ?? '');
    setStartsAt(s?.startsAt ?? '08:00');
    setEndsAt(s?.endsAt ?? '16:00');
  };

  const submitShift = async () => {
    const done = await saveShift(
      { code, nameRu, nameUz: nameUz || nameRu, startsAt, endsAt, isActive: true },
      shiftForm?.uid,
    );
    if (done) setShiftForm(null);
  };

  const submitDay = async () => {
    if (!dayForm) return;
    const done = await setCalendarDay(dayForm.day, dayForm.isWorking, why.trim() || undefined);
    if (done) {
      setDayForm(null);
      setWhy('');
    }
  };

  if (calendar.isLoading && !data) {
    return (
      <div className={`${CARD} p-3`}>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
          <Loader2 size={11} className="animate-spin" />
          {isUz ? 'Kalendar yuklanmoqda' : 'Загружаем календарь'}
        </span>
      </div>
    );
  }

  if (!data) {
    const trouble = saveError ?? calendar.error;
    return (
      <div className={`${CARD} p-3`}>
        <p className="text-[11px] text-red-600 dark:text-red-400">
          {trouble ? errorText(trouble, isUz) : isUz ? 'Kalendar topilmadi' : 'Календарь не отдался'}
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
      <div className={`lg:col-span-5 ${CARD} p-3 flex flex-col gap-3`}>
        <h3 className="text-xs font-semibold text-zinc-950 dark:text-zinc-50">
          {isUz ? 'Ish haftasi va smenalar' : 'Рабочая неделя и смены'}
        </h3>
        <p className="text-[10px] text-zinc-500">
          {isUz
            ? 'Zavod qaysi kunlarda va qaysi smenalarda ishlaydi. Shundan buyurtma muddati ish kunlarida va uchastka yuklamasi foizda hisoblanadi.'
            : 'По каким дням и в какие смены работает завод. Отсюда считаются срок заказа в рабочих днях и загрузка участка в процентах.'}
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          {WEEK.map((d) => {
            const on = data.workDays.includes(d.iso);
            return (
              <button
                key={d.iso}
                type="button"
                disabled={!mayManage || saving}
                aria-pressed={on}
                aria-label={isUz ? d.uz : d.ru}
                onClick={() =>
                  void setWorkWeek(
                    on ? data.workDays.filter((x) => x !== d.iso) : [...data.workDays, d.iso],
                  )
                }
                className={
                  on
                    ? `${BTN} bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950`
                    : `${BTN} border border-zinc-200 dark:border-zinc-700 text-zinc-400`
                }
              >
                {isUz ? d.uz : d.ru}
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-1.5">
          {data.shifts.map((s) => (
            <div
              key={s.uid}
              className="flex items-center justify-between gap-2 border-t border-zinc-100 dark:border-zinc-800/60 pt-1.5 text-[11px]"
            >
              <span className={s.isActive ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-400'}>
                {refName(s, isUz)}
                {!s.isActive && (isUz ? ' · yopiq' : ' · закрыта')}
              </span>
              <span className="font-mono tabular-nums text-zinc-500">
                {s.startsAt}–{s.endsAt} · {minutesText(s.durationMin, isUz)}
              </span>
              {mayManage && (
                <button type="button" onClick={() => openShift(s.uid)} className={GHOST}>
                  {isUz ? 'O‘zgartirish' : 'Изменить'}
                </button>
              )}
            </div>
          ))}
          {data.shifts.length === 0 && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              {isUz
                ? 'Smenalar kiritilmagan: muddatlarni smenalarga taqsimlab bo‘lmaydi va yuklama foizi hisoblanmaydi.'
                : 'Смены не заведены: разложить сроки по сменам и посчитать загрузку в процентах не из чего.'}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-zinc-500">
            {isUz
              ? `Ish kuni: ${minutesText(data.dayMinutes, isUz)}`
              : `Рабочий день: ${minutesText(data.dayMinutes, isUz)}`}
          </span>
          {mayManage && !shiftForm && (
            <button type="button" onClick={() => openShift()} className={PRIMARY}>
              {isUz ? 'Smena qo‘shish' : 'Добавить смену'}
            </button>
          )}
        </div>

        {shiftForm && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={isUz ? 'Kod, masalan S3' : 'Код, например S3'}
              aria-label={isUz ? 'Smena kodi' : 'Код смены'}
              className="h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs"
            />
            <input
              value={nameRu}
              onChange={(e) => setNameRu(e.target.value)}
              placeholder={isUz ? 'Nomi (ruscha)' : 'Название по-русски'}
              aria-label={isUz ? 'Nomi' : 'Название'}
              className="h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs"
            />
            <input
              value={nameUz}
              onChange={(e) => setNameUz(e.target.value)}
              placeholder={isUz ? 'Nomi (o‘zbekcha)' : 'Название по-узбекски'}
              aria-label={isUz ? 'O‘zbekcha nomi' : 'Название по-узбекски'}
              className="h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs"
            />
            <div className="flex items-center gap-2">
              <input
                type="time"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                aria-label={isUz ? 'Boshlanishi' : 'Начало'}
                className="h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs"
              />
              <input
                type="time"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                aria-label={isUz ? 'Tugashi' : 'Конец'}
                className="h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs"
              />
            </div>
            {saveError && (
              <span className="text-[10px] text-red-600 dark:text-red-400">
                {errorText(saveError, isUz)}
              </span>
            )}
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void submitShift()} disabled={saving} className={PRIMARY}>
                <span className="inline-flex items-center gap-1.5">
                  {saving && <Loader2 size={11} className="animate-spin" />}
                  {isUz ? 'Saqlash' : 'Сохранить'}
                </span>
              </button>
              <button type="button" onClick={() => setShiftForm(null)} className={GHOST}>
                {isUz ? 'Qaytish' : 'Назад'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className={`lg:col-span-7 ${CARD} p-3 flex flex-col gap-2`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-zinc-950 dark:text-zinc-50">
            {isUz ? 'Yaqin kunlar' : 'Ближайшие дни'}
          </h3>
          <span className="text-[10px] text-zinc-500">
            {isUz
              ? `${data.workingDays} ish kuni · kuniga ${minutesText(data.dayMinutes, isUz)}`
              : `${data.workingDays} рабочих дней · по ${minutesText(data.dayMinutes, isUz)}`}
          </span>
        </div>

        <p className="text-[10px] text-zinc-500">
          {isUz
            ? 'Oddiy kunlar ish haftasidan olinadi. Bayram yoki ishchi shanba — istisno: uni shu yerda qo‘lda belgilaysiz, sababi bilan.'
            : 'Обычные дни берутся из рабочей недели. Праздник или рабочая суббота — исключение: его отмечают здесь руками и с причиной.'}
        </p>

        {dayForm && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2">
            <span className="text-[10px] text-zinc-600 dark:text-zinc-400">
              {dayForm.isWorking
                ? isUz
                  ? `${dayText(dayForm.day, isUz)} ishchi kun bo‘ladi.`
                  : `${dayText(dayForm.day, isUz)} станет рабочим днём.`
                : isUz
                  ? `${dayText(dayForm.day, isUz)} dam olish kuni bo‘ladi. Nega — cex ko‘radi.`
                  : `${dayText(dayForm.day, isUz)} станет выходным. Причину увидит цех.`}
            </span>
            <input
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              autoFocus
              placeholder={isUz ? 'Sababi, masalan: bayram' : 'Причина, например: праздник'}
              aria-label={isUz ? 'Sababi' : 'Причина'}
              className="h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs"
            />
            {saveError && (
              <span className="text-[10px] text-red-600 dark:text-red-400">
                {errorText(saveError, isUz)}
              </span>
            )}
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void submitDay()} disabled={saving} className={PRIMARY}>
                <span className="inline-flex items-center gap-1.5">
                  {saving && <Loader2 size={11} className="animate-spin" />}
                  {isUz ? 'Belgilash' : 'Отметить'}
                </span>
              </button>
              <button type="button" onClick={() => setDayForm(null)} className={GHOST}>
                {isUz ? 'Qaytish' : 'Назад'}
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-col max-h-[420px] overflow-y-auto">
          {data.days.map((d) => (
            <div
              key={d.day}
              className="flex items-center justify-between gap-2 border-t border-zinc-100 dark:border-zinc-800/60 py-1.5 text-[11px]"
            >
              <span
                className={
                  d.isWorking ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-400 dark:text-zinc-500'
                }
              >
                {dayText(d.day, isUz)}
              </span>
              <span className="flex-1 truncate text-[10px] text-zinc-500">
                {d.isException ? d.comment ?? (isUz ? 'istisno' : 'исключение') : ''}
              </span>
              <span className="shrink-0 text-[10px] text-zinc-500">
                {d.isWorking ? (isUz ? 'ish kuni' : 'рабочий') : isUz ? 'dam olish' : 'выходной'}
              </span>
              {mayManage &&
                (d.isException ? (
                  <button
                    type="button"
                    onClick={() => void clearCalendarDay(d.day)}
                    disabled={saving}
                    className={GHOST}
                  >
                    {isUz ? 'Haftaga qaytarish' : 'К неделе'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setDayForm({ day: d.day, isWorking: !d.isWorking });
                      setWhy('');
                    }}
                    disabled={saving}
                    className={GHOST}
                  >
                    {d.isWorking
                      ? isUz
                        ? 'Dam olish'
                        : 'Выходной'
                      : isUz
                        ? 'Ishchi kun'
                        : 'Рабочий'}
                  </button>
                ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
