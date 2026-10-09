/**
 * Опись справки против файлов на диске.
 *
 * Сами тексты статей проверить автоматически нельзя — их читает человек. А вот
 * связность проверить можно и нужно: опись ссылается на файл, статья ссылается
 * на другую статью, и обе ссылки однажды разойдутся при переименовании —
 * в справке появится пустая карточка.
 *
 * Этот файл единственный в тестах фронта читает диск: `content.ts` собирает те
 * же файлы через `import.meta.glob`, который без Vite не работает. Поэтому
 * здесь тот же набор файлов берётся напрямую — и расхождение между описью и
 * каталогом видно до сборки.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HELP_ARTICLES, TOPIC_ORDER } from '../src/help/articles.ts';
import { parseHelpMarkdown, type HelpBlock } from '../src/help/markdown.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELP = path.resolve(HERE, '../src/help');
const RU = path.join(HELP, 'content/ru');
const UZ = path.join(HELP, 'content/uz');
const SHOTS = path.join(HELP, 'shots');

const read = (file: string) => fs.readFileSync(file, 'utf8');
const list = (dir: string) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : [];

/** Все статьи обоих языков: путь к файлу и его текст. */
const bodies = () => {
  const out: { slug: string; locale: 'ru' | 'uz'; file: string; text: string }[] = [];
  for (const [dir, locale] of [
    [RU, 'ru'],
    [UZ, 'uz'],
  ] as const) {
    for (const name of list(dir)) {
      out.push({
        slug: name.replace(/\.md$/, ''),
        locale,
        file: path.join(dir, name),
        text: read(path.join(dir, name)),
      });
    }
  }
  return out;
};

const blocksOf = (text: string): HelpBlock[] => parseHelpMarkdown(text);

test('слаги статей уникальны', () => {
  const seen = new Set<string>();
  for (const a of HELP_ARTICLES) {
    assert.ok(!seen.has(a.slug), `слаг «${a.slug}» встречается дважды`);
    seen.add(a.slug);
  }
});

test('у каждой статьи описи есть русский текст', () => {
  for (const a of HELP_ARTICLES) {
    const file = path.join(RU, `${a.slug}.md`);
    assert.ok(fs.existsSync(file), `нет файла ${path.relative(HELP, file)}`);
    assert.ok(read(file).trim().length > 200, `текст ${a.slug}.md слишком короткий`);
  }
});

test('у каждой статьи описи есть узбекский текст', () => {
  // Откат на русский с пометкой из `content.ts` не убран: он понадобится
  // статье, которую заведут раньше перевода. Но заказчик требует, чтобы
  // пометки сейчас не было ни на одной статье, и это проверяется здесь, а не
  // глазами по 33 карточкам.
  const missing = HELP_ARTICLES.filter((a) => !fs.existsSync(path.join(UZ, `${a.slug}.md`))).map(
    (a) => a.slug,
  );
  assert.deepEqual(missing, [], `нет узбекского текста: ${missing.join(', ')}`);

  for (const a of HELP_ARTICLES) {
    const uz = read(path.join(UZ, `${a.slug}.md`));
    assert.ok(uz.trim().length > 200, `текст uz/${a.slug}.md слишком короткий`);
    // Перевод, совпавший с русским файлом слово в слово, — это не перевод, а
    // копия: статья пройдёт проверку наличия и покажет сотруднику русский текст
    // уже без пометки, то есть молча.
    assert.notEqual(
      uz.trim(),
      read(path.join(RU, `${a.slug}.md`)).trim(),
      `uz/${a.slug}.md дословно повторяет русский файл`,
    );
  }
});

test('в узбекских статьях нет кириллических букв', () => {
  // Узбекский текст пишется латиницей, и кириллическая буква внутри слова
  // («qaraб») с виду не отличается от латинской. Глазами такое не ловится,
  // а читатель получает слово, которого в языке нет.
  for (const a of HELP_ARTICLES) {
    const uz = read(path.join(UZ, `${a.slug}.md`));
    const found = uz
      .split('\n')
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => /[А-Яа-яЁё]/.test(line))
      .map(({ line, no }) => `uz/${a.slug}.md:${no}: ${line.trim()}`);
    assert.deepEqual(found, [], `кириллица в узбекском тексте:\n${found.join('\n')}`);
  }
});

test('лишних файлов статей нет — каждый файл есть в описи', () => {
  const known = new Set(HELP_ARTICLES.map((a) => a.slug));
  for (const b of bodies()) {
    assert.ok(known.has(b.slug), `файл ${b.locale}/${b.slug}.md не описан в articles.ts`);
  }
});

