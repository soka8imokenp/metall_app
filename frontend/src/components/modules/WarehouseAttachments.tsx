/**
 * Вложения к операции: фото, сканы, сертификат качества партии
 * (ТЗ 5.4, 5.6, 6.3).
 *
 * Одно окно на любого владельца — движение, партия, финансовая операция:
 * право спрашивает сервер по тому, к чему приложен файл, и экрану остаётся
 * показать причину отказа, а не решать за него.
 *
 * Картинку показываем тут же: человек прикладывает фото штабеля, чтобы на него
 * посмотреть, а не чтобы скачать. Остальное скачивается файлом, и запрос идёт
 * с токеном — на выдаче стоит право, к `<a href>` заголовок не приложить.
 */
import React from "react";
import {
  FileText,
  Image as ImageIcon,
  Paperclip,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type {
  Attachment,
  AttachmentKind,
  AttachmentOwner,
} from "../../types/api";
import { apiClient, ApiError } from "../../lib/api-client";
import { BTN_GHOST, BTN_PRIMARY, CARD, ErrorBox, FIELD } from "./warehouse-ui";
import { CustomSelect } from "../common/CustomSelect";
import { formatBytes } from "../../lib/formatters";

/** Чем эти типы различаются на деле — иначе «Файл» и «Скан» выбирают наугад. */
const KIND_HINT: Record<AttachmentKind, { ru: string; uz: string }> = {
  photo: { ru: "снято на камеру", uz: "kamerada olingan" },
  scan: { ru: "бумага со сканера или подписанный экземпляр", uz: "skaner qogʻozi" },
  certificate: { ru: "сертификат качества партии", uz: "partiya sifat sertifikati" },
  other: { ru: "всё остальное", uz: "qolgan hammasi" },
};

const KIND_TEXT: Record<AttachmentKind, { ru: string; uz: string }> = {
  photo: { ru: "Фото", uz: "Foto" },
  scan: { ru: "Скан", uz: "Skan" },
  certificate: { ru: "Сертификат", uz: "Sertifikat" },
  other: { ru: "Файл", uz: "Fayl" },
};

/** Предел тот же, что на сервере: отказ лучше объяснить до отправки 20 МБ. */
const MAX_BYTES = 20 * 1024 * 1024;

const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,application/pdf";


const errorText = (e: unknown, isUz: boolean): string =>
  e instanceof ApiError
    ? e.message
    : isUz
      ? "Kutilmagan xatolik"
      : "Неожиданная ошибка";

/**
 * Начинка вложений без обвязки: список, загрузка, скачивание, удаление.
 *
 * Отдельно от окна, потому что мест два. В складе вложения открывают окном
 * рядом со строкой операции, в карточке клиента они живут вкладкой. Одна и та
 * же начинка в двух видах — это один код, а не два похожих: разойдясь, они
 * начали бы по-разному проверять размер файла и по-разному объяснять отказ.
 */
export const AttachmentsPanel: React.FC<{
  owner: AttachmentOwner;
  uid: string;
  /** Право на правку у владельца: без него панель только показывает. */
  canEdit: boolean;
  isUz: boolean;
}> = ({ owner, uid, canEdit, isUz }) => {
  const [rows, setRows] = React.useState<Attachment[] | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [kind, setKind] = React.useState<AttachmentKind>("photo");
  const [comment, setComment] = React.useState("");
  // Ссылки на просмотр живут в памяти страницы: файл получен с токеном, и
  // отдать его картинке можно только blob-ссылкой. Отзываем при закрытии,
  // иначе каждое открытие окна оставляет байты в памяти браузера.
  const [previews, setPreviews] = React.useState<Record<string, string>>({});
  const fileRef = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.attachments.list(owner, uid);
      setRows(res.data);
    } catch (e) {
      setError(e);
      setRows([]);
    }
  }, [owner, uid]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Картинки подтягиваем по одной, как приехал список: показать фото сразу —
  // весь смысл вложения к операции.
  React.useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    (async () => {
      for (const a of rows ?? []) {
        if (!a.mimeType.startsWith("image/")) continue;
        try {
          const { blob } = await apiClient.attachments.file(a.uid);
          if (!alive) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          setPreviews((p) => ({ ...p, [a.uid]: url }));
        } catch {
          // Не показалось — останется строка со кнопкой «скачать».
        }
      }
    })();
    return () => {
      alive = false;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [rows]);

  const pick = async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) {
      setError(
        new ApiError(
          "TOO_LARGE",
          isUz
            ? `Fayl ${formatBytes(file.size, isUz ? 'uz' : 'ru')}, cheklov 20 MB`
            : `Файл ${formatBytes(file.size, isUz ? 'uz' : 'ru')}, предел 20 МБ`,
          422,
        ),
      );
      return;
    }
    setBusy(true);
    try {
      await apiClient.attachments.upload({ owner, uid, kind, comment }, file);
      setComment("");
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const download = async (a: Attachment) => {
    setError(null);
    try {
      const { blob } = await apiClient.attachments.file(a.uid);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = a.fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e);
    }
  };

  const remove = async (a: Attachment) => {
    setRemoving(a.uid);
    setError(null);
    try {
      await apiClient.attachments.remove(a.uid);
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="flex flex-col">
      {canEdit && (
        <div className="px-4 py-3 flex flex-col gap-2 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 min-w-[9rem]">
              <span className="text-[11px] text-zinc-500">
                {isUz ? "Turi" : "Тип"}
              </span>
              <CustomSelect
                size="md"
                portal
                ariaLabel={isUz ? "Ilova turi" : "Тип вложения"}
                value={kind}
                onChange={(v) => setKind(v as AttachmentKind)}
                options={(Object.keys(KIND_TEXT) as AttachmentKind[]).map((k) => ({
                  value: k,
                  label: isUz ? KIND_TEXT[k].uz : KIND_TEXT[k].ru,
                  sublabel: isUz ? KIND_HINT[k].uz : KIND_HINT[k].ru,
                }))}
              />
            </label>

            <label className="flex flex-col gap-1 flex-1 min-w-[12rem]">
              <span className="text-[11px] text-zinc-500">
                {isUz ? "Izoh" : "Комментарий"}
              </span>
              <input
                aria-label={isUz ? "Ilova izohi" : "Комментарий к вложению"}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={500}
                placeholder={isUz ? "Ixtiyoriy" : "Необязательно"}
                className={FIELD.replace("h-8", "h-9")}
              />
            </label>

            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className={BTN_PRIMARY + " h-9 shrink-0"}
            >
              <Upload className="w-3.5 h-3.5 inline-block mr-1" />
              {busy
                ? isUz
                  ? "Yuklanmoqda…"
                  : "Загружаю…"
                : isUz
                  ? "Fayl tanlash"
                  : "Выбрать файл"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pick(f);
              }}
            />
          </div>
          <span className="text-[10px] text-zinc-400">
            {isUz
              ? "jpeg, png, webp, heic, pdf; 20 MB gacha"
              : "jpeg, png, webp, heic, pdf; до 20 МБ"}
          </span>
        </div>
      )}

      <div className="px-4 py-3 flex flex-col gap-3">
        {error !== null && (
          <ErrorBox text={errorText(error, isUz)} isUz={isUz} />
        )}

        {rows === null && (
          <span className="text-xs text-zinc-500">
            {isUz ? "Yuklanmoqda…" : "Загружаю…"}
          </span>
        )}

        {rows !== null && rows.length === 0 && (
          <span className="text-xs text-zinc-500">
            {isUz ? "Ilova yo‘q" : "Вложений нет"}
          </span>
        )}

        <ul className="flex flex-col gap-2">
          {(rows ?? []).map((a) => (
            <li
              key={a.uid}
              className="flex items-start gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2"
            >
              {previews[a.uid] ? (
                <img
                  src={previews[a.uid]}
                  alt={a.fileName}
                  className="w-16 h-16 object-cover rounded-md border border-zinc-200 dark:border-zinc-800 shrink-0 bg-zinc-100 dark:bg-zinc-900"
                />
              ) : (
                <span className="w-16 h-16 rounded-md border border-zinc-200 dark:border-zinc-800 shrink-0 flex items-center justify-center text-zinc-400">
                  {a.mimeType.startsWith("image/") ? (
                    <ImageIcon className="w-5 h-5" />
                  ) : (
                    <FileText className="w-5 h-5" />
                  )}
                </span>
              )}

              <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words">
                  {a.fileName}
                </span>
                <span className="text-[11px] text-zinc-500">
                  {isUz ? KIND_TEXT[a.kind].uz : KIND_TEXT[a.kind].ru} ·{" "}
                  {formatBytes(a.sizeBytes, isUz ? 'uz' : 'ru')}
                  {a.author ? ` · ${a.author}` : ""}
                </span>
                {a.comment && (
                  <span className="text-[11px] text-zinc-500 break-words">
                    {a.comment}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => void download(a)}
                  className={BTN_GHOST + " h-7"}
                >
                  {isUz ? "Yuklab olish" : "Скачать"}
                </button>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => void remove(a)}
                    disabled={removing === a.uid}
                    aria-label={isUz ? "Ilovani o‘chirish" : "Удалить вложение"}
                    title={isUz ? "Ilovani o‘chirish" : "Удалить вложение насовсем"}
                    className="p-1.5 rounded-md text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer disabled:opacity-40"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

/**
 * Окно вложений: та же панель в модальной обвязке. Применяется там, где
 * вложения открывают рядом со строкой операции, а не целой вкладкой.
 */
export const AttachmentsDialog: React.FC<{
  owner: AttachmentOwner;
  uid: string;
  title: string;
  canEdit: boolean;
  isUz: boolean;
  onClose: () => void;
}> = ({ owner, uid, title, canEdit, isUz, onClose }) => (
  <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-y-auto p-4">
    <div
      className={`${CARD} w-full max-w-2xl my-4 flex flex-col`}
      role="dialog"
      aria-label={isUz ? "Ilovalar" : "Вложения"}
    >
      <div className="px-4 py-3 flex items-center justify-between gap-2 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-2 min-w-0 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          <Paperclip className="w-4 h-4 shrink-0" />
          <span className="truncate">
            {isUz ? "Ilovalar" : "Вложения"} · {title}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={isUz ? "Ilovalarni yopish" : "Закрыть вложения"}
          className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <AttachmentsPanel owner={owner} uid={uid} canEdit={canEdit} isUz={isUz} />
    </div>
  </div>
);

/** Кнопка-скрепка рядом со строкой операции. */
export const AttachmentsButton: React.FC<{
  onOpen: () => void;
  isUz: boolean;
  compact?: boolean;
}> = ({ onOpen, isUz, compact }) => (
  <button
    type="button"
    onClick={onOpen}
    title={isUz ? "Ilovalar: foto, skan" : "Вложения: фото, сканы"}
    aria-label={isUz ? "Ilovalar" : "Вложения"}
    className={
      compact
        ? "p-1.5 rounded-md text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
        : BTN_GHOST + " h-7 shrink-0"
    }
  >
    <Paperclip className="w-3.5 h-3.5 inline-block" />
  </button>
);
