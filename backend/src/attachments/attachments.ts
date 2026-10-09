/**
 * Правила вложений, не зависящие ни от базы, ни от HTTP: что разрешено
 * прикреплять, каким правом, и как из имени файла получается безопасное имя.
 * Вынесено отдельным модулем, чтобы проверять таблицей, а не подъёмом сервиса.
 */

export const OWNER_KINDS = [
  'stock_move',
  'batch',
  'finance_operation',
  'production_order',
  'production_stage',
  'document',
  'partner',
] as const;
export type OwnerKind = (typeof OWNER_KINDS)[number];

export const ATTACHMENT_KINDS = ['photo', 'scan', 'certificate', 'other'] as const;
export type AttachmentKindName = (typeof ATTACHMENT_KINDS)[number];

/** 20 МиБ: фото с телефона и многостраничный скан проходят, видео — нет. */
export const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Разрешённые типы и расширение, под которым файл ложится на диск.
 *
 * Список, а не «всё, кроме опасного»: вложение отдаётся обратно в браузер, и
 * каждый новый тип здесь — это решение о том, что браузер с ним сделает.
 * HTML и SVG не пускаем совсем: они исполняют скрипт в нашем источнике.
 */
export const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

/**
 * Право на чтение и на правку — по владельцу вложения, а не общее «attachments».
 * Кто видит операцию, тот видит её фото; кто может провести операцию, тот может
 * приложить к ней скан. Отдельные права под вложения означали бы, что кладовщик
 * с правом на склад не приложит фото к своему же списанию.
 */
export const PERMISSION_BY_OWNER: Record<OwnerKind, { view: string; edit: string }> = {
  stock_move: { view: 'warehouse.view', edit: 'warehouse.move' },
  batch: { view: 'warehouse.view', edit: 'warehouse.move' },
  finance_operation: { view: 'finance.view', edit: 'finance.post' },
  // Фото брака и замера делает тот, кто ведёт задание в цеху (ТЗ 4.1, 4.6).
  production_order: { view: 'production.view', edit: 'production.manage' },
  // Снимок операции — то же право, что и у задания, к которому этап привязан.
  //
  // Отметки этапа в модуле разрешены парой «production.work или
  // production.manage», а здесь право одно: таблица проверяется по одному
  // коду на владельца, и второй код в ней означал бы второй способ считать
  // право. Взято `manage`, а не `work`, чтобы мастер с одним `manage` не
  // потерял на этапе то, что уже может на задании. Оператору с одним `work`
  // фото этапа пока недоступно — это вопрос разреза прав, и он решается
  // вместе с ролями, а не здесь.
  production_stage: { view: 'production.view', edit: 'production.manage' },
  // Скан подписанного акта прикладывает тот, кто ведёт документ, а не тот, кто
  // его согласует: согласование — решение, а скан — работа с документом
  // (ТЗ 7.1, «прикрепление сканов, фотографий, сопроводительных файлов»).
  document: { view: 'documents.view', edit: 'documents.edit' },
  // Доверенность, карточка предприятия, скан договора — их держит тот, кто
  // ведёт клиента (ТЗ 8.2, вкладка «файлы» в карточке). Отдельного права под
  // файлы клиента нет по той же причине, что и у остальных владельцев:
  // менеджер, ведущий карточку, не смог бы приложить к ней доверенность.
  partner: { view: 'crm.view', edit: 'crm.edit' },
};

/**
 * Имя файла из запроса в имя, которое не навредит.
 *
 * Пути отрезаем (`../` и `C:\`), управляющие символы убираем: имя уходит в
 * заголовок `Content-Disposition`, а перевод строки в заголовке — это отдельный
 * ответ, приклеенный к нашему. Длину режем до 150 знаков вместе с расширением.
 */
export function safeFileName(raw: string, mime: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  const fallback = `vlozhenie.${ALLOWED_MIME[mime] ?? 'bin'}`;
  const name = clean === '' || clean === '.' || clean === '..' ? fallback : clean;
  return name.length <= 150 ? name : name.slice(0, 120) + '~.' + (ALLOWED_MIME[mime] ?? 'bin');
}

/** Ключ на диске: компания / год / месяц / uid.расширение. Имя файла в ключ не идёт. */
export function storageKey(companyId: bigint, uid: string, mime: string, at = new Date()): string {
  const yyyy = String(at.getUTCFullYear());
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  const ext = ALLOWED_MIME[mime];
  return `${companyId}/${yyyy}/${mm}/${uid}${ext ? '.' + ext : ''}`;
}

/**
 * Показывать вложение в странице или скачивать файлом.
 * Картинку человек хочет увидеть, а pdf — открыть или сохранить сам.
 */
export const dispositionOf = (mime: string): 'inline' | 'attachment' =>
  mime.startsWith('image/') ? 'inline' : 'attachment';
