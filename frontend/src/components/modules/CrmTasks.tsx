/**
 * CRM Э4 — задачи и лента активностей (ТЗ 8.4).
 *
 * Экран отвечает на два вопроса менеджера: что я должен сделать и что уже
 * было. Поэтому он разделён на «Задачи» и «Ленту», а не свален в один список:
 * у задачи есть срок и она бывает просрочена, у активности срока нет — она уже
 * состоялась.
 *
 * Первая вкладка счётчиков — «Просрочено», и она открыта по умолчанию, когда
 * просроченное есть. Ради этого модуль и делается: список, где всё сделано
 * вовремя, никому не нужен.
 *
 * Чего здесь нет: уведомлений ответственному и руководителю (ТЗ 8.4 `[С]`) —
 * рассылка идёт через общий тракт уведомлений, он вне этого модуля. Просрочку
 * видно счётчиком и цветом срока.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Clock,
  FileText,
  Mail,
  Phone,
  Plus,
  StickyNote,
  Users,
  X,
} from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { errorText } from '../../context/DashboardContext';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import type {
  CrmActivityRow,
  CrmDealRow,
  CrmPartnerRow,
  CrmTaskRow,
  CrmTaskScope,
  CrmTaskTypeRow,
  CrmTasksPage,
} from '../../types/api';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, FIELD, Skeleton } from './warehouse-ui';
import { CustomSelect } from '../common/CustomSelect';
import { refName } from '../../lib/formatters';

/**
 * Значок типа задачи. Тип теперь заводит заказчик (Э7), поэтому карта знает
 * только привычные коды, а незнакомому достаётся заметка: экран не должен
 * падать оттого, что в справочнике появился «выезд на объект».
 */
const TYPE_ICON: Record<string, typeof Phone> = {
  call: Phone,
  meeting: Users,
  letter: Mail,
  document: FileText,
  site_visit: Users,
  other: StickyNote,
};
const typeIcon = (code: string) => TYPE_ICON[code] ?? StickyNote;

const ACT_ICON = { call: Phone, meeting: Users, letter: Mail, note: StickyNote } as const;
const ACT_NAME = {
  call: { ru: 'Звонок', uz: 'Qo‘ng‘iroq' },
  meeting: { ru: 'Встреча', uz: 'Uchrashuv' },
  letter: { ru: 'Письмо', uz: 'Xat' },
  note: { ru: 'Заметка', uz: 'Eslatma' },
} as const;

const SCOPES: { key: CrmTaskScope; ru: string; uz: string }[] = [
  { key: 'overdue', ru: 'Просрочено', uz: 'Muddati o‘tgan' },
  { key: 'today', ru: 'Сегодня', uz: 'Bugun' },
  { key: 'week', ru: 'Неделя', uz: 'Hafta' },
  { key: 'open', ru: 'Открытые', uz: 'Ochiq' },
  { key: 'closed', ru: 'Закрытые', uz: 'Yopilgan' },
  { key: 'all', ru: 'Все', uz: 'Hammasi' },
];

/**
 * Срок показываем по Ташкенту, а не по таймзоне браузера: задача «сегодня к
 * 17:00» у менеджера, открывшего систему из другого пояса, не должна выглядеть
 * вчерашней.
 */
const when = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Asia/Tashkent',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const fmtWhen = (iso: string | null) => (iso ? when.format(new Date(iso)).replace(', ', ' ') : '—');

