/**
 * CRM Э5 — карточка клиента целиком (ТЗ 8.2).
 *
 * Список клиентов отвечает на вопрос «кто это», карточка — на вопрос «что у
 * нас с ним». Поэтому она занимает весь экран и делится вкладками: сделки,
 * заказы, документы, финансы, задачи, общение, файлы, журнал изменений.
 *
 * Числа на вкладках приходят из счётчиков карточки, а не считаются здесь:
 * менеджеру важно увидеть «заказы 7», не открывая вкладку.
 *
 * Ничего своего экран не считает. Заказы берутся из продаж, долг и платежи —
 * из финансов теми же выражениями, что и список дебиторов. Второй счёт тех же
 * денег разошёлся бы, а спрашивают его перед отгрузкой.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, FileText, TriangleAlert } from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { errorText } from '../../context/DashboardContext';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import type {
  CrmActivityRow,
  CrmCardDeal,
  CrmCardDocument,
  CrmCardFinance,
  CrmCardHistoryRow,
  CrmCardOrder,
  CrmPartnerCard,
  CrmTaskRow,
} from '../../types/api';
import { BTN_GHOST, CARD, Empty, ErrorBox, Skeleton } from './warehouse-ui';
import { AttachmentsPanel } from './WarehouseAttachments';
import { PartnerPricesBlock } from './SalesPrices';
import { refName } from '../../lib/formatters';

type Tab =
  | 'deals'
  | 'orders'
  | 'prices'
  | 'documents'
  | 'finance'
  | 'tasks'
  | 'feed'
  | 'files'
  | 'history';

const TABS: { key: Tab; ru: string; uz: string; count?: keyof CrmPartnerCard['usage'] }[] = [
  { key: 'deals', ru: 'Сделки', uz: 'Bitimlar', count: 'deals' },
  { key: 'orders', ru: 'Заказы', uz: 'Buyurtmalar', count: 'orders' },
  // ТЗ 9.2: договорная цена — условие работы с клиентом, рядом с отсрочкой и
  // лимитом долга, а не свойство номенклатуры.
  { key: 'prices', ru: 'Цены', uz: 'Narxlar' },
  { key: 'documents', ru: 'Документы', uz: 'Hujjatlar', count: 'documents' },
  { key: 'finance', ru: 'Финансы', uz: 'Moliya' },
  { key: 'tasks', ru: 'Задачи', uz: 'Vazifalar', count: 'tasks' },
  { key: 'feed', ru: 'Общение', uz: 'Muloqot', count: 'activities' },
  { key: 'files', ru: 'Файлы', uz: 'Fayllar', count: 'files' },
  { key: 'history', ru: 'История', uz: 'Tarix' },
];

const money = (v: string | null | undefined) => Number(v ?? 0).toLocaleString('ru-RU');

const date = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};

const when = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Asia/Tashkent',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const fmtWhen = (iso: string | null) => (iso ? when.format(new Date(iso)).replace(', ', ' ') : '—');

const ORDER_STATUS: Record<string, { ru: string; uz: string }> = {
  draft: { ru: 'черновик', uz: 'qoralama' },
  confirmed: { ru: 'подтверждён', uz: 'tasdiqlangan' },
  reserved: { ru: 'зарезервирован', uz: 'zaxiralangan' },
  picking: { ru: 'сборка', uz: 'yig‘ish' },
  shipped: { ru: 'отгружен', uz: 'jo‘natilgan' },
  closed: { ru: 'закрыт', uz: 'yopilgan' },
  cancelled: { ru: 'отменён', uz: 'bekor qilingan' },
};

const PAY_STATUS: Record<string, { ru: string; uz: string }> = {
  unpaid: { ru: 'не оплачен', uz: 'to‘lanmagan' },
  partial: { ru: 'частично', uz: 'qisman' },
  paid: { ru: 'оплачен', uz: 'to‘langan' },
};

const DOC_STATUS: Record<string, { ru: string; uz: string }> = {
  draft: { ru: 'черновик', uz: 'qoralama' },
  pending_approval: { ru: 'на согласовании', uz: 'kelishuvda' },
  approved: { ru: 'согласован', uz: 'kelishilgan' },
  signed: { ru: 'подписан', uz: 'imzolangan' },
  returned: { ru: 'возвращён', uz: 'qaytarilgan' },
  cancelled: { ru: 'отменён', uz: 'bekor qilingan' },
};

const FIN_STATUS: Record<string, { ru: string; uz: string }> = {
  draft: { ru: 'черновик', uz: 'qoralama' },
  pending_approval: { ru: 'на согласовании', uz: 'kelishuvda' },
  approved: { ru: 'согласован', uz: 'kelishilgan' },
  posted: { ru: 'проведён', uz: 'o‘tkazilgan' },
  rejected: { ru: 'отклонён', uz: 'rad etilgan' },
  reversed: { ru: 'сторнирован', uz: 'storno' },
};

const FIN_TYPE: Record<string, { ru: string; uz: string }> = {
  income: { ru: 'приход', uz: 'kirim' },
  expense: { ru: 'расход', uz: 'chiqim' },
  transfer: { ru: 'перевод', uz: 'o‘tkazma' },
  conversion: { ru: 'конверсия', uz: 'konvertatsiya' },
};

const ACTION_TEXT: Record<string, { ru: string; uz: string }> = {
  create: { ru: 'Карточка заведена', uz: 'Kartochka yaratildi' },
  update: { ru: 'Правка карточки', uz: 'Kartochka tahriri' },
  archive: { ru: 'Клиент выключен', uz: 'Mijoz o‘chirildi' },
  restore: { ru: 'Клиент включён', uz: 'Mijoz yoqildi' },
  'contact.add': { ru: 'Добавлено контактное лицо', uz: 'Aloqa shaxsi qo‘shildi' },
  'contact.update': { ru: 'Правка контактного лица', uz: 'Aloqa shaxsi tahriri' },
  'contact.remove': { ru: 'Удалено контактное лицо', uz: 'Aloqa shaxsi o‘chirildi' },
  'lead.link': { ru: 'Привязано обращение', uz: 'Murojaat bog‘landi' },
};

const FIELD_TEXT: Record<string, { ru: string; uz: string }> = {
  nameRu: { ru: 'Наименование', uz: 'Nomi' },
  nameUz: { ru: 'Наименование (uz)', uz: 'Nomi (uz)' },
  inn: { ru: 'ИНН', uz: 'STIR' },
  fromLead: { ru: 'Из обращения', uz: 'Murojaatdan' },
  partnerType: { ru: 'Тип', uz: 'Turi' },
  legalAddress: { ru: 'Юр. адрес', uz: 'Yuridik manzil' },
  actualAddress: { ru: 'Факт. адрес', uz: 'Haqiqiy manzil' },
  isClient: { ru: 'Покупатель', uz: 'Xaridor' },
  isSupplier: { ru: 'Поставщик', uz: 'Yetkazuvchi' },
  paymentDelayDays: { ru: 'Отсрочка, дней', uz: 'Muddat, kun' },
  debtLimit: { ru: 'Лимит долга', uz: 'Qarz chegarasi' },
  isActive: { ru: 'Активен', uz: 'Faol' },
  tags: { ru: 'Метки', uz: 'Teglar' },
  contact: { ru: 'Контактное лицо', uz: 'Aloqa shaxsi' },
  fullName: { ru: 'Имя', uz: 'Ismi' },
  position: { ru: 'Должность', uz: 'Lavozimi' },
  phone: { ru: 'Телефон', uz: 'Telefon' },
  email: { ru: 'Почта', uz: 'Pochta' },
  telegram: { ru: 'Telegram', uz: 'Telegram' },
  isPrimary: { ru: 'Главный контакт', uz: 'Asosiy aloqa' },
};

const valueText = (v: unknown, isUz: boolean): string => {
  if (v === null || v === undefined || v === '') return isUz ? 'пусто' : 'пусто';
  if (typeof v === 'boolean') return v ? (isUz ? 'ha' : 'да') : isUz ? 'yo‘q' : 'нет';
  return String(v);
};

export const CrmPartnerFull: React.FC<{
  card: CrmPartnerCard;
  onBack: () => void;
}> = ({ card, onBack }) => {
  const { locale } = useApp();
  const { can } = useAuth();
  const isUz = locale === 'uz';
  const canEdit = can('crm.edit');
  const [tab, setTab] = useState<Tab>('deals');

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className={`${CARD} px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0`}>
        <button
          type="button"
          onClick={onBack}
          className={`${BTN_GHOST} inline-flex items-center gap-1.5 whitespace-nowrap shrink-0`}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          {isUz ? 'Ro‘yxatga' : 'К списку'}
        </button>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 break-words">
            {refName(card, isUz)}
          </span>
          <span className="text-[11px] text-zinc-500 break-words">
            {card.inn ? `ИНН ${card.inn}` : isUz ? 'INN ko‘rsatilmagan' : 'ИНН не указан'} ·{' '}
            {refName(card.company, isUz)}
            {card.manager ? ` · ${card.manager.name}` : ''}
          </span>
        </div>
        {!card.isActive && (
          <span className="text-[10px] text-amber-700 dark:text-amber-400 shrink-0">
            {isUz ? 'o‘chirilgan' : 'выключен'}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => {
          const n = t.count ? Number(card.usage[t.count] ?? 0) : null;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`h-7 px-3 rounded-lg text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                tab === t.key
                  ? 'bg-zinc-900 text-zinc-50 border-zinc-900 dark:bg-zinc-50 dark:text-zinc-900 dark:border-zinc-50'
                  : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              {isUz ? t.uz : t.ru}
              {n !== null ? ` ${n}` : ''}
            </button>
          );
        })}
      </div>

      <div className={`${CARD} flex flex-col min-w-0`}>
        {tab === 'deals' && <DealsTab uid={card.uid} isUz={isUz} />}
        {tab === 'orders' && <OrdersTab uid={card.uid} isUz={isUz} />}
        {tab === 'prices' && (
          <PartnerPricesBlock partnerUid={card.uid} companyUid={card.company?.uid} isUz={isUz} />
        )}
        {tab === 'documents' && <DocumentsTab uid={card.uid} isUz={isUz} />}
        {tab === 'finance' && <FinanceTab uid={card.uid} isUz={isUz} />}
        {tab === 'tasks' && <TasksTab uid={card.uid} isUz={isUz} />}
        {tab === 'feed' && <FeedTab uid={card.uid} isUz={isUz} />}
        {tab === 'files' && (
          <AttachmentsPanel owner="partner" uid={card.uid} canEdit={canEdit} isUz={isUz} />
        )}
        {tab === 'history' && <HistoryTab uid={card.uid} isUz={isUz} />}
      </div>
    </div>
  );
};

/** Общая обвязка вкладки: загрузка, ошибка, пусто. */
function useTab<T>(load: () => Promise<{ data: T }>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(async () => {
    setError(null);
    try {
      setData((await load()).data);
    } catch (e) {
      setData(null);
      setError(e as ApiError);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void run();
  }, [run]);
  return { data, error, reload: run };
}

const Shell: React.FC<{
  error: ApiError | null;
  isUz: boolean;
  loading: boolean;
  empty: boolean;
  emptyText: string;
  children: React.ReactNode;
}> = ({ error, isUz, loading, empty, emptyText, children }) =>
  error ? (
    <ErrorBox text={errorText(error, isUz)} isUz={isUz} />
  ) : loading ? (
    <Skeleton />
  ) : empty ? (
    <Empty text={emptyText} />
  ) : (
    <>{children}</>
  );

const DealsTab: React.FC<{ uid: string; isUz: boolean }> = ({ uid, isUz }) => {
  const { data, error } = useTab<{ rows: CrmCardDeal[] }>(
    () => apiClient.crm.partnerDeals(uid),
    [uid],
  );
  return (
    <Shell
      error={error}
      isUz={isUz}
      loading={data === null}
      empty={!!data && data.rows.length === 0}
      emptyText={isUz ? 'Bitimlar yo‘q' : 'Сделок нет'}
    >
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
        {(data?.rows ?? []).map((d) => (
          <li key={d.uid} className="px-4 py-3 flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
              <span className="text-[11px] font-mono text-zinc-400 shrink-0">{d.number}</span>
              <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
                {d.title}
              </span>
              <span
                className={`px-1.5 rounded border text-[10px] shrink-0 ${
                  d.status === 'won'
                    ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/60'
                    : d.status === 'lost'
                      ? 'text-zinc-600 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800/60 border-zinc-200 dark:border-zinc-700'
                      : 'text-sky-700 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/40 border-sky-200 dark:border-sky-900/60'
                }`}
              >
                {d.stage.name}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
              <span className="font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                {money(d.amount)} UZS
              </span>
              <span>{d.probability}%</span>
              {d.manager && <span className="break-words">{d.manager}</span>}
              <span>
                {isUz ? 'yaratildi' : 'заведена'} {date(d.createdAt)}
              </span>
              {d.lostReason && (
                <span className="break-words">
                  {isUz ? 'sabab' : 'причина'}: {d.lostReason}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Shell>
  );
};

const OrdersTab: React.FC<{ uid: string; isUz: boolean }> = ({ uid, isUz }) => {
  const { data, error } = useTab<{ rows: CrmCardOrder[] }>(
    () => apiClient.crm.partnerOrders(uid),
    [uid],
  );
  return (
    <Shell
      error={error}
      isUz={isUz}
      loading={data === null}
      empty={!!data && data.rows.length === 0}
      emptyText={isUz ? 'Buyurtmalar yo‘q' : 'Заказов нет'}
    >
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
        {(data?.rows ?? []).map((o) => {
          const left = Number(o.amountTotal) - Number(o.paidAmount);
          return (
            <li key={o.uid} className="px-4 py-3 flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
                <span className="text-[11px] font-mono text-zinc-400 shrink-0">{o.number}</span>
                <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 font-mono tabular-nums">
                  {money(o.amountTotal)} {o.currency}
                </span>
                <span className="text-[10px] text-zinc-500 shrink-0">
                  {(isUz ? ORDER_STATUS[o.status]?.uz : ORDER_STATUS[o.status]?.ru) ?? o.status}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
                <span>
                  {isUz ? 'sana' : 'от'} {date(o.orderDate)}
                </span>
                <span>
                  {(isUz ? PAY_STATUS[o.paymentStatus]?.uz : PAY_STATUS[o.paymentStatus]?.ru) ??
                    o.paymentStatus}
                </span>
                {left > 0 && (
                  <span className="font-mono tabular-nums">
                    {isUz ? 'qoldiq' : 'остаток'} {money(String(left))}
                  </span>
                )}
                {o.paymentDueDate && (
                  <span>
                    {isUz ? 'to‘lash' : 'оплата до'} {date(o.paymentDueDate)}
                  </span>
                )}
                {o.manager && <span className="break-words">{o.manager}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </Shell>
  );
};

const DocumentsTab: React.FC<{ uid: string; isUz: boolean }> = ({ uid, isUz }) => {
  const { data, error } = useTab<{ rows: CrmCardDocument[]; readOnly: boolean }>(
    () => apiClient.crm.partnerDocuments(uid),
    [uid],
  );
  return (
    <>
      {/* Предупреждение стоит над списком, а не внутри него: у клиента без
          документов список подменяется заглушкой, и подсказка пропадала ровно
          там, где человек ищет, где документ создать. */}
      {data?.readOnly && (
        <p className="px-4 py-2 text-[11px] text-zinc-500 break-words border-b border-zinc-200 dark:border-zinc-800 flex items-start gap-1.5">
          <FileText className="w-3.5 h-3.5 shrink-0 mt-px" />
          {isUz
            ? 'Faqat ko‘rish: mijoz hujjatlari shu yerda ko‘rinadi, lekin ular «Hujjatlar» bo‘limida rasmiylashtiriladi — u yerda turi va asosi tanlanadi.'
            : 'Только просмотр: документы клиента видно здесь, а выписывают их в разделе «Документы» — там выбирают тип и основание.'}
        </p>
      )}
    <Shell
      error={error}
      isUz={isUz}
      loading={data === null}
      empty={!!data && data.rows.length === 0}
      emptyText={isUz ? 'Hujjatlar yo‘q' : 'Документов нет'}
    >
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
        {(data?.rows ?? []).map((d) => (
          <li key={d.uid} className="px-4 py-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[11px] font-mono text-zinc-400 shrink-0">{d.number}</span>
            <span className="text-xs text-zinc-900 dark:text-zinc-100 break-words">
              {d.type.name}
            </span>
            <span className="text-[11px] text-zinc-500">{date(d.date)}</span>
            {d.amountTotal && (
              <span className="text-[11px] font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                {money(d.amountTotal)} {d.currency ?? ''}
              </span>
            )}
            <span className="text-[10px] text-zinc-500">
              {(isUz ? DOC_STATUS[d.status]?.uz : DOC_STATUS[d.status]?.ru) ?? d.status}
            </span>
          </li>
        ))}
      </ul>
    </Shell>
    </>
  );
};

const FinanceTab: React.FC<{ uid: string; isUz: boolean }> = ({ uid, isUz }) => {
  const { data, error } = useTab<CrmCardFinance>(() => apiClient.crm.partnerFinance(uid), [uid]);
  return (
    <Shell
      error={error}
      isUz={isUz}
      loading={data === null}
      empty={false}
      emptyText=""
    >
      {data && (
        <>
          <div className="px-4 py-3 grid grid-cols-2 lg:grid-cols-4 gap-3 border-b border-zinc-200 dark:border-zinc-800">
            <Metric
              label={isUz ? 'Qarz' : 'Задолженность'}
              value={`${money(data.debt)} UZS`}
              tone={Number(data.debt) > 0 ? 'warn' : 'plain'}
            />
            <Metric
              label={isUz ? 'Muddati o‘tgan' : 'Просрочено'}
              value={`${money(data.overdue)} UZS`}
              tone={Number(data.overdue) > 0 ? 'bad' : 'plain'}
              hint={
                data.maxOverdueDays > 0
                  ? `${isUz ? 'eng eskisi' : 'старейшему'} ${data.maxOverdueDays} ${isUz ? 'kun' : 'дн.'}`
                  : undefined
              }
            />
            <Metric
              label={isUz ? 'Qarz chegarasi' : 'Лимит долга'}
              value={`${money(data.debtLimit)} UZS`}
              tone={data.overLimit ? 'bad' : 'plain'}
              hint={data.overLimit ? (isUz ? 'chegara oshdi' : 'лимит превышен') : undefined}
            />
            <Metric
              label={isUz ? 'To‘lanmagan buyurtmalar' : 'Неоплаченных заказов'}
              value={String(data.unpaidOrders)}
              hint={`${isUz ? 'muddat' : 'отсрочка'} ${data.paymentDelayDays} ${isUz ? 'kun' : 'дн.'}`}
            />
          </div>

          {data.overLimit && (
            <p className="px-4 py-2 text-[11px] text-rose-700 dark:text-rose-400 break-words border-b border-zinc-200 dark:border-zinc-800 flex items-start gap-1.5">
              <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
              {isUz
                ? 'Qarz chegaradan oshgan: yangi jo‘natma haqida kelishuvdan oldin tekshiring.'
                : 'Долг больше лимита: прежде чем обещать отгрузку, согласуйте её.'}
            </p>
          )}

          {data.payments.length === 0 ? (
            <Empty text={isUz ? 'To‘lovlar yo‘q' : 'Платежей нет'} />
          ) : (
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
              {data.payments.map((p) => (
                <li key={p.uid} className="px-4 py-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[11px] font-mono text-zinc-400 shrink-0">{p.number}</span>
                  <span className="text-xs font-mono tabular-nums text-zinc-900 dark:text-zinc-100">
                    {money(p.amount)} {p.currency}
                  </span>
                  {/* У платежа важна дата, а не час: время проводки ничего не
                      говорит менеджеру и только занимает строку. */}
                  <span className="text-[11px] text-zinc-500">{date(p.at)}</span>
                  <span className="text-[11px] text-zinc-500">
                    {(isUz ? FIN_TYPE[p.type]?.uz : FIN_TYPE[p.type]?.ru) ?? p.type}
                  </span>
                  <span className="text-[11px] text-zinc-500 break-words">{p.account}</span>
                  <span className="text-[10px] text-zinc-500">
                    {(isUz ? FIN_STATUS[p.status]?.uz : FIN_STATUS[p.status]?.ru) ?? p.status}
                  </span>
                  {p.comment && (
                    <span className="text-[11px] text-zinc-500 break-words w-full">{p.comment}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Shell>
  );
};

const Metric: React.FC<{
  label: string;
  value: string;
  hint?: string;
  tone?: 'plain' | 'warn' | 'bad';
}> = ({ label, value, hint, tone = 'plain' }) => (
  <div className="flex flex-col gap-0.5 min-w-0">
    <span className="text-[11px] text-zinc-500 break-words">{label}</span>
    <span
      className={`text-xs font-mono tabular-nums break-words ${
        tone === 'bad'
          ? 'text-rose-700 dark:text-rose-400'
          : tone === 'warn'
            ? 'text-amber-700 dark:text-amber-400'
            : 'text-zinc-900 dark:text-zinc-100'
      }`}
    >
      {value}
    </span>
    {hint && <span className="text-[10px] text-zinc-400 break-words">{hint}</span>}
  </div>
);

const TasksTab: React.FC<{ uid: string; isUz: boolean }> = ({ uid, isUz }) => {
  const { data, error } = useTab<{ rows: CrmTaskRow[] }>(
    () => apiClient.crm.tasks({ partnerUid: uid, scope: 'all', limit: 100 }),
    [uid],
  );
  return (
    <Shell
      error={error}
      isUz={isUz}
      loading={data === null}
      empty={!!data && data.rows.length === 0}
      emptyText={isUz ? 'Vazifalar yo‘q' : 'Задач нет'}
    >
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
        {(data?.rows ?? []).map((t) => (
          <li key={t.uid} className="px-4 py-3 flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
              <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
                {t.title}
              </span>
              <span
                className={`px-1.5 rounded border text-[10px] shrink-0 ${
                  t.isOverdue
                    ? 'text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900/60'
                    : t.status === 'open'
                      ? 'text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700'
                      : 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/60'
                }`}
              >
                {fmtWhen(t.dueAt)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
              {t.assignee && <span className="break-words">{t.assignee.name}</span>}
              {t.deal && <span className="font-mono">{t.deal.number}</span>}
              {t.result && <span className="break-words w-full">{t.result}</span>}
            </div>
          </li>
        ))}
      </ul>
    </Shell>
  );
};

const FeedTab: React.FC<{ uid: string; isUz: boolean }> = ({ uid, isUz }) => {
  const { data, error } = useTab<{ rows: CrmActivityRow[] }>(
    () => apiClient.crm.activities({ partnerUid: uid, limit: 100 }),
    [uid],
  );
  return (
    <Shell
      error={error}
      isUz={isUz}
      loading={data === null}
      empty={!!data && data.rows.length === 0}
      emptyText={isUz ? 'Muloqot yozuvlari yo‘q' : 'Записей об общении нет'}
    >
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
        {(data?.rows ?? []).map((a) => (
          <li key={a.uid} className="px-4 py-3 flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
              <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
                {a.subject}
              </span>
              <span className="text-[10px] text-zinc-500 shrink-0">{fmtWhen(a.at)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
              {a.user && <span className="break-words">{a.user.name}</span>}
              {a.deal && <span className="font-mono">{a.deal.number}</span>}
              {a.note && <span className="break-words w-full">{a.note}</span>}
            </div>
          </li>
        ))}
      </ul>
    </Shell>
  );
};

const HistoryTab: React.FC<{ uid: string; isUz: boolean }> = ({ uid, isUz }) => {
  const { data, error } = useTab<{ rows: CrmCardHistoryRow[] }>(
    () => apiClient.crm.partnerHistory(uid),
    [uid],
  );
  return (
    <Shell
      error={error}
      isUz={isUz}
      loading={data === null}
      empty={!!data && data.rows.length === 0}
      emptyText={isUz ? 'O‘zgarishlar yo‘q' : 'Изменений не было'}
    >
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
        {(data?.rows ?? []).map((h, i) => (
          <li key={`${h.at}-${i}`} className="px-4 py-3 flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
              <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
                {(isUz ? ACTION_TEXT[h.action]?.uz : ACTION_TEXT[h.action]?.ru) ?? h.action}
              </span>
              <span className="text-[10px] text-zinc-500 shrink-0">{fmtWhen(h.at)}</span>
              {h.user && <span className="text-[11px] text-zinc-500 break-words">{h.user}</span>}
            </div>
            <ul className="flex flex-col gap-0.5">
              {Object.entries(h.changes).map(([field, v]) => (
                <li key={field} className="text-[11px] text-zinc-500 break-words">
                  {(isUz ? FIELD_TEXT[field]?.uz : FIELD_TEXT[field]?.ru) ?? field}:{' '}
                  <span className="line-through">{valueText(v.from, isUz)}</span>{' '}
                  <span className="text-zinc-700 dark:text-zinc-300">
                    → {valueText(v.to, isUz)}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Shell>
  );
};
