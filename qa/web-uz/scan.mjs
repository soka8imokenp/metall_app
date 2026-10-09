/**
 * Список работ по переводу: русские литералы в экранах, рядом с которыми нет
 * выбора языка. Это помощник для правки, а не приёмка — приёмку делает
 * qa/web-uz/run.mjs по отрисованному экрану.
 *
 * Помощник нарочно грубый: он смотрит на соседние строки, а не разбирает
 * дерево (в TypeScript 7 разбора из коробки больше нет). Поэтому его выводу
 * нельзя верить как приговору — только как списку мест, куда посмотреть.
 *
 * Почему с окном в три строки: половина русских строк в экранах — законная
 * русская ветка `isUz ? '…' : '…'`, и она часто разбита переносом.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../frontend/src', import.meta.url).pathname;
const CYR = /[А-Яа-яЁё]/;
const LANG = /isUz|locale\s*===|\buz\s*:|\bru\s*:|\bt\(/;
/**
 * Рядом лежит латинская строка — значит это пара «русский, узбекский».
 * Так записаны списки видов и статусов: `['fifo', 'FIFO по партиям',
 * 'Partiyalar bo‘yicha FIFO', …]`. Без этого такой список попадает в работу
 * целиком, хотя переведён.
 */
const LATIN = /'[A-Za-z][^']{3,}'|`[A-Za-z][^`]{3,}`/;

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Убираем комментарии: русский в них переводить не надо. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));
}

/**
 * Строки внутри словаря `ru: { … }` (у него рядом есть `uz: { … }`) переведены —
 * помечаем их по вложенности фигурных скобок, иначе такой экран попадает
 * в список целиком.
 */
function dictLines(lines) {
  const inDict = new Set();
  let depth = 0;
  let open = null;
  lines.forEach((line, i) => {
    if (open !== null) inDict.add(i);
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (open !== null && depth < open) open = null;
      }
    }
    if (open === null && /\b(ru|uz)\s*:\s*\{\s*$/.test(line)) {
      open = depth - 1;
      inDict.add(i);
    }
  });
  return inDict;
}

const report = [];
for (const file of files(ROOT)) {
  const raw = readFileSync(file, 'utf8');
  const lines = stripComments(raw).split('\n');
  const dict = dictLines(lines);
  const hits = [];
  lines.forEach((line, i) => {
    if (!CYR.test(line)) return;
    if (dict.has(i)) return;
    const window = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
    if (LANG.test(window) || LATIN.test(window)) return;
    hits.push({ line: i + 1, text: line.trim().slice(0, 140) });
  });
  if (hits.length) report.push({ file: relative(ROOT, file), hits });
}

report.sort((a, b) => b.hits.length - a.hits.length);
let total = 0;
for (const r of report) {
  total += r.hits.length;
  console.log(`${String(r.hits.length).padStart(4)}  ${r.file}`);
}
console.log(`\nстрок с русским без выбора языка: ${total} в ${report.length} файлах`);

const only = process.env.LIST;
if (only) {
  for (const r of report) {
    if (only !== '1' && !r.file.includes(only)) continue;
    console.log(`\n--- ${r.file}`);
    for (const h of r.hits) console.log(`${h.line}: ${h.text}`);
  }
}

/**
 * Второй сторож: название справочника взято напрямую, без запаса.
 *
 * `isUz ? x.nameUz : x.nameRu` показывает пустоту там, где узбекского названия
 * у записи нет, — а завести запись без него человек может. Общий `refName`
 * в таком случае откатывается на русское: лучше чужой язык, чем пустая клетка.
 * Поэтому прямая пара в разметке — находка, а не вкусовщина.
 */
const DIRECT = /isUz\s*\?\s*([A-Za-z_$][\w$.]*)\.nameUz\s*:\s*\1\.nameRu/g;
const direct = [];
for (const file of files(ROOT)) {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    DIRECT.lastIndex = 0;
    if (DIRECT.test(line)) direct.push({ file: relative(ROOT, file), line: i + 1, text: line.trim().slice(0, 120) });
  });
}
console.log(`\nназвание справочника без запаса на русское: ${direct.length}`);
if (direct.length && only) {
  for (const d of direct) console.log(`  ${d.file}:${d.line}  ${d.text}`);
}
if (direct.length) {
  console.log('Чинится заменой на refName(x, isUz) из lib/formatters.');
  process.exitCode = 1;
}
