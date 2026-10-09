/**
 * Заведение и правка заказа цеха, и его путь по статусам (ТЗ 4.1).
 *
 * Отдельным файлом, потому что `ProductionView` — читающий экран на 900 строк,
 * и форма записи в нём затерялась бы между сводкой и журналом отметок.
 *
 * Два правила, которые видно в коде:
 *
 * - список следующих статусов берётся из ответа сервера (`nextStatuses`), а не
 *   из своей таблицы переходов. Своя копия однажды разойдётся с проверкой, и
 *   человек нажмёт кнопку, на которую ему ответят отказом;
 * - у остановки и отмены причина спрашивается до нажатия, а не после отказа
 *   сервера. Это те два перехода, про которые через месяц спросят «почему».
 */

import React from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';
import { useProduction } from '../../context/ProductionContext';
import { errorText } from '../../context/DashboardContext';
import { CustomDatePicker } from '../common/CustomDatePicker';
import { CustomSelect, CustomSelectOption } from '../common/CustomSelect';
import { ProductionOrderDetail, ProductionStatus } from '../../types/api';
import { formatUnit, refName } from '../../lib/formatters';

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
/** Отмена выделена цветом: из неё возврата нет, заказ становится конечным. */
const BTN_DANGER =
  BTN_BASE +
  ' border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-300 ' +
  'hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer';

const QTY_RE = /^\d{1,13}([.,]\d{1,6})?$/;

/** Подпись — `span`: внутри календаря и списка свои `button`, и `label` слал бы им второй клик. */
const FieldRow: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children,
}) => (
  <div className="flex flex-col gap-1">
    <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</span>
    {children}
    {hint && <span className="text-[10px] text-zinc-400">{hint}</span>}
  </div>
);

const ErrorLine: React.FC<{ text: string }> = ({ text }) => (
  <div className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/30 text-[11px] text-red-700 dark:text-red-300">
    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
    <span className="min-w-0">{text}</span>
  </div>
);

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------

/**
 * Форма заказа. `order` пустой — заведение, заполненный — правка черновика.
 */
