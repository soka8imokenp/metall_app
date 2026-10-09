import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, DatabaseBackup, Download, Info, RefreshCw, ShieldCheck } from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import type { BackupRow, BackupSettings } from '../../types/api';
import { formatBytes } from '../../lib/formatters';
import {
  backupHealth,
  canDownload,
  durationText,
  healthText,
  keepText,
  mayManageBackups,
  sourceLabel,
  starterLabel,
  statusLabel,
} from '../../lib/backups';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, ErrorBox, Skeleton } from './warehouse-ui';

/**
 * Копии базы — вкладка в «Настройках».
 *
 * Что экран обязан отвечать администратору:
 *   1. **Копии вообще есть?** Ответ строкой над списком, а не в голове у того,
 *      кто умеет читать таблицу: считается по последней **удачной** копии,
 *      потому что сверху списка может лежать неудачная попытка.
 *   2. **Что с каждой копией:** когда начали, сколько шла, сколько весит, чем
 *      кончилась и кто её запустил.
 *   3. **Можно ли её забрать.** Файл вытесняется ротацией, запись остаётся:
 *      у такой строки кнопки скачивания нет, а не «есть и не работает».
 *
 * **Кнопки «Восстановить» здесь нет, и это решение.** Восстановление — это
 * стирание текущих данных, и HTTP-ручка под него доступна по сети каждому, кто
 * добрался до сессии администратора. Подтверждение в окне от угнанной сессии не
 * спасает. Порядок восстановления руками описан в статье справки «Бэкап базы»,
 * а проверяется он скриптом `backend/scripts/backup-verify.ts`, который
 * разворачивает копию во временную базу и сверяет число записей.
 *
 * Решения экрана (права, свежесть, можно ли скачать) живут в `lib/backups.ts` и
 * проверены `test/backups.test.ts`: в разметке их не проверить без браузера.
 */

const when = (iso: string | null, isUz: boolean) =>
  iso
    ? new Date(iso).toLocaleString(isUz ? 'uz-UZ' : 'ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const TONE: Record<BackupRow['status'], string> = {
  running: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  failed: 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
};

const LABEL = 'text-[11px] font-medium text-zinc-500 dark:text-zinc-400';
const MONO = 'font-mono text-[11px] break-all';

