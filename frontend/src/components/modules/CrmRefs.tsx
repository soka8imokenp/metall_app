/**
 * Справочники CRM на запись (ТЗ 8.3, 8.4): стадии воронки, источники
 * обращений, причины отказа, типы задач.
 *
 * До этого этапа воронка и источники приходили из сида, а типы задач вообще
 * были перечислением в базе: завести «выезд на объект» значило попросить
 * разработчика. Экран показывает ровно то, что разрешает сервер, и своих
 * запретов не изобретает: почему строку нельзя удалить или выключить, сервер
 * говорит словами — их и показываем. Вторая версия тех же правил на фронте
 * рано или поздно разошлась бы с первой.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Power, Trash2, X } from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { errorText } from '../../context/DashboardContext';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import type {
  CrmLostReasonRef,
  CrmRefs as CrmRefsData,
  CrmSourceRef,
  CrmStageRef,
  CrmTaskTypeRow,
  CrmSiteKey,
  CrmSourceRule,
} from '../../types/api';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, ErrorBox, FIELD, Skeleton } from './warehouse-ui';
import { CustomSelect } from '../common/CustomSelect';
import { refName } from '../../lib/formatters';

type Section = 'stages' | 'sources' | 'reasons' | 'types' | 'site';

const SECTIONS: [Section, string, string][] = [
  ['stages', 'Воронка', 'Voronka'],
  ['sources', 'Источники', 'Manbalar'],
  ['reasons', 'Причины отказа', 'Rad sabablari'],
  ['types', 'Типы задач', 'Vazifa turlari'],
  ['site', 'Приём с сайта', 'Saytdan qabul'],
];

/** Правило раздела читают в тот момент, когда правка не прошла. */
const HINT: Record<Section, { ru: string; uz: string; addRu: string; addUz: string }> = {
  stages: {
    ru: 'Порядок стадий — это и есть воронка. Конечные («выиграна», «проиграна») всегда последние: в них попадают не переносом, а закрытием сделки. Стадию с открытыми сделками выключить нельзя — они пропали бы с доски.',
    uz: 'Bosqichlar tartibi — voronkaning o‘zi. Yakuniy bosqichlar doim oxirida turadi.',
    addRu: 'Добавить стадию',
    addUz: 'Bosqich qo‘shish',
  },
  sources: {
    ru: 'Источник, по которому уже пришли обращения, не удаляется и канал у него не меняется: иначе отчёт по источникам задним числом скажет, что реклама привела не тех.',
    uz: 'Murojaat kelgan manba o‘chirilmaydi va kanali o‘zgarmaydi.',
    addRu: 'Добавить источник',
    addUz: 'Manba qo‘shish',
  },
  reasons: {
    ru: 'Причину, по которой уже закрывали сделки, выключают, а не удаляют — иначе отчёт по причинам отказов потеряет прошлый квартал. Последнюю выключить нельзя: проигрыш без причины не записывается.',
    uz: 'Ishlatilgan sabab o‘chirilmaydi, faqat faolsizlantiriladi.',
    addRu: 'Добавить причину',
    addUz: 'Sabab qo‘shish',
  },
  site: {
    ru: 'Ключ сайта — адрес, по которому заявка с их страницы попадает в эту компанию вместе с метками визита. Секрета в нём нет: он лежит в открытом коде страницы, поэтому его не прячут, а выключают и заводят новый. Правила ниже показывают, каким источником система считает те или иные метки.',
    uz: 'Sayt kaliti — ariza shu kompaniyaga tushadigan manzil. Unda sir yo‘q: u sahifa kodida ochiq turadi.',
    addRu: 'Добавить ключ',
    addUz: 'Kalit qo‘shish',
  },
  types: {
    ru: 'У типа задачи есть вид активности: им закрытая задача ложится в ленту общения клиента. Поэтому «выезд на объект» стоит завести встречей, а не заметкой — иначе «покажи все встречи» его не найдёт.',
    uz: 'Vazifa turi yopilgach, lentaga qaysi faoliyat bo‘lib tushishini belgilaydi.',
    addRu: 'Добавить тип',
    addUz: 'Tur qo‘shish',
  },
};

