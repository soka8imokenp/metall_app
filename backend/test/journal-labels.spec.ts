import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIONS } from '../src/admin/journal.service.js';
import { DOCUMENT_ACTIONS } from '../src/documents/workflow.js';

/**
 * Журнал действий (ТЗ 3.4) человек читает словами. Если новое действие заводят
 * в коде, но забывают подпись, в таблице появляется голый код вроде
 * «edit_new_version» — тест ловит это до того, как увидит заказчик.
 */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'generated') out.push(...sources(p));
    } else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Коды действий, которые код правда пишет в журнал. */
function writtenActions(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sources('src')) {
    const text = readFileSync(file, 'utf8');
    for (const call of text.split('writeAudit(').slice(1)) {
      // Аргумент writeAudit — один объект; дальше следующего вызова не смотрим.
      const chunk = call.slice(0, 900);
      for (const m of chunk.matchAll(/action: '([a-z_.]+)'/g)) found.set(m[1], file);
    }
  }
  return found;
}

describe('подписи в журнале действий', () => {
  it('у каждого действия из кода есть название по-русски и по-узбекски', () => {
    const noLabel = [...writtenActions()]
      .filter(([action]) => !ACTIONS[action]?.ru || !ACTIONS[action]?.uz)
      .map(([action, file]) => `${action} (${file})`);
    expect(noLabel).toEqual([]);
  });

  it('действия документов и согласования финансов подписаны', () => {
    const dynamic = [
      ...DOCUMENT_ACTIONS,
      'edit',
      'edit_new_version',
      'archive',
      'restore',
      'reject',
      'post',
    ];
    expect(dynamic.filter((a) => !ACTIONS[a])).toEqual([]);
  });

  it('тест видит действия, а не пустой список', () => {
    expect(writtenActions().size).toBeGreaterThan(15);
  });
});
