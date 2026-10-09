/**
 * Согласование, редакции и журнал документа (ТЗ 7.4).
 *
 * Экран ничего не решает сам: какие действия доступны, говорит сервер
 * (`card.actions`). Свой список правил на фронте однажды разошёлся бы с
 * серверным, и кнопка предлагала бы действие, на которое придёт отказ.
 *
 * Слова при возврате и отмене спрашиваются до отправки, а не после отказа:
 * человек уже нажал «Вернуть» — незачем гонять его через ошибку, чтобы
 * выяснить, что нужна причина.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Check, Clock, Download, PenLine, RotateCcw, Send, X } from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { errorText } from '../../context/DashboardContext';
import type {
  DocumentAction,
  DocumentCard,
  DocumentHistoryRow,
  DocumentLineInput,
  DocumentVersionsPage,
} from '../../types/api';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, ErrorBox, FIELD, Skeleton } from './warehouse-ui';
import { CustomSelect } from '../common/CustomSelect';
import { CustomDatePicker } from '../common/CustomDatePicker';
import { statusText } from './document-status';

const ACTION: Record<
  DocumentAction,
  { ru: string; uz: string; icon: React.ReactNode; primary?: boolean; comment?: boolean }
> = {
  submit: {
    ru: 'На согласование',
    uz: 'Kelishuvga',
    icon: <Send className="w-3 h-3" />,
    primary: true,
  },
  approve: { ru: 'Утвердить', uz: 'Tasdiqlash', icon: <Check className="w-3 h-3" />, primary: true },
  return: {
    ru: 'Вернуть',
    uz: 'Qaytarish',
    icon: <RotateCcw className="w-3 h-3" />,
    comment: true,
  },
  sign: {
    ru: 'Подписан',
    uz: 'Imzolangan',
    icon: <PenLine className="w-3 h-3" />,
    primary: true,
  },
  cancel: { ru: 'Отменить', uz: 'Bekor qilish', icon: <X className="w-3 h-3" />, comment: true },
};

/** Что уже случилось с документом — строка журнала согласования. */
const ACTION_PAST: Record<string, { ru: string; uz: string }> = {
  submit: { ru: 'Отправлен на согласование', uz: 'Kelishuvga yuborildi' },
  approve: { ru: 'Утверждён', uz: 'Tasdiqlandi' },
  return: { ru: 'Возвращён на доработку', uz: 'Qayta ishlashga qaytarildi' },
  sign: { ru: 'Отмечен подписанным', uz: 'Imzolangan deb belgilandi' },
  cancel: { ru: 'Отменён', uz: 'Bekor qilindi' },
  edit: { ru: 'Изменён', uz: 'O‘zgartirildi' },
  edit_new_version: {
    ru: 'Изменён — заведена новая редакция',
    uz: 'O‘zgartirildi — yangi tahrir ochildi',
  },
};

/** Поле документа в строке «что именно изменилось». */
const FIELD_LABEL: Record<string, { ru: string; uz: string }> = {
  status: { ru: 'Статус', uz: 'Holat' },
  comment: { ru: 'Комментарий', uz: 'Izoh' },
  documentDate: { ru: 'Дата документа', uz: 'Hujjat sanasi' },
  locale: { ru: 'Язык', uz: 'Til' },
  amountTotal: { ru: 'Сумма', uz: 'Summa' },
  lines: { ru: 'Табличная часть', uz: 'Jadval qismi' },
  version: { ru: 'Редакция', uz: 'Tahrir' },
};

