/**
 * Тонкий клиент Bot API: ровно те методы, которыми пользуется каркас.
 *
 * Отдельной библиотеки здесь нет сознательно. Нам нужны пять методов и разбор
 * одного типа ответа; библиотека принесла бы свой жизненный цикл, свои
 * таймеры и свой способ хранить состояние — а состояние у нас в базе.
 */
/**
 * Цвет кнопки. Bot API 9.4 добавил полю `style` три значения — «primary»
 * (синяя), «success» (зелёная) и «danger» (красная); без него клиент красит
 * кнопку сам. Старые клиенты поле просто не поймут и покажут кнопку как
 * раньше, поэтому цвет — оформление, а не условие работы.
 * https://core.telegram.org/bots/api#inlinekeyboardbutton
 */
export type ButtonStyle = 'primary' | 'success' | 'danger';

export interface InlineButton {
  text: string;
  /** `callback_data` ограничена 64 байтами: кладём код действия, а не предмет. */
  data: string;
  style?: ButtonStyle;
}

export type InlineKeyboard = InlineButton[][];

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  chat: { id: number; type: string };
  from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
  /** Есть у сообщения с шапкой: по нему видно, подпись править или текст. */
  photo?: { file_id: string; file_size?: number }[];
  /**
   * Файл, присланный человеком. Чек фотографируют, но присылают по-разному:
   * «фото» (Telegram сжимает) или «файл» (как есть, в том числе PDF).
   */
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: TelegramMessage;
  };
}

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    description: string,
  ) {
    super(`${method}: ${code} ${description}`);
  }
}

