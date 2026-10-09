/**
 * Шаблоны печатных форм (ТЗ 7.2).
 *
 * Экран устроен вокруг одного правила: **загруженный файл не печатает, пока
 * его не проверили.** Поэтому порядок жёсткий и виден глазами — загрузил,
 * сопоставил чужие теги, проверил на настоящем документе, опубликовал. Кнопка
 * «Опубликовать» доступна и до проверки: сервер откажет и назовёт тег, а
 * прятать её значило бы объяснять отказ дважды, в двух местах.
 *
 * Список полей системы показан рядом с тегами файла не для красоты: без него
 * сопоставлять нечего — администратор не помнит, что у нас `amount.words`, а
 * не `СуммаПрописью`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Download, Trash2, Upload, X } from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { errorText } from '../../context/DashboardContext';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import type {
  DocumentTemplateCheck,
  DocumentTemplateFields,
  DocumentTemplateRow,
  DocumentTypeRef,
} from '../../types/api';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, ErrorBox, Skeleton } from './warehouse-ui';
import { CustomSelect } from '../common/CustomSelect';
import { formatBytes, refName } from '../../lib/formatters';

const ROW = 'px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0';

const saveBlob = (blob: Blob, filename: string) => {
  // Ссылку отзываем сразу: иначе файл висит в памяти вкладки до её закрытия.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export const DocumentTemplates: React.FC = () => {
  const { locale, company } = useApp();
  const { session } = useAuth();
  const isUz = locale === 'uz';
  const mayEdit = session?.permissions.includes('refs.edit') ?? false;

  const [rows, setRows] = useState<DocumentTemplateRow[] | null>(null);
  const [types, setTypes] = useState<DocumentTypeRef[]>([]);
  const [fields, setFields] = useState<DocumentTemplateFields | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<Record<string, DocumentTemplateCheck>>({});
  const [mapping, setMapping] = useState<DocumentTemplateRow | null>(null);
  const [upTypeUid, setUpTypeUid] = useState('');
  const [upLocale, setUpLocale] = useState<'ru' | 'uz'>('ru');
  const [needType, setNeedType] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, r] = await Promise.all([
        apiClient.documents.types(),
        apiClient.documents.templates.list(),
      ]);
      setTypes(t.data.rows);
      setRows(r.data.rows);
      if (mayEdit && !fields) {
        setFields((await apiClient.documents.templates.fields()).data);
      }
    } catch (e) {
      setRows(null);
      setError(e as ApiError);
    }
  }, [company, mayEdit, fields]);

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

  const doCheck = async (uid: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.documents.templates.check(uid);
      setChecked((s) => ({ ...s, [uid]: res.data }));
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const doUpload = async (file: File) => {
    if (!upTypeUid) return;
    await act(() => apiClient.documents.templates.upload(upTypeUid, upLocale, file));
    if (fileRef.current) fileRef.current.value = '';
  };

  const manyCompanies = new Set((rows ?? []).map((r) => r.company.code)).size > 1;

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className={CARD + ' p-4 text-xs text-zinc-600 dark:text-zinc-400 break-words'}>
        {isUz
          ? 'Chop etish shakli — fayl, kod emas. Word shablonini yuklang, undagi teglarni '
            + 'tizim maydonlari bilan solishtiring, haqiqiy hujjatda tekshiring — shundan '
            + 'keyin chop etishga chiqadi.'
          : 'Печатная форма — файл, а не код: загрузите шаблон Word, сопоставьте его теги ' +
            'с полями системы и проверьте на настоящем документе. Публикуется только ' +
            'проверенный: шаблон с опечаткой в теге даёт не ошибку, а пустое место в счёте, ' +
            'который уже ушёл клиенту. На тип документа и язык публикуется ровно один.'}
      </div>

      {mayEdit && (
        <div className={CARD + ' p-4 flex flex-col gap-3 min-w-0'}>
          <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-900 dark:text-zinc-100">
            <Upload className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
            {isUz ? 'Shablon yuklash' : 'Загрузить шаблон'}
          </span>
          {/*
            Три поля в ряд — grid с явными дорожками, а не flex.
            У `input[type=file]` собственная ширина под кнопку «Обзор» и имя
            файла: во flex-строке он забирал место, и селект типа сжимался в
            нулевую ширину — кликнуть по нему было нельзя. Дорожки
            `minmax(0, …)` задают это правилом, а не подгонкой.
            На 360 столбик: три поля в строку не умещаются.
          */}
          <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_10rem_minmax(0,1.2fr)] sm:items-end gap-2 min-w-0">
            <label className="flex flex-col gap-1 min-w-0">
              <span className="text-[11px] text-zinc-500">
                {isUz ? 'Hujjat turi' : 'Тип документа'}
              </span>
              <CustomSelect
                value={upTypeUid}
                onChange={(v) => {
                  setUpTypeUid(v);
                  if (v) setNeedType(false);
                }}
                options={[
                  { value: '', label: isUz ? 'tanlang' : 'выберите' },
                  ...types.map((t) => ({
                    value: t.uid,
                    label:
                      (manyCompanies ? `${t.company.code} · ` : '') +
                      (refName(t, isUz)),
                  })),
                ]}
                ariaLabel={isUz ? 'Hujjat turi' : 'Тип документа'}
              />
            </label>
            <label className="flex flex-col gap-1 min-w-0">
              <span className="text-[11px] text-zinc-500">{isUz ? 'Til' : 'Язык'}</span>
              <CustomSelect
                value={upLocale}
                onChange={(v) => setUpLocale(v as 'ru' | 'uz')}
                options={[
                  { value: 'ru', label: isUz ? 'Rus tili' : 'Русский' },
                  { value: 'uz', label: isUz ? 'O‘zbekcha' : 'Узбекский' },
                ]}
                ariaLabel={isUz ? 'Til' : 'Язык'}
              />
            </label>
            {/*
              Кнопка своя, а `input[type=file]` спрятан. Нативное поле рисовало
              чужую кнопку с чужой надписью, а без выбранного типа браузер её
              ещё и гасил: человек жал и не понимал, почему ничего не
              происходит. Теперь кнопка отвечает всегда, а причину отказа
              называет словами.
            */}
            <div className="flex flex-col gap-1 min-w-0">
              <span className="text-[11px] text-zinc-500">{isUz ? 'Fayl' : 'Файл'}</span>
              <input
                ref={fileRef}
                type="file"
                accept=".docx"
                aria-hidden="true"
                tabIndex={-1}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void doUpload(f);
                }}
              />
              <button
                type="button"
                disabled={busy}
                title={
                  isUz
                    ? 'Kompyuterdan .docx faylini tanlang — u darhol yuklanadi'
                    : 'Выберите файл .docx на компьютере — он загрузится сразу'
                }
                onClick={() => {
                  if (!upTypeUid) {
                    setNeedType(true);
                    return;
                  }
                  setNeedType(false);
                  fileRef.current?.click();
                }}
                className={BTN_GHOST + ' inline-flex items-center justify-center gap-1.5 h-8 w-full min-w-0'}
              >
                <Upload className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{isUz ? 'Fayl tanlash' : 'Выбрать файл'}</span>
              </button>
            </div>
          </div>
          {!upTypeUid && !needType && (
            <span className="text-[11px] text-zinc-500">
              {isUz
                ? 'Avval hujjat turini tanlang: shablon turga tegishli.'
                : 'Сначала выберите тип документа: шаблон принадлежит типу, не системе.'}
            </span>
          )}
          {needType && (
            <span role="alert" className="text-[11px] text-red-600 dark:text-red-400">
              {isUz
                ? 'Hujjat turi tanlanmagan: uni chapda tanlang, keyin fayl yuklanadi.'
                : 'Тип документа не выбран: выберите его слева, и файл можно будет загрузить.'}
            </span>
          )}
        </div>
      )}

      <div className={CARD + ' flex flex-col min-w-0'}>
        <div className="px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-800">
          <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
            {isUz ? 'Shablonlar' : 'Шаблоны'}
          </span>
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
          <Empty text={isUz ? 'Shablonlar yo‘q' : 'Шаблонов нет'} />
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {rows.map((t) => {
              const unknown = t.tags.filter((x) => !x.known);
              const res = checked[t.uid];
              return (
                <li key={t.uid} className="flex flex-col">
                  <div className={ROW}>
                    {manyCompanies && (
                      <span className="text-[11px] text-zinc-400 w-10 shrink-0">
                        {t.company.code}
                      </span>
                    )}
                    <span className="text-[11px] font-mono text-zinc-400 shrink-0">
                      {t.type.code}
                    </span>
                    <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
                      {refName(t.type, isUz)}
                    </span>
                    <span className="px-1.5 rounded border border-zinc-300 dark:border-zinc-700 text-[10px] text-zinc-500 shrink-0 uppercase">
                      {t.locale}
                    </span>
                    <span className="text-[11px] text-zinc-500 whitespace-nowrap">
                      {isUz ? 'versiya' : 'версия'} {t.version}
                    </span>
                    <span className="text-[11px] text-zinc-500 break-all">{t.fileName}</span>
                    <span className="text-[11px] text-zinc-400 whitespace-nowrap">
                      {formatBytes(t.fileSize, locale)}
                    </span>
                    {t.isPublished ? (
                      <span className="px-1.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-[10px] text-emerald-700 dark:text-emerald-300 shrink-0 whitespace-nowrap">
                        {isUz ? 'chop etishda' : 'публикуется'}
                      </span>
                    ) : (
                      <span className="px-1.5 rounded border border-zinc-300 dark:border-zinc-700 text-[10px] text-zinc-500 shrink-0 whitespace-nowrap">
                        {isUz ? 'qoralama' : 'черновик'}
                      </span>
                    )}
                    {unknown.length > 0 && (
                      <span className="px-1.5 rounded bg-amber-100 dark:bg-amber-900/40 text-[10px] text-amber-700 dark:text-amber-300 shrink-0 whitespace-nowrap">
                        {isUz ? 'noma’lum teglar' : 'теги без поля'}: {unknown.length}
                      </span>
                    )}
                    <span className="text-[11px] text-zinc-500 whitespace-nowrap ms-auto">
                      {t.printed > 0
                        ? `${isUz ? 'chop etilgan' : 'напечатано'} ${t.printed}`
                        : '—'}
                    </span>
                    {/*
                      Кнопки переносятся, а не сжимаются: их пять, и на 360
                      строка из них шире экрана — `shrink-0` распирал
                      контейнер, и список уезжал вбок.
                    */}
                    <div className="flex flex-wrap items-center gap-1 min-w-0">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void (async () => {
                            const { blob, filename } =
                              await apiClient.documents.templates.file(t.uid);
                            saveBlob(blob, filename);
                          })()
                        }
                        aria-label={isUz ? 'Faylni yuklab olish' : 'Скачать файл'}
                        title={
                          isUz
                            ? 'Shablon faylini yuklab olish'
                            : 'Скачать сам файл шаблона — тот, что загрузили'
                        }
                        className={BTN_GHOST + ' h-7'}
                      >
                        <Download className="w-3 h-3" />
                      </button>
                      {mayEdit && (
                        <>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void doCheck(t.uid)}
                            title={
                              isUz
                                ? 'Shablonni haqiqiy hujjatda yig‘ib ko‘rish'
                                : 'Собрать шаблон на настоящем документе и показать, что получилось'
                            }
                            className={BTN_GHOST + ' h-7 text-[11px] px-2 whitespace-nowrap'}
                          >
                            {isUz ? 'Tekshirish' : 'Проверить'}
                          </button>
                          {!t.isPublished && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setMapping(t)}
                              title={
                                isUz
                                  ? 'Fayl teglarini tizim maydonlari bilan solishtirish'
                                  : 'Сопоставить теги из файла с полями системы'
                              }
                              className={BTN_GHOST + ' h-7 text-[11px] px-2 whitespace-nowrap'}
                            >
                              {isUz ? 'Teglar' : 'Теги'}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              act(() =>
                                t.isPublished
                                  ? apiClient.documents.templates.unpublish(t.uid)
                                  : apiClient.documents.templates.publish(t.uid),
                              )
                            }
                            title={
                              t.isPublished
                                ? isUz
                                  ? 'Chop etishdan olish: bu shablon bilan chop etilmaydi'
                                  : 'Снять с печати: по этому шаблону перестанут печатать'
                                : isUz
                                  ? 'Chop etishga: shu turdagi hujjatlar shu shablon bilan chiqadi'
                                  : 'Опубликовать: документы этого типа будут печататься этим шаблоном'
                            }
                            className={
                              (t.isPublished ? BTN_GHOST : BTN_PRIMARY) +
                              ' h-7 text-[11px] px-2 whitespace-nowrap'
                            }
                          >
                            {t.isPublished
                              ? isUz
                                ? 'Chop etishdan olish'
                                : 'Снять'
                              : isUz
                                ? 'Chop etishga'
                                : 'Опубликовать'}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => act(() => apiClient.documents.templates.remove(t.uid))}
                            aria-label={isUz ? 'O‘chirib tashlash' : 'Удалить'}
                            title={
                              isUz
                                ? 'O‘chirib tashlash: chop etilgan shablon o‘chmaydi'
                                : 'Удалить шаблон: тот, которым уже печатали, удалить нельзя'
                            }
                            className={BTN_GHOST + ' h-7'}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {res && (
                    <div
                      className={`px-4 pb-2.5 -mt-1 flex items-start gap-1.5 text-[11px] break-words ${
                        res.ok
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-amber-700 dark:text-amber-400'
                      }`}
                    >
                      {res.ok ? (
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
                      ) : (
                        <CircleAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
                      )}
                      <span>{res.message}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {mapping && fields && (
        <MappingForm
          isUz={isUz}
          row={mapping}
          fields={fields}
          busy={busy}
          onClose={() => setMapping(null)}
          onSave={async (fieldMap) => {
            const ok = await act(() =>
              apiClient.documents.templates.setFieldMap(mapping.uid, fieldMap),
            );
            if (ok) {
              setMapping(null);
              await doCheck(mapping.uid);
            }
          }}
        />
      )}
    </div>
  );
};

/**
 * Сопоставление тегов файла с полями системы.
 *
 * Знакомые теги показаны тоже, и это не лишнее: администратор должен видеть,
 * что в бумаге осталось незаполненным, — пустая строка в счёте выглядит как
 * забытое поле, а не как ошибка шаблона.
 */
const MappingForm: React.FC<{
  isUz: boolean;
  row: DocumentTemplateRow;
  fields: DocumentTemplateFields;
  busy: boolean;
  onClose: () => void;
  onSave: (fieldMap: Record<string, string>) => void;
}> = ({ isUz, row, fields, busy, onClose, onSave }) => {
  const [map, setMap] = useState<Record<string, string>>(row.fieldMap ?? {});
  const unknown = row.tags.filter((t) => !t.known || map[t.name]);
  const known = row.tags.filter((t) => t.known && !map[t.name]);

  const options = [
    { value: '', label: isUz ? 'sopishtirilmagan' : 'не сопоставлен' },
    ...fields.document.map((f) => ({ value: f.name, label: `${f.name} — ${f.title}` })),
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isUz ? 'Teglarni solishtirish' : 'Сопоставление тегов'}
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-zinc-900/40 p-3 overflow-y-auto"
    >
      <div className={CARD + ' w-full max-w-2xl p-4 flex flex-col gap-3 min-w-0'}>
        <div className="flex items-start gap-2">
          <div className="min-w-0">
            <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
              {isUz ? 'Teglarni solishtirish' : 'Сопоставление тегов'} — {row.fileName}
            </span>
            <p className="text-[11px] text-zinc-500 break-words">
              {isUz
                ? 'Fayldagi teg tizim maydoniga bog‘lanadi. Mijozning qog‘ozini qayta yozmaymiz.'
                : 'Тег из файла связывается с полем системы. Бумагу заказчика мы не переписываем: ' +
                  'если в ней стоит {НомерСчета}, связываем его с нашим doc.number.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={isUz ? 'Yopish' : 'Закрыть'}
            className={BTN_GHOST + ' h-7 ms-auto shrink-0'}
          >
            <X className="w-3 h-3" />
          </button>
        </div>

        {unknown.length === 0 ? (
          <span className="text-[11px] text-emerald-700 dark:text-emerald-400">
            {isUz
              ? 'Barcha teglar tanildi — solishtirish kerak emas.'
              : 'Все теги файла знакомы системе — сопоставлять нечего.'}
          </span>
        ) : (
          <ul className="flex flex-col gap-2">
            {unknown.map((t) => (
              <li key={t.name} className="flex flex-col sm:flex-row sm:items-center gap-2 min-w-0">
                <span className="text-[11px] font-mono text-zinc-700 dark:text-zinc-300 break-all sm:w-48 shrink-0">
                  {'{'}
                  {t.name}
                  {'}'}
                </span>
                <div className="min-w-0 flex-1">
                  <CustomSelect
                    value={map[t.name] ?? ''}
                    onChange={(v) =>
                      setMap((s) => {
                        const next = { ...s };
                        if (v) next[t.name] = v;
                        else delete next[t.name];
                        return next;
                      })
                    }
                    options={options}
                    ariaLabel={`${isUz ? 'Maydon' : 'Поле'} ${t.name}`}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}

        {known.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-500">
              {isUz ? 'Tanilgan teglar' : 'Теги, знакомые системе'}
            </span>
            <div className="flex flex-wrap gap-1">
              {known.map((t) => (
                <span
                  key={t.name}
                  className="px-1.5 rounded border border-zinc-200 dark:border-zinc-700 text-[10px] font-mono text-zinc-500 break-all"
                >
                  {t.name}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onSave(map)}
            className={BTN_PRIMARY + ' h-7'}
          >
            {isUz ? 'Saqlash va tekshirish' : 'Сохранить и проверить'}
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST + ' h-7'}>
            {isUz ? 'Bekor qilish' : 'Отмена'}
          </button>
        </div>
      </div>
    </div>
  );
};
