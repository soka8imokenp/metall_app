/**
 * Учётки стенда: вход по ролям (требование Отабека от 06.10).
 *
 * До 06.10 здесь держалось обратное правило: `admin` и `user` с одинаковыми
 * правами, «разделение ролей делаем в конце проекта». Конец наступил — тем же
 * сообщением заказчик снял запрет и попросил вход по ролям. Учётка `user`
 * убрана: вход «клиент видит всё» перестал быть нужен, как только у каждой
 * роли появился свой.
 *
 * Правило стенда теперь одно и целиком проверяемое:
 *
 * - у каждой системной роли есть хотя бы одна демо-учётка;
 * - логин — название роли, набирается с клавиатуры и диктуется голосом;
 * - пароль — `<логин>123`, он **дефолтный**;
 * - у всех поднят признак «пароль временный»: дефолтный пароль открыт всем,
 *   кому называли логин, и пускать по нему дальше первого экрана нельзя.
 *
 * Проверяются свойства, а не список: новая роль без своей учётки, учётка со
 * случайным паролем или забытый признак валят тест.
 */
import { describe, expect, it } from 'vitest';
import { defaultPasswordFor } from '../src/common/default-password.js';
import { roleDefs } from '../prisma/rbac.js';
import { profiles } from '../prisma/seed-profiles.js';

const demo = profiles.demo;

const user = (login: string) => {
  const found = demo.users.find((u) => u.login === login);
  expect(found, `учётка «${login}» в демо-профиле`).toBeDefined();
  return found!;
};

/** Логин → роль → компании: та самая таблица, которую называют заказчику. */
const EXPECTED: { login: string; role: string; companies: ('trade' | 'plant')[] }[] = [
  { login: 'admin', role: 'admin', companies: ['trade', 'plant'] },
  { login: 'owner1', role: 'owner', companies: ['trade', 'plant'] },
  { login: 'owner2', role: 'owner', companies: ['plant'] },
  { login: 'director', role: 'director', companies: ['trade', 'plant'] },
  { login: 'finance', role: 'accountant', companies: ['trade', 'plant'] },
  { login: 'sales', role: 'sales_manager', companies: ['trade', 'plant'] },
  { login: 'warehouse', role: 'warehouse_keeper', companies: ['trade', 'plant'] },
  { login: 'master', role: 'production_master', companies: ['plant'] },
  { login: 'worker', role: 'production_worker', companies: ['plant'] },
];

describe('учётки демо-стенда', () => {
  it('ровно девять и ровно те, что названы заказчику', () => {
    expect(demo.users.map((u) => u.login).sort()).toEqual(EXPECTED.map((e) => e.login).sort());
  });

  it('каждая на своей роли и в своих компаниях', () => {
    for (const e of EXPECTED) {
      expect(user(e.login).role, `роль учётки «${e.login}»`).toBe(e.role);
      expect(user(e.login).companies, `компании учётки «${e.login}»`).toEqual(e.companies);
    }
  });

  it('учётки user больше нет: вход «клиент видит всё» заменён входом по ролям', () => {
    expect(demo.users.map((u) => u.login)).not.toContain('user');
  });

  it('собственников двое, роль одна, разделяет их список компаний', () => {
    // Поправка заказчика от 06.10: owner1 и owner2 — люди, роль у обоих одна.
    // owner1 — «более крутой аккаунт», ему открыты оба бизнеса; owner2 видит
    // только завод. Разделяет их назначение компаний, а не набор прав, поэтому
    // второй роли и отдельной ветки в коде под это не заводится.
    const owners = demo.users.filter((u) => u.role === 'owner');
    expect(owners.length).toBe(2);
    expect([...user('owner1').companies].sort(), 'owner1 видит оба бизнеса').toEqual([
      'plant',
      'trade',
    ]);
    expect(user('owner2').companies, 'owner2 — только завод').toEqual(['plant']);
  });

  it('у каждой системной роли есть своя демо-учётка', () => {
    for (const role of roleDefs) {
      const own = demo.users.filter((u) => u.role === role.code);
      expect(own.length, `нет демо-учётки для роли «${role.code}»`).toBeGreaterThan(0);
    }
  });

  it('пароль у всех — дефолтный образец «роль+123», без исключений', () => {
    for (const u of demo.users) {
      expect(u.password, `пароль учётки «${u.login}»`).toBe(defaultPasswordFor(u.login));
    }
  });

  // Заказчик 06.10 назвал образец пальцем: «admin — admin123, owner1 —
  // owner123, owner2 — owner123». Правило проверяется и само по себе, но без
  // этих трёх строк «роль+123» снова можно прочесть как «логин+123»: разница
  // видна только на двух собственниках.
  it('у двух собственников дефолтный пароль один — по роли, а не по логину', () => {
    const by = (login: string) => demo.users.find((u) => u.login === login);
    expect(by('admin')?.password).toBe('admin123');
    expect(by('owner1')?.password).toBe('owner123');
    expect(by('owner2')?.password).toBe('owner123');
  });

  it('у всех поднят признак «пароль временный»', () => {
    // Дефолтный пароль знает каждый, кому назвали логин. Без признака такой
    // вход открывает систему целиком, а не одно окно смены пароля.
    for (const u of demo.users) {
      expect(u.mustChangePassword, `признак у «${u.login}»`).toBe(true);
    }
  });

  it('логин набирают с клавиатуры: только строчная латиница, цифры и подчёркивание', () => {
    for (const u of demo.users) {
      expect(u.login, `логин «${u.login}»`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('администратор по-прежнему имеет все права системы, без изъятий', () => {
    const role = roleDefs.find((r) => r.code === 'admin')!;
    const all = roleDefs.flatMap((r) => r.perms);
    expect([...role.perms].sort()).toEqual([...new Set(all)].sort());
  });
});
