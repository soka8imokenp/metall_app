import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, LogIn, ShieldAlert } from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { useApp } from '../../context/AppContext';
import type { AdminAuditRow, AdminLoginRow } from '../../types/api';
import { BTN_GHOST, CARD, Empty, ErrorBox, FIELD, Skeleton } from './warehouse-ui';
import { refName } from '../../lib/formatters';

/**
 * Журнал действий и журнал входов (ТЗ 3.4).
 *
 * Оба писались с самого начала — их просто негде было смотреть. Здесь они
 * показаны так, как их читают: не «изменена сущность user», а «кто, когда, что
 * и с чего на что».
 *
 * «Было → стало» — главное в этом экране. Строка без него отвечает «что-то
 * поменялось», а это не ответ: по журналу разбирают, кто поставил скидку и
 * какой она была до того.
 */

const when = (iso: string, isUz: boolean) =>
  new Date(iso).toLocaleString(isUz ? 'uz-UZ' : 'ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Названия сущностей: в журнале стоит код таблицы, человеку нужен предмет. */
const ENTITIES: Record<string, { ru: string; uz: string }> = {
  user: { ru: 'Учётная запись', uz: 'Hisob' },
  role: { ru: 'Роль', uz: 'Rol' },
  partner: { ru: 'Клиент', uz: 'Mijoz' },
  lead: { ru: 'Обращение', uz: 'Murojaat' },
  deal: { ru: 'Сделка', uz: 'Bitim' },
  item: { ru: 'Номенклатура', uz: 'Nomenklatura' },
  warehouse: { ru: 'Склад', uz: 'Ombor' },
  document: { ru: 'Документ', uz: 'Hujjat' },
  document_type: { ru: 'Тип документа', uz: 'Hujjat turi' },
  finance_operation: { ru: 'Денежная операция', uz: 'Pul operatsiyasi' },
  sales_order: { ru: 'Заказ', uz: 'Buyurtma' },
  company: { ru: 'Компания', uz: 'Kompaniya' },
  company_settings: { ru: 'Настройки компании', uz: 'Kompaniya sozlamalari' },
  stock_move: { ru: 'Движение склада', uz: 'Ombor harakati' },
  stock_reservation: { ru: 'Резерв', uz: 'Zahira' },
  inventory_sheet: { ru: 'Инвентаризация', uz: 'Inventarizatsiya' },
  warehouse_zone: { ru: 'Зона склада', uz: 'Ombor zonasi' },
  storage_location: { ru: 'Ячейка', uz: 'Yacheyka' },
  stock_reason: { ru: 'Причина списания', uz: 'Hisobdan chiqarish sababi' },
  item_stock_level: { ru: 'Уровень запаса', uz: 'Zaxira darajasi' },
  budget: { ru: 'Бюджет', uz: 'Byudjet' },
  user_telegram: { ru: 'Привязка Telegram', uz: 'Telegram bog‘lanishi' },
  sales_order_line: { ru: 'Строка заказа', uz: 'Buyurtma satri' },
  price_list: { ru: 'Прайс-лист', uz: 'Narxlar ro‘yxati' },
};

const entityName = (code: string, isUz: boolean) =>
  ENTITIES[code] ? (isUz ? ENTITIES[code].uz : ENTITIES[code].ru) : code;

/**
 * Названия полей: в журнале лежит имя поля из кода (`amountTotal`), а человек
 * ищет «Сумма». Поля, которого тут нет, прячем не мы — оно покажется как есть,
 * и это видно сразу.
 */
const FIELDS: Record<string, { ru: string; uz: string }> = {
  number: { ru: 'Номер', uz: 'Raqam' },
  status: { ru: 'Статус', uz: 'Holat' },
  qty: { ru: 'Количество', uz: 'Miqdor' },
  qtyCounted: { ru: 'Пересчитано', uz: 'Qayta hisoblandi' },
  qtyExpected: { ru: 'Числилось', uz: 'Hisobda edi' },
  operationType: { ru: 'Вид операции', uz: 'Operatsiya turi' },
  lines: { ru: 'Строк', uz: 'Satrlar' },
  diffLines: { ru: 'Строк с расхождением', uz: 'Farqli satrlar' },
  line: { ru: 'Строка', uz: 'Satr' },
  item: { ru: 'Номенклатура', uz: 'Nomenklatura' },
  batch: { ru: 'Партия', uz: 'Partiya' },
  serial: { ru: 'Серийный номер', uz: 'Seriya raqami' },
  amount: { ru: 'Сумма', uz: 'Summa' },
  amountTotal: { ru: 'Сумма', uz: 'Summa' },
  amountPlanned: { ru: 'План', uz: 'Reja' },
  price: { ru: 'Цена', uz: 'Narx' },
  currency: { ru: 'Валюта', uz: 'Valyuta' },
  account: { ru: 'Счёт или касса', uz: 'Hisob yoki kassa' },
  counterAccount: { ru: 'Встречный счёт', uz: 'Qarshi hisob' },
  entries: { ru: 'Проводок', uz: 'O‘tkazmalar' },
  comment: { ru: 'Комментарий', uz: 'Izoh' },
  from: { ru: 'Откуда', uz: 'Qayerdan' },
  to: { ru: 'Куда', uz: 'Qayerga' },
  warehouse: { ru: 'Склад', uz: 'Ombor' },
  zone: { ru: 'Зона', uz: 'Zona' },
  reversalOf: { ru: 'Сторно к', uz: 'Storno' },
  salesOrder: { ru: 'Заказ', uz: 'Buyurtma' },
  fromLead: { ru: 'Из обращения', uz: 'Murojaatdan' },
  overSell: { ru: 'Сверх остатка', uz: 'Qoldiqdan ortiq' },
  free: { ru: 'Свободный остаток', uz: 'Erkin qoldiq' },
  expiresAt: { ru: 'Действует до', uz: 'Amal qiladi' },
  validFrom: { ru: 'Действует с', uz: 'Amal qiladi' },
  documentDate: { ru: 'Дата документа', uz: 'Hujjat sanasi' },
  period: { ru: 'Период', uz: 'Davr' },
  version: { ru: 'Редакция', uz: 'Tahrir' },
  thresholdWarnPercent: { ru: 'Порог предупреждения, %', uz: 'Ogohlantirish chegarasi, %' },
  minQty: { ru: 'Минимальный запас', uz: 'Eng kam zaxira' },
  criticalQty: { ru: 'Критический запас', uz: 'Tanqidiy zaxira' },
  costingMethod: { ru: 'Метод себестоимости', uz: 'Tannarx usuli' },
  blockMode: { ru: 'Продажа сверх остатка', uz: 'Qoldiqdan ortiq sotish' },
  belowCostMode: { ru: 'Цена ниже себестоимости', uz: 'Tannarxdan past narx' },
  priceType: { ru: 'Тип цены', uz: 'Narx turi' },
  baseUnit: { ru: 'Единица', uz: 'Birlik' },
  itemType: { ru: 'Вид позиции', uz: 'Pozitsiya turi' },
  trackBatches: { ru: 'Учёт партий', uz: 'Partiya hisobi' },
  trackSerials: { ru: 'Штучный учёт', uz: 'Donalab hisob' },
  barcode: { ru: 'Штрихкод', uz: 'Shtrix-kod' },
  code: { ru: 'Код', uz: 'Kod' },
  name: { ru: 'Название', uz: 'Nomi' },
  nameRu: { ru: 'Наименование', uz: 'Nomi' },
  fullName: { ru: 'ФИО', uz: 'F.I.Sh.' },
  login: { ru: 'Логин', uz: 'Login' },
  inn: { ru: 'ИНН', uz: 'STIR' },
  phone: { ru: 'Телефон', uz: 'Telefon' },
  contact: { ru: 'Контактное лицо', uz: 'Kontakt shaxs' },
  isActive: { ru: 'В работе', uz: 'Ishda' },
  roles: { ru: 'Роли', uz: 'Rollar' },
  permissions: { ru: 'Права', uz: 'Huquqlar' },
  paymentDelayDays: { ru: 'Отсрочка, дней', uz: 'Muddat, kun' },
  telegramUserId: { ru: 'Аккаунт Telegram', uz: 'Telegram hisobi' },
  kind: { ru: 'Вид', uz: 'Turi' },
  added: { ru: 'Добавлено', uz: 'Qo‘shildi' },
  removed: { ru: 'Убрано', uz: 'Olib tashlandi' },
};

const fieldName = (code: string, isUz: boolean) =>
  FIELDS[code] ? (isUz ? FIELDS[code].uz : FIELDS[code].ru) : code;

/**
 * Значения-коды: статусы и виды операций хранятся словами английского кода.
 * «status approved → draft» человеку ничего не говорит, а «Утверждён →
 * Черновик» говорит. Подменяем только известные коды и только в строковых
 * значениях: число, дата и свободный текст идут как есть.
 */
const CODE_VALUES: Record<string, { ru: string; uz: string }> = {
  draft: { ru: 'Черновик', uz: 'Qoralama' },
  review: { ru: 'На проверке', uz: 'Tekshiruvda' },
  pending_approval: { ru: 'На согласовании', uz: 'Tasdiqlashda' },
  approved: { ru: 'Утверждён', uz: 'Tasdiqlangan' },
  returned: { ru: 'Возвращён на доработку', uz: 'Qaytarilgan' },
  rejected: { ru: 'Отклонён', uz: 'Rad etilgan' },
  signed: { ru: 'Подписан', uz: 'Imzolangan' },
  posted: { ru: 'Проведён', uz: 'O‘tkazilgan' },
  cancelled: { ru: 'Отменён', uz: 'Bekor qilingan' },
  released: { ru: 'Снят', uz: 'Olib tashlangan' },
  receipt: { ru: 'Приёмка', uz: 'Qabul' },
  expense: { ru: 'Отгрузка', uz: 'Jo‘natish' },
  transfer: { ru: 'Перемещение', uz: 'Ko‘chirish' },
  write_off: { ru: 'Списание', uz: 'Hisobdan chiqarish' },
  surplus: { ru: 'Оприходование излишка', uz: 'Ortiqchani kirim qilish' },
  issue_to_production: { ru: 'Выдача в цех', uz: 'Sexga berish' },
  return_from_production: { ru: 'Возврат из цеха', uz: 'Sexdan qaytish' },
  return_from_client: { ru: 'Возврат от клиента', uz: 'Mijozdan qaytish' },
  fifo: { ru: 'ФИФО', uz: 'FIFO' },
  weighted_average: { ru: 'Средняя', uz: 'O‘rtacha' },
  block: { ru: 'Запрещено', uz: 'Taqiqlangan' },
  mark: { ru: 'Пометить', uz: 'Belgilash' },
  approve: { ru: 'По праву', uz: 'Huquq bo‘yicha' },
  goods: { ru: 'Товар', uz: 'Tovar' },
  wholesale: { ru: 'Оптовая', uz: 'Ulgurji' },
};

/** Пустое значение в журнале пишем словом: прочерк читается как «ноль». */
const value = (v: unknown, isUz: boolean): string => {
  if (v === null || v === undefined || v === '') return isUz ? 'bo‘sh' : 'пусто';
  if (typeof v === 'boolean') return v ? (isUz ? 'ha' : 'да') : isUz ? 'yo‘q' : 'нет';
  if (typeof v === 'string' && CODE_VALUES[v]) {
    return isUz ? CODE_VALUES[v].uz : CODE_VALUES[v].ru;
  }
  // Время в журнал попадает как его отдаёт сервер — «2026-10-02T10:57:31.392Z».
  // Это строка для машины: человек по ней не скажет даже, что это сегодня.
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    return when(v, isUz);
  }
  // Деньги приходят из базы как «396852078.3300»: столько знаков не читают, а
  // разрядов не видно вовсе. Доли оставляем, если они есть на самом деле.
  if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v))) {
    const n = Number(v);
    if (Number.isFinite(n) && Math.abs(n) >= 1000) {
      return n.toLocaleString(isUz ? 'uz-UZ' : 'ru-RU', { maximumFractionDigits: 2 });
    }
  }
  return String(v);
};

