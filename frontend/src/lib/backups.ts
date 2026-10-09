/**
 * Копии базы: решения экрана, вынутые из разметки.
 *
 * Экран «Настройки → Копии базы» рисует список и три кнопки, но решает он
 * больше, чем видно: кому раздел показывать, у какой строки файл ещё есть,
 * сколько времени прошло без удачной копии. Это и есть то, что ломается молча,
 * и то, что проверяется тестом без браузера (`test/backups.test.ts`).
 *
 * Права берутся существующие. Своего права под бэкап нет: RBAC этой задачей не
 * менялся, а список копий открыт ровно тем, кому открыт сам раздел «Настройки».
 */
import type { BackupRow, BackupSettings } from '../types/api';

/**
 * Без этого права экран не показывается, и это не украшение: тот же код стоит
 * на маршрутах `admin/backups` в бэкенде. Один список в двух местах — чтобы
 * «скрыли кнопку» и «закрыли доступ» не разошлись.
 */
export const BACKUP_PERMISSIONS = ['admin.users'] as const;

export const mayManageBackups = (permissions: readonly string[] | undefined): boolean =>
  (permissions ?? []).some((p) => (BACKUP_PERMISSIONS as readonly string[]).includes(p));

/**
 * Скачивать можно только удачную копию, у которой файл ещё на диске.
 *
 * Ротация удаляет файлы, оставляя записи: строка месячной давности в списке
 * есть, а файла по ней нет. Кнопка, которая в ответ приносит «файл удалён по
 * сроку хранения», хуже отсутствующей.
 */
export const canDownload = (row: BackupRow): boolean => row.status === 'ok' && row.onDisk;

export const statusLabel = (row: BackupRow, isUz: boolean): string => {
  if (row.status === 'running') return isUz ? 'olinmoqda' : 'делается';
  if (row.status === 'ok') return isUz ? 'tayyor' : 'готова';
  return isUz ? 'yiqildi' : 'не вышла';
};

export const sourceLabel = (row: BackupRow, isUz: boolean): string =>
  row.source === 'manual'
    ? isUz
      ? 'qo‘lda'
      : 'вручную'
    : isUz
      ? 'jadval bo‘yicha'
      : 'по расписанию';

/**
 * Сколько шла копия. Секунды, а не миллисекунды: человек сравнивает «18 с» с
 * «вчера было 12 с», и три знака после запятой ему в этом не помогают.
 */
export const durationText = (ms: number | null, isUz: boolean): string => {
  if (ms === null) return '—';
  // Копия небольшой базы укладывается в доли секунды, и округление писало
  // «0 с» — это читается как «ничего не произошло». Словами честнее.
  if (ms < 1000) return isUz ? 'bir soniyadan kam' : 'меньше секунды';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return isUz ? `${sec} s` : `${sec} с`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return isUz ? `${min} min ${rest} s` : `${min} мин ${rest} с`;
};

/**
 * «Храним N последних копий» — с правильным числом.
 *
 * Число приходит из `BACKUP_KEEP`, то есть из настройки сервера, и на стенде
 * оно равно единице. Подпись, написанная под множественное число, выдавала
 * «1 последних копий»: заказчик читает этот экран, и такая строка выглядит
 * недоделкой. В узбекском счётное слово `ta` уже стоит — там число ничего
 * не меняет.
 */
export const keepText = (keep: number, isUz: boolean): string => {
  if (isUz) return `${keep} ta oxirgi nusxa`;
  const tens = keep % 100;
  const ones = keep % 10;
  if (tens >= 11 && tens <= 14) return `${keep} последних копий`;
  if (ones === 1) return `${keep} последнюю копию`;
  if (ones >= 2 && ones <= 4) return `${keep} последние копии`;
  return `${keep} последних копий`;
};

/** Кто запустил. Расписание не нажимает никто, и выдумывать ему имя не нужно. */
export const starterLabel = (row: BackupRow, isUz: boolean): string =>
  row.starterName ?? (row.source === 'schedule' ? (isUz ? 'tizim' : 'система') : '—');

