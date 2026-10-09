/**
 * Документы (ТЗ 7): реестр на живом API.
 *
 * До этого экран показывал 149 выдуманных счетов из `MOCK_DOCUMENTS`: найти в
 * нём настоящий документ было нельзя, а «просмотр PDF» ничего не открывал.
 * Теперь список, фильтры и карточка берут данные с сервера.
 *
 * Разбивка по статусам сверху — она же фильтр: «на согласовании 83» и «покажи
 * эти 83» — один вопрос, и разводить их на счётчик и отдельный выпадающий
 * список значит заставлять делать два действия вместо одного. Счётчики при
 * этом считаются по остальным фильтрам, но без выбранного статуса, поэтому не
 * пропадают, как только по ним нажали.
 *
 * Создания, согласования и файлов здесь пока нет — они идут следующими этапами
 * модуля. Чего нет, того экран и не обещает: кнопок, которые ничего не делают,
 * на нём не стоит.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Download,
  FilePlus2,
  FileText,
  History,
  Layers,
  Printer,
  Search,
  X,
} from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { errorText } from '../../context/DashboardContext';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import type {
  DocumentAction,
  DocumentCard as DocumentCardData,
  DocumentLine,
  DocumentLineInput,
  DocumentRequisites,
  DocumentRow,
  DocumentSourceKind,
  DocumentSourceRow,
  DocumentTypeRef,
  DocumentStatus,
  DocumentsPage,
} from '../../types/api';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, ErrorBox, FIELD, Skeleton } from './warehouse-ui';
import { CustomSelect } from '../common/CustomSelect';
import { CustomDatePicker } from '../common/CustomDatePicker';
import { AttachmentsPanel } from './WarehouseAttachments';
import { DocumentTypes } from './DocumentTypes';
import { DocumentTemplates } from './DocumentTemplates';
import {
  EditDialog,
  HistoryPanel,
  VersionsPanel,
  WorkflowBar,
} from './DocumentWorkflow';
import { statusCls, statusText } from './document-status';
import { refName } from '../../lib/formatters';
import { useSearchJump } from '../../lib/use-search-jump';

/** Порядок вкладок — это путь документа, а не алфавит. */
const STATUS_ORDER: DocumentStatus[] = [
  'draft',
  'pending_approval',
  'approved',
  'signed',
  'returned',
  'cancelled',
];

const SOURCE_TEXT: Record<string, { ru: string; uz: string }> = {
  sales_order: { ru: 'Заказ', uz: 'Buyurtma' },
  deal: { ru: 'Сделка', uz: 'Bitim' },
  finance_operation: { ru: 'Платёж', uz: 'Toʻlov' },
  production_order: { ru: 'Производство', uz: 'Ishlab chiqarish' },
};

/**
 * Подпись источника берётся с запасным вариантом: новое значение на сервере не
 * должно ронять экран, пока ему не завели перевод. Ровно на этом падала
 * карточка клиента, когда в CRM добавились счётчики задач.
 */
const sourceText = (kind: string, isUz: boolean) =>
  SOURCE_TEXT[kind] ? (isUz ? SOURCE_TEXT[kind]!.uz : SOURCE_TEXT[kind]!.ru) : kind;

/**
 * Деньги на экране.
 *
 * В списке копейки не нужны — там сравнивают порядок величин. В карточке
 * нужны: шапка округляла 179 256 089,59 до 179 256 090, а рядом стояла та же
 * сумма прописью с «59 тийинов». Для документа это расхождение в реквизите,
 * и спорить будут именно о нём.
 */
const money = (
  v: string | null,
  currency: string | null,
  isUz: boolean,
  precise = false,
) => {
  if (v === null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  const opts = precise
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 0 };
  return `${n.toLocaleString(isUz ? 'uz-UZ' : 'ru-RU', opts)} ${currency ?? ''}`.trim();
};

