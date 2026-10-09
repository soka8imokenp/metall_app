/**
 * Экран «Копии базы»: решения, которые на нём ломаются молча.
 *
 * Проверяется не разметка, а то, что она спрашивает: кому показывать раздел,
 * у какой строки есть файл и сколько времени система стоит без копии. Разметку
 * на 360 и 1440 в обеих темах смотрит живой прогон `qa/admin-live`; здесь — то,
 * что браузер не покажет: вчерашняя копия вместо позавчерашней, неудачная
 * попытка сверху списка, право, уехавшее у человека.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_PERMISSIONS,
  FRESH_HOURS,
  backupHealth,
  canDownload,
  durationText,
  healthText,
  keepText,
  mayManageBackups,
  sourceLabel,
  starterLabel,
  statusLabel,
} from '../src/lib/backups.ts';
import type { BackupRow, BackupSettings } from '../src/types/api.ts';

const SETTINGS: BackupSettings = {
  dir: '/srv/metall-asia/backups',
  at: '03:20',
  keep: 30,
  scheduler: true,
};

const NOW = new Date('2026-10-07T12:00:00+05:00');
const hoursBefore = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const row = (over: Partial<BackupRow> = {}): BackupRow => ({
  uid: '0199c2a0-0000-7000-8000-000000000001',
  status: 'ok',
  source: 'schedule',
  startedAt: hoursBefore(9),
  finishedAt: hoursBefore(9),
  durationMs: 18_400,
  fileName: 'metall-asia-20261007-032000.dump',
  sizeBytes: 2 * 1024 * 1024,
  sha256: 'a'.repeat(64),
  error: null,
  starterName: null,
  onDisk: true,
  ...over,
});

test('экран копий открыт только праву на «Настройки»', () => {
  assert.deepEqual([...BACKUP_PERMISSIONS], ['admin.users']);

  assert.equal(mayManageBackups(['admin.users', 'admin.roles']), true);
  // Роли без «Настроек» — а это все остальные, включая директора с 06.10.
  assert.equal(mayManageBackups(['finance.view', 'finance.post']), false);
  assert.equal(mayManageBackups(['warehouse.view', 'warehouse.move']), false);
  assert.equal(mayManageBackups([]), false);
  // Сессии ещё нет или права уехали: экран закрыт, а не падает.
  assert.equal(mayManageBackups(undefined), false);
});

test('право на роли само копий не открывает', () => {
  // `admin.roles` правит матрицу прав, но не даёт выгрузить всю базу одним
  // файлом. Если однажды решат открыть копии и этому праву, это должно быть
  // сознательной правкой списка, а не побочным действием `.some()`.
  assert.equal(mayManageBackups(['admin.roles']), false);
});

test('скачать можно только удачную копию, у которой файл на диске', () => {
  assert.equal(canDownload(row()), true);
  // Ротация унесла файл, запись осталась.
  assert.equal(canDownload(row({ onDisk: false })), false);
  assert.equal(canDownload(row({ status: 'failed', error: 'pg_dump вышел с кодом 1' })), false);
  assert.equal(canDownload(row({ status: 'running', sizeBytes: null, sha256: null })), false);
  // Самый опасный случай: копия упала, а файл-обрубок на диске остался.
  assert.equal(canDownload(row({ status: 'failed', onDisk: true })), false);
});

test('свежесть считается по последней удачной копии, а не по первой строке', () => {
  // Сверху списка — сегодняшняя неудача, удачная копия ниже и свежая.
  const health = backupHealth(
    [
      row({ uid: 'f', status: 'failed', startedAt: hoursBefore(1), error: 'нет места на диске' }),
      row({ uid: 'o', startedAt: hoursBefore(9) }),
    ],
    NOW,
  );
  assert.deepEqual(health, { level: 'ok', hoursAgo: 9 });
});

test('копий нет вовсе — это отдельное состояние, а не «старая копия»', () => {
  assert.deepEqual(backupHealth([], NOW), { level: 'none' });
  assert.deepEqual(
    backupHealth([row({ status: 'failed', error: 'пусто' }), row({ status: 'running' })], NOW),
    { level: 'none' },
  );

  const text = healthText({ level: 'none' }, SETTINGS, false);
  assert.match(text, /нет ни одной/);
  // Человеку сказано, что делать, а не только что всё плохо.
  assert.match(text, /Сделать копию сейчас/);
});

test('ночная копия не считается просроченной к следующему вечеру', () => {
  // Порог записан здесь числом, а не взят из `FRESH_HOURS`: тест, который
  // берёт порог у проверяемого кода, уезжает вместе с ним и не замечает ни
  // суток, ни недели. Проверено сломом — с `FRESH_HOURS = 24` он оставался
  // зелёным, пока числа не стали своими.
  assert.equal(FRESH_HOURS, 30, 'порог свежести сменили — это сознательное решение, а не опечатка');

  // Копия в 03:20, человек смотрит экран в 23:00 того же дня — это 20 ч, и
  // тревоги быть не должно. Порог в сутки красил бы экран каждый вечер.
  assert.equal(backupHealth([row({ startedAt: hoursBefore(20) })], NOW).level, 'ok');
  assert.equal(backupHealth([row({ startedAt: hoursBefore(26) })], NOW).level, 'ok');
  assert.equal(backupHealth([row({ startedAt: hoursBefore(30) })], NOW).level, 'ok');
  // Две ночи подряд без копии — уже тревога.
  assert.equal(backupHealth([row({ startedAt: hoursBefore(31) })], NOW).level, 'stale');
  assert.equal(backupHealth([row({ startedAt: hoursBefore(48) })], NOW).level, 'stale');
});

test('просроченная копия названа числом часов и временем расписания', () => {
  const health = backupHealth([row({ startedAt: hoursBefore(70) })], NOW);
  assert.deepEqual(health, { level: 'stale', hoursAgo: 70 });
  const text = healthText(health, SETTINGS, false);
  assert.match(text, /70 ч назад/);
  assert.match(text, /03:20/);
});

test('выключенное расписание — не тревога и не «служба была выключена»', () => {
  // Уточнение Отабека от 07.10: расписание — переключатель. На сервере
  // заказчика оно включено само, на стенде выключено `BACKUP_SCHEDULER=off`.
  // Экран стенда при этом не должен объяснять отсутствие ночных копий словами
  // «служба была выключена или копия падала»: выключили её сознательно, и
  // администратор, прочитав тревогу, пойдёт искать поломку, которой нет.
  const OFF: BackupSettings = { ...SETTINGS, scheduler: false, keep: 1 };

  const old = backupHealth([row({ startedAt: hoursBefore(70) })], NOW, false);
  assert.deepEqual(old, { level: 'off', hoursAgo: 70 });
  const text = healthText(old, OFF, false);
  assert.match(text, /Расписание выключено/);
  assert.match(text, /70 ч назад/);
  assert.doesNotMatch(text, /падала|это много/);

  // Копий нет и расписания нет — «не ждите ночи» здесь тоже неправда: ночью
  // ничего не произойдёт.
  const empty = backupHealth([], NOW, false);
  assert.deepEqual(empty, { level: 'off', hoursAgo: null });
  const emptyText = healthText(empty, OFF, false);
  assert.match(emptyText, /Расписание выключено/);
  assert.match(emptyText, /кнопк/);
  assert.doesNotMatch(emptyText, /ночи/);

  // Включённое расписание (сервер заказчика) считается как раньше.
  assert.equal(backupHealth([row({ startedAt: hoursBefore(70) })], NOW, true).level, 'stale');
  assert.equal(backupHealth([row({ startedAt: hoursBefore(70) })], NOW).level, 'stale');
});

test('сколько копий храним — по-русски, а не «1 последних копий»', () => {
  // Увидено на живом стенде после BACKUP_KEEP=1: число пришло из переменной,
  // а подпись была написана под множественное число. Заказчик читает этот
  // экран, и «1 последних копий» выглядит как недоделка, а не как настройка.
  assert.equal(keepText(1, false), '1 последнюю копию');
  assert.equal(keepText(2, false), '2 последние копии');
  assert.equal(keepText(4, false), '4 последние копии');
  assert.equal(keepText(5, false), '5 последних копий');
  assert.equal(keepText(30, false), '30 последних копий');
  // 11–14 — исключение из правила «кончается на 2–4».
  assert.equal(keepText(11, false), '11 последних копий');
  assert.equal(keepText(12, false), '12 последних копий');
  assert.equal(keepText(21, false), '21 последнюю копию');
  assert.equal(keepText(22, false), '22 последние копии');
  assert.equal(keepText(101, false), '101 последнюю копию');
  // В узбекском число множественное не меняет: счётное слово уже стоит.
  assert.equal(keepText(1, true), '1 ta oxirgi nusxa');
  assert.equal(keepText(30, true), '30 ta oxirgi nusxa');
});

test('подписи строки на двух языках и без кодов состояния', () => {
  for (const [status, ru, uz] of [
    ['ok', 'готова', 'tayyor'],
    ['failed', 'не вышла', 'yiqildi'],
    ['running', 'делается', 'olinmoqda'],
  ] as const) {
    assert.equal(statusLabel(row({ status }), false), ru);
    assert.equal(statusLabel(row({ status }), true), uz);
  }
  assert.equal(sourceLabel(row({ source: 'schedule' }), false), 'по расписанию');
  assert.equal(sourceLabel(row({ source: 'manual' }), false), 'вручную');

  // Ночную копию не запускает никто, и выдумывать ей имя нельзя; у ручной имя
  // есть всегда — его подставляет сервер из учётки нажавшего.
  assert.equal(starterLabel(row({ source: 'schedule' }), false), 'система');
  assert.equal(starterLabel(row({ source: 'manual', starterName: 'Пулатов А.' }), false), 'Пулатов А.');
  assert.equal(starterLabel(row({ source: 'manual' }), false), '—');
});

test('длительность читается человеком, а не в миллисекундах', () => {
  assert.equal(durationText(null, false), '—');
  // Копия базы стенда идёт двести миллисекунд. Округление до секунд писало
  // «0 с» — а это читается как «ничего не произошло», и администратор ищет
  // ошибку там, где всё хорошо. Увидено на живом стенде, прогон admin-live.
  assert.equal(durationText(204, false), 'меньше секунды');
  assert.equal(durationText(204, true), 'bir soniyadan kam');
  assert.equal(durationText(999, false), 'меньше секунды');
  assert.equal(durationText(1_000, false), '1 с');
  assert.equal(durationText(18_400, false), '18 с');
  assert.equal(durationText(95_000, false), '1 мин 35 с');
  assert.equal(durationText(95_000, true), '1 min 35 s');
});

test('все подписи экрана переведены — ни одна не осталась по-русски в uz', () => {
  // Узбекский интерфейс обязателен по Спецификации, и пропущенная подпись
  // выглядит как опечатка, а не как недоделка: её не замечают.
  const texts = [
    statusLabel(row({ status: 'ok' }), true),
    statusLabel(row({ status: 'failed' }), true),
    statusLabel(row({ status: 'running' }), true),
    sourceLabel(row({ source: 'schedule' }), true),
    sourceLabel(row({ source: 'manual' }), true),
    starterLabel(row({ source: 'schedule' }), true),
    durationText(95_000, true),
    healthText({ level: 'none' }, SETTINGS, true),
    healthText({ level: 'ok', hoursAgo: 9 }, SETTINGS, true),
    healthText({ level: 'stale', hoursAgo: 70 }, SETTINGS, true),
    healthText({ level: 'off', hoursAgo: null }, { ...SETTINGS, scheduler: false }, true),
    healthText({ level: 'off', hoursAgo: 70 }, { ...SETTINGS, scheduler: false }, true),
  ];
  for (const t of texts) {
    assert.ok(!/[А-Яа-яЁё]/.test(t), `кириллица в узбекской подписи: ${t}`);
  }
});