const CHANNELS: [string, string, string][] = [
  ['site', 'Сайт', 'Sayt'],
  ['ads', 'Реклама', 'Reklama'],
  ['call', 'Звонок', 'Qo‘ng‘iroq'],
  ['manual', 'Занесён вручную', 'Qo‘lda kiritilgan'],
  ['telegram', 'Telegram', 'Telegram'],
  ['other', 'Другое', 'Boshqa'],
];

const ACTIVITY_KINDS: [string, string, string][] = [
  ['call', 'Звонок', 'Qo‘ng‘iroq'],
  ['meeting', 'Встреча', 'Uchrashuv'],
  ['letter', 'Письмо', 'Xat'],
  ['note', 'Заметка', 'Eslatma'],
];

const label = (list: [string, string, string][], code: string, isUz: boolean) => {
  const row = list.find((r) => r[0] === code);
  // Запасной вариант — сам код: новое значение на сервере не должно ронять
  // экран, пока ему не завели перевод.
  return row ? (isUz ? row[2] : row[1]) : code;
};

/** Сколько записей ссылается на строку справочника — по ним и решают, что выключать. */
const Usage: React.FC<{ parts: [string, number][] }> = ({ parts }) => {
  const shown = parts.filter(([, n]) => n > 0);
  if (shown.length === 0) return <span className="text-[11px] text-zinc-400">—</span>;
  return (
    <span className="text-[11px] text-zinc-500 break-words">
      {shown.map(([t, n]) => `${t} ${n}`).join(' · ')}
    </span>
  );
};

const Off: React.FC<{ isUz: boolean }> = ({ isUz }) => (
  <span className="px-1.5 rounded border border-zinc-300 dark:border-zinc-700 text-[10px] text-zinc-500 shrink-0">
    {isUz ? 'o‘chirilgan' : 'выключен'}
  </span>
);

export const CrmRefs: React.FC = () => {
  const { locale, company } = useApp();
  const { session } = useAuth();
  const isUz = locale === 'uz';
  const mayEdit = session?.permissions.includes('refs.edit') ?? false;

  const [section, setSection] = useState<Section>('stages');
  const [showOff, setShowOff] = useState(false);
  const [data, setData] = useState<CrmRefsData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ open: boolean; edit: unknown } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.crm.refs(showOff);
      setData(res.data);
    } catch (e) {
      setData(null);
      setError(e as ApiError);
    }
  }, [showOff, company]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Компании, в чьи справочники можно писать: их две, и они раздельные. */
  const companies = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of data?.stages ?? []) map.set(s.company.uid, s.company.code);
    for (const s of data?.sources ?? []) map.set(s.company.uid, s.company.code);
    return [...map].map(([uid, code]) => ({ uid, code }));
  }, [data]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const closeForm = () => setForm(null);
  const doneForm = async () => {
    setForm(null);
    await load();
  };

  return (
    <div className={CARD + ' flex flex-col min-w-0'}>
      <div className="px-4 py-2.5 flex flex-wrap items-center gap-2 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-1">
          {SECTIONS.map(([key, ru, uz]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={section === key}
              onClick={() => {
                setSection(key);
                setForm(null);
              }}
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

        {/* На 360 «показать выключенные» и кнопка добавления рядом дают 301 px
            в контейнере на 286 — и вся страница уезжала вбок. Переносим их,
            а вправо прижимаем только там, где место есть. */}
        <div className="flex flex-wrap items-center gap-2 sm:ms-auto">
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 whitespace-nowrap shrink-0">
            <input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} />
            {isUz ? 'O‘chirilganlar' : 'Показать выключенные'}
          </label>
          {mayEdit && section !== 'site' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setForm({ open: true, edit: null })}
              className={BTN_PRIMARY + ' h-7 whitespace-nowrap shrink-0'}
            >
              <Plus className="w-3 h-3 inline-block mr-1" />
              {isUz ? HINT[section].addUz : HINT[section].addRu}
            </button>
          )}
        </div>
      </div>

      <p className="px-4 pt-2.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
        {isUz ? HINT[section].uz : HINT[section].ru}
      </p>

      {error && (
        <div className="px-4 pt-2">
          <ErrorBox text={errorText(error, isUz)} isUz={isUz} />
        </div>
      )}

      {form?.open && (
        <div className="px-4 pt-3">
          <RefForm
            section={section}
            isUz={isUz}
            companies={companies}
            edit={form.edit as never}
            onClose={closeForm}
            onDone={doneForm}
          />
        </div>
      )}

      {!data ? (
        <div className="p-4">
          <Skeleton />
        </div>
      ) : section === 'site' ? (
        <SiteIntake isUz={isUz} mayEdit={mayEdit} />
      ) : section === 'stages' ? (
        <Stages
          rows={data.stages}
          isUz={isUz}
          mayEdit={mayEdit}
          busy={busy}
          onEdit={(r) => setForm({ open: true, edit: r })}
          onAct={act}
        />
      ) : section === 'sources' ? (
        <Sources
          rows={data.sources}
          isUz={isUz}
          mayEdit={mayEdit}
          busy={busy}
          onEdit={(r) => setForm({ open: true, edit: r })}
          onAct={act}
        />
      ) : section === 'reasons' ? (
        <Reasons
          rows={data.lostReasons}
          isUz={isUz}
          mayEdit={mayEdit}
          busy={busy}
          onEdit={(r) => setForm({ open: true, edit: r })}
          onAct={act}
        />
      ) : (
        <Types
          rows={data.taskTypes}
          isUz={isUz}
          mayEdit={mayEdit}
          busy={busy}
          onEdit={(r) => setForm({ open: true, edit: r })}
          onAct={act}
        />
      )}
    </div>
  );
};

