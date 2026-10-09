/**
 * Разбор статей справки.
 *
 * Зачем свой разбор, а не библиотека: статьи пишем мы сами, и нужен узкий
 * набор — заголовки, шаги по порядку, снимок экрана, предупреждение, таблица.
 * Библиотека markdown принесла бы ещё и сырой HTML из текста статьи, то есть
 * дыру там, где её быть не должно. Поэтому разбор свой, подмножество
 * закрытое, а что в него не входит — остаётся обычным текстом.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHelpMarkdown, plainText } from '../src/help/markdown.ts';

test('заголовки второго и третьего уровня', () => {
  const blocks = parseHelpMarkdown('## Как записать приход\n\n### Если партии нет\n');
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['heading', 'heading'],
  );
  assert.equal(blocks[0]!.kind === 'heading' && blocks[0]!.level, 2);
  assert.equal(blocks[1]!.kind === 'heading' && blocks[1]!.level, 3);
  assert.equal(plainText(blocks[0]!), 'Как записать приход');
});

test('нумерованный список собирается в один блок, а не в три абзаца', () => {
  const blocks = parseHelpMarkdown('1. Откройте склад\n2. Выберите тип\n3. Нажмите «Записать»\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.kind, 'list');
  assert.equal(blocks[0]!.kind === 'list' && blocks[0]!.ordered, true);
  assert.equal(blocks[0]!.kind === 'list' && blocks[0]!.items.length, 3);
});

test('список с дефисами — не нумерованный', () => {
  const blocks = parseHelpMarkdown('- первое\n- второе\n');
  assert.equal(blocks[0]!.kind === 'list' && blocks[0]!.ordered, false);
});

test('абзац склеивается из соседних строк, пустая строка его закрывает', () => {
  const blocks = parseHelpMarkdown('одна строка\nи вторая\n\nновый абзац\n');
  assert.equal(blocks.length, 2);
  assert.equal(plainText(blocks[0]!), 'одна строка и вторая');
  assert.equal(plainText(blocks[1]!), 'новый абзац');
});

test('предупреждение — отдельный блок, а не абзац с уголком', () => {
  const blocks = parseHelpMarkdown('> Сторно не удаляет строку журнала.\n> Оно пишет встречную.\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.kind, 'note');
  assert.equal(plainText(blocks[0]!), 'Сторно не удаляет строку журнала. Оно пишет встречную.');
});

test('картинка больше не разбирается — остаётся текстом абзаца', () => {
  // Снимки экрана из справки убраны (заказчик, 07.10), и разбор картинок убран
  // вместе с ними: ветка, которой ничем не пользуются, однажды нарисует на
  // экране «снимок экрана не найден» вместо шага инструкции. Теперь строка с
  // картинкой доедет до экрана как есть — её видно глазами, а в содержимом её
  // запрещает `help-content.test.ts`.
  const blocks = parseHelpMarkdown('![Правая панель склада](shots/sklad-prihod.webp)\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.kind, 'paragraph');
  assert.equal(plainText(blocks[0]!), '![Правая панель склада](shots/sklad-prihod.webp)');
});

test('таблица: шапка и строки', () => {
  const md = '| Тип | Откуда | Куда |\n| --- | --- | --- |\n| Приход | — | склад |\n';
  const blocks = parseHelpMarkdown(md);
  assert.equal(blocks.length, 1);
  if (blocks[0]!.kind !== 'table') return assert.fail('ожидалась таблица');
  assert.equal(blocks[0]!.head.length, 3);
  assert.equal(blocks[0]!.rows.length, 1);
  assert.equal(blocks[0]!.rows[0]!.length, 3);
});

test('жирный, код и ссылка на другую статью внутри строки', () => {
  const blocks = parseHelpMarkdown(
    'Нажмите **Записать**, код `СР-00054`, см. [партии](help:sklad-serii).\n',
  );
  const p = blocks[0]!;
  if (p.kind !== 'paragraph') return assert.fail('ожидался абзац');
  const kinds = p.inline.map((i) => i.kind);
  assert.ok(kinds.includes('strong'), 'жирный не разобран');
  assert.ok(kinds.includes('code'), 'код не разобран');
  const link = p.inline.find((i) => i.kind === 'article');
  assert.ok(link, 'ссылка на статью не разобрана');
  assert.equal(link.kind === 'article' && link.slug, 'sklad-serii');
  assert.equal(plainText(p), 'Нажмите Записать, код СР-00054, см. партии.');
});

test('внешняя ссылка остаётся ссылкой, а не превращается в статью', () => {
  const blocks = parseHelpMarkdown('Стенд: [адрес](https://metall-asia.cloudplus.uz).\n');
  const p = blocks[0]!;
  if (p.kind !== 'paragraph') return assert.fail('ожидался абзац');
  const link = p.inline.find((i) => i.kind === 'link');
  assert.ok(link, 'внешняя ссылка потерялась');
  assert.equal(link.kind === 'link' && link.href, 'https://metall-asia.cloudplus.uz');
});

test('разметка в тексте статьи не становится разметкой страницы', () => {
  // Статьи пишем мы, но дыру оставлять нельзя: сырой HTML обязан дойти до
  // экрана текстом. Разбор его не распознаёт, значит и вставлять нечего.
  const blocks = parseHelpMarkdown('<img src=x onerror=alert(1)>\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.kind, 'paragraph');
  assert.equal(plainText(blocks[0]!), '<img src=x onerror=alert(1)>');
});

test('блок кода отдаётся как есть, без разбора внутри', () => {
  const blocks = parseHelpMarkdown('```\nGET /api/v1/exchange\n**не жирный**\n```\n');
  assert.equal(blocks.length, 1);
  if (blocks[0]!.kind !== 'code') return assert.fail('ожидался блок кода');
  assert.equal(blocks[0]!.text, 'GET /api/v1/exchange\n**не жирный**');
});