const saveBlob = (blob: Blob, filename: string) => {
  // Ссылку отзываем сразу: иначе копия базы висит в памяти вкладки до её закрытия.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export const AdminBackups: React.FC = () => {
  const { locale } = useApp();
  const { session } = useAuth();
  const isUz = locale === 'uz';
  const may = mayManageBackups(session?.permissions);

  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [rows, setRows] = useState<BackupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.admin.backups();
      setSettings(res.data.settings);
      setRows(res.data.rows);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    if (may) void load();
  }, [may, load]);

  /**
   * «Сделать копию сейчас». Дамп идёт минуты, поэтому кнопка выключена до
   * ответа: второе нажатие сервер отвергнет замком, но человек об этом не
   * знает, и получил бы отказ вместо ожидания.
   *
   * Упавшая копия приходит обычным ответом со `status: 'failed'` — её причину
   * показываем сразу, не заставляя искать строку в списке.
   */
  const runNow = async () => {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const res = await apiClient.admin.runBackup();
      const row = res.data;
      setNote(
        row.status === 'ok'
          ? isUz
            ? `Nusxa olindi: ${row.fileName}`
            : `Копия сделана: ${row.fileName}`
          : isUz
            ? `Nusxa olinmadi: ${row.error ?? 'sabab yozilmagan'}`
            : `Копия не сделалась: ${row.error ?? 'причина не записана'}`,
      );
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const download = async (row: BackupRow) => {
    setError(null);
    try {
      const { blob, filename } = await apiClient.admin.downloadBackup(row.uid);
      saveBlob(blob, filename || row.fileName);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  // Раздел «Настройки» целиком закрыт без этого права, но вкладка обязана
  // отвечать за себя: её рисует не только `AdminView`, а право может уехать у
  // человека прямо посреди работы.
  if (!may) {
    return (
      <div
        data-screen="admin-backups"
        className={CARD + ' p-4 text-xs text-zinc-600 dark:text-zinc-400 break-words'}
      >
        {isUz
          ? 'Baza nusxalari — «Sozlamalar» huquqi bo‘lgan odamlar uchun.'
          : 'Копии базы видны тем, у кого есть право на «Настройки».'}
      </div>
    );
  }

  // Расписание учитывается в состоянии, а не только в подписи «Выключено»:
  // на стенде оно выключено сознательно, и строка «копия старая, значит служба
  // падала» там была бы ложной тревогой.
  const health = rows && settings ? backupHealth(rows, new Date(), settings.scheduler) : null;

  return (
    <div data-screen="admin-backups" className="flex flex-col gap-3 min-w-0">
      {/* Что настроено на сервере. Это не украшение: без каталога и времени
          человек не может проверить копию руками и не знает, чего ждать. */}
      <div className={CARD + ' p-4 flex flex-col gap-3 min-w-0'}>
        <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <DatabaseBackup className="w-4 h-4 shrink-0 text-zinc-500" />
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {isUz ? 'Baza nusxalari' : 'Копии базы'}
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className={BTN_GHOST}
              onClick={() => void load()}
              data-role="backups-reload"
            >
              <RefreshCw className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" />
              {isUz ? 'Yangilash' : 'Обновить'}
            </button>
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={busy}
              onClick={() => void runNow()}
              data-role="backup-run-now"
            >
              {busy
                ? isUz
                  ? 'Olinmoqda…'
                  : 'Делается…'
                : isUz
                  ? 'Hozir nusxa olish'
                  : 'Сделать копию сейчас'}
            </button>
          </div>
        </div>

        {settings && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 min-w-0">
            <div className="min-w-0">
              <div className={LABEL}>{isUz ? 'Jadval' : 'Расписание'}</div>
              <div className="text-xs text-zinc-900 dark:text-zinc-100" data-role="backup-at">
                {settings.scheduler
                  ? isUz
                    ? `Har kuni ${settings.at}`
                    : `Ежедневно в ${settings.at}`
                  : isUz
                    ? 'O‘chirilgan'
                    : 'Выключено'}
              </div>
            </div>
            <div className="min-w-0">
              <div className={LABEL}>{isUz ? 'Saqlanadi' : 'Храним'}</div>
              <div className="text-xs text-zinc-900 dark:text-zinc-100">
                {keepText(settings.keep, isUz)}
              </div>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <div className={LABEL}>{isUz ? 'Katalog' : 'Каталог'}</div>
              <div
                className={MONO + ' text-zinc-700 dark:text-zinc-300'}
                data-role="backup-dir"
              >
                {settings.dir}
              </div>
            </div>
          </div>
        )}

        {health && settings && (
          <div
            data-role="backup-health"
            data-level={health.level}
            className={
              'flex items-start gap-2 rounded-lg px-3 py-2 text-xs break-words min-w-0 ' +
              (health.level === 'ok'
                ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200'
                : health.level === 'off'
                  ? 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                  : 'bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200')
            }
          >
            {health.level === 'ok' ? (
              <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" />
            ) : health.level === 'off' ? (
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            )}
            <span className="min-w-0">{healthText(health, settings, isUz)}</span>
          </div>
        )}

        {note && (
          <div
            role="status"
            data-role="backup-note"
            className="text-xs text-zinc-700 dark:text-zinc-300 break-words min-w-0"
          >
            {note}
          </div>
        )}

        {/* Восстановление кнопкой не делается — и человек должен узнать об этом
            здесь, а не искать несуществующую кнопку. */}
        <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400 break-words min-w-0">
          {isUz
            ? 'Tiklash tugmasi yo‘q: u tarmoq orqali barcha ma’lumotni o‘chirish tugmasi bo‘lardi. ' +
              'Nusxa serverda qo‘lda yoyiladi — tartib «Yordam» → «Bazaning zaxira nusxasi» da.'
            : 'Кнопки восстановления здесь нет: по сети это была бы кнопка «стереть все данные». ' +
              'Копия разворачивается на сервере руками — порядок в «Справке» → «Бэкап базы».'}
        </p>
      </div>

      {error && <div className={CARD}><ErrorBox text={error} onRetry={() => void load()} isUz={isUz} /></div>}

      <div className={CARD + ' overflow-hidden min-w-0'}>
        {rows === null ? (
          <Skeleton />
        ) : rows.length === 0 ? (
          <Empty
            text={
              isUz
                ? 'Hali bitta ham nusxa yo‘q. «Hozir nusxa olish» ni bosib ko‘ring.'
                : 'Копий пока нет. Нажмите «Сделать копию сейчас».'
            }
          />
        ) : (
          <div className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
            {rows.map((row) => (
              <div
                key={row.uid}
                data-backup={row.uid}
                data-backup-status={row.status}
                className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 min-w-0"
              >
                <span
                  className={
                    'px-2 py-0.5 rounded-md text-[11px] font-medium shrink-0 ' + TONE[row.status]
                  }
                >
                  {statusLabel(row, isUz)}
                </span>
                <span className="text-xs text-zinc-900 dark:text-zinc-100 shrink-0">
                  {when(row.startedAt, isUz)}
                </span>
                {/* Кто запустил — единственное место строки, где длина не наша:
                    полное имя человека бывает длиннее всей ширины 360. Поэтому
                    этот кусок переносится и рвётся по словам, а не держит
                    ширину как остальные: с `shrink-0` он выносил строку за край
                    контейнера — нашлось прогоном `qa/admin-live` на 360. */}
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400 min-w-0 break-words">
                  {sourceLabel(row, isUz)} · {starterLabel(row, isUz)}
                </span>
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400 shrink-0">
                  {durationText(row.durationMs, isUz)}
                </span>
                <span className="text-xs text-zinc-700 dark:text-zinc-300 shrink-0">
                  {row.sizeBytes === null ? '—' : formatBytes(row.sizeBytes, isUz ? 'uz' : 'ru')}
                </span>
                {/* Имя файла и хеш — ширине строки, а не наоборот: длинный хеш
                    иначе растягивает строку и уводит кнопку за край на 360. */}
                <span className={MONO + ' text-zinc-500 dark:text-zinc-400 basis-full min-w-0'}>
                  {row.fileName}
                  {row.sha256 ? ` · sha256 ${row.sha256.slice(0, 16)}…` : ''}
                </span>
                {row.error && (
                  <span className="basis-full min-w-0 text-[11px] text-rose-700 dark:text-rose-300 break-words">
                    {row.error}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1.5 shrink-0">
                  {canDownload(row) ? (
                    <button
                      type="button"
                      className={BTN_GHOST}
                      onClick={() => void download(row)}
                      data-role="backup-download"
                    >
                      <Download className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" />
                      {isUz ? 'Yuklab olish' : 'Скачать'}
                    </button>
                  ) : row.status === 'ok' ? (
                    <span className="text-[11px] text-zinc-400" data-role="backup-gone">
                      {isUz ? 'fayl saqlash muddati o‘tgan' : 'файл удалён по сроку хранения'}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
