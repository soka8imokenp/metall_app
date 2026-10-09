/**
 * Кому какие статьи «Справки» видны.
 *
 * Требование заказчика: сотрудник видит статьи своих разделов, а статьи
 * администратора (учётки, ключи обмена, бэкап, выкатка) — только те роли, у
 * кого есть право на «Настройки». Проверка идёт на правах, а не на названиях
 * ролей: права роли живут в `backend/prisma/rbac.ts` и меняются там.
 *
 * Запуск: cd dev/frontend && npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HELP_ARTICLES } from '../src/help/articles.ts';
import { visibleArticles, articleVisible, matchArticles } from '../src/help/access.ts';

/** Права ролей — те же наборы, что в `backend/prisma/rbac.ts`. */
const PERMS = {
  sales_manager: [
    'dashboard.view',
    'sales.view',
    'sales.edit',
    'crm.view',
    'crm.edit',
    'warehouse.view',
    'documents.view',
    'documents.edit',
  ],
  warehouse_keeper: [
    'dashboard.view',
    'warehouse.view',
    'warehouse.move',
    'warehouse.writeoff',
    'warehouse.inventory',
    'sales.view',
    'production.view',
  ],
  production_worker: ['dashboard.view', 'production.view', 'production.work'],
  accountant: [
    'dashboard.view',
    'finance.view',
    'finance.post',
    'documents.view',
    'documents.edit',
    'documents.approve',
    'sales.view',
  ],
  admin: ['dashboard.view', 'admin.users', 'admin.roles', 'finance.view'],
  /** Директор: всё, кроме `admin.*` — «Настроек» у него нет (решение 06.10). */
  director: ['dashboard.view', 'sales.view', 'warehouse.view', 'production.view', 'finance.view'],
};

const canOf = (role: keyof typeof PERMS) => (p: string) => PERMS[role].includes(p);

const slugs = (role: keyof typeof PERMS) => visibleArticles(canOf(role)).map((a) => a.slug);

test('общие статьи видны любой вошедшей роли', () => {
  for (const role of Object.keys(PERMS) as (keyof typeof PERMS)[]) {
    const mine = slugs(role);
    for (const slug of ['vhod', 'smena-parolya', 'rabochee-mesto', 'telegram']) {
      assert.ok(mine.includes(slug), `${role} не видит общую статью ${slug}`);
    }
  }
});

test('рабочий цеха видит производство и не видит склад, финансы, продажи', () => {
  const mine = slugs('production_worker');
  assert.ok(mine.includes('proizvodstvo-zadanie'));
  assert.ok(mine.includes('proizvodstvo-etapy'));
  assert.ok(!mine.includes('sklad-prihod'), 'рабочему цеха открылся склад');
  assert.ok(!mine.includes('finansy-operatsiya'), 'рабочему цеха открылись финансы');
  assert.ok(!mine.includes('prodazhi-zakaz'), 'рабочему цеха открылись продажи');
});

test('кладовщик видит склад и продажи, но не CRM и не финансы', () => {
  const mine = slugs('warehouse_keeper');
  assert.ok(mine.includes('sklad-inventarizatsiya'));
  assert.ok(mine.includes('prodazhi-zakaz'), 'у кладовщика есть sales.view — статья должна быть');
  assert.ok(!mine.includes('crm-zayavka'));
  assert.ok(!mine.includes('finansy-otchety'));
});

test('бухгалтер видит финансы и документы, но не склад', () => {
  const mine = slugs('accountant');
  assert.ok(mine.includes('finansy-operatsiya'));
  assert.ok(mine.includes('dokumenty-marshrut'));
  assert.ok(!mine.includes('sklad-prihod'));
});

test('статьи администратора — только роли с правом на «Настройки»', () => {
  const adminSlugs = HELP_ARTICLES.filter((a) => a.audience === 'admin').map((a) => a.slug);
  assert.ok(adminSlugs.length >= 7, 'статей администратора должно быть не меньше семи');

  const mine = slugs('admin');
  for (const slug of adminSlugs) {
    assert.ok(mine.includes(slug), `администратор не видит ${slug}`);
  }

  // Директор правами на «Настройки» не обладает с 06.10 — и статей не видит.
  for (const role of ['director', 'sales_manager', 'warehouse_keeper', 'accountant'] as const) {
    const theirs = slugs(role);
    for (const slug of adminSlugs) {
      assert.ok(!theirs.includes(slug), `${role} видит статью администратора ${slug}`);
    }
  }
});

test('одного права на роли довольно: администрирование открывают два права', () => {
  const onlyRoles = (p: string) => p === 'admin.roles';
  const admin = HELP_ARTICLES.find((a) => a.audience === 'admin')!;
  assert.equal(articleVisible(admin, onlyRoles), true);
});

test('поиск требует все слова и не различает ё', () => {
  const items = [
    { article: HELP_ARTICLES[0]!, haystack: 'приход на склад партия количество' },
    { article: HELP_ARTICLES[1]!, haystack: 'учёт расхождений инвентаризации' },
  ];
  assert.equal(matchArticles(items, 'приход склад').length, 1);
  assert.equal(matchArticles(items, 'склад приход').length, 1, 'порядок слов не должен решать');
  assert.equal(matchArticles(items, 'учет').length, 1, '«учет» обязан находить «учёт»');
  assert.equal(matchArticles(items, 'приход финансы').length, 0, 'найдено по одному слову из двух');
  assert.equal(matchArticles(items, '   ').length, 2, 'пустой запрос ничего не отсеивает');
});
