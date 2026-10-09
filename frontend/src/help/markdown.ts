/**
 * Разбор статей справки: markdown → блоки.
 *
 * Подмножество закрытое и маленькое, ровно под то, из чего состоит инструкция
 * сотруднику: заголовок, абзац, шаги по порядку, перечисление, предупреждение,
 * таблица, блок кода. Внутри строки — жирный, код, ссылка на другую статью и
 * внешняя ссылка.
 *
 * Картинок здесь нет намеренно (требование заказчика от 07.10). Разбор снимков
 * экрана убран вместе с самими снимками, а не оставлен без применения: ветка,
 * которой никто не пользуется, пережила бы удаление каталога `shots/` и
 * нарисовала бы на экране «снимок экрана не найден» на месте шага инструкции.
 * Теперь строка `![…](…)` — обычный текст, и её видно глазами; в содержимом
 * статей её запрещает `help-content.test.ts`. Шаг описывается словами: путь по
 * меню, точное название кнопки, название поля, что появится после нажатия.
 *
 * Почему не библиотека. Любой полноценный markdown пропускает сырой HTML из
 * текста статьи на страницу. Статьи пишем мы, но держать на экране
 * `dangerouslySetInnerHTML` ради жирного шрифта незачем: разбор отдаёт
 * дерево, React рисует его обычными узлами, и чего разбор не знает — остаётся
 * текстом. Проверено тестом `help-markdown.test.ts`.
 *
 * Заголовка первого уровня в статьях нет: название статьи живёт в описи
 * (`articles.ts`), и второй его экземпляр в файле однажды с ней разойдётся.
 */

export type HelpInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'article'; text: string; slug: string };

export type HelpBlock =
  | { kind: 'heading'; level: 2 | 3; inline: HelpInline[] }
  | { kind: 'paragraph'; inline: HelpInline[] }
  | { kind: 'list'; ordered: boolean; items: HelpInline[][] }
  | { kind: 'note'; inline: HelpInline[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; head: HelpInline[][]; rows: HelpInline[][][] };

/**
 * Разбор строки.
 *
 * Один проход по регулярному выражению со всеми видами сразу: разбирать
 * жирный, потом код, потом ссылки по очереди значит однажды найти `**` внутри
 * кода и разъехаться.
 *
 * Восклицательный знак перед ссылкой захвачен намеренно. `![alt](url)` — это
 * картинка; без этого захвата от неё осталась бы живая ссылка на файл, которого
 * в сборке нет. Такая строка целиком остаётся текстом, и её видно глазами.
 */
const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|(!?)\[([^\]]+)\]\(([^)]+)\)/g;

export const parseInline = (src: string): HelpInline[] => {
  const out: HelpInline[] = [];
  let last = 0;
  for (const m of src.matchAll(INLINE)) {
    const at = m.index;
    if (at > last) out.push({ kind: 'text', text: src.slice(last, at) });
    if (m[1] !== undefined) out.push({ kind: 'strong', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'code', text: m[2] });
    else if (m[3] === '!') out.push({ kind: 'text', text: m[0] });
    else if (m[4] !== undefined && m[5] !== undefined) {
      const href = m[5];
      if (href.startsWith('help:')) {
        out.push({ kind: 'article', text: m[4], slug: href.slice('help:'.length) });
      } else {
        out.push({ kind: 'link', text: m[4], href });
      }
    }
    last = at + m[0].length;
  }
  if (last < src.length) out.push({ kind: 'text', text: src.slice(last) });
  return out;
};

/** Ячейки строки таблицы: `| a | b |` без крайних разделителей. */
const cells = (line: string) =>
  line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());

const isTableLine = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableRule = (line: string) => /^\s*\|[\s|:-]+\|\s*$/.test(line);

export const parseHelpMarkdown = (src: string): HelpBlock[] => {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: HelpBlock[] = [];
  let i = 0;

  /** Строки одного абзаца склеиваются пробелом: перенос в файле — не перенос на экране. */
  const flow = (buf: string[]) => parseInline(buf.join(' ').trim());

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Блок кода: внутри ничего не разбираем, иначе адрес с `**` поедет жирным.
    if (line.trim().startsWith('```')) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      out.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    const heading = line.match(/^(##|###)\s+(.*)$/);
    if (heading) {
      out.push({
        kind: 'heading',
        level: heading[1] === '##' ? 2 : 3,
        inline: parseInline(heading[2]!.trim()),
      });
      i += 1;
      continue;
    }

    if (line.trimStart().startsWith('> ') || line.trim() === '>') {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith('>')) {
        body.push(lines[i]!.trimStart().replace(/^>\s?/, ''));
        i += 1;
      }
      out.push({ kind: 'note', inline: flow(body) });
      continue;
    }

    const bullet = /^\s*([-*]|\d+[.)])\s+(.*)$/;
    const first = line.match(bullet);
    if (first) {
      const ordered = /\d/.test(first[1]!);
      const items: HelpInline[][] = [];
      let cur: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(bullet);
        if (m) {
          if (cur.length) items.push(flow(cur));
          cur = [m[2]!];
          i += 1;
          continue;
        }
        // Продолжение пункта: строка с отступом и без своего маркера.
        if (lines[i]!.trim() !== '' && /^\s+\S/.test(lines[i]!)) {
          cur.push(lines[i]!.trim());
          i += 1;
          continue;
        }
        break;
      }
      if (cur.length) items.push(flow(cur));
      out.push({ kind: 'list', ordered, items });
      continue;
    }

    if (isTableLine(line) && i + 1 < lines.length && isTableRule(lines[i + 1]!)) {
      const head = cells(line).map(parseInline);
      i += 2;
      const rows: HelpInline[][][] = [];
      while (i < lines.length && isTableLine(lines[i]!)) {
        rows.push(cells(lines[i]!).map(parseInline));
        i += 1;
      }
      out.push({ kind: 'table', head, rows });
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !lines[i]!.match(/^(##|###)\s/) &&
      !lines[i]!.match(bullet) &&
      !lines[i]!.trimStart().startsWith('>') &&
      !lines[i]!.trim().startsWith('```') &&
      !isTableLine(lines[i]!)
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    out.push({ kind: 'paragraph', inline: flow(para) });
  }

  return out;
};

const inlineText = (inline: HelpInline[]) => inline.map((i) => i.text).join('');

/** Текст блока без разметки — для поиска по статьям и для проверок. */
export const plainText = (block: HelpBlock): string => {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
    case 'note':
      return inlineText(block.inline);
    case 'list':
      return block.items.map(inlineText).join(' ');
    case 'code':
      return block.text;
    case 'table':
      return [block.head, ...block.rows].map((r) => r.map(inlineText).join(' ')).join(' ');
  }
};

/** Вся статья одной строкой: по ней ищет поле поиска в «Справке». */
export const articleText = (src: string): string =>
  parseHelpMarkdown(src).map(plainText).join(' ');
