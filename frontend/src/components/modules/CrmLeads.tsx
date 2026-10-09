/**
 * CRM Э2 — обращения (лиды), ТЗ 8.1.
 *
 * Лид — это ещё не клиент: позвонили, спросили цену, назвали имя и телефон.
 * Половина таких звонков ничем не кончается, поэтому в базе контрагентов, по
 * которой выставляют счета, им не место, пока не станет ясно, что это сделка.
 *
 * Экран отвечает на два вопроса менеджера: что сегодня пришло и что с этим
 * делать. Поэтому наверху разбивка по статусам — она же фильтр, а в строке
 * обращения ровно три действия: взять в работу, отказать с причиной,
 * превратить в клиента.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Check, Globe, Phone, Plus, Search, UserPlus, X } from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { errorText } from '../../context/DashboardContext';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import type { CrmLeadRow, CrmLeadStatus, CrmPartnerOptions, CrmLeadMarks } from '../../types/api';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, ErrorBox, FIELD, Skeleton } from './warehouse-ui';
import { CustomSelect } from '../common/CustomSelect';
import { refName } from '../../lib/formatters';

const STATUS: Record<CrmLeadStatus, { ru: string; uz: string; tone: string }> = {
  new: {
    ru: 'Новое',
    uz: 'Yangi',
    tone: 'text-sky-700 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/40 border-sky-200 dark:border-sky-900/60',
  },
  qualified: {
    ru: 'В работе',
    uz: 'Ishda',
    tone: 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900/60',
  },
  converted: {
    ru: 'Стал клиентом',
    uz: 'Mijoz bo‘ldi',
    tone: 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/60',
  },
  rejected: {
    ru: 'Отказ',
    uz: 'Rad etilgan',
    tone: 'text-zinc-600 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800/60 border-zinc-200 dark:border-zinc-700',
  },
};

const ORDER: CrmLeadStatus[] = ['new', 'qualified', 'converted', 'rejected'];

export const CrmLeads: React.FC = () => {
  const { locale, company } = useApp();
  const { can } = useAuth();
  const isUz = locale === 'uz';
  const canEdit = can('crm.edit');

  const [rows, setRows] = useState<CrmLeadRow[] | null>(null);
  const [byStatus, setByStatus] = useState<Partial<Record<CrmLeadStatus, number>>>({});
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<CrmLeadStatus | ''>('');
  const [options, setOptions] = useState<CrmPartnerOptions | null>(null);
  const [adding, setAdding] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.crm.leads({
        search: search.trim() || undefined,
        status: status || undefined,
        limit: 100,
      });
      setRows(res.data.rows);
      setByStatus(res.data.byStatus);
      setTotal(res.data.total);
    } catch (e) {
      setRows([]);
      setError(e as ApiError);
    }
    // Компания в зависимостях: её меняют переключателем в шапке, и без
    // перечитывания экран остался бы с данными прежней, ничем об этом не сказав.
  }, [search, status, company]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (!options) {
      apiClient.crm
        .partnerOptions()
        .then((r) => setOptions(r.data))
        .catch(() => setOptions({ managers: [], sources: [], priceTypes: [], companies: [] }));
    }
  }, [options]);

  const act = async (uid: string, run: () => Promise<string | null>) => {
    setActing(uid);
    setError(null);
    setNote(null);
    try {
      const said = await run();
      if (said) setNote(said);
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Разбивка по статусам — она же фильтр: «сегодня пришло семь» и
          «покажи эти семь» это один и тот же вопрос. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setStatus('')}
          className={`h-7 px-3 rounded-lg text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap ${
            status === ''
              ? 'bg-zinc-900 text-zinc-50 border-zinc-900 dark:bg-zinc-50 dark:text-zinc-900 dark:border-zinc-50'
              : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
        >
          {isUz ? 'Hammasi' : 'Все'} {total}
        </button>
        {ORDER.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(status === s ? '' : s)}
            className={`h-7 px-3 rounded-lg text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap ${
              status === s
                ? 'bg-zinc-900 text-zinc-50 border-zinc-900 dark:bg-zinc-50 dark:text-zinc-900 dark:border-zinc-50'
                : STATUS[s].tone
            }`}
          >
            {isUz ? STATUS[s].uz : STATUS[s].ru} {byStatus[s] ?? 0}
          </button>
        ))}
      </div>

      <div className={`${CARD} flex flex-col min-w-0`}>
        <div className="px-4 py-3 flex flex-wrap items-center gap-2 border-b border-zinc-200 dark:border-zinc-800">
          <div className="relative flex-1 min-w-0">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={isUz ? 'Ism, telefon yoki pochta' : 'Имя, телефон или почта'}
              aria-label={isUz ? 'Murojaatlarni qidirish' : 'Поиск обращений'}
              className={`${FIELD} pl-9`}
            />
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={() => setAdding((v) => !v)}
              className={`${BTN_PRIMARY} inline-flex items-center gap-1.5 whitespace-nowrap shrink-0`}
            >
              <Plus className="w-3.5 h-3.5" />
              {isUz ? 'Murojaat qabul qilish' : 'Принять обращение'}
            </button>
          )}
        </div>

        {adding && (
          <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
            <LeadForm
              isUz={isUz}
              options={options}
              onCancel={() => setAdding(false)}
              onDone={async () => {
                setAdding(false);
                await load();
              }}
            />
          </div>
        )}

        {note && (
          <p className="px-4 py-2 text-[11px] text-emerald-700 dark:text-emerald-400 break-words border-b border-zinc-200 dark:border-zinc-800">
            {note}
          </p>
        )}
        {error && (
          <p className="px-4 py-2 text-[11px] text-amber-700 dark:text-amber-400 break-words border-b border-zinc-200 dark:border-zinc-800">
            {errorText(error, isUz)}
          </p>
        )}

        {rows === null ? (
          <Skeleton />
        ) : rows.length === 0 ? (
          <Empty text={isUz ? 'Murojaatlar yo‘q' : 'Обращений нет'} />
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
            {rows.map((l) => (
              <LeadRow
                key={l.uid}
                lead={l}
                isUz={isUz}
                canEdit={canEdit}
                busy={acting === l.uid}
                onAct={act}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

const LeadRow: React.FC<{
  lead: CrmLeadRow;
  isUz: boolean;
  canEdit: boolean;
  busy: boolean;
  onAct: (uid: string, run: () => Promise<string | null>) => Promise<void>;
}> = ({ lead, isUz, canEdit, busy, onAct }) => {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [marks, setMarks] = useState(false);
  const s = STATUS[lead.status];
  const open = lead.status === 'new' || lead.status === 'qualified';

  // Откуда пришло и кто ведёт — это не про самого человека, а про учёт.
  // На широком экране они уходят вправо, к кнопкам: слева остаётся то, по
  // чему обращение узнают — имя, телефон, почта, что просил.
  const meta = [lead.source?.name, lead.manager?.name].filter(Boolean) as string[];

  /* Метки визита не вводятся руками — их приносит форма сайта. Если их нет,
     кнопки тоже нет: пустое окно «откуда пришёл» хуже его отсутствия. */
  const marksButton = lead.marks?.has ? (
    <button
      type="button"
      onClick={() => setMarks(true)}
      title={isUz ? 'Tashrif belgilari' : 'Метки визита: откуда пришёл этот человек'}
      className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 underline underline-offset-2 cursor-pointer"
    >
      <Globe className="w-3 h-3" />
      {isUz ? 'Qayerdan kelgan' : 'Откуда пришёл'}
    </button>
  ) : null;

  const actions = (
    <>
      {lead.status === 'new' && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void onAct(lead.uid, async () => {
              await apiClient.crm.updateLead(lead.uid, { status: 'qualified' });
              return null;
            })
          }
          className={`${BTN_GHOST} inline-flex items-center gap-1.5 whitespace-nowrap`}
        >
          <Check className="w-3.5 h-3.5" />
          {isUz ? 'Ishga olish' : 'Взять в работу'}
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void onAct(lead.uid, async () => {
            const res = await apiClient.crm.convertLead(lead.uid, { withDeal: true });
            return res.data.alreadyConverted
              ? isUz
                ? 'Bu murojaat allaqachon mijozga aylangan.'
                : 'Это обращение уже было превращено в клиента — открыта прежняя карточка.'
              : isUz
                ? 'Mijoz va bitim yaratildi.'
                : 'Клиент заведён, сделка создана в первой стадии воронки.';
          })
        }
        className={`${BTN_PRIMARY} inline-flex items-center gap-1.5 whitespace-nowrap`}
      >
        <UserPlus className="w-3.5 h-3.5" />
        {isUz ? 'Mijozga aylantirish' : 'Сделать клиентом'}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setRejecting(true)}
        className={`${BTN_GHOST} whitespace-nowrap`}
      >
        {isUz ? 'Rad etish' : 'Отказ'}
      </button>
    </>
  );
  return (
    <li className="px-4 py-3 flex flex-col gap-2">
      {/*
        На широком экране строка делится надвое: слева — кто обратился,
        справа — учёт и действия. До 1024 точек колонки складываются в
        столбик: три кнопки и имя в одну строку там не помещаются, и
        правая колонка съела бы имя до многоточия.
      */}
      <div className="flex flex-col gap-2 min-w-0 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
        <div className="flex flex-col gap-2 min-w-0 lg:flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
            <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
              {lead.name}
            </span>
            <span className={`px-1.5 rounded border text-[10px] shrink-0 ${s.tone}`}>
              {isUz ? s.uz : s.ru}
            </span>
            {lead.partner && (
              <span className="text-[10px] text-zinc-500 break-words">→ {lead.partner.name}</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
            {lead.phone && (
              <span className="inline-flex items-center gap-1 font-mono">
                <Phone className="w-3 h-3" />
                {lead.phone}
              </span>
            )}
            {lead.email && <span className="font-mono break-words">{lead.email}</span>}
          </div>

          {/* Узкий экран: учётные подписи отдельной строкой — в строку контактов
              они дописывались хвостом и рвались по-разному в каждой карточке. */}
          {meta.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-500 lg:hidden">
              {meta.map((m) => (
                <span key={m}>{m}</span>
              ))}
              {marksButton}
            </div>
          )}

          {lead.comment && (
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400 break-words">
              {lead.comment}
            </p>
          )}
          {lead.rejectReason && (
            <p className="text-[11px] text-zinc-500 break-words">
              {isUz ? 'Rad etish sababi' : 'Причина отказа'}: {lead.rejectReason}
            </p>
          )}
        </div>

        <div className="hidden lg:flex flex-col items-end gap-2 shrink-0">
          {(meta.length > 0 || marksButton) && (
            <div className="flex flex-wrap justify-end items-center gap-x-3 text-[11px] text-zinc-500">
              {meta.map((m) => (
                <span key={m}>{m}</span>
              ))}
              {marksButton}
            </div>
          )}
          {canEdit && open && !rejecting && (
            <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
          )}
        </div>
      </div>

      {canEdit && open && !rejecting && (
        <div className="flex flex-wrap items-center gap-2 lg:hidden">
          {actions}
        </div>
      )}

      {marks && lead.marks && (
        <MarksDialog
          marks={lead.marks}
          sourceName={lead.source?.name ?? null}
          leadAt={lead.createdAt}
          isUz={isUz}
          onClose={() => setMarks(false)}
        />
      )}

      {rejecting && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={isUz ? 'Nega ketdi?' : 'Почему ушёл?'}
            aria-label={isUz ? 'Rad etish sababi' : 'Причина отказа'}
            className={`${FIELD} flex-1 min-w-0`}
          />
          <button
            type="button"
            disabled={busy || reason.trim().length < 3}
            onClick={() =>
              void onAct(lead.uid, async () => {
                await apiClient.crm.updateLead(lead.uid, {
                  status: 'rejected',
                  rejectReason: reason.trim(),
                });
                setRejecting(false);
                setReason('');
                return null;
              })
            }
            className={`${BTN_GHOST} whitespace-nowrap shrink-0`}
          >
            {isUz ? 'Saqlash' : 'Сохранить'}
          </button>
          <button
            type="button"
            onClick={() => setRejecting(false)}
            aria-label={isUz ? 'Bekor qilish' : 'Отменить отказ'}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </li>
  );
};

/** Склонение дней: «1 день», «2 дня», «5 дней». */
const days = (n: number, isUz: boolean) => {
  if (isUz) return `${n} kun`;
  const t = n % 100;
  if (t >= 11 && t <= 14) return `${n} дней`;
  const o = n % 10;
  if (o === 1) return `${n} день`;
  if (o >= 2 && o <= 4) return `${n} дня`;
  return `${n} дней`;
};

/** Канал визита словами. utm_medium — язык рекламщика, менеджеру нужен перевод. */
const CHANNEL: Record<string, { ru: string; uz: string; tone: string }> = {
  organic: {
    ru: 'Поиск',
    uz: 'Qidiruv',
    tone: 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/60',
  },
  cpc: {
    ru: 'Реклама',
    uz: 'Reklama',
    tone: 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900/60',
  },
  referral: {
    ru: 'Переход по ссылке',
    uz: 'Havola orqali',
    tone: 'text-sky-700 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/40 border-sky-200 dark:border-sky-900/60',
  },
  social: {
    ru: 'Соцсети',
    uz: 'Ijtimoiy tarmoq',
    tone: 'text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/40 border-violet-200 dark:border-violet-900/60',
  },
  email: {
    ru: 'Письмо',
    uz: 'Xat',
    tone: 'text-sky-700 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/40 border-sky-200 dark:border-sky-900/60',
  },
};

const CHIP_NEUTRAL =
  'text-zinc-600 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800/60 border-zinc-200 dark:border-zinc-700';

/** Короткий вид адреса: домен отдельно от пути — путь и есть страница входа. */
const urlParts = (u: string): { host: string; rest: string } => {
  try {
    const x = new URL(u);
    return { host: x.host.replace(/^www\./, ''), rest: `${x.pathname}${x.search}`.replace(/^\/$/, '') };
  } catch {
    return { host: u, rest: '' };
  }
};

const Chip: React.FC<{ text: string; tone?: string; className?: string }> = ({
  text,
  tone,
  className,
}) => (
  <span
    className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-medium whitespace-nowrap ${tone ?? CHIP_NEUTRAL} ${className ?? ''}`}
  >
    {text}
  </span>
);

/**
 * Строка метки. Человеческое название сверху, техническое имя под ним —
 * менеджер читает первое, веб-мастеру нужно второе, и спорить им не о чем.
 */
const MarkRow: React.FC<{ label: string; hint?: string; value: string; link?: boolean }> = ({
  label,
  hint,
  value,
  link,
}) => {
  const parts = link ? urlParts(value) : null;
  return (
    <div className="grid grid-cols-[5.75rem_minmax(0,1fr)] gap-x-2.5 items-baseline">
      <span className="text-[11px] text-zinc-500 leading-tight min-w-0">
        {label}
        {hint && <span className="block font-mono text-[9px] text-zinc-400 truncate">{hint}</span>}
      </span>
      {parts ? (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          title={value}
          className="block truncate text-[11px] text-zinc-800 dark:text-zinc-200 underline decoration-zinc-300 dark:decoration-zinc-700 underline-offset-2 hover:decoration-zinc-500"
        >
          {parts.host}
          {parts.rest && <span className="text-zinc-500">{parts.rest}</span>}
        </a>
      ) : (
        <span className="text-[11px] text-zinc-800 dark:text-zinc-200 break-words">{value}</span>
      )}
    </div>
  );
};

type MarkField = { label: string; hint?: string; value: string | null; link?: boolean };

/** Одно касание: шапка со шагом и датой, заполненные метки, список непереданных. */
const Touch: React.FC<{
  step: number;
  title: string;
  at: string | null;
  medium: string | null;
  fields: MarkField[];
  isUz: boolean;
}> = ({ step, title, at, medium, fields, isUz }) => {
  const filled = fields.filter((f) => f.value && f.value.trim());
  const missing = fields.filter((f) => !f.value || !f.value.trim());
  const ch = medium ? CHANNEL[medium.toLowerCase()] : undefined;
  return (
    <section
      data-touch
      className="flex flex-col min-w-0 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40"
    >
      <header className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-zinc-200 dark:border-zinc-800">
        <span className="flex items-center gap-2 min-w-0">
          <span className="w-4.5 h-4.5 shrink-0 rounded-full bg-zinc-900 dark:bg-zinc-100 text-zinc-50 dark:text-zinc-900 text-[10px] font-semibold flex items-center justify-center">
            {step}
          </span>
          <span className="text-[11px] font-medium text-zinc-900 dark:text-zinc-100 truncate">
            {title}
          </span>
        </span>
        {at && <span className="text-[10px] text-zinc-500 shrink-0">{at}</span>}
      </header>
      <div className="flex flex-col gap-1.5 p-2.5 min-w-0">
        {medium && (
          <Chip text={ch ? (isUz ? ch.uz : ch.ru) : medium} tone={ch?.tone} className="self-start" />
        )}
        {filled.length === 0 && (
          <span className="text-[11px] text-zinc-500">
            {isUz ? 'Belgilar yuborilmagan' : 'Меток не было'}
          </span>
        )}
        {filled.map((f) => (
          <MarkRow key={f.label} label={f.label} hint={f.hint} value={f.value as string} link={f.link} />
        ))}
        {missing.length > 0 && (
          <p className="text-[10px] text-zinc-400 dark:text-zinc-500 break-words pt-0.5">
            {isUz ? 'Yuborilmagan' : 'Не передано'}:{' '}
            {missing.map((f) => f.label.toLowerCase()).join(', ')}
          </p>
        )}
      </div>
    </section>
  );
};

/**
 * Метки визита: откуда пришёл человек, оставивший заявку.
 *
 * Окно отвечает одной строкой сверху — каким источником система это признала
 * и почему, — а метки лежат ниже доказательством. Два касания стоят рядом и
 * по времени намеренно. По последнему считают рекламу: кликнул и оставил
 * заявку. По первому — поиск и содержание сайта: нашли в Google, ушли думать,
 * вернулись через неделю прямым заходом. Если смотреть одно, половина работы
 * остаётся неучтённой.
 */
const MarksDialog: React.FC<{
  marks: CrmLeadMarks;
  sourceName: string | null;
  leadAt: string;
  isUz: boolean;
  onClose: () => void;
}> = ({ marks, sourceName, leadAt, isUz, onClose }) => {
  const dt = (v: string | null) =>
    v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : null;

  // Фраза собирается по первому касанию: именно оно отвечает на вопрос
  // «как нас нашли». Последнее говорит лишь, откуда дожали.
  const f = marks.first;
  const l = marks.last;
  const lead = f.source || f.medium || f.landing || f.referrer ? f : l;
  const phrase = (() => {
    if (l.term) {
      return isUz
        ? `«${l.term}» soʻrovi boʻyicha ${l.source ?? 'qidiruvdan'} orqali topishgan`
        : `Нашли в ${l.source ?? 'поиске'} по запросу «${l.term}»`;
    }
    if (lead.source) {
      return isUz
        ? `${lead.source} orqali kelgan${lead.campaign ? `, «${lead.campaign}» kampaniyasi` : ''}`
        : `Пришёл с ${lead.source}${lead.campaign ? `, кампания «${lead.campaign}»` : ''}`;
    }
    if (lead.referrer) {
      return isUz
        ? `${urlParts(lead.referrer).host} saytidan oʻtgan`
        : `Перешёл с ${urlParts(lead.referrer).host}`;
    }
    return isUz
      ? 'Belgilarsiz, toʻgʻridan-toʻgʻri kirgan'
      : 'Зашёл напрямую, без меток';
  })();

  const gap =
    f.at && leadAt
      ? Math.max(0, Math.round((Date.parse(leadAt) - Date.parse(f.at)) / 86400000))
      : null;
  const gapText =
    gap === null
      ? null
      : gap === 0
        ? isUz
          ? 'Oʻsha kuni ariza qoldirgan'
          : 'Зашёл и оставил заявку в тот же день'
        : isUz
          ? `Birinchi tashrif va ariza orasida ${days(gap, true)}`
          : `Между первым заходом и заявкой ${days(gap, false)}`;

  const hasFirst = !!(f.at || f.source || f.medium || f.landing || f.referrer);

  const firstFields: MarkField[] = [
    { label: isUz ? 'Manba' : 'Источник', hint: 'utm_source', value: f.source },
    { label: isUz ? 'Kanal' : 'Канал', hint: 'utm_medium', value: f.medium },
    { label: isUz ? 'Kampaniya' : 'Кампания', hint: 'utm_campaign', value: f.campaign },
    { label: isUz ? 'Kirish sahifasi' : 'Страница входа', value: f.landing, link: true },
    { label: isUz ? 'Oʻtish manbai' : 'Откуда перешёл', value: f.referrer, link: true },
  ];
  const lastFields: MarkField[] = [
    { label: isUz ? 'Manba' : 'Источник', hint: 'utm_source', value: l.source },
    { label: isUz ? 'Kanal' : 'Канал', hint: 'utm_medium', value: l.medium },
    { label: isUz ? 'Kampaniya' : 'Кампания', hint: 'utm_campaign', value: l.campaign },
    { label: isUz ? 'Obyekt' : 'Объявление', hint: 'utm_content', value: l.content },
    { label: isUz ? 'Kirish sahifasi' : 'Страница входа', value: l.landing, link: true },
    { label: isUz ? 'Oʻtish manbai' : 'Откуда перешёл', value: l.referrer, link: true },
    { label: isUz ? 'Klik belgisi' : 'Метка клика', value: l.clickId },
  ];

  const tech: { k: string; v: string }[] = [];
  if (marks.formCode) tech.push({ k: isUz ? 'Shakl' : 'Форма', v: marks.formCode });
  if (marks.visitorId) tech.push({ k: isUz ? 'Tashrifchi' : 'Посетитель', v: marks.visitorId });
  if (marks.analyticsId) tech.push({ k: isUz ? 'Analitika' : 'Аналитика', v: marks.analyticsId });

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div
        className={`${CARD} w-full max-w-3xl max-h-[90vh] overflow-y-auto p-4 flex flex-col gap-3`}
        role="dialog"
        aria-label={isUz ? 'Tashrif belgilari' : 'Метки визита'}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {isUz ? 'Qayerdan kelgan' : 'Откуда пришёл'}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={isUz ? 'Yopish' : 'Закрыть метки визита'}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Ответ. Всё остальное в окне — доказательство к этой строке. */}
        <div className="flex flex-col gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 px-3 py-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Globe className="w-4 h-4 text-zinc-400 shrink-0" />
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {sourceName || f.sourceName || (isUz ? 'Manba aniqlanmagan' : 'Источник не определён')}
            </span>
            {l.medium && (
              <Chip
                text={
                  CHANNEL[l.medium.toLowerCase()]
                    ? isUz
                      ? CHANNEL[l.medium.toLowerCase()].uz
                      : CHANNEL[l.medium.toLowerCase()].ru
                    : l.medium
                }
                tone={CHANNEL[l.medium.toLowerCase()]?.tone}
              />
            )}
          </div>
          <p className="text-[12px] text-zinc-700 dark:text-zinc-300 break-words">{phrase}</p>
          {gapText && <p className="text-[10px] text-zinc-500">{gapText}</p>}
        </div>

        {/* Поисковый запрос стоит отдельно: ради него и делают SEO. */}
        {l.term && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 min-w-0">
            <Search className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="flex flex-col min-w-0">
              <span className="text-[10px] text-emerald-700/80 dark:text-emerald-400/80">
                {isUz ? 'Qidiruv soʻrovi' : 'Поисковый запрос'}
              </span>
              <span className="text-[12px] font-medium text-emerald-900 dark:text-emerald-200 break-words">
                {l.term}
              </span>
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 items-start">
          {hasFirst ? (
            <Touch
              step={1}
              title={isUz ? 'Birinchi tashrif' : 'Первый визит'}
              at={dt(f.at)}
              medium={f.medium}
              fields={firstFields}
              isUz={isUz}
            />
          ) : (
            <section
              data-touch
              className="flex flex-col gap-1 min-w-0 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 px-2.5 py-3"
            >
              <span className="text-[11px] font-medium text-zinc-500">
                {isUz ? 'Birinchi tashrif' : 'Первый визит'}
              </span>
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500 break-words">
                {isUz
                  ? 'Sayt birinchi tashrifni yubormagan: skript oʻrnatilmagan yoki tashrifchi belgilarni tozalagan.'
                  : 'Сайт не передал первое касание: скрипт не стоит или посетитель очистил память браузера.'}
              </span>
            </section>
          )}
          <Touch
            step={2}
            title={isUz ? 'Ariza qoldirilgan tashrif' : 'Визит с заявкой'}
            at={dt(leadAt)}
            medium={l.medium}
            fields={lastFields}
            isUz={isUz}
          />
        </div>

        {tech.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 border-t border-zinc-200 dark:border-zinc-800">
            {tech.map((x) => (
              <span key={x.k} className="flex items-center gap-1 min-w-0">
                <span className="text-[10px] text-zinc-500">{x.k}</span>
                <span className="font-mono text-[10px] text-zinc-700 dark:text-zinc-300 truncate max-w-[12rem]">
                  {x.v}
                </span>
              </span>
            ))}
          </div>
        )}

        <p className="text-[10px] text-zinc-500 break-words">
          {isUz
            ? 'Belgilarni sayt shakli yuboradi, ularni qoʻlda kiritib boʻlmaydi.'
            : 'Метки приходят с формы сайта и руками не вводятся. Чего нет в списке — того форма не передала или визит был прямым.'}
        </p>
      </div>
    </div>
  );
};


const LeadForm: React.FC<{
  isUz: boolean;
  options: CrmPartnerOptions | null;
  onCancel: () => void;
  onDone: () => Promise<void>;
}> = ({ isUz, options, onCancel, onDone }) => {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [comment, setComment] = useState('');
  const [sourceUid, setSourceUid] = useState('');
  const [managerUid, setManagerUid] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  // Источник по умолчанию не подставляем: он обязателен, и подставленный
  // молча «сайт» испортил бы ровно тот отчёт, ради которого его спрашивают.
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Kim murojaat qildi' : 'Кто обратился'}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={FIELD} />
        </label>
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Telefon' : 'Телефон'}</span>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+998 90 000 00 00"
            className={`${FIELD} font-mono`}
          />
        </label>
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Manba' : 'Источник'}</span>
          <CustomSelect
            ariaLabel={isUz ? 'Murojaat manbasi' : 'Источник обращения'}
            value={sourceUid}
            onChange={setSourceUid}
            options={[
              { value: '', label: isUz ? 'tanlang' : 'выберите' },
              ...(options?.sources ?? []).map((s) => ({
                value: s.uid,
                label: refName(s, isUz),
              })),
            ]}
          />
        </div>
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Menejer' : 'Менеджер'}</span>
          <CustomSelect
            ariaLabel={isUz ? 'Mas’ul menejer' : 'Ответственный менеджер'}
            value={managerUid}
            onChange={setManagerUid}
            options={[
              { value: '', label: isUz ? 'ko‘rsatilmagan' : 'не указан' },
              ...(options?.managers ?? []).map((m) => ({ value: m.uid, label: m.name })),
            ]}
          />
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-zinc-500">{isUz ? 'Nima so‘radi' : 'Что спрашивал'}</span>
        <input value={comment} onChange={(e) => setComment(e.target.value)} className={FIELD} />
      </label>

      {!sourceUid && (
        <p className="text-[11px] text-zinc-400 break-words">
          {isUz
            ? 'Manba majburiy: usiz manbalar bo‘yicha hisobot bo‘sh qoladi.'
            : 'Источник обязателен: без него отчёт по источникам пуст, а рекламу оплачивают по этому числу.'}
        </p>
      )}
      {error && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400 break-words">
          {errorText(error, isUz)}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || name.trim().length < 2 || !sourceUid}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await apiClient.crm.createLead({
                sourceUid,
                name: name.trim(),
                phone: phone.trim() || undefined,
                comment: comment.trim() || undefined,
                managerUid: managerUid || undefined,
              });
              await onDone();
            } catch (e) {
              setError(e as ApiError);
            } finally {
              setBusy(false);
            }
          }}
          className={`${BTN_PRIMARY} whitespace-nowrap`}
        >
          {isUz ? 'Qabul qilish' : 'Принять'}
        </button>
        <button type="button" onClick={onCancel} className={`${BTN_GHOST} whitespace-nowrap`}>
          {isUz ? 'Bekor qilish' : 'Отмена'}
        </button>
      </div>
    </div>
  );
};
