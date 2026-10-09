/**
 * Демо-профиль сида не содержит данных заказчика.
 *
 * Стенд на нашем домене — это наша инфраструктура, а по договору данные
 * METALL ASIA живут на сервере заказчика в Узбекистане. Значит наружу уезжает
 * отдельный набор данных, и единственный способ удержать это правило — не
 * глазами, а проверкой: один невнимательный `git cherry-pick` возвращает в
 * демо реальные ИНН и телефоны, и снаружи этого никто не заметит.
 *
 * Проверяются свойства, а не конкретные строки: переименование справочника
 * проверку не обойдёт.
 */
import { describe, expect, it } from 'vitest';
import { profiles, type SeedProfile } from '../prisma/seed-profiles.js';

const dev = profiles.dev;
const demo = profiles.demo;

/**
 * Сколько первых индексов проверяем у генерируемых полей. В сиде контактов
 * столько же, сколько контрагентов, а заявок 34 — берём с запасом.
 */
const ROWS = 40;
const each = <T>(fn: (i: number) => T) => Array.from({ length: ROWS }, (_, i) => fn(i));

/** Все опознавательные строки профиля: по ним человека или фирму находят. */
function identifiers(p: SeedProfile) {
  return {
    inns: [...p.companies.map((c) => c.inn), ...p.partners.map((x) => x.inn)],
    names: [
      ...p.companies.flatMap((c) => [c.nameRu, c.nameUz]),
      ...p.partners.flatMap((x) => [x.nameRu, x.nameUz]),
      ...p.leadNames,
    ],
    // Контактные лица рабочего профиля берутся из списка по жребию, и на
    // индексе имя пустое. Сравнивать имеет смысл только непустые.
    people: [...p.users.map((u) => u.fullName), ...each(p.contactName)].filter(Boolean),
    emails: [...p.users.map((u) => u.email), ...each(p.contactEmail), ...each(p.leadEmail)],
    phones: [...p.users.map((u) => u.phone), ...each(p.contactPhone), ...each(p.leadPhone)],
    banks: p.companies.map((c) => JSON.stringify(c.bankDetails)),
    addresses: [
      ...p.companies.map((c) => c.legalAddress),
      ...p.partners.map((x) => x.legalAddress),
    ],
  };
}

describe('демо-профиль сида', () => {
  it('не пересекается с рабочим ни одним идентификатором', () => {
    const a = identifiers(dev);
    const b = identifiers(demo);
    for (const key of Object.keys(a) as (keyof typeof a)[]) {
      const shared = b[key].filter((v) => a[key].includes(v));
      expect(shared, `общее в «${key}»`).toEqual([]);
    }
  });

  it('использует ИНН, которых не бывает в реестре', () => {
    // ИНН Узбекистана — девять цифр, и ведущего нуля в них не бывает.
    // Нулевой префикс делает номер заведомо несуществующим.
    for (const inn of identifiers(demo).inns) {
      expect(inn, `ИНН ${inn}`).toMatch(/^0\d{8}$/);
    }
  });

  it('использует почту в зарезервированном домене', () => {
    // RFC 2606: .invalid и .example не делегируются никогда, письмо с такого
    // стенда не уйдёт живому человеку даже при ошибке в рассылке.
    for (const email of identifiers(demo).emails) {
      expect(email, email).toMatch(/@[\w.-]+\.(invalid|example)$/);
    }
  });

  it('использует телефоны вне выделенной нумерации', () => {
    // Код оператора в Узбекистане нулём не начинается.
    for (const phone of identifiers(demo).phones) {
      expect(phone, phone).toMatch(/^\+99800\d{7}$/);
    }
  });

  it('выдаёт каждому прогону свой пароль и не читает SEED_PASSWORD', () => {
    process.env.SEED_PASSWORD = 'metall-dev-2026';
    try {
      const first = demo.password();
      const second = demo.password();
      expect(first).not.toBe(second);
      expect(first).not.toBe('metall-dev-2026');
      expect(first.length).toBeGreaterThanOrEqual(16);
    } finally {
      delete process.env.SEED_PASSWORD;
    }
  });

  it('рабочий профиль по-прежнему берёт пароль из окружения', () => {
    process.env.SEED_PASSWORD = 'проверочный-пароль';
    try {
      expect(dev.password()).toBe('проверочный-пароль');
    } finally {
      delete process.env.SEED_PASSWORD;
    }
  });

  it('ссылается только на своих пользователей', () => {
    // Менеджер контрагента и функциональные ключи — логины из того же профиля.
    // Разъедутся профили — сид упадёт на undefined уже после вставки половины
    // данных, а это час на выяснение вместо секунды.
    for (const p of [dev, demo]) {
      const logins = new Set(p.users.map((u) => u.login));
      for (const partner of p.partners) {
        if (partner.manager === null) continue;
        expect(logins.has(partner.manager), `${p.name}: ${partner.manager}`).toBe(true);
      }
      for (const [key, login] of Object.entries(p.logins)) {
        expect(logins.has(login), `${p.name}: ключ ${key} → ${login}`).toBe(true);
      }
    }
  });

  it('покрывает функциональными ключами все роли обоих профилей', () => {
    // Набор ключей одинаков, иначе сид в одном профиле расставит
    // ответственных, а в другом промолчит.
    expect(Object.keys(demo.logins).sort()).toEqual(Object.keys(dev.logins).sort());
    for (const p of [dev, demo]) {
      const byLogin = new Map(p.users.map((u) => [u.login, u.role]));
      expect(byLogin.get(p.logins.director), `${p.name}: директор`).toBe('director');
      expect(byLogin.get(p.logins.warehouse), `${p.name}: кладовщик`).toBe('warehouse_keeper');
      expect(byLogin.get(p.logins.accountant), `${p.name}: бухгалтер`).toBe('accountant');
      expect(byLogin.get(p.logins.master), `${p.name}: мастер`).toBe('production_master');
    }
  });

  it('называет себя демонстрационным на каждом экране', () => {
    // Компания подписана в шапке и в каждом документе. Если данные ненастоящие,
    // это должно быть видно без объяснений, а не только из переписки.
    for (const c of demo.companies) {
      expect(c.nameRu.toLowerCase()).toContain('демо');
      expect(c.nameUz.toLowerCase()).toContain('demo');
    }
  });
});