export type BackupHealth =
  /** Удачная копия есть и она свежая. */
  | { level: 'ok'; hoursAgo: number }
  /** Копии были, но последняя удачная старше срока. */
  | { level: 'stale'; hoursAgo: number }
  /** Ни одной удачной копии вовсе. */
  | { level: 'none' }
  /**
   * Расписание выключено переменной `BACKUP_SCHEDULER=off` — так стоит стенд.
   *
   * Отдельный уровень, а не `stale`: где ночных копий не ждут, «копия старая»
   * не предупреждение, а неправда, и она посылает человека искать поломку,
   * которой нет. `hoursAgo` — когда копию делали кнопкой, `null` — не делали.
   */
  | { level: 'off'; hoursAgo: number | null };

/**
 * Сколько часов считаем копию свежей.
 *
 * Сутки плюс запас: копия ночная, и ровно через 24 часа после неё следующая
 * ещё не начиналась. Порог в сутки красил бы экран тревогой каждый вечер.
 */
export const FRESH_HOURS = 30;

/**
 * Состояние дел одной строкой над списком.
 *
 * Список, отсортированный по времени, сам на вопрос «копия вообще есть?» не
 * отвечает: сверху может лежать неудачная попытка, а удачная — третьей. Поэтому
 * свежесть считается по последней **удачной**, а не по первой строке.
 *
 * `schedulerOn` — то же, что `settings.scheduler`. Выключенное расписание
 * меняет не оформление, а смысл ответа: ждать следующую копию не от кого.
 * По умолчанию `true`, потому что на сервере заказчика расписание включено
 * само и ничего не настраивается.
 */
export const backupHealth = (
  rows: readonly BackupRow[],
  now = new Date(),
  schedulerOn = true,
): BackupHealth => {
  const good = rows
    .filter((r) => r.status === 'ok')
    .map((r) => new Date(r.startedAt).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a);
  const hoursAgo =
    good.length === 0 ? null : Math.max(0, Math.floor((now.getTime() - good[0]!) / 3_600_000));
  if (!schedulerOn) return { level: 'off', hoursAgo };
  if (hoursAgo === null) return { level: 'none' };
  return { level: hoursAgo > FRESH_HOURS ? 'stale' : 'ok', hoursAgo };
};

/** Подпись к состоянию: то же, что `backupHealth`, но словами для человека. */
export const healthText = (
  health: BackupHealth,
  settings: BackupSettings,
  isUz: boolean,
): string => {
  if (health.level === 'none') {
    return isUz
      ? 'Hali bitta ham tayyor nusxa yo‘q. Tungi nusxani kutmasdan «Hozir nusxa olish» ni bosing.'
      : 'Удачной копии пока нет ни одной. Не ждите ночи — нажмите «Сделать копию сейчас».';
  }
  // Расписание выключено: про ночь и про «много часов назад» молчим, иначе
  // экран обещает то, чего не будет, или пугает тем, чего не случилось.
  if (health.level === 'off') {
    const was =
      health.hoursAgo === null
        ? isUz
          ? 'Tayyor nusxa hali yo‘q.'
          : 'Готовой копии пока нет.'
        : isUz
          ? `Oxirgi tayyor nusxa ${health.hoursAgo} soat oldin.`
          : `Последняя готовая копия ${health.hoursAgo} ч назад.`;
    return isUz
      ? `Jadval o‘chirilgan: nusxa faqat «Hozir nusxa olish» tugmasi bilan olinadi. ${was}`
      : `Расписание выключено: копия делается только кнопкой «Сделать копию сейчас». ${was}`;
  }
  const h = health.hoursAgo;
  if (health.level === 'stale') {
    return isUz
      ? `Oxirgi tayyor nusxa ${h} soat oldin — bu juda ko‘p. Jadval ${settings.at} da ishlaydi; ` +
        `xizmat o‘chiq bo‘lgan yoki nusxa yiqilgan.`
      : `Последняя удачная копия ${h} ч назад — это много. Расписание стоит на ${settings.at}; ` +
        `значит служба была выключена или копия падала.`;
  }
  return isUz
    ? `Oxirgi tayyor nusxa ${h} soat oldin. Jadval ${settings.at}, ${settings.keep} nusxa saqlanadi.`
    : `Последняя удачная копия ${h} ч назад. Расписание ${settings.at}, храним ${settings.keep} копий.`;
};