const at = (v: string, isUz: boolean) =>
  new Date(v).toLocaleString(isUz ? 'uz-UZ' : 'ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const money = (v: string | null, isUz: boolean) =>
  v === null ? '—' : Number(v).toLocaleString(isUz ? 'uz-UZ' : 'ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/**
 * Число для поля ввода.
 *
 * База хранит четыре знака и отдаёт «12.0000» для ставки НДС и «30.444670»
 * для тонн. Человек правит счёт, а не таблицу базы: хвост нулей он всё равно
 * сотрёт, а прочитав «12.0000», сначала решит, что тут что-то не так.
 */
const num = (v: string | null | undefined) => {
  const s = String(v ?? '').trim();
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/**
 * Число из поля ввода.
 *
 * «30,5» здесь пишут чаще, чем «30.5»: на экране всюду запятая. Сервер ждёт
 * точку, и без замены он отвечал бы «количество должно быть больше нуля» на
 * совершенно правильное количество.
 */
const plain = (v: string) => v.trim().replace(',', '.');

const saveBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

/** Полоса со статусом, причиной и кнопками маршрута. */
export const WorkflowBar: React.FC<{
  doc: DocumentCard;
  isUz: boolean;
  busy: boolean;
  onAct: (action: DocumentAction, comment?: string) => void;
  onEdit: () => void;
}> = ({ doc, isUz, busy, onAct, onEdit }) => {
  const [ask, setAsk] = useState<DocumentAction | null>(null);
  const [comment, setComment] = useState('');
  const canEdit = doc.actions.length > 0 && doc.status !== 'pending_approval'
    && doc.status !== 'cancelled';

  return (
    <div className={CARD + ' p-4 flex flex-col gap-2 min-w-0'}>
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
          {isUz ? 'Kelishuv' : 'Согласование'}
        </span>
        {doc.statusAt && (
          <span className="text-[11px] text-zinc-500 break-words">
            {statusText(doc.status, isUz).toLowerCase()} · {at(doc.statusAt, isUz)}
            {doc.statusUser ? ` · ${doc.statusUser}` : ''}
          </span>
        )}
        <div className="flex flex-wrap items-center gap-1.5 sm:ms-auto">
          {canEdit && (
            <button
              type="button"
              disabled={busy}
              onClick={onEdit}
              className={BTN_GHOST + ' h-7 inline-flex items-center gap-1 whitespace-nowrap'}
            >
              <PenLine className="w-3 h-3" />
              {isUz ? 'Tahrirlash' : 'Править'}
            </button>
          )}
          {doc.actions.map((a) => (
            <button
              key={a}
              type="button"
              disabled={busy}
              onClick={() => {
                if (ACTION[a].comment) {
                  setComment('');
                  setAsk(a);
                } else {
                  onAct(a);
                }
              }}
              className={
                (ACTION[a].primary ? BTN_PRIMARY : BTN_GHOST) +
                ' h-7 inline-flex items-center gap-1 whitespace-nowrap'
              }
            >
              {ACTION[a].icon}
              {isUz ? ACTION[a].uz : ACTION[a].ru}
            </button>
          ))}
        </div>
      </div>

      {/*
        Почему документ в этом статусе — рядом со статусом, а не в журнале:
        переделывает это тот, кто открыл карточку, и искать причину в истории
        он не пойдёт.
      */}
      {doc.statusComment && (
        <div className="text-[11px] text-amber-700 dark:text-amber-400 break-words">
          {doc.statusComment}
        </div>
      )}

      {doc.actions.length === 0 && (
        <span className="text-[11px] text-zinc-500 break-words">
          {doc.status === 'cancelled'
            ? isUz
              ? 'Hujjat bekor qilingan: u bilan boshqa ishlanmaydi.'
              : 'Документ отменён: с ним больше ничего не делают.'
            : isUz
              ? 'Bu bosqichda sizdan harakat talab qilinmaydi.'
              : 'На этом шаге от вас действий не требуется — решение за согласующим.'}
        </span>
      )}

      {ask && (
        <CommentDialog
          isUz={isUz}
          title={isUz ? ACTION[ask].uz : ACTION[ask].ru}
          value={comment}
          onChange={setComment}
          onClose={() => setAsk(null)}
          onSubmit={() => {
            onAct(ask, comment);
            setAsk(null);
          }}
        />
      )}
    </div>
  );
};

const CommentDialog: React.FC<{
  isUz: boolean;
  title: string;
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}> = ({ isUz, title, value, onChange, onClose, onSubmit }) => (
  <div
    role="dialog"
    aria-modal="true"
    aria-label={title}
    className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-zinc-900/40 p-3 overflow-y-auto"
  >
    <div className={CARD + ' w-full max-w-md p-4 flex flex-col gap-3 min-w-0'}>
      <div className="flex items-start gap-2">
        <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={isUz ? 'Yopish' : 'Закрыть'}
          className={BTN_GHOST + ' h-7 ms-auto shrink-0'}
        >
          <X className="w-3 h-3" />
        </button>
      </div>
      <label className="flex flex-col gap-1 min-w-0">
        <span className="text-[11px] text-zinc-500">
          {isUz ? 'Sabab' : 'Причина'}
        </span>
        <textarea
          autoFocus
          rows={3}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={isUz ? 'Sabab' : 'Причина'}
          className={FIELD.replace('h-8', 'h-20 py-2 resize-y')}
        />
      </label>
      <span className="text-[11px] text-zinc-500 break-words">
        {isUz
          ? 'Sababsiz jurnalda sababsiz harakat qoladi, ijrochi esa nimani tuzatishni bilmaydi.'
          : 'Без причины в журнале останется действие без объяснения, а исполнитель не узнает, что переделывать.'}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!value.trim()}
          onClick={onSubmit}
          className={BTN_PRIMARY + ' h-7'}
        >
          {isUz ? 'Saqlash' : 'Готово'}
        </button>
        <button type="button" onClick={onClose} className={BTN_GHOST + ' h-7'}>
          {isUz ? 'Bekor qilish' : 'Отмена'}
        </button>
      </div>
    </div>
  </div>
);

/** Архив редакций: что было до правок и чем это печаталось. */
export const VersionsPanel: React.FC<{ uid: string; isUz: boolean; reload: number }> = ({
  uid,
  isUz,
  reload,
}) => {
  const [data, setData] = useState<DocumentVersionsPage | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData((await apiClient.documents.versions(uid)).data);
    } catch (e) {
      setData(null);
      setError(e as ApiError);
    }
  }, [uid]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  const grab = async (version: number, format: 'docx' | 'pdf') => {
    setError(null);
    try {
      const { blob, filename } = await apiClient.documents.versionFile(uid, version, format);
      saveBlob(blob, filename);
    } catch (e) {
      setError(e as ApiError);
    }
  };

  if (error) return <ErrorBox text={errorText(error, isUz)} isUz={isUz} />;
  if (!data) return <Skeleton />;
  if (data.rows.length === 0) {
    return (
      <Empty
        text={
          isUz
            ? 'Oldingi tahrirlar yo‘q: hujjat tasdiqlangandan keyin o‘zgartirilmagan.'
            : 'Прежних редакций нет: документ не правили после утверждения.'
        }
      />
    );
  }

  return (
    <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
      {data.rows.map((v) => (
        <li key={v.uid} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
          <span className="text-[11px] font-mono text-zinc-400 shrink-0">
            {isUz ? 'tahrir' : 'ред.'} {v.version}
          </span>
          <span className="px-1.5 rounded border border-zinc-300 dark:border-zinc-700 text-[10px] text-zinc-500 shrink-0 whitespace-nowrap">
            {statusText(v.status, isUz)}
          </span>
          <span className="text-[11px] text-zinc-500 whitespace-nowrap">
            {String(v.documentDate).slice(0, 10).split('-').reverse().join('.')}
          </span>
          <span className="text-xs text-zinc-900 dark:text-zinc-100 tabular-nums whitespace-nowrap">
            {money(v.amountTotal, isUz)}
          </span>
          <span className="text-[11px] text-zinc-500 whitespace-nowrap">
            {isUz ? 'satr' : 'строк'} {v.linesCount}
          </span>
          <span className="text-[11px] text-zinc-500 break-words">
            {at(v.replacedAt, isUz)}
            {v.author ? ` · ${v.author}` : ''}
          </span>
          <div className="flex flex-wrap items-center gap-1 min-w-0 sm:ms-auto">
            {/*
              Кнопка стоит только там, где файл есть чем собрать. Шаблон
              закрепляется на документе первой удачной печатью: редакцию,
              которую не печатали, предлагать скачать значит обещать отказ.
            */}
            {v.hasTemplate ? (
              <button
                type="button"
                onClick={() => void grab(v.version, 'docx')}
                title={
                  isUz
                    ? 'Bu tahrirni o‘z shabloni bilan yuklab olish'
                    : 'Скачать эту редакцию — тем шаблоном и теми цифрами, какими её печатали'
                }
                className={BTN_GHOST + ' h-7 text-[11px] px-2 inline-flex items-center gap-1'}
              >
                <Download className="w-3 h-3" />
                DOCX
              </button>
            ) : (
              <span className="text-[11px] text-zinc-500 break-words">
                {isUz ? 'bu tahrir chop etilmagan' : 'эту редакцию не печатали'}
              </span>
            )}
            {/*
              PDF предлагается только у той редакции, которую печатали:
              собрать его заново означало бы другой файл, а спор с клиентом
              идёт о той бумаге, которую он получил.
            */}
            {v.hasPdf && (
              <button
                type="button"
                onClick={() => void grab(v.version, 'pdf')}
                title={
                  isUz
                    ? 'Bu tahrirning chop etilgan PDF fayli'
                    : 'Тот самый PDF, которым эту редакцию печатали'
                }
                className={BTN_GHOST + ' h-7 text-[11px] px-2 inline-flex items-center gap-1'}
              >
                <Download className="w-3 h-3" />
                PDF
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
};

/** Журнал: кто, когда и что сделал с документом. */
export const HistoryPanel: React.FC<{ uid: string; isUz: boolean; reload: number }> = ({
  uid,
  isUz,
  reload,
}) => {
  const [rows, setRows] = useState<DocumentHistoryRow[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows((await apiClient.documents.history(uid)).data.rows);
    } catch (e) {
      setRows(null);
      setError(e as ApiError);
    }
  }, [uid]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  if (error) return <ErrorBox text={errorText(error, isUz)} isUz={isUz} />;
  if (!rows) return <Skeleton />;
  if (rows.length === 0) {
    return (
      <Empty
        text={
          isUz
            ? 'Jurnal bo‘sh: hujjat yozilgandan beri unga tegilmagan.'
            : 'Журнал пуст: с момента выписки документ не трогали.'
        }
      />
    );
  }

  return (
    <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
      {rows.map((r, i) => (
        <li key={i} className="px-4 py-2.5 flex flex-col gap-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            <Clock className="w-3 h-3 text-zinc-400 shrink-0" />
            <span className="text-[11px] text-zinc-500 whitespace-nowrap">{at(r.at, isUz)}</span>
            <span className="text-xs text-zinc-900 dark:text-zinc-100 break-words">
              {ACTION_PAST[r.action] ? (isUz ? ACTION_PAST[r.action].uz : ACTION_PAST[r.action].ru) : r.action}
            </span>
            {r.user && <span className="text-[11px] text-zinc-500 break-words">{r.user}</span>}
          </div>
          {Object.entries(r.changes).length > 0 && (
            <div className="flex flex-col gap-0.5 ps-5">
              {Object.entries(r.changes).map(([k, v]) => (
                <span key={k} className="text-[11px] text-zinc-500 break-words">
                  {FIELD_LABEL[k] ? (isUz ? FIELD_LABEL[k].uz : FIELD_LABEL[k].ru) : k}:{' '}
                  {k === 'comment' ? (
                    <span className="text-zinc-700 dark:text-zinc-300">{String(v.to ?? '')}</span>
                  ) : k === 'lines' && v.from === v.to ? (
                    /* Таблицу переписали, а строк столько же: «3 → 3» выглядело
                       бы опечаткой, хотя изменение настоящее. */
                    <span className="text-zinc-700 dark:text-zinc-300">
                      {isUz ? `qayta yozilgan, ${v.to} satr` : `переписана, строк ${v.to}`}
                    </span>
                  ) : (
                    <>
                      <span className="text-zinc-400">{label(k, v.from, isUz)}</span>
                      {' → '}
                      <span className="text-zinc-700 dark:text-zinc-300">{label(k, v.to, isUz)}</span>
                    </>
                  )}
                </span>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
};

const label = (field: string, v: unknown, isUz: boolean) => {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'status') return statusText(String(v), isUz).toLowerCase();
  // Деньги в журнале пишутся так же, как везде на экране: «403200604.2662»
  // человек читает не как сумму, а как ошибку.
  if (field === 'amountTotal') return money(String(v), isUz);
  return String(v);
};

/**
 * Правка документа.
 *
 * Табличная часть заменяется целиком, а не по строке: документ — снимок, и
 * его таблица это один предмет. Суммы считает сервер, здесь они показываются
 * на глаз, чтобы человек видел, к чему ведёт правка, до сохранения.
 */
export const EditDialog: React.FC<{
  doc: DocumentCard;
  isUz: boolean;
  busy: boolean;
  error: ApiError | null;
  onClose: () => void;
  onSave: (body: {
    version: number;
    documentDate?: string;
    locale?: 'ru' | 'uz';
    lines?: DocumentLineInput[];
  }) => void;
}> = ({ doc, isUz, busy, error, onClose, onSave }) => {
  const [date, setDate] = useState(String(doc.documentDate).slice(0, 10));
  const [locale, setLocale] = useState<'ru' | 'uz'>(doc.locale);
  const [lines, setLines] = useState<DocumentLineInput[]>(
    doc.lines.map((l) => ({
      name: l.name,
      qty: num(l.qty),
      price: num(l.price),
      unitCode: l.unitCode,
      unitName: l.unitName,
      itemCode: l.itemCode,
      discountPercent: num(l.discountPercent),
      vatRate: num(l.vatRate),
    })),
  );

  const newVersion = doc.status === 'approved' || doc.status === 'signed';

  const set = (i: number, patch: Partial<DocumentLineInput>) =>
    setLines((s) => s.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const totals = lines.reduce(
    (a, l) => {
      const net =
        Number(plain(l.qty) || 0) *
        Number(plain(l.price) || 0) *
        (1 - Number(plain(l.discountPercent ?? '') || 0) / 100);
      const vat = net * (Number(plain(l.vatRate ?? '') || 0) / 100);
      return { net: a.net + net, vat: a.vat + vat, total: a.total + net + vat };
    },
    { net: 0, vat: 0, total: 0 },
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isUz ? 'Hujjatni tahrirlash' : 'Правка документа'}
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-zinc-900/40 p-3 overflow-y-auto"
    >
      <div className={CARD + ' w-full max-w-3xl p-4 flex flex-col gap-3 min-w-0'}>
        <div className="flex items-start gap-2">
          <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
            {isUz ? 'Hujjatni tahrirlash' : 'Правка документа'} — {doc.number}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={isUz ? 'Yopish' : 'Закрыть'}
            className={BTN_GHOST + ' h-7 ms-auto shrink-0'}
          >
            <X className="w-3 h-3" />
          </button>
        </div>

        {/*
          Предупреждение до сохранения, а не после: правка утверждённого
          документа — это не то же самое, что правка черновика, и узнать об
          этом из ответа сервера человеку поздно.
        */}
        {newVersion && (
          <div className="text-[11px] text-amber-700 dark:text-amber-400 break-words">
            {isUz
              ? 'Hujjat tasdiqlangan. Saqlash yangi tahrirni ochadi, oldingisi arxivga o‘z fayllari bilan ketadi, hujjat esa qoralamaga qaytadi va qaytadan kelishiladi.'
              : 'Документ уже утверждён. Сохранение заведёт новую редакцию: прежняя уйдёт в архив со своими файлами, а документ вернётся в черновик и пойдёт на согласование заново.'}
          </div>
        )}

        {error && <ErrorBox text={errorText(error, isUz)} isUz={isUz} />}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 min-w-0">
          <label className="flex flex-col gap-1 min-w-0">
            <span className="text-[11px] text-zinc-500">{isUz ? 'Sana' : 'Дата документа'}</span>
            <CustomDatePicker
              portal
              value={date}
              onChange={setDate}
              ariaLabel={isUz ? 'Sana' : 'Дата документа'}
            />
          </label>
          <label className="flex flex-col gap-1 min-w-0">
            <span className="text-[11px] text-zinc-500">{isUz ? 'Til' : 'Язык'}</span>
            <CustomSelect
              portal
              value={locale}
              onChange={(v) => setLocale(v as 'ru' | 'uz')}
              options={[
                { value: 'ru', label: 'Русский' },
                { value: 'uz', label: 'O‘zbekcha' },
              ]}
              ariaLabel={isUz ? 'Til' : 'Язык'}
            />
          </label>
        </div>

        {lines.length > 0 && (
          <div className="flex flex-col gap-2 min-w-0">
            <span className="text-[11px] text-zinc-500">
              {isUz ? 'Jadval qismi' : 'Табличная часть'}
            </span>
            <ul className="flex flex-col gap-2">
              {lines.map((l, i) => (
                <li
                  key={i}
                  className="grid grid-cols-1 sm:grid-cols-[minmax(0,3fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)_auto] gap-1.5 min-w-0 items-end"
                >
                  <label className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-[10px] text-zinc-400">
                      {isUz ? 'Nomi' : 'Наименование'}
                    </span>
                    <input
                      value={l.name}
                      onChange={(e) => set(i, { name: e.target.value })}
                      aria-label={`${isUz ? 'Nomi' : 'Наименование'} ${i + 1}`}
                      className={FIELD + ' w-full min-w-0'}
                    />
                  </label>
                  <label className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-[10px] text-zinc-400">{isUz ? 'Soni' : 'Кол-во'}</span>
                    <input
                      inputMode="decimal"
                      value={l.qty}
                      onChange={(e) => set(i, { qty: e.target.value })}
                      aria-label={`${isUz ? 'Soni' : 'Количество'} ${i + 1}`}
                      className={FIELD + ' w-full min-w-0 text-end tabular-nums'}
                    />
                  </label>
                  <label className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-[10px] text-zinc-400">{isUz ? 'Narx' : 'Цена'}</span>
                    <input
                      inputMode="decimal"
                      value={l.price}
                      onChange={(e) => set(i, { price: e.target.value })}
                      aria-label={`${isUz ? 'Narx' : 'Цена'} ${i + 1}`}
                      className={FIELD + ' w-full min-w-0 text-end tabular-nums'}
                    />
                  </label>
                  <label className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-[10px] text-zinc-400">{isUz ? 'QQS %' : 'НДС, %'}</span>
                    <input
                      inputMode="decimal"
                      value={l.vatRate ?? '0'}
                      onChange={(e) => set(i, { vatRate: e.target.value })}
                      aria-label={`${isUz ? 'QQS' : 'НДС'} ${i + 1}`}
                      className={FIELD + ' w-full min-w-0 text-end tabular-nums'}
                    />
                  </label>
                  {/* На узком экране строка разложена в столбик, и кнопка без
                      подписи читается как отдельный пустой блок. */}
                  <button
                    type="button"
                    disabled={lines.length === 1}
                    onClick={() => setLines((s) => s.filter((_, j) => j !== i))}
                    aria-label={`${isUz ? 'Satrni o‘chirish' : 'Убрать строку'} ${i + 1}`}
                    className={BTN_GHOST + ' h-8 shrink-0 inline-flex items-center justify-center gap-1'}
                  >
                    <X className="w-3 h-3" />
                    <span className="sm:hidden">{isUz ? 'Satrni o‘chirish' : 'Убрать строку'}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setLines((s) => [
                    ...s,
                    { name: '', qty: '1', price: '0', vatRate: s[0]?.vatRate ?? '12', unitCode: s[0]?.unitCode },
                  ])
                }
                className={BTN_GHOST + ' h-7 text-[11px]'}
              >
                {isUz ? 'Satr qo‘shish' : 'Добавить строку'}
              </button>
              {/*
                Итоги переносятся по частям: одной строкой с `whitespace-nowrap`
                они на 360 растягивали диалог и заводили в нём горизонтальную
                прокрутку. Не разрывается каждая сумма по отдельности.
              */}
              <span className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-zinc-500 tabular-nums sm:ms-auto min-w-0">
                <span className="whitespace-nowrap">
                  {isUz ? 'QQS siz' : 'Без НДС'} {money(String(totals.net), isUz)}
                </span>
                <span className="whitespace-nowrap">
                  {isUz ? 'QQS' : 'НДС'} {money(String(totals.vat), isUz)}
                </span>
                <span className="whitespace-nowrap text-zinc-900 dark:text-zinc-100 font-medium">
                  {isUz ? 'Jami' : 'Итого'} {money(String(totals.total), isUz)}
                </span>
              </span>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onSave({
                version: doc.version,
                documentDate: date,
                locale,
                ...(lines.length > 0
                  ? {
                      lines: lines.map((l) => ({
                        ...l,
                        qty: plain(l.qty),
                        price: plain(l.price),
                        ...(l.discountPercent ? { discountPercent: plain(l.discountPercent) } : {}),
                        ...(l.vatRate ? { vatRate: plain(l.vatRate) } : {}),
                      })),
                    }
                  : {}),
              })
            }
            className={BTN_PRIMARY + ' h-7'}
          >
            {isUz ? 'Saqlash' : 'Сохранить'}
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST + ' h-7'}>
            {isUz ? 'Bekor qilish' : 'Отмена'}
          </button>
        </div>
      </div>
    </div>
  );
};