/** Значение для `datetime-local`: завтра, 10:00 по месту. */
function defaultDue(): string {
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(10, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const CrmTasks: React.FC = () => {
  const { locale, company } = useApp();
  const { can } = useAuth();
  const isUz = locale === 'uz';
  const canEdit = can('crm.edit');

  const [view, setView] = useState<'tasks' | 'feed'>('tasks');
  const [scope, setScope] = useState<CrmTaskScope>('open');
  const [page, setPage] = useState<CrmTasksPage | null>(null);
  const [feed, setFeed] = useState<CrmActivityRow[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [adding, setAdding] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  /** Просрочку открываем сами — но один раз, чтобы не перебивать выбор менеджера. */
  const [jumped, setJumped] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.crm.tasks({ scope, limit: 100 });
      setPage(res.data);
    } catch (e) {
      setPage(null);
      setError(e as ApiError);
    }
  }, [scope, company]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (view !== 'feed' || feed !== null) return;
    apiClient.crm
      .activities({ limit: 50 })
      .then((r) => setFeed(r.data.rows))
      .catch((e) => {
        setFeed([]);
        setError(e as ApiError);
      });
  }, [view, feed]);

  useEffect(() => {
    if (jumped || !page) return;
    setJumped(true);
    if (page.counts.overdue > 0) setScope('overdue');
  }, [page, jumped]);

  const act = async (uid: string, run: () => Promise<void>) => {
    setActing(uid);
    setError(null);
    try {
      await run();
      setFeed(null);
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setActing(null);
    }
  };

  const counts = page?.counts;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {view === 'tasks' &&
          SCOPES.map((s) => {
            const n = counts?.[s.key] ?? 0;
            const hot = s.key === 'overdue' && n > 0;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setScope(s.key)}
                className={`h-7 px-3 rounded-lg text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                  scope === s.key
                    ? 'bg-zinc-900 text-zinc-50 border-zinc-900 dark:bg-zinc-50 dark:text-zinc-900 dark:border-zinc-50'
                    : hot
                      ? 'text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900/60'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                {isUz ? s.uz : s.ru} {n}
              </button>
            );
          })}

        <div className="flex items-center border border-zinc-200 dark:border-zinc-800 rounded-lg p-0.5 bg-zinc-50 dark:bg-zinc-900 ms-auto shrink-0">
          {(
            [
              ['tasks', isUz ? 'Vazifalar' : 'Задачи'],
              ['feed', isUz ? 'Tasmasi' : 'Лента'],
            ] as const
          ).map(([key, text]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => setView(key)}
              className={`px-3 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                view === key
                  ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs'
                  : 'text-zinc-500'
              }`}
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      <div className={`${CARD} flex flex-col min-w-0`}>
        {view === 'tasks' && canEdit && (
          <div className="px-4 py-3 flex flex-wrap items-center gap-2 border-b border-zinc-200 dark:border-zinc-800">
            <p className="text-[11px] text-zinc-500 break-words min-w-0 flex-1">
              {isUz
                ? 'Yopilgan vazifa natijasi bilan mijoz tasmasiga tushadi.'
                : 'Закрытая задача с результатом сама ложится в ленту клиента.'}
            </p>
            <button
              type="button"
              onClick={() => setAdding((v) => !v)}
              className={`${BTN_PRIMARY} inline-flex items-center gap-1.5 whitespace-nowrap shrink-0`}
            >
              <Plus className="w-3.5 h-3.5" />
              {isUz ? 'Vazifa qo‘shish' : 'Новая задача'}
            </button>
          </div>
        )}

        {adding && view === 'tasks' && (
          <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
            <TaskForm
              isUz={isUz}
              onCancel={() => setAdding(false)}
              onDone={async () => {
                setAdding(false);
                await load();
              }}
            />
          </div>
        )}

        {error && (
          <p className="px-4 py-2 text-[11px] text-amber-700 dark:text-amber-400 break-words border-b border-zinc-200 dark:border-zinc-800">
            {errorText(error, isUz)}
          </p>
        )}

        {view === 'tasks' ? (
          page === null ? (
            <Skeleton />
          ) : page.rows.length === 0 ? (
            <Empty
              text={
                scope === 'overdue'
                  ? isUz
                    ? 'Muddati o‘tgan vazifa yo‘q'
                    : 'Просроченных задач нет'
                  : isUz
                    ? 'Vazifalar yo‘q'
                    : 'Задач нет'
              }
            />
          ) : (
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
              {page.rows.map((t) => (
                <TaskRow
                  key={t.uid}
                  task={t}
                  isUz={isUz}
                  canEdit={canEdit}
                  busy={acting === t.uid}
                  onAct={act}
                />
              ))}
            </ul>
          )
        ) : feed === null ? (
          <Skeleton />
        ) : feed.length === 0 ? (
          <Empty text={isUz ? 'Tasmada yozuv yo‘q' : 'В ленте пока пусто'} />
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
            {feed.map((a) => (
              <ActivityRow key={a.uid} row={a} isUz={isUz} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

const TaskRow: React.FC<{
  task: CrmTaskRow;
  isUz: boolean;
  canEdit: boolean;
  busy: boolean;
  onAct: (uid: string, run: () => Promise<void>) => Promise<void>;
}> = ({ task, isUz, canEdit, busy, onAct }) => {
  const [closing, setClosing] = useState<'done' | 'cancel' | null>(null);
  const [text, setText] = useState('');
  const TypeIcon = typeIcon(task.type.code);
  const open = task.status === 'open';

  return (
    <li className="px-4 py-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
        <TypeIcon className="w-3.5 h-3.5 text-zinc-400 shrink-0 self-center" />
        <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
          {task.title}
        </span>
        <span
          className={`inline-flex items-center gap-1 px-1.5 rounded border text-[10px] shrink-0 ${
            task.isOverdue
              ? 'text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900/60'
              : open
                ? 'text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700'
                : 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/60'
          }`}
        >
          <Clock className="w-3 h-3" />
          {fmtWhen(task.dueAt)}
        </span>
        {!open && (
          <span className="text-[10px] text-zinc-500 shrink-0">
            {task.status === 'done'
              ? isUz
                ? 'bajarildi'
                : 'сделана'
              : isUz
                ? 'bekor qilindi'
                : 'отменена'}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
        <span>{refName(task.type, isUz)}</span>
        {task.partner && <span className="break-words">{task.partner.name}</span>}
        {task.deal && (
          <span className="break-words font-mono">
            {task.deal.number}
          </span>
        )}
        {task.assignee && <span className="break-words">{task.assignee.name}</span>}
      </div>

      {task.description && (
        <p className="text-[11px] text-zinc-600 dark:text-zinc-400 break-words">
          {task.description}
        </p>
      )}
      {task.result && (
        <p className="text-[11px] text-zinc-600 dark:text-zinc-400 break-words">
          {isUz ? 'Natija' : 'Результат'}: {task.result}
        </p>
      )}

      {canEdit && open && !closing && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setText('');
              setClosing('done');
            }}
            className={`${BTN_PRIMARY} inline-flex items-center gap-1.5 whitespace-nowrap`}
          >
            <Check className="w-3.5 h-3.5" />
            {isUz ? 'Bajarildi' : 'Сделано'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setText('');
              setClosing('cancel');
            }}
            className={`${BTN_GHOST} whitespace-nowrap`}
          >
            {isUz ? 'Bekor qilish' : 'Отменить'}
          </button>
        </div>
      )}

      {canEdit && open && closing && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 flex-1 min-w-0">
            <span className="text-[11px] text-zinc-500 break-words">
              {closing === 'done'
                ? isUz
                  ? 'Natija: nima bilan tugadi'
                  : 'Результат: чем кончилось'
                : isUz
                  ? 'Bekor qilish sababi'
                  : 'Причина отмены'}
            </span>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
              aria-label={
                closing === 'done'
                  ? isUz
                    ? 'Vazifa natijasi'
                    : 'Результат задачи'
                  : isUz
                    ? 'Vazifani bekor qilish sababi'
                    : 'Причина отмены задачи'
              }
              className={FIELD}
            />
          </label>
          <button
            type="button"
            disabled={busy || text.trim().length < 3}
            onClick={() =>
              void onAct(task.uid, async () => {
                if (closing === 'done') {
                  await apiClient.crm.completeTask(task.uid, task.version, text.trim());
                } else {
                  await apiClient.crm.cancelTask(task.uid, task.version, text.trim());
                }
                setClosing(null);
                setText('');
              })
            }
            className={`${BTN_PRIMARY} whitespace-nowrap shrink-0`}
          >
            {isUz ? 'Saqlash' : 'Сохранить'}
          </button>
          <button
            type="button"
            onClick={() => setClosing(null)}
            aria-label={isUz ? 'Bekor qilish' : 'Отменить закрытие задачи'}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </li>
  );
};

const ActivityRow: React.FC<{ row: CrmActivityRow; isUz: boolean }> = ({ row, isUz }) => {
  const Icon = ACT_ICON[row.type];
  const Dir = row.direction === 'incoming' ? ArrowDownLeft : ArrowUpRight;
  return (
    <li className="px-4 py-3 flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
        <Icon className="w-3.5 h-3.5 text-zinc-400 shrink-0 self-center" />
        <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
          {row.subject}
        </span>
        {row.direction && (
          <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500 shrink-0">
            <Dir className="w-3 h-3" />
            {row.direction === 'incoming'
              ? isUz
                ? 'kiruvchi'
                : 'входящий'
              : isUz
                ? 'chiquvchi'
                : 'исходящий'}
          </span>
        )}
        <span className="text-[10px] text-zinc-500 shrink-0">{fmtWhen(row.at)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
        <span>{isUz ? ACT_NAME[row.type].uz : ACT_NAME[row.type].ru}</span>
        {row.partner && <span className="break-words">{row.partner.name}</span>}
        {row.deal && <span className="font-mono break-words">{row.deal.number}</span>}
        {row.durationSec !== null && (
          <span>
            {Math.floor(row.durationSec / 60)} {isUz ? 'daq' : 'мин'}
          </span>
        )}
        {row.user && <span className="break-words">{row.user.name}</span>}
        {row.task && (
          <span className="break-words">{isUz ? 'vazifadan' : 'из задачи'}</span>
        )}
      </div>
      {row.note && (
        <p className="text-[11px] text-zinc-600 dark:text-zinc-400 break-words">{row.note}</p>
      )}
    </li>
  );
};

const TaskForm: React.FC<{
  isUz: boolean;
  onCancel: () => void;
  onDone: () => Promise<void>;
}> = ({ isUz, onCancel, onDone }) => {
  const [typeUid, setTypeUid] = useState('');
  const [types, setTypes] = useState<CrmTaskTypeRow[]>([]);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(defaultDue());
  const [partnerUid, setPartnerUid] = useState('');
  const [dealUid, setDealUid] = useState('');
  const [partners, setPartners] = useState<CrmPartnerRow[]>([]);
  const [deals, setDeals] = useState<CrmDealRow[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiClient.crm
      .refs()
      .then((r) => {
        setTypes(r.data.taskTypes);
        setTypeUid((prev) => prev || (r.data.taskTypes[0]?.uid ?? ''));
      })
      .catch(() => setTypes([]));
    apiClient.crm
      .partners({ role: 'client', limit: 200 })
      .then((r) => setPartners(r.data.rows))
      .catch(() => setPartners([]));
    apiClient.crm
      .deals({ status: 'open', limit: 200 })
      .then((r) => setDeals(r.data.rows))
      .catch(() => setDeals([]));
  }, []);

  // Сделки показываем только выбранного клиента: сделка чужого клиента с
  // задачей не сойдётся, и сервер ответит отказом — лучше её не предлагать.
  const dealOptions = useMemo(
    () => (partnerUid ? deals.filter((d) => d.partner?.uid === partnerUid) : deals),
    [deals, partnerUid],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Turi' : 'Тип'}</span>
          <CustomSelect
            ariaLabel={isUz ? 'Vazifa turi' : 'Тип задачи'}
            value={typeUid}
            onChange={setTypeUid}
            options={types.map((t) => ({
              value: t.uid,
              label: refName(t, isUz),
            }))}
          />
        </div>
        <label className="flex flex-col gap-1 min-w-0 sm:col-span-2">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Nima qilish kerak' : 'Что сделать'}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={FIELD} />
        </label>
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Muddat' : 'Срок'}</span>
          <input
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className={FIELD}
          />
        </label>
        <div className="flex flex-col gap-1 min-w-0 sm:col-span-2">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Mijoz' : 'Клиент'}</span>
          <CustomSelect
            ariaLabel={isUz ? 'Mijoz' : 'Клиент'}
            value={partnerUid}
            onChange={(v) => {
              setPartnerUid(v);
              setDealUid('');
            }}
            options={[
              { value: '', label: isUz ? 'tanlang' : 'выберите' },
              ...partners.map((p) => ({ value: p.uid, label: refName(p, isUz) })),
            ]}
          />
        </div>
        <div className="flex flex-col gap-1 min-w-0 sm:col-span-2">
          <span className="text-[11px] text-zinc-500">
            {isUz ? 'Bitim (majburiy emas)' : 'Сделка (необязательно)'}
          </span>
          <CustomSelect
            ariaLabel={isUz ? 'Bitim' : 'Сделка'}
            value={dealUid}
            onChange={setDealUid}
            options={[
              { value: '', label: isUz ? 'bog‘lanmagan' : 'без сделки' },
              ...dealOptions.map((d) => ({ value: d.uid, label: `${d.number} — ${d.title}` })),
            ]}
          />
        </div>
      </div>

      {!partnerUid && !dealUid && (
        <p className="text-[11px] text-zinc-400 break-words">
          {isUz
            ? 'Mijoz yoki bitim majburiy: usiz vazifa hech qaysi kartochkada ko‘rinmaydi.'
            : 'Клиент или сделка обязательны: без них задача не покажется ни в одной карточке.'}
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
          disabled={busy || !typeUid || title.trim().length < 2 || !due || (!partnerUid && !dealUid)}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await apiClient.crm.createTask({
                typeUid,
                title: title.trim(),
                dueAt: new Date(due).toISOString(),
                partnerUid: partnerUid || undefined,
                dealUid: dealUid || undefined,
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
          {isUz ? 'Qo‘shish' : 'Поставить'}
        </button>
        <button type="button" onClick={onCancel} className={`${BTN_GHOST} whitespace-nowrap`}>
          {isUz ? 'Bekor qilish' : 'Отмена'}
        </button>
      </div>
    </div>
  );
};
