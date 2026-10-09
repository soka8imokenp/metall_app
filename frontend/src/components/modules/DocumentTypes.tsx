/**
 * Типы документов и нумерация на запись (ТЗ 7.3).
 *
 * До этого этапа типы приходили из посева: завести «Счёт-фактуру» или сменить
 * префикс номера значило попросить разработчика. Теперь это справочник.
 *
 * Своих запретов экран не изобретает: почему строку нельзя удалить, сменить ей
 * код или область счётчика, сервер говорит словами — их и показываем. Вторая
 * версия тех же правил на фронте рано или поздно разошлась бы с первой.
 *
 * Единственное, что экран считает сам, — ничего: даже пример номера по маске
 * приходит с сервера, потому что разбирать маску в двух местах значит однажды
 * показать в подсказке одно, а напечатать другое.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Power, Trash2, X } from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { errorText } from '../../context/DashboardContext';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import type { DocumentTypeRef } from '../../types/api';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, ErrorBox, FIELD, Skeleton } from './warehouse-ui';
import { CustomSelect } from '../common/CustomSelect';
import { refName } from '../../lib/formatters';
import {
  DEFAULT_SEQ_WIDTH,
  SEPARATORS,
  buildMask,
  parseMask,
  realSeparators,
  singleSeparator,
  togglePart,
  withSeparator,
} from '../../lib/number-mask';

const SCOPES: { value: 'company' | 'company_period'; ru: string; uz: string; hintRu: string }[] = [
  {
    value: 'company_period',
    ru: 'с начала года',
    uz: 'yil boshidan',
    hintRu: 'Каждый январь счётчик начинается с единицы. Год в маске обязателен, иначе номер повторится.',
  },
  {
    value: 'company',
    ru: 'сквозной',
    uz: 'uzluksiz',
    hintRu: 'Счётчик не обнуляется никогда: номер растёт от первого документа и дальше.',
  },
];

const scopeText = (v: string, isUz: boolean) => {
  const s = SCOPES.find((x) => x.value === v);
  return s ? (isUz ? s.uz : s.ru) : v;
};

/**
 * Подстановки маски.
 *
 * Раньше они стояли одной строкой под полем и их перепечатывали руками —
 * с фигурными скобками, точным регистром и двоеточием в `{SEQ:3}`. Опечатка
 * в любом знаке превращала подстановку в текст, который так и печатался бы
 * на бумаге. Теперь это кнопки: подстановка вставляется туда, где стоит
 * курсор.
 */
const PLACEHOLDERS: { tag: string; ru: string; uz: string }[] = [
  { tag: '{SEQ}', ru: 'счётчик, пять знаков', uz: 'hisoblagich, besh belgi' },
  { tag: '{SEQ:3}', ru: 'счётчик заданной ширины', uz: 'berilgan kenglikdagi hisoblagich' },
  { tag: '{YY}', ru: 'год, две цифры', uz: 'yil, ikki raqam' },
  { tag: '{YYYY}', ru: 'год, четыре цифры', uz: 'yil, to‘rt raqam' },
  { tag: '{MM}', ru: 'месяц', uz: 'oy' },
  { tag: '{TYPE}', ru: 'код типа', uz: 'tur kodi' },
  { tag: '{COMPANY}', ru: 'код компании', uz: 'kompaniya kodi' },
];

const ROW = 'px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0';

