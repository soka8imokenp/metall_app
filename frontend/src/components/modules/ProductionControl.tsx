/**
 * Отклонения производства (ТЗ 4.1, Э7).
 *
 * Журнал копился с третьего захода: пауза этапа клала строку простоя, расход
 * сверх плана и брак ложились своими строками. Смотреть на него было негде —
 * в сводке он был свёрнут до итогов по причинам. Здесь он читается строками,
 * и отсюда же записывают простой участка, который случился без заказа.
 */

import React from 'react';
import { Loader2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { errorText } from '../../context/DashboardContext';
import { useProduction } from '../../context/ProductionContext';
import { CustomSelect } from '../common/CustomSelect';
import { ProductionDeviationKind } from '../../types/api';
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

const KIND: Record<ProductionDeviationKind, { ru: string; uz: string }> = {
  downtime: { ru: 'Простой', uz: 'To‘xtab turish' },
  overuse: { ru: 'Перерасход', uz: 'Ortiqcha sarf' },
  defect: { ru: 'Брак', uz: 'Brak' },
  delay: { ru: 'Срыв срока', uz: 'Muddat buzilishi' },
};

/** Минуты человеку: «3 ч 25 мин», а не «205». */
export const minutesText = (min: number, isUz: boolean) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} ${isUz ? 'daq' : 'мин'}`;
  return `${h} ${isUz ? 'soat' : 'ч'}${m > 0 ? ` ${m} ${isUz ? 'daq' : 'мин'}` : ''}`;
};

const stamp = (iso: string, isUz: boolean) =>
  new Date(iso).toLocaleString(isUz ? 'uz-UZ' : 'ru-RU', {
    timeZone: 'Asia/Tashkent',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

export const ProductionControl: React.FC = () => {
  const { locale } = useApp();
  const { can } = useAuth();
  const isUz = locale === 'uz';
  const mayManage = can('production.manage');
  const {
    deviations,
    deviationKind,
    setDeviationKind,
    wantDeviations,
    registerDowntime,
    options,
    wantOptions,
    saving,
    saveError,
  } = useProduction();

  React.useEffect(() => {
    wantDeviations();
    if (mayManage) wantOptions();
  }, [wantDeviations, wantOptions, mayManage]);

  const [adding, setAdding] = React.useState(false);
  const [center, setCenter] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [minutes, setMinutes] = React.useState('');
  const [comment, setComment] = React.useState('');
  const [wrong, setWrong] = React.useState<string | null>(null);

  const centers = options.data?.workCenters ?? [];
  const reasons = options.data?.downtimeReasons ?? [];

  const start = () => {
    setAdding(true);
    setWrong(null);
    setMinutes('');
    setComment('');
    setCenter(centers[0]?.code ?? '');
    setReason(reasons[0]?.uid ?? '');
  };

  const confirm = async () => {
    const value = Number(minutes.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      setWrong(isUz ? 'Necha daqiqa turdi — noldan katta son' : 'Сколько простояли — число минут больше нуля');
      return;
    }
    if (!center || !reason) {
      setWrong(isUz ? 'Uchastka va sabab kerak' : 'Нужны участок и причина');
      return;
    }
    const done = await registerDowntime({
      workCenterCode: center,
      reasonUid: reason,
      minutes: Math.round(value),
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    });
    if (done) setAdding(false);
  };

  const rows = deviations.data?.rows ?? [];
  const totals = deviations.data?.totals ?? [];

  const filters: { key: ProductionDeviationKind | 'all'; ru: string; uz: string }[] = [
    { key: 'all', ru: 'Все', uz: 'Hammasi' },
    { key: 'downtime', ...KIND.downtime },
    { key: 'overuse', ...KIND.overuse },
    { key: 'defect', ...KIND.defect },
    { key: 'delay', ...KIND.delay },
  ];

  return (
    <div className={`${CARD} p-3 flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-zinc-950 dark:text-zinc-50">
          {isUz ? 'Chetlanishlar jurnali' : 'Журнал отклонений'}
        </h3>
        {mayManage && !adding && (
          <button type="button" onClick={start} className={PRIMARY}>
            {isUz ? 'To‘xtab turishni yozish' : 'Зафиксировать простой'}
          </button>
        )}
      </div>

      <p className="text-[10px] text-zinc-500">
        {isUz
          ? 'Bu yerda rejadan chetga chiqqan hamma narsa: uchastka to‘xtab turgani, material rejadan ortiq sarflangani va brak. To‘xtab turish bosqich pauzasidan o‘zi tushadi; buyurtmasiz turgan uchastkani qo‘lda yozasiz.'
          : 'Здесь всё, что пошло не по плану: простои участков, расход материала сверх нормы и брак. Простой этапа попадает сюда сам — из паузы; участок, стоявший без заказа, записывают руками.'}
      </p>

      {/* Итоги по видам: сколько времени и сколько случаев за период. */}
      {totals.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {totals.map((t) => (
            <div
              key={t.kind}
              className="rounded-lg border border-zinc-200 dark:border-zinc-800 px-2 py-1.5"
            >
              <div className="text-[10px] text-zinc-500">
                {isUz ? KIND[t.kind].uz : KIND[t.kind].ru}
              </div>
              <div className="font-mono text-[11px] tabular-nums text-zinc-950 dark:text-zinc-50">
                {t.minutes > 0 ? minutesText(t.minutes, isUz) : `${t.events} ${isUz ? 'ta' : 'шт'}`}
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2">
          <span className="text-[10px] text-zinc-600 dark:text-zinc-400">
            {isUz
              ? 'Qaysi uchastka, qancha turdi va nega? Yozuv jurnalga tushadi va uchastka yuklamasida ko‘rinadi.'
              : 'Какой участок, сколько стоял и почему? Запись ляжет в журнал и будет видна в загрузке участка.'}
          </span>
          <CustomSelect
            value={center}
            onChange={setCenter}
            portal
            options={centers.map((c) => ({
              value: c.code,
              label: `${c.code} · ${refName(c, isUz)}`,
            }))}
            ariaLabel={isUz ? 'Uchastka' : 'Участок'}
          />
          <CustomSelect
            value={reason}
            onChange={setReason}
            portal
            options={reasons.map((r) => ({ value: r.uid, label: refName(r, isUz) }))}
            ariaLabel={isUz ? 'Sabab' : 'Причина'}
          />
          <input
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            inputMode="numeric"
            autoFocus
            placeholder={isUz ? 'Necha daqiqa' : 'Сколько минут'}
            aria-label={isUz ? 'Davomiyligi' : 'Длительность'}
            className="w-full h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs text-zinc-950 dark:text-zinc-50"
          />
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={isUz ? 'Izoh (ixtiyoriy)' : 'Примечание (необязательно)'}
            aria-label={isUz ? 'Izoh' : 'Примечание'}
            className="w-full h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs text-zinc-950 dark:text-zinc-50"
          />
          {(wrong || saveError) && (
            <span className="text-[10px] text-red-600 dark:text-red-400">
              {wrong ?? (saveError ? errorText(saveError, isUz) : '')}
            </span>
          )}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void confirm()} disabled={saving} className={PRIMARY}>
              <span className="inline-flex items-center gap-1.5">
                {saving && <Loader2 size={11} className="animate-spin" />}
                {isUz ? 'Yozib qo‘yish' : 'Записать'}
              </span>
            </button>
            <button type="button" onClick={() => setAdding(false)} className={GHOST}>
              {isUz ? 'Qaytish' : 'Назад'}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setDeviationKind(f.key)}
            aria-pressed={deviationKind === f.key}
            className={
              deviationKind === f.key
                ? `${BTN} bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950`
                : `${BTN} text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200`
            }
          >
            {isUz ? f.uz : f.ru}
          </button>
        ))}
      </div>

      {deviations.isLoading && rows.length === 0 ? (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
          <Loader2 size={11} className="animate-spin" />
          {isUz ? 'Jurnal yuklanmoqda' : 'Загружаем журнал'}
        </span>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-zinc-500 py-6 text-center">
          {isUz ? 'Bu davrda chetlanish yo‘q' : 'За этот период отклонений нет'}
        </p>
      ) : (
        <div className="flex flex-col">
          {rows.map((r, i) => (
            <div
              key={`${r.occurredAt}-${i}`}
              className="flex flex-col gap-0.5 border-t border-zinc-100 dark:border-zinc-800/60 py-1.5 text-[11px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={
                    r.kind === 'defect'
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-zinc-900 dark:text-zinc-100'
                  }
                >
                  {isUz ? KIND[r.kind].uz : KIND[r.kind].ru}
                  {r.workCenterCode ? ` · ${r.workCenterCode}` : ''}
                  {r.orderNumber ? ` · ${r.orderNumber}` : ''}
                </span>
                <span className="shrink-0 font-mono tabular-nums text-zinc-900 dark:text-zinc-100">
                  {r.durationMin > 0
                    ? minutesText(r.durationMin, isUz)
                    : Number(r.amount) > 0
                      ? Number(r.amount).toLocaleString('ru-RU', { maximumFractionDigits: 4 })
                      : ''}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                <span className="truncate">
                  {[
                    isUz ? r.reasonUz : r.reasonRu,
                    isUz ? r.stageNameUz : r.stageNameRu,
                    r.comment,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className="shrink-0 font-mono">{stamp(r.occurredAt, isUz)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