/** Кнопки строки: правка, выключение и удаление — одинаковые во всех разделах. */
const RowActions: React.FC<{
  isUz: boolean;
  mayEdit: boolean;
  busy: boolean;
  isActive: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}> = ({ isUz, mayEdit, busy, isActive, onEdit, onToggle, onDelete }) => {
  if (!mayEdit) return null;
  return (
    <div className="flex items-center gap-1 shrink-0">
      <button
        type="button"
        disabled={busy}
        onClick={onEdit}
        aria-label={isUz ? 'Tahrirlash' : 'Править'}
        className={BTN_GHOST + ' h-7'}
      >
        <Pencil className="w-3 h-3" />
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onToggle}
        aria-label={isActive ? (isUz ? 'O‘chirish' : 'Выключить') : isUz ? 'Yoqish' : 'Включить'}
        className={BTN_GHOST + ' h-7'}
      >
        <Power className={`w-3 h-3 ${isActive ? '' : 'text-emerald-600'}`} />
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onDelete}
        aria-label={isUz ? 'O‘chirib tashlash' : 'Удалить'}
        className={BTN_GHOST + ' h-7'}
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );
};

const LIST = 'divide-y divide-zinc-200 dark:divide-zinc-800';

/** Код компании в строке — только когда в списке видны обе. */
const Co: React.FC<{ code: string; show: boolean }> = ({ code, show }) =>
  show ? <span className="text-[11px] text-zinc-400 w-6 shrink-0">{code}</span> : null;

const manyCompanies = (rows: { company: { uid: string } }[]) =>
  new Set(rows.map((r) => r.company.uid)).size > 1;
const ROW = 'px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0';
const NAME = 'text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words';
const CODE = 'text-[11px] font-mono text-zinc-400 shrink-0';

