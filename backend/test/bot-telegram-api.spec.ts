/**
 * Связь с Telegram рвётся на ровном месте — за первый час жизни бота это
 * случилось один раз («fetch failed»), и человек не увидел ответа на нажатие.
 * Один повтор это закрывает; второго не делаем — Telegram сам переотдаст
 * обновление, если ответа не было.
 */
import { describe, expect, it } from 'vitest';
import { TelegramApi, TelegramError } from '../src/bot/telegram.api.js';

const ok = () =>
  Promise.resolve(
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      headers: { 'content-type': 'application/json' },
    }),
  );

describe('клиент Telegram', () => {
  it('повторяет один раз, если связь оборвалась', async () => {
    let calls = 0;
    const api = new TelegramApi('token', (() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new TypeError('fetch failed'));
      return ok();
    }) as unknown as typeof fetch);

    await api.sendMessage(1n, 'привет');
    expect(calls, 'повтора не было').toBe(2);
  });

  it('если и повтор не прошёл — говорит, что это связь, а не Telegram', async () => {
    const api = new TelegramApi('token', (() =>
      Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch);

    await expect(api.sendMessage(1n, 'привет')).rejects.toThrow(TelegramError);
    await expect(api.sendMessage(1n, 'привет')).rejects.toThrow(/связь/);
  });

  it('отказ самого Telegram повтором не прячет', async () => {
    let calls = 0;
    const api = new TelegramApi('token', (() => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false, description: 'chat not found' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch);

    await expect(api.sendMessage(1n, 'привет')).rejects.toThrow(/chat not found/);
    expect(calls, 'отказ Telegram повторять незачем').toBe(1);
  });
});

/**
 * Цвет кнопки — поле `style` (Bot API 9.4). Проверено живым запросом к
 * Telegram: «primary», «success», «danger» он принимает, выдуманное значение
 * возвращает как «Invalid button style specified». Здесь проверяем, что наш
 * клиент это поле действительно отправляет, а не теряет по дороге.
 */
describe('цвет кнопки уходит в Telegram', () => {
  it('передаёт style в разметке', async () => {
    let body = '';
    const api = new TelegramApi('token', ((_url: string, init: RequestInit) => {
      body = String(init.body);
      return ok();
    }) as unknown as typeof fetch);

    await api.sendMessage(1n, 'привет', [
      [
        { text: 'Склад', data: 'm:warehouse', style: 'primary' },
        { text: 'Настройки', data: 's', style: 'success' },
      ],
    ]);

    const sent = JSON.parse(body) as {
      reply_markup: { inline_keyboard: { text: string; style?: string }[][] };
    };
    const row = sent.reply_markup.inline_keyboard[0]!;
    expect(row[0]!.style, 'цвет раздела не ушёл в Telegram').toBe('primary');
    expect(row[1]!.style, 'цвет настроек не ушёл в Telegram').toBe('success');
  });
});