test('картинок в статьях нет — ни одной', () => {
  // Требование заказчика от 07.10: снимков экрана в справке нет. Разбор
  // картинок из `markdown.ts` убран вместе с ними, поэтому строка `![…](…)`
  // теперь не картинка, а обычный текст — и на экране она так и прочитается,
  // квадратными скобками. Эта проверка ловит её до сборки.
  //
  // Проверяем текст, а не блоки: разбор картинку больше не знает, и спросить у
  // него «есть ли тут снимок» нечем. Сторож нужен именно на источнике.
  const IMAGE = /!\[[^\]]*\]\([^)]*\)/;
  for (const b of bodies()) {
    for (const [n, line] of b.text.split('\n').entries()) {
      assert.ok(
        !IMAGE.test(line),
        `${b.locale}/${b.slug}.md:${n + 1} — картинка «${line.trim()}». ` +
          'Шаг описывается словами: путь по меню, название кнопки, что появится',
      );
    }
  }
});

test('каталога снимков нет', () => {
  // Он удалён вместе с картинками. Если каталог появится снова — значит кто-то
  // вернул снимки, и первая проверка про это промолчит, пока на них не
  // сошлётся статья.
  assert.ok(!fs.existsSync(SHOTS), `каталог ${path.relative(HELP, SHOTS)} снова существует`);
});

test('пункт меню и заголовок экрана справки называются одинаково', () => {
  // Статьи говорят «Справка в подвале левого меню», а подпись пункта меню брали
  // из ключа `nav.get_help`, который лежал в словаре со времён импорта фронта и
  // гласил «Помощь». Человек искал в меню то слово, которое прочитал в статье,
  // и не находил. Одна и та же вещь обязана называться одним словом во всех
  // трёх местах: словарь, заголовок экрана, текст статьи.
  const dict = read(path.resolve(HERE, '../src/context/AppContext.tsx'));
  const view = read(path.resolve(HERE, '../src/components/help/HelpView.tsx'));

  const header = view.match(/<h2[^>]*>\s*\{isUz \? '([^']+)' : '([^']+)'\}/);
  assert.ok(header, 'в HelpView.tsx не нашёлся заголовок экрана');
  const [, uzHeader, ruHeader] = header;

  const labels = [...dict.matchAll(/'nav\.get_help': '([^']+)'/g)].map((m) => m[1]);
  assert.equal(labels.length, 2, 'ожидались подписи пункта меню на двух языках');
  assert.deepEqual(
    labels,
    [ruHeader, uzHeader],
    `пункт меню — ${labels.join(' / ')}, заголовок экрана — ${ruHeader} / ${uzHeader}`,
  );
});

test('ссылки help: ведут на существующие статьи', () => {
  const known = new Set(HELP_ARTICLES.map((a) => a.slug));
  for (const b of bodies()) {
    for (const block of blocksOf(b.text)) {
      const inline =
        block.kind === 'list'
          ? block.items.flat()
          : block.kind === 'table'
            ? [...block.head, ...block.rows.flat()].flat()
            : 'inline' in block
              ? block.inline
              : [];
      for (const node of inline) {
        if (node.kind !== 'article') continue;
        assert.ok(known.has(node.slug), `${b.locale}/${b.slug}.md ссылается на help:${node.slug}`);
      }
    }
  }
});

test('статья не содержит заголовка первого уровня', () => {
  // Название статьи живёт в описи; второй его экземпляр в файле однажды
  // разойдётся с первым, и список покажет одно, а статья — другое.
  for (const b of bodies()) {
    for (const line of b.text.split('\n')) {
      assert.ok(!/^#\s/.test(line), `${b.locale}/${b.slug}.md: заголовок «${line.trim()}»`);
    }
  }
});

test('статья для сотрудника пошаговая — есть нумерованные шаги или таблица', () => {
  // Требование заказчика: «пошагово». Статья из одних абзацев его не
  // выполняет, и это видно без человека.
  for (const a of HELP_ARTICLES) {
    const blocks = blocksOf(read(path.join(RU, `${a.slug}.md`)));
    const stepwise = blocks.some(
      (b) => (b.kind === 'list' && b.ordered) || b.kind === 'table',
    );
    assert.ok(stepwise, `${a.slug}.md: ни одного шага по порядку и ни одной таблицы`);
  }
});

test('у каждого раздела системы есть хотя бы одна статья', () => {
  for (const topic of TOPIC_ORDER) {
    if (topic === 'help') continue; // сама справка объясняется в «Общем»
    assert.ok(
      HELP_ARTICLES.some((a) => a.topic === topic),
      `по разделу «${topic}» статей нет`,
    );
  }
});