const Stages: React.FC<{
  rows: CrmStageRef[];
  isUz: boolean;
  mayEdit: boolean;
  busy: boolean;
  onEdit: (r: CrmStageRef) => void;
  onAct: (run: () => Promise<unknown>) => Promise<void>;
}> = ({ rows, isUz, mayEdit, busy, onEdit, onAct }) => {
  const many = manyCompanies(rows);
  if (rows.length === 0) return <Empty text={isUz ? 'Bo‘sh' : 'Пусто'} />;

  /** Перестановка идёт полным списком рабочих стадий компании: номер у одной
      строки оставил бы воронку с двумя третьими стадиями. */
  const move = (row: CrmStageRef, dir: -1 | 1) => {
    const own = rows.filter((r) => r.company.uid === row.company.uid && !r.isFinal);
    const i = own.findIndex((r) => r.uid === row.uid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= own.length) return;
    const uids = own.map((r) => r.uid);
    [uids[i], uids[j]] = [uids[j]!, uids[i]!];
    void onAct(() => apiClient.crm.reorderStages(row.company.uid, uids));
  };

  return (
    <ul className={LIST}>
      {rows.map((r) => {
        const own = rows.filter((x) => x.company.uid === r.company.uid && !x.isFinal);
        const i = own.findIndex((x) => x.uid === r.uid);
        return (
          <li key={r.uid} className={ROW}>
            <Co code={r.company.code} show={many} />
            <span className={NAME}>{refName(r, isUz)}</span>
            <span className={CODE}>{r.code}</span>
            {r.isFinal && (
              <span className="px-1.5 rounded border border-zinc-300 dark:border-zinc-700 text-[10px] text-zinc-500 shrink-0">
                {isUz ? 'yakuniy' : 'конечная'}
              </span>
            )}
            {!r.isActive && <Off isUz={isUz} />}
            <span className="text-[11px] text-zinc-500 shrink-0">
              {isUz ? 'ehtimollik' : 'вероятность'} {r.probabilityDefault}%
            </span>
            <Usage
              parts={[
                [isUz ? 'bitim' : 'сделок', r.usage.deals],
                [isUz ? 'o‘tish' : 'переходов', r.usage.events],
              ]}
            />
            <div className="flex items-center gap-1 ms-auto shrink-0">
              {mayEdit && !r.isFinal && (
                <>
                  <button
                    type="button"
                    disabled={busy || i <= 0}
                    onClick={() => move(r, -1)}
                    aria-label={isUz ? 'Yuqoriga' : 'Выше'}
                    className={BTN_GHOST + ' h-7'}
                  >
                    <ArrowUp className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    disabled={busy || i < 0 || i >= own.length - 1}
                    onClick={() => move(r, 1)}
                    aria-label={isUz ? 'Pastga' : 'Ниже'}
                    className={BTN_GHOST + ' h-7'}
                  >
                    <ArrowDown className="w-3 h-3" />
                  </button>
                </>
              )}
              <RowActions
                isUz={isUz}
                mayEdit={mayEdit}
                busy={busy}
                isActive={r.isActive}
                onEdit={() => onEdit(r)}
                onToggle={() =>
                  void onAct(() => apiClient.crm.updateStage(r.uid, { isActive: !r.isActive }))
                }
                onDelete={() => void onAct(() => apiClient.crm.deleteStage(r.uid))}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
};

const Sources: React.FC<{
  rows: CrmSourceRef[];
  isUz: boolean;
  mayEdit: boolean;
  busy: boolean;
  onEdit: (r: CrmSourceRef) => void;
  onAct: (run: () => Promise<unknown>) => Promise<void>;
}> = ({ rows, isUz, mayEdit, busy, onEdit, onAct }) => {
  const many = manyCompanies(rows);
  if (rows.length === 0) return <Empty text={isUz ? 'Bo‘sh' : 'Пусто'} />;
  return (
    <ul className={LIST}>
      {rows.map((r) => (
        <li key={r.uid} className={ROW}>
          <Co code={r.company.code} show={many} />
          <span className={NAME}>{refName(r, isUz)}</span>
          <span className={CODE}>{r.code}</span>
          <span className="text-[11px] text-zinc-500 shrink-0">
            {label(CHANNELS, r.channel, isUz)}
          </span>
          {!r.isActive && <Off isUz={isUz} />}
          <Usage
            parts={[
              [isUz ? 'murojaat' : 'обращений', r.usage.leads],
              [isUz ? 'mijoz' : 'клиентов', r.usage.partners],
            ]}
          />
          <div className="ms-auto shrink-0">
            <RowActions
              isUz={isUz}
              mayEdit={mayEdit}
              busy={busy}
              isActive={r.isActive}
              onEdit={() => onEdit(r)}
              onToggle={() =>
                void onAct(() => apiClient.crm.updateSource(r.uid, { isActive: !r.isActive }))
              }
              onDelete={() => void onAct(() => apiClient.crm.deleteSource(r.uid))}
            />
          </div>
        </li>
      ))}
    </ul>
  );
};

const Reasons: React.FC<{
  rows: CrmLostReasonRef[];
  isUz: boolean;
  mayEdit: boolean;
  busy: boolean;
  onEdit: (r: CrmLostReasonRef) => void;
  onAct: (run: () => Promise<unknown>) => Promise<void>;
}> = ({ rows, isUz, mayEdit, busy, onEdit, onAct }) => {
  const many = manyCompanies(rows);
  if (rows.length === 0) return <Empty text={isUz ? 'Bo‘sh' : 'Пусто'} />;
  return (
    <ul className={LIST}>
      {rows.map((r) => (
        <li key={r.uid} className={ROW}>
          <Co code={r.company.code} show={many} />
          <span className={NAME}>{refName(r, isUz)}</span>
          <span className={CODE}>{r.code}</span>
          {!r.isActive && <Off isUz={isUz} />}
          <Usage parts={[[isUz ? 'bitim' : 'сделок', r.usage.deals]]} />
          <div className="ms-auto shrink-0">
            <RowActions
              isUz={isUz}
              mayEdit={mayEdit}
              busy={busy}
              isActive={r.isActive}
              onEdit={() => onEdit(r)}
              onToggle={() =>
                void onAct(() => apiClient.crm.updateLostReason(r.uid, { isActive: !r.isActive }))
              }
              onDelete={() => void onAct(() => apiClient.crm.deleteLostReason(r.uid))}
            />
          </div>
        </li>
      ))}
    </ul>
  );
};

const Types: React.FC<{
  rows: CrmTaskTypeRow[];
  isUz: boolean;
  mayEdit: boolean;
  busy: boolean;
  onEdit: (r: CrmTaskTypeRow) => void;
  onAct: (run: () => Promise<unknown>) => Promise<void>;
}> = ({ rows, isUz, mayEdit, busy, onEdit, onAct }) => {
  const many = manyCompanies(rows);
  if (rows.length === 0) return <Empty text={isUz ? 'Bo‘sh' : 'Пусто'} />;
  return (
    <ul className={LIST}>
      {rows.map((r) => (
        <li key={r.uid} className={ROW}>
          <Co code={r.company.code} show={many} />
          <span className={NAME}>{refName(r, isUz)}</span>
          <span className={CODE}>{r.code}</span>
          <span className="text-[11px] text-zinc-500 break-words">
            {isUz ? 'lentada: ' : 'в ленте: '}
            {label(ACTIVITY_KINDS, r.activityKind, isUz)}
          </span>
          {!r.isActive && <Off isUz={isUz} />}
          <Usage parts={[[isUz ? 'vazifa' : 'задач', r.usage.tasks]]} />
          <div className="ms-auto shrink-0">
            <RowActions
              isUz={isUz}
              mayEdit={mayEdit}
              busy={busy}
              isActive={r.isActive}
              onEdit={() => onEdit(r)}
              onToggle={() =>
                void onAct(() => apiClient.crm.updateTaskType(r.uid, { isActive: !r.isActive }))
              }
              onDelete={() => void onAct(() => apiClient.crm.deleteTaskType(r.uid))}
            />
          </div>
        </li>
      ))}
    </ul>
  );
};

type AnyRow = CrmStageRef | CrmSourceRef | CrmLostReasonRef | CrmTaskTypeRow;

/**
 * Одна форма на четыре раздела: поля у них почти общие — код, название,
 * и по одному своему. Четыре почти одинаковые формы разошлись бы в мелочах.
 */
const RefForm: React.FC<{
  section: Section;
  isUz: boolean;
  companies: { uid: string; code: string }[];
  edit: AnyRow | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}> = ({ section, isUz, companies, edit, onClose, onDone }) => {
  const [companyUid, setCompanyUid] = useState(edit?.company.uid ?? companies[0]?.uid ?? '');
  const [code, setCode] = useState(edit?.code ?? '');
  const [nameRu, setNameRu] = useState(edit?.nameRu ?? '');
  const [nameUz, setNameUz] = useState(edit?.nameUz ?? '');
  const [channel, setChannel] = useState(
    edit && 'channel' in edit ? (edit as CrmSourceRef).channel : 'site',
  );
  const [kind, setKind] = useState<string>(
    edit && 'activityKind' in edit ? (edit as CrmTaskTypeRow).activityKind : 'call',
  );
  const [prob, setProb] = useState(
    edit && 'probabilityDefault' in edit ? String((edit as CrmStageRef).probabilityDefault) : '0',
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const common = { code: code.trim(), nameRu: nameRu.trim(), nameUz: nameUz.trim() || undefined };
      if (edit) {
        const uid = edit.uid;
        if (section === 'stages') {
          await apiClient.crm.updateStage(uid, { ...common, probabilityDefault: Number(prob) });
        } else if (section === 'sources') {
          await apiClient.crm.updateSource(uid, { ...common, channel });
        } else if (section === 'reasons') {
          await apiClient.crm.updateLostReason(uid, common);
        } else {
          await apiClient.crm.updateTaskType(uid, { ...common, activityKind: kind });
        }
      } else {
        const withCompany = { ...common, companyUid: companyUid || undefined };
        if (section === 'stages') {
          await apiClient.crm.createStage({ ...withCompany, probabilityDefault: Number(prob) });
        } else if (section === 'sources') {
          await apiClient.crm.createSource({ ...withCompany, channel });
        } else if (section === 'reasons') {
          await apiClient.crm.createLostReason(withCompany);
        } else {
          await apiClient.crm.createTaskType({ ...withCompany, activityKind: kind });
        }
      }
      await onDone();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
          {edit ? (isUz ? 'Tahrirlash' : 'Правка') : isUz ? 'Yangi yozuv' : 'Новая запись'}
        </span>
        <button type="button" onClick={onClose} className={BTN_GHOST + ' h-7'} aria-label="X">
          <X className="w-3 h-3" />
        </button>
      </div>

      {error && <ErrorBox text={errorText(error, isUz)} isUz={isUz} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        {!edit && companies.length > 1 && (
          <div className="flex flex-col gap-1 min-w-0">
            <span className="text-[11px] text-zinc-500">{isUz ? 'Kompaniya' : 'Компания'}</span>
            <CustomSelect
              ariaLabel={isUz ? 'Kompaniya' : 'Компания'}
              value={companyUid}
              onChange={setCompanyUid}
              options={companies.map((c) => ({ value: c.uid, label: c.code }))}
            />
          </div>
        )}
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Kod' : 'Код'}</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="site-visit"
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1 min-w-0 sm:col-span-2">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Nomi (ru)' : 'Название'}</span>
          <input value={nameRu} onChange={(e) => setNameRu(e.target.value)} className={FIELD} />
        </label>
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-[11px] text-zinc-500">
            {isUz ? 'Nomi (uz)' : 'Название (uz)'}
          </span>
          <input value={nameUz} onChange={(e) => setNameUz(e.target.value)} className={FIELD} />
        </label>

        {section === 'stages' && (
          <label className="flex flex-col gap-1 min-w-0">
            <span className="text-[11px] text-zinc-500">
              {isUz ? 'Ehtimollik, %' : 'Вероятность, %'}
            </span>
            <input
              type="number"
              min={0}
              max={100}
              value={prob}
              onChange={(e) => setProb(e.target.value)}
              className={FIELD}
            />
          </label>
        )}
        {section === 'sources' && (
          <div className="flex flex-col gap-1 min-w-0">
            <span className="text-[11px] text-zinc-500">{isUz ? 'Kanal' : 'Канал'}</span>
            <CustomSelect
              ariaLabel={isUz ? 'Kanal' : 'Канал'}
              value={channel}
              onChange={setChannel}
              options={CHANNELS.map(([v, ru, uz]) => ({ value: v, label: isUz ? uz : ru }))}
            />
          </div>
        )}
        {section === 'types' && (
          <div className="flex flex-col gap-1 min-w-0">
            <span className="text-[11px] text-zinc-500">
              {isUz ? 'Lentada qanday ko‘rinadi' : 'Чем ляжет в ленту'}
            </span>
            <CustomSelect
              ariaLabel={isUz ? 'Faoliyat turi' : 'Вид активности'}
              value={kind}
              onChange={setKind}
              options={ACTIVITY_KINDS.map(([v, ru, uz]) => ({ value: v, label: isUz ? uz : ru }))}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={saving || code.trim() === '' || nameRu.trim() === ''}
          onClick={() => void save()}
          className={BTN_PRIMARY}
        >
          {saving ? (isUz ? 'Saqlanmoqda…' : 'Сохраняю…') : isUz ? 'Saqlash' : 'Сохранить'}
        </button>
        <button type="button" onClick={onClose} className={BTN_GHOST}>
          {isUz ? 'Bekor qilish' : 'Отмена'}
        </button>
      </div>
    </div>
  );
};

/**
 * Приём заявок с сайта: ключи и правила разбора меток.
 *
 * Раздел отвечает на два вопроса веб-мастера: «куда слать форму» и «почему
 * заявка считается поиском, а не рекламой». Первое — ключ и адрес, второе —
 * список правил сверху вниз: побеждает первое подходящее.
 *
 * Ключ показан открыто: он и так уходит в исходный код страницы. Прятать его
 * звёздочками значило бы делать вид, что он секрет.
 */
const SiteIntake: React.FC<{ isUz: boolean; mayEdit: boolean }> = ({ isUz, mayEdit }) => {
  const [keys, setKeys] = useState<CrmSiteKey[] | null>(null);
  const [rules, setRules] = useState<CrmSourceRule[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');
  const [companyUid, setCompanyUid] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [k, r] = await Promise.all([apiClient.crm.siteKeys(), apiClient.crm.sourceRules()]);
      setKeys(k.data.rows);
      setRules(r.data.rows);
    } catch (e) {
      setKeys([]);
      setError(e as ApiError);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const companies = useMemo(() => {
    const map = new Map<string, CrmSiteKey['company']>();
    for (const k of keys ?? []) map.set(k.company.uid, k.company);
    for (const r of rules) {
      if (!map.has(r.company.uid)) {
        map.set(r.company.uid, {
          uid: r.company.uid,
          code: r.company.code,
          nameRu: r.company.code,
          nameUz: r.company.code,
        });
      }
    }
    return [...map.values()];
  }, [keys, rules]);

  useEffect(() => {
    if (companies.length && !companies.some((c) => c.uid === companyUid)) {
      setCompanyUid(companies[0]!.uid);
    }
  }, [companies, companyUid]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const endpoint = `${window.location.origin}/api/v1/public/leads`;

  if (keys === null) {
    return (
      <div className="p-4">
        <Skeleton />
      </div>
    );
  }

  return (
    <div className="p-4 flex flex-col gap-4 min-w-0">
      {error && <ErrorBox text={errorText(error, isUz)} isUz={isUz} />}

      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-zinc-500">
          {isUz ? 'Ariza qabul qilish manzili' : 'Адрес приёма заявок'}
        </span>
        <code className="text-[11px] font-mono text-zinc-800 dark:text-zinc-200 break-all">
          POST {endpoint}
        </code>
        <span className="text-[10px] text-zinc-500 break-words">
          {isUz
            ? 'Shakl shu manzilga yuboriladi; kalit tanasida bo‘ladi.'
            : 'Форма сайта шлёт сюда JSON с ключом и метками. Готовый скрипт и инструкция для веб-мастера — в docs/10-SITE-TRACKING.md.'}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-medium text-zinc-500">
          {isUz ? 'Sayt kalitlari' : 'Ключи сайта'}
        </span>
        {keys.length === 0 ? (
          <Empty text={isUz ? 'Kalit yo‘q' : 'Ключей пока нет'} />
        ) : (
          <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800/60">
            {keys.map((k) => (
              <li key={k.uid} className="py-2 flex flex-wrap items-start justify-between gap-2">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
                    {k.name} · {refName(k.company, isUz)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(k.code);
                      setCopied(k.uid);
                    }}
                    title={isUz ? 'Nusxa olish' : 'Скопировать ключ'}
                    className="text-[11px] font-mono text-zinc-600 dark:text-zinc-300 break-all text-left hover:underline cursor-pointer"
                  >
                    {k.code}
                    {copied === k.uid && (
                      <span className="ms-2 text-[10px] text-zinc-400">
                        {isUz ? 'nusxa olindi' : 'скопирован'}
                      </span>
                    )}
                  </button>
                  <span className="text-[10px] text-zinc-500 break-words">
                    {k.origins.length
                      ? `${isUz ? 'Sahifalar' : 'Разрешённые адреса'}: ${k.origins.join(', ')}`
                      : isUz
                        ? 'Istalgan sahifadan qabul qilinadi'
                        : 'Принимается с любой страницы'}
                    {' · '}
                    {isUz ? 'arizalar' : 'заявок'}: {k.usedCount}
                    {k.lastUsedAt
                      ? ` · ${isUz ? 'oxirgisi' : 'последняя'} ${new Date(k.lastUsedAt).toLocaleDateString('ru-RU')}`
                      : ''}
                  </span>
                </div>
                {mayEdit && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(() => apiClient.crm.updateSiteKey(k.uid, { isActive: !k.isActive }))
                    }
                    title={
                      k.isActive
                        ? isUz
                          ? 'O‘chirish: bu kalit bo‘yicha yangi so‘rovlar qabul qilinmaydi, avvalgilari qoladi'
                          : 'Выключить: заявки по этому ключу приниматься перестанут, прежние останутся'
                        : isUz
                          ? 'Yoqish: bu kalit bo‘yicha so‘rovlar yana qabul qilinadi'
                          : 'Включить: заявки по этому ключу снова будут приниматься'
                    }
                    className={`${BTN_GHOST} h-7 whitespace-nowrap shrink-0`}
                  >
                    {k.isActive
                      ? isUz
                        ? 'O‘chirish'
                        : 'Выключить'
                      : isUz
                        ? 'Yoqish'
                        : 'Включить'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {mayEdit && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {companies.length > 1 && (
              <div className="w-44">
                <CustomSelect
                  ariaLabel={isUz ? 'Kompaniya' : 'Компания ключа'}
                  value={companyUid}
                  onChange={setCompanyUid}
                  options={companies.map((c) => ({
                    value: c.uid,
                    label: refName(c, isUz),
                  }))}
                />
              </div>
            )}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isUz ? 'Kalit nomi' : 'Название: «Сайт metallasia.uz»'}
              aria-label={isUz ? 'Kalit nomi' : 'Название ключа'}
              className={`${FIELD} flex-1 min-w-[12rem]`}
            />
            <input
              value={origins}
              onChange={(e) => setOrigins(e.target.value)}
              placeholder="https://metallasia.uz"
              aria-label={isUz ? 'Ruxsat etilgan sahifalar' : 'Разрешённые адреса страниц'}
              className={`${FIELD} flex-1 min-w-[12rem]`}
            />
            <button
              type="button"
              disabled={busy || name.trim().length < 3}
              onClick={() =>
                void act(async () => {
                  await apiClient.crm.createSiteKey({
                    companyUid: companyUid || undefined,
                    name: name.trim(),
                    origins: origins
                      .split(',')
                      .map((o) => o.trim())
                      .filter(Boolean),
                  });
                  setName('');
                  setOrigins('');
                })
              }
              className={`${BTN_PRIMARY} h-8 whitespace-nowrap`}
            >
              {isUz ? 'Kalit qo‘shish' : 'Добавить ключ'}
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1 pt-2 border-t border-zinc-200 dark:border-zinc-800">
        <span className="text-[11px] font-medium text-zinc-500">
          {isUz ? 'Belgilarni ajratish qoidalari' : 'Правила разбора меток'}
        </span>
        <span className="text-[10px] text-zinc-500 break-words">
          {isUz
            ? 'Yuqoridan pastga: birinchi mos qoida g‘olib.'
            : 'Сверху вниз, побеждает первое подходящее. Пустое условие значит «любой».'}
        </span>
        <ul className="flex flex-col gap-0.5 pt-1">
          {rules
            .filter((r) => !companyUid || r.company.uid === companyUid)
            .map((r) => {
              const cond = [
                r.match.medium ? `utm_medium = ${r.match.medium}` : null,
                r.match.source ? `utm_source = ${r.match.source}` : null,
                r.match.referrer
                  ? `${isUz ? 'o‘tish' : 'переход c'} ${r.match.referrer}`
                  : null,
                r.match.hasClick === true ? (isUz ? 'klik belgisi bor' : 'есть метка клика') : null,
                r.match.hasMarks === false ? (isUz ? 'belgilar yo‘q' : 'меток нет') : null,
                r.match.hasReferrer === true ? (isUz ? 'o‘tish bor' : 'есть переход') : null,
                r.match.hasReferrer === false ? (isUz ? 'o‘tish yo‘q' : 'перехода нет') : null,
              ].filter(Boolean);
              return (
                <li
                  key={r.uid}
                  className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-zinc-600 dark:text-zinc-300"
                >
                  <span className="font-mono text-zinc-400 tabular-nums">{r.priority}</span>
                  <span className="break-words">
                    {cond.length ? cond.join(', ') : isUz ? 'qolgan hammasi' : 'всё остальное'}
                  </span>
                  <span className="text-zinc-400">→</span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100 break-words">
                    {r.source.name}
                  </span>
                </li>
              );
            })}
        </ul>
      </div>
    </div>
  );
};