/** Кнопка-переключатель: нажата — залита, как вкладка. */
const chip = (on: boolean) =>
  'h-7 px-2.5 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ' +
  (on
    ? 'bg-zinc-900 text-zinc-50 border-zinc-900 dark:bg-zinc-50 dark:text-zinc-900 dark:border-zinc-50'
    : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800');

export const DocumentTypes: React.FC = () => {
  const { locale, company } = useApp();
  const { session } = useAuth();
  const isUz = locale === 'uz';
  const mayEdit = session?.permissions.includes('refs.edit') ?? false;

  const [rows, setRows] = useState<DocumentTypeRef[] | null>(null);
  const [showOff, setShowOff] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ edit: DocumentTypeRef | null } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.documents.types(showOff);
      setRows(res.data.rows);
    } catch (e) {
      setRows(null);
      setError(e as ApiError);
    }
  }, [showOff, company]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError(e as ApiError);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const manyCompanies = new Set((rows ?? []).map((r) => r.company.uid)).size > 1;

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className={CARD + ' p-4 text-xs text-zinc-600 dark:text-zinc-400 break-words'}>
        {isUz
          ? 'Hujjat turi kompaniyaga tegishli: savdo uyi va zavodning o‘z raqamlash tartibi bor.'
          : 'Тип принадлежит компании: у торгового дома и завода своя нумерация. ' +
            'Код типа и область счётчика замораживаются с первого выданного номера — ' +
            'они уже в напечатанных бумагах. Маску менять можно, она действует вперёд.'}
      </div>

      <div className={CARD + ' flex flex-col min-w-0'}>
        <div className="px-4 py-2.5 flex flex-wrap items-center gap-2 border-b border-zinc-200 dark:border-zinc-800">
          <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
            {isUz ? 'Hujjat turlari' : 'Типы документов'}
          </span>
          <div className="flex flex-wrap items-center gap-2 sm:ms-auto">
            <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 cursor-pointer">
              <input
                type="checkbox"
                checked={showOff}
                onChange={(e) => setShowOff(e.target.checked)}
                className="cursor-pointer"
              />
              {isUz ? 'o‘chirilganlarni ko‘rsatish' : 'показать выключенные'}
            </label>
            {mayEdit && (
              <button
                type="button"
                onClick={() => setForm({ edit: null })}
                className={BTN_PRIMARY + ' h-7 whitespace-nowrap shrink-0'}
              >
                <Plus className="w-3 h-3 inline-block me-1" />
                {isUz ? 'Tur qo‘shish' : 'Добавить тип'}
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="px-4 pt-3">
            <ErrorBox text={errorText(error, isUz)} isUz={isUz} />
          </div>
        )}

        {!rows ? (
          <div className="p-4">
            <Skeleton />
          </div>
        ) : rows.length === 0 ? (
          <Empty text={isUz ? 'Turlar yo‘q' : 'Типов нет'} />
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {rows.map((t) => (
              <li key={t.uid} className={ROW}>
                {manyCompanies && (
                  <span className="text-[11px] text-zinc-400 w-10 shrink-0">{t.company.code}</span>
                )}
                <span className="text-[11px] font-mono text-zinc-400 shrink-0">{t.code}</span>
                <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
                  {refName(t, isUz)}
                </span>
                {!t.isActive && (
                  <span className="px-1.5 rounded border border-zinc-300 dark:border-zinc-700 text-[10px] text-zinc-500 shrink-0">
                    {isUz ? 'o‘chirilgan' : 'выключен'}
                  </span>
                )}
                <span className="text-[11px] font-mono text-zinc-500 break-words">
                  {t.numberingMask}
                </span>
                <span className="text-[11px] text-zinc-500 whitespace-nowrap">
                  {scopeText(t.counterScope, isUz)}
                </span>
                <span className="text-[11px] text-zinc-500 break-words">
                  {isUz ? 'keyingi' : 'следующий'}{' '}
                  <span className="font-mono text-zinc-700 dark:text-zinc-300">{t.nextNumber}</span>
                </span>
                <span className="text-[11px] text-zinc-500 whitespace-nowrap ms-auto">
                  {t.usage.documents > 0
                    ? `${isUz ? 'hujjat' : 'документов'} ${t.usage.documents}`
                    : '—'}
                </span>
                {mayEdit && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setForm({ edit: t })}
                      aria-label={isUz ? 'Tahrirlash' : 'Править'}
                      title={
                        isUz
                          ? 'Tahrirlash: nomi va raqam qolipi'
                          : 'Править: название и маска номера. Выданные номера не меняются'
                      }
                      className={BTN_GHOST + ' h-7'}
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        act(() => apiClient.documents.patchType(t.uid, { isActive: !t.isActive }))
                      }
                      aria-label={
                        t.isActive
                          ? isUz
                            ? 'O‘chirish'
                            : 'Выключить'
                          : isUz
                            ? 'Yoqish'
                            : 'Включить'
                      }
                      title={
                        t.isActive
                          ? isUz
                            ? 'O‘chirish: yangi hujjat yozilmaydi, yozilganlari qoladi'
                            : 'Выключить: новые документы по нему не выписывают, выписанные остаются'
                          : isUz
                            ? 'Yoqish: tur yana ro‘yxatda'
                            : 'Включить: тип снова появится в списке выписки'
                      }
                      className={BTN_GHOST + ' h-7'}
                    >
                      <Power className={`w-3 h-3 ${t.isActive ? '' : 'text-emerald-600'}`} />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => act(() => apiClient.documents.removeType(t.uid))}
                      aria-label={isUz ? 'O‘chirib tashlash' : 'Удалить'}
                      title={
                        isUz
                          ? 'O‘chirib tashlash: faqat hujjat yozilmagan bo‘lsa'
                          : 'Удалить насовсем: получится, только пока по типу не выписан ни один документ'
                      }
                      className={BTN_GHOST + ' h-7'}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {form && (
        <TypeForm
          isUz={isUz}
          edit={form.edit}
          busy={busy}
          onClose={() => setForm(null)}
          onSave={async (body) => {
            const ok = await act(() =>
              form.edit
                ? apiClient.documents.patchType(form.edit.uid, body)
                : apiClient.documents.createType(body as never),
            );
            if (ok) setForm(null);
          }}
        />
      )}
    </div>
  );
};

const TypeForm: React.FC<{
  isUz: boolean;
  edit: DocumentTypeRef | null;
  busy: boolean;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => void;
}> = ({ isUz, edit, busy, onClose, onSave }) => {
  const [code, setCode] = useState(edit?.code ?? '');
  const [nameRu, setNameRu] = useState(edit?.nameRu ?? '');
  const [nameUz, setNameUz] = useState(edit?.nameUz ?? '');
  const [mask, setMask] = useState(edit?.numberingMask ?? '{TYPE}-{YY}/{SEQ}');
  const [scope, setScope] = useState<'company' | 'company_period'>(
    edit?.counterScope ?? 'company_period',
  );
  const [sample, setSample] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);

  // Пример пересчитывается на сервере при каждой правке маски: человек видит,
  // что напечатается, до того как сохранит, а не после первого документа.
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      apiClient.documents
        .sampleNumber(mask, scope, code, edit?.uid)
        .then((r) => {
          if (!alive) return;
          setSample(r.data.sample);
          setSampleError(null);
        })
        .catch((e: ApiError) => {
          if (!alive) return;
          setSample(null);
          setSampleError(errorText(e, isUz));
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [mask, scope, code, isUz, edit?.uid]);

  const frozen = edit ? edit.usage.documents > 0 || edit.usage.issued > 0 : false;


  /** Маска текстом — для редкого случая, когда простых полей не хватает. */
  const [manual, setManual] = useState(false);
  const parts = parseMask(mask);

  const maskRef = React.useRef<HTMLInputElement>(null);
  /**
   * Подстановка встаёт туда, где стоит курсор.
   *
   * Дописывать в конец нельзя: префикс «СЧ-» набирают перед счётчиком, и
   * маска собиралась бы задом наперёд.
   */
  const insert = (tag: string) => {
    const el = maskRef.current;
    if (!el) {
      setMask(mask + tag);
      return;
    }
    const from = el.selectionStart ?? mask.length;
    const to = el.selectionEnd ?? from;
    setMask(mask.slice(0, from) + tag + mask.slice(to));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(from + tag.length, from + tag.length);
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-3 overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={edit ? (isUz ? 'Turni tahrirlash' : 'Правка типа') : isUz ? 'Yangi tur' : 'Новый тип документа'}
        className={CARD + ' w-full max-w-lg p-4 flex flex-col gap-3 min-w-0'}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">
            {edit
              ? isUz
                ? 'Turni tahrirlash'
                : 'Правка типа'
              : isUz
                ? 'Yangi tur'
                : 'Новый тип документа'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className={BTN_GHOST + ' h-7 ms-auto'}
            aria-label={isUz ? 'Yopish' : 'Закрыть'}
            title={isUz ? 'Yopish' : 'Закрыть, не сохраняя'}
          >
            <X className="w-3 h-3" />
          </button>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-500">{isUz ? 'Kod' : 'Код'}</span>
          <input
            aria-label={isUz ? 'Kod' : 'Код типа'}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={frozen}
            placeholder="INV"
            className={FIELD + (frozen ? ' opacity-60 cursor-not-allowed' : '')}
          />
          {frozen && (
            <span className="text-[11px] text-zinc-500">
              {isUz
                ? 'Raqamlar berilgan: kod o‘zgarmaydi'
                : 'По типу уже выданы номера — код в них и остаётся'}
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-500">
            {isUz ? 'Nomi (ruscha)' : 'Название по-русски'}
          </span>
          <input
            aria-label={isUz ? 'Nomi (ruscha)' : 'Название по-русски'}
            value={nameRu}
            onChange={(e) => setNameRu(e.target.value)}
            className={FIELD}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-500">
            {isUz ? 'Nomi (o‘zbekcha)' : 'Название по-узбекски'}
          </span>
          <input
            aria-label={isUz ? 'Nomi (o‘zbekcha)' : 'Название по-узбекски'}
            value={nameUz}
            onChange={(e) => setNameUz(e.target.value)}
            className={FIELD}
          />
        </label>

        {/*
          Номер собирается простыми полями, а не маской.
          Маска — это то, что хранит сервер: `СЧ-{YY}/{SEQ}`. Человеку,
          который заводит тип раз в год, она читается шифром, и ошибиться в
          `{SEQ:3}` проще, чем попасть. Поля говорят то же самое словами, а
          маску экран собирает сам. Сложную маску простыми полями не
          собрать — тогда форма честно показывает её текстом.
        */}
        <div className="flex flex-col gap-2 min-w-0">
          <span className="text-[11px] text-zinc-500">
            {isUz ? 'Hujjat raqami' : 'Номер документа'}
          </span>

          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2 min-w-0">
            <span className="text-[11px] text-zinc-500">
              {isUz ? 'Keyingi raqam' : 'Следующий номер будет'}
            </span>
            <div className="text-sm font-mono font-medium text-zinc-900 dark:text-zinc-100 break-words">
              {sample ?? '—'}
            </div>
            {sampleError && (
              <div className="text-[11px] text-rose-600 dark:text-rose-400 break-words mt-1">
                {sampleError}
              </div>
            )}
          </div>

          {parts ? (
            <div className="flex flex-col gap-2 min-w-0">
              <label className="flex flex-col gap-1 min-w-0">
                <span className="text-[11px] text-zinc-500">
                  {isUz ? 'Raqam boshi' : 'Начало номера'}
                </span>
                <input
                  aria-label={isUz ? 'Raqam boshi' : 'Начало номера'}
                  value={parts.startIsType ? code : parts.start}
                  onChange={(e) => {
                    const text = e.target.value;
                    // Совпало с кодом типа — подставляем код: поменяют код,
                    // и номер поменяется вместе с ним, без правки маски.
                    setMask(
                      buildMask({
                        ...parts,
                        start: text,
                        startIsType: text !== '' && text === code,
                      }),
                    );
                  }}
                  placeholder={code || (isUz ? 'HF' : 'СЧ')}
                  className={FIELD + ' sm:max-w-[12rem]'}
                />
              </label>

              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-[11px] text-zinc-500">
                  {isUz ? 'Raqamga qo‘shish' : 'Добавить в номер'}
                </span>
                <div className="flex flex-wrap items-center gap-1 min-w-0">
                  {([
                    ['year-yy', parts.year === 'YY', isUz ? 'Yil 26' : 'Год 26',
                      () => setMask(buildMask(togglePart(parts, 'year', parts.year === 'YY' ? false : 'YY')))],
                    ['year-yyyy', parts.year === 'YYYY', isUz ? 'Yil 2026' : 'Год 2026',
                      () => setMask(buildMask(togglePart(parts, 'year', parts.year === 'YYYY' ? false : 'YYYY')))],
                    ['month', parts.month, isUz ? 'Oy' : 'Месяц',
                      () => setMask(buildMask(togglePart(parts, 'month', !parts.month)))],
                    ['company', parts.company, isUz ? 'Kompaniya kodi' : 'Код компании',
                      () => setMask(buildMask(togglePart(parts, 'company', !parts.company)))],
                  ] as [string, boolean, string, () => void][]).map(([key, on, text, act]) => (
                    <button key={key} type="button" onClick={act} aria-pressed={on} className={chip(on)}>
                      {text}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1 min-w-0">
                <span className="text-[11px] text-zinc-500 me-1">
                  {isUz ? 'Ajratgich' : 'Разделитель'}
                </span>
                {SEPARATORS.map((sep) => (
                  <button
                    key={sep || 'none'}
                    type="button"
                    onClick={() => setMask(buildMask(withSeparator(parts, sep)))}
                    aria-pressed={singleSeparator(parts) === sep}
                    className={chip(singleSeparator(parts) === sep)}
                  >
                    {sep === '' ? (isUz ? 'yo‘q' : 'нет') : sep}
                  </button>
                ))}
                {singleSeparator(parts) === null && (
                  <span className="text-[11px] text-zinc-500 break-words">
                    {isUz ? 'hozir har xil' : 'сейчас разные'}
                    {': '}
                    {[...new Set(realSeparators(parts))]
                      .map((sep) => (sep === '' ? (isUz ? 'yo‘q' : 'нет') : sep))
                      .join(' и ')}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1 min-w-0">
                <span className="text-[11px] text-zinc-500 me-1">
                  {isUz ? 'Hisoblagich belgilari' : 'Знаков в счётчике'}
                </span>
                {[3, 4, 5, 6].map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() =>
                      setMask(buildMask({ ...parts, seqWidth: w, seqPlain: w === DEFAULT_SEQ_WIDTH }))
                    }
                    aria-pressed={parts.seqWidth === w}
                    className={chip(parts.seqWidth === w) + ' font-mono'}
                  >
                    {'0'.repeat(w - 1) + '1'}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <span className="text-[11px] text-zinc-500 break-words">
              {isUz
                ? 'Bu qolip oddiy maydonlarga sig‘maydi — uni matn bilan tahrirlang.'
                : 'Эта маска сложнее простых полей — её правят текстом ниже.'}
            </span>
          )}

          <button
            type="button"
            onClick={() => setManual((v) => !v)}
            className="text-[11px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 underline underline-offset-2 self-start cursor-pointer"
          >
            {manual || !parts
              ? isUz
                ? 'Qolipni yashirish'
                : 'Скрыть маску'
              : isUz
                ? 'Qolip bilan berish'
                : 'Задать маской'}
          </button>

          {(manual || !parts) && (
            <div className="flex flex-col gap-1.5 min-w-0 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5">
              <span className="text-[11px] text-zinc-500 break-words">
                {isUz
                  ? 'Qolip — bu raqamning o‘zi: o‘z matningiz va almashtirishlar.'
                  : 'Маска — это и есть будущий номер: свой текст плюс подстановки в фигурных скобках.'}
              </span>
              <input
                ref={maskRef}
                aria-label={isUz ? 'Raqam qolipi' : 'Маска номера'}
                value={mask}
                onChange={(e) => setMask(e.target.value)}
                placeholder="{TYPE}-{YY}/{SEQ:5}"
                className={FIELD + ' font-mono'}
              />
              <div className="flex flex-wrap items-center gap-1 min-w-0">
                {PLACEHOLDERS.map((ph) => (
                  <button
                    key={ph.tag}
                    type="button"
                    onClick={() => insert(ph.tag)}
                    title={
                      (isUz ? ph.uz : ph.ru) +
                      (isUz ? '. Bosing — qolipga qo‘shiladi' : '. Нажмите — встанет в маску')
                    }
                    className={BTN_GHOST + ' h-6 px-1.5 text-[11px] font-mono whitespace-nowrap'}
                  >
                    {ph.tag}
                  </button>
                ))}
              </div>
              <span className="text-[11px] text-zinc-500 break-words">
                {PLACEHOLDERS.map((ph) => `${ph.tag} — ${isUz ? ph.uz : ph.ru}`).join(' · ')}
              </span>
            </div>
          )}
        </div>


        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-500">
            {isUz ? 'Hisoblagich qachon nolga tushadi' : 'Когда счётчик обнуляется'}
          </span>
          <CustomSelect
            ariaLabel={isUz ? 'Hisoblagich' : 'Счётчик'}
            value={scope}
            onChange={(v) => setScope(v as 'company' | 'company_period')}
            options={SCOPES.map((s) => ({ value: s.value, label: isUz ? s.uz : s.ru }))}
          />
          {frozen ? (
            <span className="text-[11px] text-zinc-500">
              {isUz
                ? 'Raqamlar berilgan: hisoblagich turi o‘zgarmaydi'
                : 'По типу уже выданы номера — область счётчика не меняется'}
            </span>
          ) : (
            <span className="text-[11px] text-zinc-500 break-words">
              {SCOPES.find((s) => s.value === scope)?.hintRu}
            </span>
          )}
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onSave(
                edit
                  ? {
                      ...(frozen ? {} : { code, counterScope: scope }),
                      nameRu,
                      nameUz,
                      numberingMask: mask,
                    }
                  : { code, nameRu, nameUz, numberingMask: mask, counterScope: scope },
              )
            }
            className={BTN_PRIMARY}
          >
            {isUz ? 'Saqlash' : 'Сохранить'}
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST}>
            {isUz ? 'Bekor qilish' : 'Отмена'}
          </button>
        </div>
      </div>
    </div>
  );
};
