import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Контекст одного запроса: кто спрашивает и от имени каких компаний.
 *
 * Хранится в AsyncLocalStorage, а не в объекте запроса, чтобы до него
 * доставал слой данных, которому про HTTP знать незачем. Из этого же контекста
 * берутся значения для SET LOCAL перед каждым обращением к базе — именно по ним
 * работает RLS.
 */
export interface RequestContext {
  requestId: string;
  userId: bigint | null;
  companyIds: bigint[];
  /**
   * Все компании человека, без сужения заголовком `X-Company-Id`.
   *
   * Нужны одному разделу — администрированию. Люди, роли и назначения не
   * принадлежат компании: кладовщик работает в обеих, и назначить ему роль на
   * заводе, стоя в «Торговом доме», администратор обязан. Остальные модули
   * берут `companyIds` и видят ровно выбранную компанию.
   */
  allCompanyIds: bigint[];
  permissions: Set<string>;
  locale: 'ru' | 'uz';
  /**
   * Откуда человек работает. Поле обязательное: журнал действий отвечает на
   * вопрос «кто и откуда», и значение по умолчанию здесь означало бы, что
   * действие из Telegram однажды тихо запишется как работа в браузере.
   */
  source: 'web' | 'mobile' | 'bot';
  /**
   * Сессия, которой подписан токен (`sid`). Нет у старых токенов, выданных до
   * появления сессий, и у бота. Нужна выходу и списку «мои сессии».
   */
  sessionUid?: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T =>
  storage.run(ctx, fn);

export const currentContext = (): RequestContext | undefined => storage.getStore();

/** Контекста нет — это ошибка программиста, а не повод молча показать всё. */
export function requireContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error('Обращение к данным вне контекста запроса');
  }
  return ctx;
}