export class TelegramApi {
  /** Кеш загруженной картинки: второй раз шлём `file_id`, а не файл. */
  private photoIds = new Map<string, string>();

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  /**
   * Сеть до Telegram рвётся: один `fetch failed` не должен стоить человеку
   * нажатия. Повторяем один раз — больше незачем, Telegram сам переотдаст
   * обновление, если ответа не было.
   *
   * Повтор безопасен: все наши методы — показ экрана, а не проведение денег.
   */
  private async send(url: string, init: RequestInit, method: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (e) {
      const cause = (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message;
      await new Promise((r) => setTimeout(r, 500));
      try {
        return await this.fetchImpl(url, init);
      } catch (again) {
        const last =
          (again as { cause?: { message?: string } }).cause?.message ?? (again as Error).message;
        throw new TelegramError(method, 0, `связь: ${cause}; повтор: ${last}`);
      }
    }
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await this.send(
      this.url(method),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      },
      method,
    );
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) throw new TelegramError(method, res.status, body.description ?? 'нет описания');
    return body.result as T;
  }

  getMe() {
    return this.call<{ id: number; username: string }>('getMe');
  }

  /**
   * Длинный опрос. Сам Telegram держит соединение до `timeout` секунд, поэтому
   * своего интервала и своего `sleep` здесь нет.
   */
  /** Список команд в меню Telegram: человек видит их, а не угадывает. */
  setMyCommands(commands: { command: string; description: string }[]) {
    return this.call<boolean>('setMyCommands', { commands });
  }

  getUpdates(offset: number, timeoutSeconds: number) {
    return this.call<TelegramUpdate[]>('getUpdates', {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    });
  }

  /**
   * Где лежит присланный файл. Telegram хранит его у себя и отдаёт путь,
   * который живёт около часа — поэтому скачиваем сразу, а не запоминаем.
   */
  getFile(fileId: string) {
    return this.call<{ file_id: string; file_path?: string; file_size?: number }>('getFile', {
      file_id: fileId,
    });
  }

  /**
   * Сам файл. Адрес у него другой, чем у методов Bot API, и в нём токен —
   * поэтому путь приходит от `getFile`, а не собирается из имени файла.
   */
  async downloadFile(filePath: string): Promise<ArrayBuffer> {
    const url = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    const res = await this.send(url, { method: 'GET' }, 'downloadFile');
    if (!res.ok) {
      throw new TelegramError('downloadFile', res.status, 'файл не отдан');
    }
    return res.arrayBuffer();
  }

  sendMessage(chatId: number | bigint, text: string, keyboard?: InlineKeyboard) {
    return this.call<TelegramMessage>('sendMessage', {
      chat_id: String(chatId),
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard ? { inline_keyboard: toMarkup(keyboard) } : undefined,
    });
  }

  editMessageText(
    chatId: number | bigint,
    messageId: number,
    text: string,
    keyboard?: InlineKeyboard,
  ) {
    return this.call<TelegramMessage>('editMessageText', {
      chat_id: String(chatId),
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard ? { inline_keyboard: toMarkup(keyboard) } : undefined,
    });
  }

  /**
   * Панель живёт одним сообщением с картинкой: при переходах меняется подпись,
   * а не шлётся новая простыня. Поэтому правим именно подпись — у сообщения с
   * фотографией текста нет, и `editMessageText` на нём отказывает.
   */
  editMessageCaption(
    chatId: number | bigint,
    messageId: number,
    caption: string,
    keyboard?: InlineKeyboard,
  ) {
    return this.call<TelegramMessage>('editMessageCaption', {
      chat_id: String(chatId),
      message_id: messageId,
      caption,
      parse_mode: 'HTML',
      reply_markup: keyboard ? { inline_keyboard: toMarkup(keyboard) } : undefined,
    });
  }

  /**
   * Удаление сообщения человека. В приватном чате боту это разрешено, и на нём
   * держится обещание «логин и пароль не остаются в переписке».
   */
  deleteMessage(chatId: number | bigint, messageId: number) {
    return this.call<boolean>('deleteMessage', {
      chat_id: String(chatId),
      message_id: messageId,
    });
  }

  answerCallback(id: string, text?: string) {
    return this.call<boolean>('answerCallbackQuery', { callback_query_id: id, text });
  }

  /**
   * Картинка шапки. Первый раз уходит файлом, дальше — идентификатором: гонять
   * один и тот же файл на каждое «Старт» незачем.
   */
  async sendPhoto(
    chatId: number | bigint,
    photo: { key: string; bytes: ArrayBuffer; fileName: string },
    caption: string,
    keyboard?: InlineKeyboard,
  ) {
    const known = this.photoIds.get(photo.key);
    const markup = keyboard ? JSON.stringify({ inline_keyboard: toMarkup(keyboard) }) : undefined;

    if (known) {
      return this.call<TelegramMessage>('sendPhoto', {
        chat_id: String(chatId),
        photo: known,
        caption,
        parse_mode: 'HTML',
        reply_markup: keyboard ? { inline_keyboard: toMarkup(keyboard) } : undefined,
      });
    }

    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    if (markup) form.append('reply_markup', markup);
    form.append('photo', new Blob([photo.bytes]), photo.fileName);

    const res = await this.send(this.url('sendPhoto'), { method: 'POST', body: form }, 'sendPhoto');
    const body = (await res.json()) as {
      ok: boolean;
      result?: TelegramMessage & { photo?: { file_id: string }[] };
      description?: string;
    };
    if (!body.ok) throw new TelegramError('sendPhoto', res.status, body.description ?? '');
    const sizes = body.result?.photo ?? [];
    const id = sizes[sizes.length - 1]?.file_id;
    if (id) this.photoIds.set(photo.key, id);
    return body.result as TelegramMessage;
  }

  /**
   * Файл документа: PDF или DOCX.
   *
   * Отдельным сообщением, а не правкой панели: панель живёт одной подписью,
   * которую бот меняет на каждом переходе, а файл человек пересылает клиенту
   * и возвращается к нему через месяц. Кеша `file_id` здесь нет намеренно —
   * счёт пересобирается при правке, и прислать прежний файл значит отправить
   * клиенту не ту бумагу.
   */
  async sendDocument(
    chatId: number | bigint,
    file: { bytes: ArrayBuffer; fileName: string; mimeType: string },
    caption?: string,
  ): Promise<TelegramMessage> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }
    form.append('document', new Blob([file.bytes], { type: file.mimeType }), file.fileName);

    const res = await this.send(
      this.url('sendDocument'),
      { method: 'POST', body: form },
      'sendDocument',
    );
    const body = (await res.json()) as {
      ok: boolean;
      result?: TelegramMessage;
      description?: string;
    };
    if (!body.ok) throw new TelegramError('sendDocument', res.status, body.description ?? '');
    return body.result as TelegramMessage;
  }
}

function toMarkup(keyboard: InlineKeyboard) {
  return keyboard.map((row) =>
    row.map((b) => ({ text: b.text, callback_data: b.data, style: b.style })),
  );
}