const day = (v: string, isUz: boolean) =>
  new Date(v).toLocaleDateString(isUz ? 'uz-UZ' : 'ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

type Tab = 'registry' | 'types' | 'templates';

/** Разделы карточки документа. */
type Pane = 'doc' | 'versions' | 'history';

export const DocumentsView: React.FC = () => {
  const { locale, company } = useApp();
  const { session } = useAuth();
  const isUz = locale === 'uz';
  const mayEdit = session?.permissions.includes('documents.edit') ?? false;
  const holding = company === 'all';

  const [tab, setTab] = useState<Tab>('registry');
  const [page, setPage] = useState<DocumentsPage | null>(null);
  const [types, setTypes] = useState<DocumentTypeRef[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [open, setOpen] = useState<DocumentRow | null>(null);
  const [issue, setIssue] = useState(false);
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueError, setIssueError] = useState<ApiError | null>(null);
  /**
   * Что вышло из выписки — словами.
   *
   * Раньше единственным признаком успеха было то, что окно закрылось и
   * открылась карточка. Если карточка не открывалась (документ не нашёлся
   * поиском по своему же номеру), на экране не менялось ничего — и человек не
   * знал, выписан документ или нет. Номер выдан в любом случае, и сказать об
   * этом обязаны.
   */
  const [issued, setIssued] = useState<{ number: string; opened: boolean } | null>(null);

  const [search, setSearch] = useState('');
  useSearchJump('documents', setSearch, 'registry');
  const [typeCode, setTypeCode] = useState('');
  const [status, setStatus] = useState<string>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.documents.list({
        search: search.trim() || undefined,
        typeCode: typeCode || undefined,
        status: status || undefined,
        from: from || undefined,
        to: to || undefined,
        limit: 100,
      });
      setPage(res.data);
    } catch (e) {
      setPage(null);
      setError(e as ApiError);
    }
    // company в зависимостях не лишний: переключатель компании меняет
    // заголовок X-Company-Id, но сам по себе перезапрос не вызывает. Без него
    // после перехода в холдинг на экране оставался список торгового дома.
  }, [search, typeCode, status, from, to, company]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // tab в зависимостях: справочник типов правят на соседней вкладке этого же
    // экрана. Без перечитывания заведённый тип не появлялся в фильтре реестра,
    // пока не перезагрузят страницу, — и выглядело это так, будто он не
    // сохранился.
    apiClient.documents
      .types()
      .then((r) => setTypes(r.data.rows))
      .catch(() => setTypes([]));
  }, [company, tab]);

  /**
   * Тип документа принадлежит компании: «Счёт» торгового дома и «Счёт» завода —
   * две строки справочника со своей нумерацией. В режиме холдинга список
   * показывал бы их обе, и выбор любой прятал бы половину счетов. Сводим по
   * коду и фильтруем по нему же.
   */
  const typeOptions = useMemo(() => {
    const byCode = new Map<string, DocumentTypeRef>();
    for (const t of types) if (!byCode.has(t.code)) byCode.set(t.code, t);
    return [...byCode.values()].map((t) => ({
      value: t.code,
      label: refName(t, isUz),
    }));
  }, [types, isUz]);

  const tabs = useMemo(() => {
    const counts = page?.byStatus ?? {};
    const all = Object.values(counts).reduce((a, b) => a + b, 0);
    return [
      { key: '', text: isUz ? 'Hammasi' : 'Все', n: all },
      ...STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0).map((s) => ({
        key: s as string,
        text: statusText(s, isUz),
        n: counts[s] ?? 0,
      })),
    ];
  }, [page, isUz]);

  const header = (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50 break-words">
          {isUz ? 'Hujjatlar' : 'Документы'}
        </h2>
        <p className="text-zinc-500 text-xs break-words">
          {isUz
            ? 'Hisoblar, yuk xatlari, shartnomalar va dalolatnomalar reestri'
            : 'Реестр счетов, накладных, договоров и актов'}
        </p>
      </div>
      {/* Вкладки переносятся: на 360 две подписи в строку с заголовком не встают. */}
      <div className="flex flex-wrap items-center gap-2">
       <div className="flex flex-wrap items-center gap-1">
        {([
          ['registry', 'Реестр', 'Reestr'],
          ['types', 'Типы документов', 'Hujjat turlari'],
          ['templates', 'Шаблоны', 'Shablonlar'],
        ] as [Tab, string, string][]).map(([key, ru, uz]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`h-7 px-3 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
              tab === key
                ? 'bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900'
                : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
            }`}
          >
            {isUz ? uz : ru}
          </button>
        ))}
       </div>
       {mayEdit && tab === 'registry' && (
         <button
           type="button"
           onClick={() => {
             setIssueError(null);
             setIssue(true);
           }}
           className={BTN_PRIMARY + ' h-7 whitespace-nowrap'}
         >
           <FilePlus2 className="w-3 h-3 inline-block me-1" />
           {isUz ? 'Hujjat yozish' : 'Выписать документ'}
         </button>
       )}
      </div>
    </div>
  );

  const issuedBar = issued && (
    <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-2.5 flex flex-wrap items-center gap-2 min-w-0">
      <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400 shrink-0" />
      <span className="text-xs text-emerald-900 dark:text-emerald-200 break-words">
        {isUz ? 'Hujjat yozildi' : 'Документ выписан'}:{' '}
        <span className="font-mono font-medium">{issued.number}</span>
        {!issued.opened && (
          <>
            {' — '}
            {isUz
              ? 'kartochka ochilmadi, uni reestrdan raqami bo‘yicha toping'
              : 'карточка не открылась, найдите его в реестре по номеру'}
          </>
        )}
      </span>
      <button
        type="button"
        onClick={() => setIssued(null)}
        aria-label={isUz ? 'Yopish' : 'Закрыть'}
        title={isUz ? 'Yopish' : 'Убрать сообщение'}
        className={BTN_GHOST + ' h-7 ms-auto shrink-0'}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );

  if (open) {
    return (
      <div className="flex flex-col gap-4 min-w-0">
        {issuedBar}
        <DocumentCard
        row={open}
        isUz={isUz}
        mayEdit={mayEdit}
        onBack={() => {
          setOpen(null);
          setIssued(null);
          void load();
        }}
        />
      </div>
    );
  }

  if (tab === 'types' || tab === 'templates') {
    return (
      <div className="flex flex-col gap-4 text-xs">
        {header}
        {tab === 'types' ? <DocumentTypes /> : <DocumentTemplates />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 text-xs">
      {header}
      {issuedBar}

      <div className={CARD + ' flex flex-col min-w-0'}>
        <div className="px-4 py-2.5 flex flex-wrap items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
          {tabs.map((t) => (
            <button
              key={t.key || 'all'}
              type="button"
              role="tab"
              aria-selected={status === t.key}
              onClick={() => setStatus(t.key)}
              className={`h-7 px-3 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                status === t.key
                  ? 'bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900'
                  : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              {t.text} <span className="opacity-60">{t.n}</span>
            </button>
          ))}
        </div>

        {/* На 360 четыре поля в строку не встают: поиск сжимался до «Ном», а от
            выбора дат оставались две стрелки без подписи. Поэтому до 640 точек
            каждый фильтр занимает всю ширину, дальше — встают в ряд. */}
        <div className="px-4 py-2.5 flex flex-wrap items-center gap-2 border-b border-zinc-200 dark:border-zinc-800">
          <div className="relative min-w-0 w-full sm:w-56">
            <Search className="w-3 h-3 absolute start-2 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              aria-label={isUz ? 'Raqam boʻyicha qidirish' : 'Поиск по номеру'}
              className={FIELD + ' ps-7 w-full'}
              placeholder={isUz ? 'Hujjat raqami' : 'Номер документа'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="min-w-0 w-full sm:w-52">
            <CustomSelect
              ariaLabel={isUz ? 'Hujjat turi' : 'Тип документа'}
              value={typeCode}
              onChange={setTypeCode}
              options={[
                { value: '', label: isUz ? 'barcha turlar' : 'все типы' },
                ...typeOptions,
              ]}
            />
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 min-w-0 w-full sm:w-64">
            <div className="flex-1 min-w-0">
              <CustomDatePicker
                portal
                value={from}
                onChange={setFrom}
                placeholder={isUz ? 'Sanadan' : 'Дата с'}
                ariaLabel={isUz ? 'Sanadan' : 'Дата с'}
              />
            </div>
            <span className="hidden sm:inline text-xs text-zinc-400">—</span>
            <div className="flex-1 min-w-0">
              <CustomDatePicker
                portal
                value={to}
                onChange={setTo}
                placeholder={isUz ? 'Sanagacha' : 'Дата по'}
                ariaLabel={isUz ? 'Sanagacha' : 'Дата по'}
              />
            </div>
          </div>
        </div>

        {error && (
          <div className="px-4 pt-3">
            <ErrorBox text={errorText(error, isUz)} isUz={isUz} />
          </div>
        )}

        {!page ? (
          <div className="p-4">
            <Skeleton />
          </div>
        ) : page.rows.length === 0 ? (
          <Empty text={isUz ? 'Hujjat topilmadi' : 'Документов не найдено'} />
        ) : (
          <>
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {page.rows.map((d) => (
                <li key={d.uid}>
                  <button
                    type="button"
                    onClick={() => setOpen(d)}
                    className="w-full text-start px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 cursor-pointer"
                  >
                    <span className="text-xs font-mono font-medium text-zinc-900 dark:text-zinc-100 break-words">
                      {d.number}
                    </span>
                    {/* Нумерация у каждой компании своя, и в холдинге в списке
                        стоят два «ТТН-26/00003» подряд. Без пометки их не
                        различить: одинаковый номер, разные контрагенты и суммы. */}
                    {holding && (
                      <span className="px-1 rounded border border-zinc-200 dark:border-zinc-700 text-[10px] text-zinc-500 whitespace-nowrap">
                        {d.company.code}
                      </span>
                    )}
                    <span className="text-[11px] text-zinc-500 whitespace-nowrap">
                      {day(d.documentDate, isUz)}
                    </span>
                    <span className="text-[11px] text-zinc-600 dark:text-zinc-400 break-words">
                      {refName(d.type, isUz)}
                    </span>
                    {d.partner && (
                      <span className="text-xs text-zinc-900 dark:text-zinc-100 break-words">
                        {d.partner.name}
                      </span>
                    )}
                    {d.source?.number && (
                      <span className="text-[11px] text-zinc-500 font-mono whitespace-nowrap">
                        {sourceText(d.source.kind, isUz)} {d.source.number}
                      </span>
                    )}
                    {d.files > 0 && (
                      <span className="text-[11px] text-zinc-500 whitespace-nowrap">
                        {isUz ? 'fayl' : 'файлов'} {d.files}
                      </span>
                    )}
                    <span className="text-xs text-zinc-900 dark:text-zinc-100 tabular-nums whitespace-nowrap ms-auto">
                      {money(d.amountTotal, d.currency, isUz)}
                    </span>
                    <span
                      className={`px-1.5 rounded border text-[10px] whitespace-nowrap ${statusCls(d.status)}`}
                    >
                      {statusText(d.status, isUz)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {page.total > page.rows.length && (
              <p className="px-4 py-2.5 text-[11px] text-zinc-500 border-t border-zinc-200 dark:border-zinc-800">
                {isUz
                  ? `${page.rows.length} ta koʻrsatildi, jami ${page.total}. Filtrni toraytiring.`
                  : `Показано ${page.rows.length} из ${page.total}. Сузьте фильтр.`}
              </p>
            )}
          </>
        )}
      </div>

      {issue && (
        <IssueForm
          isUz={isUz}
          types={types}
          busy={issueBusy}
          error={issueError}
          onClose={() => setIssue(false)}
          onIssue={async (body) => {
            setIssueBusy(true);
            setIssueError(null);
            try {
              const res = await apiClient.documents.createFromSource(body);
              setIssue(false);
              await load();
              // Сразу открываем выписанное: человек жал «выписать», чтобы
              // увидеть документ, а не чтобы найти его потом в списке.
              const fresh = await apiClient.documents.list({ search: res.data.number, limit: 1 });
              const row = fresh.data.rows[0] ?? null;
              setIssued({ number: res.data.number, opened: Boolean(row) });

              if (row) setOpen(row);
            } catch (e) {
              setIssueError(e as ApiError);
            } finally {
              setIssueBusy(false);
            }
          }}
        />
      )}
    </div>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex flex-col gap-0.5 min-w-0">
    <span className="text-[11px] text-zinc-500">{label}</span>
    <span className="text-xs text-zinc-900 dark:text-zinc-100 break-words">{children}</span>
  </div>
);

/**
 * Карточка догружает документ целиком: строки и реквизиты в списке не
 * приходят намеренно — на 240 документов это 240 лишних запросов ради данных,
 * которых на экране списка не видно.
 */
const DocumentCard: React.FC<{
  row: DocumentRow;
  isUz: boolean;
  mayEdit: boolean;
  onBack: () => void;
}> = ({ row, isUz, mayEdit, onBack }) => {
  const [doc, setDoc] = useState<DocumentCardData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [printing, setPrinting] = useState<'docx' | 'pdf' | null>(null);
  const [printError, setPrintError] = useState<ApiError | null>(null);
  const [pane, setPane] = useState<Pane>('doc');
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState<ApiError | null>(null);
  const [edit, setEdit] = useState(false);
  const [editError, setEditError] = useState<ApiError | null>(null);
  /** Счётчик правок: по нему перечитываются редакции и журнал. */
  const [changed, setChanged] = useState(0);

  const reload = useCallback(async () => {
    const r = await apiClient.documents.one(row.uid);
    setDoc(r.data);
    setChanged((n) => n + 1);
  }, [row.uid]);

  const act = async (action: DocumentAction, comment?: string) => {
    setBusy(true);
    setActError(null);
    try {
      await apiClient.documents.act(row.uid, action, comment);
      await reload();
    } catch (e) {
      setActError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const save = async (body: {
    version: number;
    documentDate?: string;
    locale?: 'ru' | 'uz';
    lines?: DocumentLineInput[];
  }) => {
    setBusy(true);
    setEditError(null);
    try {
      await apiClient.documents.patch(row.uid, body);
      await reload();
      setEdit(false);
    } catch (e) {
      setEditError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Печатная форма собирается на сервере и приходит файлом.
   *
   * Ссылкой этого не сделать: на выдаче стоит право, а заголовок Authorization
   * к `<a href>` не приложить — браузер ушёл бы за файлом без токена.
   * Отказ показываем словами сервера: «нет опубликованного шаблона» — это не
   * ошибка пользователя, а незакрытая настройка, и он должен прочитать какая.
   */
  const print = async (format: 'docx' | 'pdf') => {
    setPrinting(format);
    setPrintError(null);
    try {
      const { blob, filename } = await apiClient.documents.file(row.uid, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setPrintError(e as ApiError);
    } finally {
      setPrinting(null);
    }
  };

  useEffect(() => {
    setDoc(null);
    apiClient.documents
      .one(row.uid)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e as ApiError));
  }, [row.uid]);

  const view = doc ?? row;

  return (
  <div className="flex flex-col gap-4 text-xs">
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <button type="button" onClick={onBack} className={BTN_GHOST + ' h-7'}>
        <ArrowLeft className="w-3 h-3 inline-block me-1" />
        {isUz ? 'Roʻyxatga' : 'К списку'}
      </button>
      <FileText className="w-3.5 h-3.5 text-zinc-400" />
      <h2 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50 font-mono break-words">
        {row.number}
      </h2>
      <span className={`px-1.5 rounded border text-[10px] whitespace-nowrap ${statusCls(view.status)}`}>
        {statusText(view.status, isUz)}
      </span>
      {mayEdit && (
        /*
          Две кнопки, а не выбор формата: DOCX — то, что ещё правят руками,
          PDF — то, что отправляют и подписывают. Это два разных действия, и
          прятать одно за список значит заставлять выбирать дважды.
          PDF собирается через LibreOffice и дольше — подпись это говорит.
        */
        <div className="flex flex-wrap items-center gap-2 ms-auto">
          <button
            type="button"
            disabled={printing !== null}
            onClick={() => void print('docx')}
            className={BTN_GHOST + ' h-7 whitespace-nowrap'}
          >
            <Download className="w-3 h-3 inline-block me-1" />
            {printing === 'docx' ? (isUz ? 'Yig‘ilmoqda…' : 'Собираю…') : 'DOCX'}
          </button>
          <button
            type="button"
            disabled={printing !== null}
            onClick={() => void print('pdf')}
            className={BTN_PRIMARY + ' h-7 whitespace-nowrap'}
          >
            <Printer className="w-3 h-3 inline-block me-1" />
            {printing === 'pdf' ? (isUz ? 'Yig‘ilmoqda…' : 'Собираю…') : 'PDF'}
          </button>
        </div>
      )}
    </div>

    {printError && <ErrorBox text={errorText(printError, isUz)} isUz={isUz} />}

    {error && (
      <ErrorBox text={errorText(error, isUz)} isUz={isUz} />
    )}

    {actError && <ErrorBox text={errorText(actError, isUz)} isUz={isUz} />}

    {doc && (
      <WorkflowBar
        doc={doc}
        isUz={isUz}
        busy={busy}
        onAct={(a, c) => void act(a, c)}
        onEdit={() => {
          setEditError(null);
          setEdit(true);
        }}
      />
    )}

    {/*
      Редакции и журнал — отдельные разделы, а не приписка внизу: на карточке и
      без них четыре блока, и пятый с шестым сделали бы её свитком, по которому
      строки документа надо искать прокруткой.
    */}
    <div className="flex flex-wrap items-center gap-1">
      {([
        ['doc', isUz ? 'Hujjat' : 'Документ', null],
        [
          'versions',
          `${isUz ? 'Tahrirlar' : 'Редакции'}${view.versions > 0 ? ` ${view.versions}` : ''}`,
          <Layers key="i" className="w-3 h-3" />,
        ],
        ['history', isUz ? 'Jurnal' : 'Журнал', <History key="i" className="w-3 h-3" />],
      ] as [Pane, string, React.ReactNode][]).map(([key, text, icon]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={pane === key}
          onClick={() => setPane(key)}
          className={`h-7 px-3 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap inline-flex items-center gap-1 ${
            pane === key
              ? 'bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900'
              : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
        >
          {icon}
          {text}
        </button>
      ))}
    </div>

    {pane === 'versions' && (
      <div className={CARD + ' min-w-0'}>
        <VersionsPanel uid={row.uid} isUz={isUz} reload={changed} />
      </div>
    )}

    {pane === 'history' && (
      <div className={CARD + ' min-w-0'}>
        <HistoryPanel uid={row.uid} isUz={isUz} reload={changed} />
      </div>
    )}

    {pane === 'doc' && (
     <>
    <div className={CARD + ' p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 min-w-0'}>
      <Field label={isUz ? 'Turi' : 'Тип'}>{refName(row.type, isUz)}</Field>
      <Field label={isUz ? 'Sana' : 'Дата'}>{day(view.documentDate, isUz)}</Field>
      <Field label={isUz ? 'Kompaniya' : 'Компания'}>
        {refName(row.company, isUz)}
      </Field>
      <Field label={isUz ? 'Kontragent' : 'Контрагент'}>
        {row.partner ? (
          <>
            {row.partner.name}
            {row.partner.inn && (
              <span className="text-[11px] text-zinc-500 ms-1">
                {isUz ? 'STIR' : 'ИНН'} {row.partner.inn}
              </span>
            )}
          </>
        ) : (
          '—'
        )}
      </Field>
      <Field label={isUz ? 'Summa' : 'Сумма'}>
        <span className="tabular-nums">
          {money(view.amountTotal, view.currency, isUz, true)}
        </span>
      </Field>
      <Field label={isUz ? 'Asos' : 'Основание'}>
        {row.source?.number ? (
          <span className="font-mono">
            {sourceText(row.source.kind, isUz)} {row.source.number}
          </span>
        ) : (
          '—'
        )}
      </Field>
      <Field label={isUz ? 'Til' : 'Язык'}>{view.locale === 'uz' ? 'oʻzbekcha' : 'русский'}</Field>
      <Field label={isUz ? 'Versiya' : 'Версия'}>{view.version}</Field>
      <Field label={isUz ? 'Kim yaratgan' : 'Кто завёл'}>{row.author?.name ?? '—'}</Field>
    </div>

    {doc?.requisites && <Requisites req={doc.requisites} isUz={isUz} />}
    {doc && <Lines lines={doc.lines} doc={doc} isUz={isUz} />}

    <div className={CARD + ' p-4 flex flex-col gap-2 min-w-0'}>
      <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
        {isUz ? 'Fayllar' : 'Файлы'}
      </span>
      {/* Сканы и подписанные экземпляры складываются сюда же, куда складывают
          фото приёмки и сертификаты партии: одно хранилище, одни правила. */}
      <AttachmentsPanel owner="document" uid={row.uid} canEdit={mayEdit} isUz={isUz} />
    </div>
     </>
    )}

    {edit && doc && (
      <EditDialog
        doc={doc}
        isUz={isUz}
        busy={busy}
        error={editError}
        onClose={() => setEdit(false)}
        onSave={(body) => void save(body)}
      />
    )}
  </div>
  );
};


const SOURCE_KINDS: [DocumentSourceKind, string, string][] = [
  ['sales_order', 'Заказ', 'Buyurtma'],
  ['shipment', 'Отгрузка', 'Yuklash'],
  ['deal', 'Сделка', 'Bitim'],
  ['finance_operation', 'Платёж', 'To‘lov'],
  ['production_order', 'Производство', 'Ishlab chiqarish'],
  ['partner', 'Контрагент', 'Kontragent'],
];

/**
 * Реквизиты — снимок на момент выписки, а не текущие данные компании и
 * клиента. Поэтому они показываются отдельным блоком, а не подмешиваются к
 * карточке контрагента: сменили расчётный счёт — в выписанном счёте остался
 * прежний, и это не ошибка, а смысл документа.
 */
const Requisites: React.FC<{ req: DocumentRequisites; isUz: boolean }> = ({ req, isUz }) => (
  <div className={CARD + ' p-4 flex flex-col gap-3 min-w-0'}>
    <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
      {isUz ? 'Rekvizitlar (yozilgan paytdagi)' : 'Реквизиты на момент выписки'}
    </span>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 min-w-0">
      <Field label={isUz ? 'Kim yozdi' : 'Кто выписал'}>
        {req.company.name}
        {req.company.inn && (
          <span className="text-[11px] text-zinc-500 ms-1">
            {isUz ? 'STIR' : 'ИНН'} {req.company.inn}
          </span>
        )}
        {req.company.legalAddress && (
          <div className="text-[11px] text-zinc-500">{req.company.legalAddress}</div>
        )}
      </Field>
      <Field label={isUz ? 'Kimga' : 'Кому'}>
        {req.partner ? (
          <>
            {req.partner.name}
            {req.partner.inn && (
              <span className="text-[11px] text-zinc-500 ms-1">
                {isUz ? 'STIR' : 'ИНН'} {req.partner.inn}
              </span>
            )}
            {req.partner.legalAddress && (
              <div className="text-[11px] text-zinc-500">{req.partner.legalAddress}</div>
            )}
          </>
        ) : (
          '—'
        )}
      </Field>
      <Field label={isUz ? 'Asos' : 'Основание'}>{req.basis}</Field>
      <Field label={isUz ? 'To‘lov muddati' : 'Срок оплаты'}>
        {req.paymentDueDate
          ? day(req.paymentDueDate, isUz)
          : req.paymentDelayDays
            ? `${isUz ? 'kechikish' : 'отсрочка'} ${req.paymentDelayDays} ${isUz ? 'kun' : 'дней'}`
            : '—'}
      </Field>
      {req.vehicle && <Field label={isUz ? 'Transport' : 'Транспорт'}>{req.vehicle}</Field>}
      {req.driver && <Field label={isUz ? 'Haydovchi' : 'Водитель'}>{req.driver}</Field>}
    </div>
    <div className="border-t border-zinc-200 dark:border-zinc-800 pt-2 min-w-0">
      <span className="text-[11px] text-zinc-500">{isUz ? 'Summa yozuvda' : 'Сумма прописью'}</span>
      <div className="text-xs text-zinc-900 dark:text-zinc-100 break-words">
        {req.amountInWords}
      </div>
    </div>
  </div>
);

const num = (v: string, digits = 2) =>
  Number(v).toLocaleString('ru-RU', { maximumFractionDigits: digits });

/**
 * Табличная часть. Колонок семь, и прятать правый край прокруткой нельзя:
 * без «НДС» и «Всего» строка счёта бессмысленна. Поэтому на узком экране
 * строка становится карточкой «подпись — значение», как в отчётах склада.
 */
const Lines: React.FC<{ lines: DocumentLine[]; doc: DocumentCardData; isUz: boolean }> = ({
  lines,
  doc,
  isUz,
}) => {
  if (!lines.length) {
    return (
      <div className={CARD + ' p-4 text-xs text-zinc-500 break-words'}>
        {isUz
          ? 'Bu hujjatda jadval qismi yo‘q: manbada satrlar bo‘lmagan.'
          : 'Табличной части нет: в источнике строк не было. Так бывает у документов ' +
            'по сделке, платежу и контрагенту — там сумма одна, перечислять нечего.'}
      </div>
    );
  }
  const head = [
    ['', ''],
    [isUz ? 'Nomi' : 'Наименование', ''],
    [isUz ? 'Soni' : 'Кол-во', 'end'],
    [isUz ? 'Birlik' : 'Ед.', ''],
    [isUz ? 'Narx' : 'Цена', 'end'],
    [isUz ? 'Summa' : 'Сумма', 'end'],
    [isUz ? 'QQS' : 'НДС', 'end'],
    [isUz ? 'Jami' : 'Всего', 'end'],
  ];
  return (
    <div className={CARD + ' flex flex-col min-w-0'}>
      <div className="px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-800">
        <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
          {isUz ? 'Jadval qismi' : 'Табличная часть'}
        </span>
      </div>

      {/* Широкий экран — таблица. */}
      <table className="hidden md:table w-full text-xs">
        <thead>
          <tr className="text-[11px] text-zinc-500">
            {head.map(([t, align], i) => (
              <th
                key={i}
                className={`px-3 py-1.5 font-normal ${align === 'end' ? 'text-end' : 'text-start'}`}
              >
                {t}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {lines.map((l) => (
            <tr key={l.uid}>
              <td className="px-3 py-1.5 text-zinc-400 tabular-nums">{l.seq}</td>
              <td className="px-3 py-1.5 break-words">
                {l.name}
                {l.itemCode && (
                  <span className="text-[11px] font-mono text-zinc-400 ms-1">{l.itemCode}</span>
                )}
              </td>
              <td className="px-3 py-1.5 text-end tabular-nums whitespace-nowrap">{num(l.qty, 3)}</td>
              <td className="px-3 py-1.5 whitespace-nowrap">{l.unitCode}</td>
              <td className="px-3 py-1.5 text-end tabular-nums whitespace-nowrap">{num(l.price)}</td>
              <td className="px-3 py-1.5 text-end tabular-nums whitespace-nowrap">{num(l.amountNet)}</td>
              <td className="px-3 py-1.5 text-end tabular-nums whitespace-nowrap">
                {num(l.amountVat)}
                <span className="text-[11px] text-zinc-400 ms-1">{num(l.vatRate, 0)}%</span>
              </td>
              <td className="px-3 py-1.5 text-end tabular-nums whitespace-nowrap font-medium">
                {num(l.amountTotal)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Узкий — карточки в том же порядке, что колонки. */}
      <ul className="md:hidden divide-y divide-zinc-200 dark:divide-zinc-800">
        {lines.map((l) => (
          <li key={l.uid} className="px-4 py-2.5 flex flex-col gap-1 min-w-0">
            <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
              {l.seq}. {l.name}
            </span>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
              <span>{isUz ? 'Soni' : 'Кол-во'}</span>
              <span className="text-end tabular-nums text-zinc-900 dark:text-zinc-100">
                {num(l.qty, 3)} {l.unitCode}
              </span>
              <span>{isUz ? 'Narx' : 'Цена'}</span>
              <span className="text-end tabular-nums text-zinc-900 dark:text-zinc-100">
                {num(l.price)}
              </span>
              <span>{isUz ? 'QQS' : 'НДС'} {num(l.vatRate, 0)}%</span>
              <span className="text-end tabular-nums text-zinc-900 dark:text-zinc-100">
                {num(l.amountVat)}
              </span>
              <span>{isUz ? 'Jami' : 'Всего'}</span>
              <span className="text-end tabular-nums font-medium text-zinc-900 dark:text-zinc-100">
                {num(l.amountTotal)}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <div className="px-4 py-2.5 border-t border-zinc-200 dark:border-zinc-800 flex flex-wrap items-center gap-x-4 gap-y-1 justify-end text-xs">
        <span className="text-zinc-500">
          {isUz ? 'QQSsiz' : 'Без НДС'}{' '}
          <span className="tabular-nums text-zinc-900 dark:text-zinc-100">
            {money(doc.amountNet, doc.currency, isUz, true)}
          </span>
        </span>
        <span className="text-zinc-500">
          {isUz ? 'QQS' : 'НДС'}{' '}
          <span className="tabular-nums text-zinc-900 dark:text-zinc-100">
            {money(doc.amountVat, doc.currency, isUz, true)}
          </span>
        </span>
        <span className="font-medium text-zinc-900 dark:text-zinc-100">
          {isUz ? 'Jami' : 'Итого'}{' '}
          <span className="tabular-nums">{money(doc.amountTotal, doc.currency, isUz, true)}</span>
        </span>
      </div>
    </div>
  );
};

/**
 * Выписка документа из источника.
 *
 * Порядок полей — порядок вопроса: что выписываем, на основании чего, и уже
 * потом какой именно заказ. Источник ищется по номеру, а не выбирается из
 * полного списка: заказов в системе тысячи, и выпадающий список на тысячу
 * строк — это не выбор, а поиск вслепую.
 */
const IssueForm: React.FC<{
  isUz: boolean;
  types: DocumentTypeRef[];
  busy: boolean;
  error: ApiError | null;
  onClose: () => void;
  onIssue: (body: {
    documentTypeUid: string;
    sourceType: DocumentSourceKind;
    sourceUid: string;
    locale: 'ru' | 'uz';
  }) => void;
}> = ({ isUz, types, busy, error, onClose, onIssue }) => {
  const [typeUid, setTypeUid] = useState(types[0]?.uid ?? '');
  const [kind, setKind] = useState<DocumentSourceKind>('sales_order');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<DocumentSourceRow[] | null>(null);
  const [picked, setPicked] = useState<DocumentSourceRow | null>(null);
  const [locale, setLocale] = useState<'ru' | 'uz'>(isUz ? 'uz' : 'ru');

  useEffect(() => {
    setPicked(null);
    let alive = true;
    const t = setTimeout(() => {
      apiClient.documents
        .sources(kind, search)
        .then((r) => alive && setRows(r.data.rows))
        .catch(() => alive && setRows([]));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [kind, search]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-3 overflow-y-auto">
      {/* role/aria-modal объявлены не для галочки: без них список под окном
          остаётся для скринридера частью той же страницы, и «следующий
          элемент» уводит за пределы окна. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isUz ? 'Hujjat yozish' : 'Выписать документ'}
        className={CARD + ' w-full max-w-xl p-4 flex flex-col gap-3 min-w-0'}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">
            {isUz ? 'Hujjat yozish' : 'Выписать документ'}
          </span>
          <button type="button" onClick={onClose} className={BTN_GHOST + ' h-7 ms-auto'} aria-label="X">
            <X className="w-3 h-3" />
          </button>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Nima yozamiz' : 'Что выписываем'}</span>
          <CustomSelect
            ariaLabel={isUz ? 'Hujjat turi' : 'Что выписываем'}
            value={typeUid}
            onChange={setTypeUid}
            options={types.map((t) => ({
              value: t.uid,
              label: refName(t, isUz),
              sublabel: `${t.company.code} · ${t.nextNumber}`,
            }))}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Asos' : 'На основании'}</span>
          <CustomSelect
            ariaLabel={isUz ? 'Asos turi' : 'На основании'}
            value={kind}
            onChange={(v) => setKind(v as DocumentSourceKind)}
            options={SOURCE_KINDS.map(([v, ru, uz]) => ({ value: v, label: isUz ? uz : ru }))}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-500">
            {kind === 'partner'
              ? isUz
                ? 'Nomi yoki STIR'
                : 'Название или ИНН'
              : isUz
                ? 'Raqam boʻyicha qidirish'
                : 'Поиск по номеру'}
          </span>
          <input
            aria-label={isUz ? 'Manbani qidirish' : 'Поиск источника'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={FIELD}
          />
        </label>

        <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg max-h-56 overflow-y-auto min-w-0">
          {!rows ? (
            <div className="p-3">
              <Skeleton />
            </div>
          ) : rows.length === 0 ? (
            <div className="p-3 text-[11px] text-zinc-500">
              {isUz ? 'Topilmadi' : 'Ничего не нашлось'}
            </div>
          ) : (
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {rows.map((r) => (
                <li key={r.uid}>
                  <button
                    type="button"
                    onClick={() => setPicked(r)}
                    className={`w-full text-start px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 cursor-pointer min-w-0 ${
                      picked?.uid === r.uid
                        ? 'bg-zinc-100 dark:bg-zinc-800'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                    }`}
                  >
                    <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 break-words">
                      {r.number}
                    </span>
                    {r.at && <span className="text-[11px] text-zinc-500">{day(r.at, isUz)}</span>}
                    {r.partner && (
                      <span className="text-[11px] text-zinc-600 dark:text-zinc-400 break-words">
                        {r.partner}
                      </span>
                    )}
                    {r.amount && (
                      <span className="text-[11px] text-zinc-500 tabular-nums ms-auto">
                        {num(r.amount, 0)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Hujjat tili' : 'Язык документа'}</span>
          <CustomSelect
            ariaLabel={isUz ? 'Hujjat tili' : 'Язык документа'}
            value={locale}
            onChange={(v) => setLocale(v as 'ru' | 'uz')}
            options={[
              { value: 'ru', label: 'русский' },
              { value: 'uz', label: 'oʻzbekcha' },
            ]}
          />
        </label>

        {error && <ErrorBox text={errorText(error, isUz)} isUz={isUz} />}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || !typeUid || !picked}
            onClick={() =>
              picked &&
              onIssue({ documentTypeUid: typeUid, sourceType: kind, sourceUid: picked.uid, locale })
            }
            className={BTN_PRIMARY}
          >
            {busy ? (isUz ? 'Yozilmoqda…' : 'Выписываю…') : isUz ? 'Yozish' : 'Выписать'}
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST}>
            {isUz ? 'Bekor qilish' : 'Отмена'}
          </button>
          {!picked && (
            <span className="text-[11px] text-zinc-500 break-words">
              {isUz ? 'Avval asosni tanlang' : 'Сначала выберите основание в списке'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