export const ProductionOrderForm: React.FC<{
  order: ProductionOrderDetail | null;
  isUz: boolean;
  onDone: (uid: string) => void;
  onCancel: () => void;
}> = ({ order, isUz, onDone, onCancel }) => {
  const { options, wantOptions, saveOrder, editOrder, saving, saveError, clearSaveError } =
    useProduction();

  React.useEffect(() => {
    wantOptions();
  }, [wantOptions]);

  const [itemCode, setItemCode] = React.useState(order?.itemCode ?? '');
  const [qty, setQty] = React.useState(order ? String(Number(order.qtyPlanned)) : '');
  const [dueDate, setDueDate] = React.useState(order?.dueDate ?? '');
  const [priority, setPriority] = React.useState(String(order?.priority ?? 0));
  const [responsibleUid, setResponsibleUid] = React.useState(order?.responsibleUid ?? '');
  const [salesOrderUid, setSalesOrderUid] = React.useState(order?.salesOrderUid ?? '');
  const [comment, setComment] = React.useState(order?.comment ?? '');
  const [wrong, setWrong] = React.useState<string | null>(null);

  const items = options.data?.items ?? [];
  const picked = items.find((i) => i.code === itemCode) ?? null;

  const itemOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'Mahsulotni tanlang' : 'Выберите продукцию' },
    ...items.map((i) => ({
      value: i.code,
      label: refName(i, isUz),
      sublabel: `${i.code} • ${formatUnit(i.unit, isUz ? 'uz' : 'ru')}`,
    })),
  ];

  const responsibleOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'Ko‘rsatilmagan' : 'Не указан' },
    ...(options.data?.responsibles ?? []).map((u) => ({ value: u.uid, label: u.fullName })),
  ];

  const salesOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'Bog‘lanmagan' : 'Не привязан' },
    ...(options.data?.salesOrders ?? []).map((o) => ({
      value: o.uid,
      label: o.number,
      sublabel: o.partnerNameRu,
    })),
  ];

  /** Проверяем до отправки то, что можно проверить здесь: иначе человек ждёт отказа сервера. */
  const check = (): string | null => {
    if (!itemCode) return isUz ? 'Mahsulotni tanlang' : 'Выберите, что производим';
    if (!QTY_RE.test(qty.trim())) {
      return isUz
        ? 'Miqdor: son, masalan 12,5'
        : 'Количество: число, например 12,5';
    }
    if (Number(qty.replace(',', '.')) <= 0) {
      return isUz ? 'Miqdor noldan katta bo‘lishi kerak' : 'Количество должно быть больше нуля';
    }
    if (picked?.trackSerials) {
      const value = Number(qty.replace(',', '.'));
      if (Math.abs(value - Math.round(value)) > 1e-9) {
        return isUz
          ? `${picked.code} dona bilan hisoblanadi: butun son kiriting`
          : `${picked.code} считают штуками: укажите целое число`;
      }
    }
    if (!dueDate) return isUz ? 'Topshirish muddatini ko‘rsating' : 'Укажите срок сдачи';
    const p = Number(priority);
    if (!Number.isInteger(p) || p < 0 || p > 99) {
      return isUz ? 'Ustuvorlik: 0 dan 99 gacha' : 'Приоритет: целое от 0 до 99';
    }
    return null;
  };

  const submit = async () => {
    const bad = check();
    setWrong(bad);
    if (bad) return;
    clearSaveError();

    const body = {
      itemCode,
      qtyPlanned: qty.trim().replace(',', '.'),
      dueDate,
      priority: Number(priority),
      responsibleUid,
      salesOrderUid,
      comment: comment.trim(),
    };
    const done = order
      ? await editOrder(order.uid, body)
      : await saveOrder({
          ...body,
          // Заведение пустые поля не присылает вовсе: там это «не указано», а
          // не «снять указанное», и сервер различает эти два случая.
          ...(responsibleUid ? {} : { responsibleUid: undefined }),
          ...(salesOrderUid ? {} : { salesOrderUid: undefined }),
          ...(body.comment ? {} : { comment: undefined }),
        });
    if (done) onDone(done.uid);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <div className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider">
            {isUz ? 'Ishlab chiqarish' : 'Производство'}
          </div>
          <div className="text-sm font-bold text-zinc-950 dark:text-zinc-50">
            {order
              ? `${isUz ? 'Qoralamani tahrirlash' : 'Правка черновика'} ${order.number}`
              : isUz
                ? 'Yangi sex buyurtmasi'
                : 'Новый заказ цеха'}
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

      {/* Что произойдёт после нажатия, сказано до нажатия. */}
      <p className="text-[11px] text-zinc-500 border-s-2 border-zinc-200 dark:border-zinc-700 ps-2 shrink-0">
        {isUz
          ? 'Buyurtma qoralama bo‘lib tug‘iladi: uni sex hali ko‘rmaydi. Rejaga qo‘yilgandan keyin ishga tushadi.'
          : 'Заказ рождается черновиком: участок его ещё не видит. Запланируете — он попадёт в работу цеха.'}
      </p>

      <div className="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-2.5">
        {options.error && !options.data && <ErrorLine text={errorText(options.error, isUz)} />}

        <FieldRow
          label={isUz ? 'Nima ishlab chiqaramiz' : 'Что производим'}
          hint={
            picked
              ? `${picked.code} • ${formatUnit(picked.unit, isUz ? 'uz' : 'ru')}`
              : isUz
                ? 'Ro‘yxatda zavod ishlab chiqaradigan mahsulot bor'
                : 'В списке только то, что завод производит сам'
          }
        >
          <CustomSelect
            value={itemCode}
            onChange={setItemCode}
            options={itemOptions}
            portal
            ariaLabel={isUz ? 'Mahsulot' : 'Продукция'}
          />
        </FieldRow>

        <FieldRow
          label={isUz ? 'Miqdor' : 'Количество'}
          hint={
            isUz
              ? 'Masalan 12,5 — o‘n ikki yarim'
              : 'Например 12,5 — двенадцать с половиной'
          }
        >
          <input
            type="text"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="12,5"
            aria-label={isUz ? 'Miqdor' : 'Количество'}
            className={FIELD}
          />
        </FieldRow>

        <FieldRow
          label={isUz ? 'Topshirish muddati' : 'Срок сдачи'}
          hint={
            isUz
              ? 'Shu sana bo‘yicha bot kechikish haqida eslatadi'
              : 'По этой дате бот напомнит о просрочке'
          }
        >
          <CustomDatePicker
            value={dueDate}
            onChange={setDueDate}
            minDate={order ? undefined : today()}
            portal
            ariaLabel={isUz ? 'Muddat' : 'Срок'}
          />
        </FieldRow>

        <div className="grid grid-cols-2 gap-2">
          <FieldRow label={isUz ? 'Ustuvorlik' : 'Приоритет'}>
            <input
              type="text"
              inputMode="numeric"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              aria-label={isUz ? 'Ustuvorlik' : 'Приоритет'}
              className={FIELD}
            />
          </FieldRow>
          <FieldRow label={isUz ? 'Mas’ul' : 'Ответственный'}>
            <CustomSelect
              value={responsibleUid}
              onChange={setResponsibleUid}
              options={responsibleOptions}
              portal
              ariaLabel={isUz ? 'Mas’ul' : 'Ответственный'}
            />
          </FieldRow>
        </div>

        <FieldRow
          label={isUz ? 'Savdo buyurtmasi' : 'Заказ продажи'}
          hint={
            isUz
              ? 'Mijoz uchun ishlab chiqarilsa — bog‘lab qo‘ying'
              : 'Производим под клиента — привяжите, и связь будет видна в карточке'
          }
        >
          <CustomSelect
            value={salesOrderUid}
            onChange={setSalesOrderUid}
            options={salesOptions}
            portal
            ariaLabel={isUz ? 'Savdo buyurtmasi' : 'Заказ продажи'}
          />
        </FieldRow>

        <FieldRow label={isUz ? 'Izoh' : 'Примечание'}>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            maxLength={500}
            aria-label={isUz ? 'Izoh' : 'Примечание'}
            className={FIELD.replace('h-8', 'h-auto py-1.5')}
          />
        </FieldRow>

        {wrong && <ErrorLine text={wrong} />}
        {saveError && <ErrorLine text={errorText(saveError, isUz)} />}
      </div>

      <div className="shrink-0 pt-2 border-t border-zinc-100 dark:border-zinc-800/60 flex items-center gap-2">
        <button type="button" onClick={submit} disabled={saving} className={BTN_PRIMARY}>
          <span className="inline-flex items-center gap-1.5">
            {saving && <Loader2 size={12} className="animate-spin" />}
            {order
              ? isUz
                ? 'Saqlash'
                : 'Сохранить'
              : isUz
                ? 'Qoralama qilib yozish'
                : 'Завести черновиком'}
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

/** Подпись кнопки — глагол: жмут действие, а не название состояния. */
const ACTION: Record<ProductionStatus, { ru: string; uz: string }> = {
  draft: { ru: 'В черновик', uz: 'Qoralamaga' },
  planned: { ru: 'Запланировать', uz: 'Rejaga qo‘yish' },
  in_progress: { ru: 'Запустить', uz: 'Ishga tushirish' },
  paused: { ru: 'Приостановить', uz: 'To‘xtatish' },
  produced: { ru: 'Выпустить', uz: 'Chiqarish' },
  closed: { ru: 'Закрыть', uz: 'Yopish' },
  cancelled: { ru: 'Отменить', uz: 'Bekor qilish' },
};

/** Что случится после нажатия. Пишем до нажатия, а не в ответе об ошибке. */
const WHY: Record<ProductionStatus, { ru: string; uz: string }> = {
  draft: { ru: '', uz: '' },
  planned: {
    ru: 'Заказ встанет в план цеха, и участок его увидит. После этого править его нельзя.',
    uz: 'Buyurtma sex rejasiga tushadi va uchastka uni ko‘radi. Keyin tahrirlanmaydi.',
  },
  in_progress: {
    ru: 'Отметим время запуска. С него считается фактическая длительность работы. Возврат с паузы время запуска не переписывает.',
    uz: 'Boshlanish vaqti yozib olinadi: fakt davomiylik shundan hisoblanadi. To‘xtashdan qaytish bu vaqtni o‘zgartirmaydi.',
  },
  paused: {
    ru: 'Работа встанет. Причина попадёт в журнал — из неё потом растёт учёт простоев.',
    uz: 'Ish to‘xtaydi. Sabab jurnalga tushadi — to‘xtashlar hisobi shundan o‘sadi.',
  },
  produced: {
    ru: 'Заказ считается сделанным. Незавершённые этапы сервер не пропустит.',
    uz: 'Buyurtma bajarilgan hisoblanadi. Yakunlanmagan bosqichlarni server o‘tkazmaydi.',
  },
  closed: {
    ru: 'Заказ уходит в историю: по нему больше ничего не ждут.',
    uz: 'Buyurtma tarixga o‘tadi: undan boshqa hech narsa kutilmaydi.',
  },
  cancelled: {
    ru: 'Заказ снимается совсем, и обратно его не вернуть. Нужна причина.',
    uz: 'Buyurtma butunlay olinadi va qaytarilmaydi. Sabab kerak.',
  },
};

/** Переходы, на которые форма спрашивает причину заранее. */
const NEEDS_REASON: ProductionStatus[] = ['paused', 'cancelled'];

/**
 * С паузы заказ не «запускают», а продолжают.
 *
 * Статус один и тот же (`in_progress`), а действие для человека разное: запуск
 * бывает один раз, возвращаются к работе сколько угодно. Мастеру, который
 * второй раз видит «Запустить», непонятно, не начнётся ли отсчёт заново.
 */
const RESUME = { ru: 'Продолжить', uz: 'Davom ettirish' };

const actionLabel = (next: ProductionStatus, from: ProductionStatus, isUz: boolean): string => {
  if (next === 'in_progress' && from === 'paused') return isUz ? RESUME.uz : RESUME.ru;
  return isUz ? ACTION[next].uz : ACTION[next].ru;
};

export const ProductionOrderActions: React.FC<{
  order: ProductionOrderDetail;
  isUz: boolean;
  onEdit: () => void;
}> = ({ order, isUz, onEdit }) => {
  const { changeStatus, saving, saveError, clearSaveError, lastSaved } = useProduction();
  const [pending, setPending] = React.useState<ProductionStatus | null>(null);
  const [reason, setReason] = React.useState('');
  const [wrong, setWrong] = React.useState<string | null>(null);

  // Карточку могли переключить на другой заказ — незаконченное подтверждение
  // чужого перехода оставлять нельзя.
  React.useEffect(() => {
    setPending(null);
    setReason('');
    setWrong(null);
  }, [order.uid]);

  const press = (next: ProductionStatus) => {
    clearSaveError();
    setWrong(null);
    setPending(next);
    setReason('');
    if (!NEEDS_REASON.includes(next)) void run(next, undefined);
  };

  const run = async (next: ProductionStatus, text: string | undefined) => {
    const done = await changeStatus(order.uid, next, text);
    if (done) {
      setPending(null);
      setReason('');
    }
  };

  const confirm = () => {
    if (!pending) return;
    if (reason.trim().length < 5) {
      setWrong(
        isUz
          ? 'Sababni yozing: kamida bir necha so‘z'
          : 'Напишите причину: хотя бы несколько слов',
      );
      return;
    }
    setWrong(null);
    void run(pending, reason.trim());
  };

  const asking = pending !== null && NEEDS_REASON.includes(pending);

  return (
    <div className="shrink-0 pt-2.5 mt-2 border-t border-zinc-100 dark:border-zinc-800/60 space-y-2">
      {saveError && <ErrorLine text={errorText(saveError, isUz)} />}
      {!saveError && lastSaved && (
        <div className="text-[11px] text-zinc-500">
          {lastSaved.number} — {lastSaved.note}
        </div>
      )}

      {asking && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
            {isUz ? WHY[pending!].uz : WHY[pending!].ru}
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            autoFocus
            placeholder={
              pending === 'paused'
                ? isUz
                  ? 'Masalan: uchastkada zagotovka tugadi'
                  : 'Например: на участке кончилась заготовка'
                : isUz
                  ? 'Masalan: mijoz buyurtmani oldi'
                  : 'Например: заказчик снял заявку'
            }
            aria-label={isUz ? 'Sabab' : 'Причина'}
            className={FIELD.replace('h-8', 'h-auto py-1.5')}
          />
          {wrong && <ErrorLine text={wrong} />}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={confirm}
              disabled={saving}
              className={pending === 'cancelled' ? BTN_DANGER : BTN_PRIMARY}
            >
              <span className="inline-flex items-center gap-1.5">
                {saving && <Loader2 size={12} className="animate-spin" />}
                {actionLabel(pending!, order.status, isUz)}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              disabled={saving}
              className={BTN_GHOST}
            >
              {isUz ? 'Qaytish' : 'Назад'}
            </button>
          </div>
        </div>
      )}

      {!asking && (
        <>
          {order.nextStatuses.length === 0 ? (
            <p className="text-[11px] text-zinc-400">
              {isUz
                ? 'Buyurtma bo‘yicha boshqa harakat yo‘q.'
                : 'По заказу действий больше нет.'}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {order.canEdit && (
                <button type="button" onClick={onEdit} disabled={saving} className={BTN_GHOST}>
                  {isUz ? 'Tahrirlash' : 'Править'}
                </button>
              )}
              {order.nextStatuses.map((next) => (
                <button
                  key={next}
                  type="button"
                  onClick={() => press(next)}
                  disabled={saving}
                  className={next === 'cancelled' ? BTN_DANGER : BTN_PRIMARY}
                  title={isUz ? WHY[next].uz : WHY[next].ru}
                >
                  {actionLabel(next, order.status, isUz)}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};