export const AdminAudit: React.FC = () => {
  const { locale } = useApp();
  const isUz = locale === 'uz';

  const [rows, setRows] = useState<AdminAuditRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(50);
  const [facets, setFacets] = useState<{
    entities: { value: string; count: number }[];
    actions: { value: string; nameRu: string; nameUz: string; count: number }[];
  } | null>(null);
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.admin.audit({
        entityType: entityType || undefined,
        action: action || undefined,
        search: search.trim() || undefined,
        limit,
      });
      setRows(res.data.rows);
      setTotal(res.data.total);
      if (!facets) setFacets((await apiClient.admin.auditFacets()).data);
    } catch (e) {
      setRows(null);
      setError(e as ApiError);
    }
  }, [entityType, action, search, limit, facets]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <select
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          aria-label={isUz ? 'Nima o‘zgardi' : 'Что меняли'}
          className={FIELD + ' max-w-[14rem]'}
        >
          <option value="">{isUz ? 'Hammasi' : 'Всё подряд'}</option>
          {(facets?.entities ?? []).map((e) => (
            <option key={e.value} value={e.value}>
              {entityName(e.value, isUz)} ({e.count})
            </option>
          ))}
        </select>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          aria-label={isUz ? 'Harakat' : 'Действие'}
          className={FIELD + ' max-w-[14rem]'}
        >
          <option value="">{isUz ? 'Barcha harakatlar' : 'Любое действие'}</option>
          {(facets?.actions ?? []).map((a) => (
            <option key={a.value} value={a.value}>
              {(refName(a, isUz))} ({a.count})
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={isUz ? 'Odam yoki qiymat' : 'Человек или значение'}
          aria-label={isUz ? 'Qidirish' : 'Поиск'}
          className={FIELD + ' max-w-[16rem]'}
        />
        <span className="text-[11px] text-zinc-500 ms-auto">
          {isUz
            ? `${rows?.length ?? 0} dan ${total} ko‘rsatildi`
            : `показано ${rows?.length ?? 0} из ${total}`}
        </span>
      </div>

      {error && <ErrorBox text={error.message} onRetry={load} isUz={isUz} />}

      <div className={CARD + ' flex flex-col min-w-0'}>
        {rows === null && !error ? (
          <Skeleton rows={5} />
        ) : rows && rows.length === 0 ? (
          <Empty
            text={
              isUz
                ? 'Bu shartlar bo‘yicha yozuv yo‘q'
                : 'По этим условиям записей нет'
            }
          />
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 min-w-0">
            {(rows ?? []).map((r, i) => (
              <li key={`${r.occurredAt}:${i}`} className="px-4 py-3 flex flex-col gap-1.5 min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                  <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
                    {isUz ? r.actionUz : r.actionRu}
                  </span>
                  <span className="text-xs text-zinc-600 dark:text-zinc-400 break-words">
                    {entityName(r.entityType, isUz)}
                  </span>
                  {/* Название предмета вместо идентификатора: «Клиент
                      01a0fbb1-358c…» не отвечает, какой это клиент.
                      Идентификатор остаётся только там, где назвать нечем —
                      предмет удалён. */}
                  <span
                    className={
                      r.entityTitle
                        ? 'text-xs text-zinc-900 dark:text-zinc-100 font-medium break-words'
                        : 'text-[11px] text-zinc-400 font-mono break-all'
                    }
                    title={r.entityTitle ? r.entityId : undefined}
                  >
                    {r.entityTitle ?? r.entityId}
                  </span>
                  <span className="text-[11px] text-zinc-500 ms-auto whitespace-nowrap">
                    {when(r.occurredAt, isUz)}
                  </span>
                </div>

                <div className="text-[11px] text-zinc-500 break-words">
                  {r.user
                    ? `${r.user.fullName} (${r.user.login})`
                    : isUz
                      ? 'tizim'
                      : 'система'}
                  {` · ${r.company}`}
                  {r.ip ? ` · ${r.ip}` : ''}
                </div>

                {/* «Было → стало» по каждому полю. Поле, которого в правке не
                    было, сюда не попадает: журнал не должен показывать
                    изменение там, где его не делали. */}
                {r.changes && Object.keys(r.changes).length > 0 && (
                  <div className="flex flex-col gap-0.5 min-w-0">
                    {Object.entries(r.changes).map(([field, ch]) => (
                      <div
                        key={field}
                        className="flex flex-wrap items-center gap-1.5 text-[11px] min-w-0"
                      >
                        <span className="text-zinc-500 break-words">
                          {fieldName(field, isUz)}
                        </span>
                        <span className="text-zinc-700 dark:text-zinc-300 break-words">
                          {value(ch?.from, isUz)}
                        </span>
                        <ArrowRight className="w-3 h-3 text-zinc-400 shrink-0" />
                        <span className="text-zinc-900 dark:text-zinc-100 font-medium break-words">
                          {value(ch?.to, isUz)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {rows && total > rows.length && (
        <div>
          <button type="button" onClick={() => setLimit((l) => l + 50)} className={BTN_GHOST}>
            {isUz ? 'Yana 50 ta' : 'Показать ещё 50'}
          </button>
        </div>
      )}
    </div>
  );
};

export const AdminLogins: React.FC = () => {
  const { locale } = useApp();
  const isUz = locale === 'uz';

  const [rows, setRows] = useState<AdminLoginRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [limit, setLimit] = useState(50);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.admin.logins({ onlyFailed, limit });
      setRows(res.data.rows);
      setTotal(res.data.total);
    } catch (e) {
      setRows(null);
      setError(e as ApiError);
    }
  }, [onlyFailed, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className={CARD + ' p-4 text-xs text-zinc-600 dark:text-zinc-400 break-words'}>
        {isUz
          ? 'Muvaffaqiyatsiz urinishlar ham yoziladi — mavjud bo‘lmagan login bilan ham. ' +
            'Bir xil IP dan ketma-ket rad etishlar login tanlashga o‘xshaydi.'
          : 'Неудачные попытки записываются тоже — в том числе под логином, которого нет. ' +
            'Череда отказов с одного адреса и выглядит как перебор логинов.'}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer">
          <input
            type="checkbox"
            checked={onlyFailed}
            onChange={(e) => setOnlyFailed(e.target.checked)}
          />
          {isUz ? 'Faqat rad etilganlar' : 'Только неудачные'}
        </label>
        <span className="text-[11px] text-zinc-500 ms-auto">
          {isUz
            ? `${rows?.length ?? 0} dan ${total} ko‘rsatildi`
            : `показано ${rows?.length ?? 0} из ${total}`}
        </span>
      </div>

      {error && <ErrorBox text={error.message} onRetry={load} isUz={isUz} />}

      <div className={CARD + ' flex flex-col min-w-0'}>
        {rows === null && !error ? (
          <Skeleton rows={5} />
        ) : rows && rows.length === 0 ? (
          <Empty text={isUz ? 'Yozuv yo‘q' : 'Записей нет'} />
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 min-w-0">
            {(rows ?? []).map((r, i) => (
              <li
                key={`${r.occurredAt}:${i}`}
                className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0"
              >
                {r.success ? (
                  <LogIn className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-500 shrink-0" />
                ) : (
                  <ShieldAlert className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400 shrink-0" />
                )}
                <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 break-all">
                  {r.login ?? (isUz ? 'bunday login yo‘q' : 'логина нет')}
                </span>
                {r.fullName && (
                  <span className="text-[11px] text-zinc-500 break-words">{r.fullName}</span>
                )}
                {!r.success && (
                  <span className="text-[11px] text-rose-600 dark:text-rose-400 break-words">
                    {(isUz ? r.reasonUz : r.reasonRu) ?? (isUz ? 'rad etildi' : 'отказ')}
                  </span>
                )}
                {r.ip && <span className="text-[11px] text-zinc-400 font-mono">{r.ip}</span>}
                <span className="text-[11px] text-zinc-500 ms-auto whitespace-nowrap">
                  {when(r.occurredAt, isUz)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {rows && total > rows.length && (
        <div>
          <button type="button" onClick={() => setLimit((l) => l + 50)} className={BTN_GHOST}>
            {isUz ? 'Yana 50 ta' : 'Показать ещё 50'}
          </button>
        </div>
      )}
    </div>
  );
};
