import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Тексты отказов — часть интерфейса (ТЗ 13.4).
 *
 * Человек видит их в тостах и в боте, поэтому на узбекском экране они обязаны
 * быть узбекскими. Проверка смотрит исходники, а не ответы: сообщений несколько
 * сотен, по одному их не вызвать, и забытое всплыло бы у заказчика.
 *
 * Правило одно: русский текст в исключении проходит через `say(ru, uz)`.
 * Каталог `bot/` не считаем — у бота свой двуязычный слой (`label`, `*.texts.ts`),
 * и в нём язык берётся из сессии, а не из заголовка запроса.
 */
const SRC = new URL('../src', import.meta.url).pathname;
const SKIP = ['bot', 'generated', 'prisma'];
const CYR = /[А-Яа-яЁё]/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Текст аргумента исключения: от открывающей скобки до парной ей. */
function argument(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

describe('язык отказов', () => {
  it('каждый русский текст отказа переведён', () => {
    const bad: string[] = [];
    for (const file of files(SRC)) {
      const text = readFileSync(file, 'utf8');
      const re = /new [A-Za-z]*Exception\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const open = m.index + m[0].length - 1;
        const arg = argument(text, open);
        if (!CYR.test(arg)) continue;
        if (/\bsay\(/.test(arg)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        const short = arg.replace(/\s+/g, ' ').trim().slice(0, 90);
        bad.push(`${file.slice(SRC.length + 1)}:${line} ${short}`);
      }
    }
    expect(bad, `отказов только по-русски: ${bad.length}\n${bad.slice(0, 40).join('\n')}`).toEqual(
      [],
    );
  });
});
