/**
 * Состав прав системных ролей (ТЗ 3.3).
 *
 * Проверяются свойства роли, а не её список прав строка в строку: список
 * меняется каждый раз, когда в системе появляется новая возможность, и тест,
 * переписанный под каждое право, перестаёт что-либо держать. Держать нужно
 * другое — границу роли: кладовщик не проводит платежи, рабочий цеха не видит
 * контрагентов, собственник ничего не администрирует.
 *
 * Роль «Собственник» (`owner`) заведена 06.10 по задаче Отабека: учредителю
 * нужен сводный просмотр своей компании, включая финансы и отчёты, без права
 * что-либо менять. Набор задан правилом «все права с суффиксом `.view`», а не
 * перечислением: новое право на просмотр достанется ему само, а любое право на
 * запись — никогда.
 */
import { describe, expect, it } from 'vitest';
import { permissionDefs, roleDefs } from '../prisma/rbac.js';

const role = (code: string) => {
  const found = roleDefs.find((r) => r.code === code);
  expect(found, `роль «${code}» в roleDefs`).toBeDefined();
  return found!;
};

const allCodes = permissionDefs.map((p) => p[0]);

describe('системные роли', () => {
  it('у каждой роли все права существуют в справочнике', () => {
    for (const r of roleDefs) {
      for (const p of r.perms) {
        expect(allCodes, `роль «${r.code}»: право «${p}»`).toContain(p);
      }
    }
  });

  it('у каждой роли есть название на двух языках', () => {
    for (const r of roleDefs) {
      expect(r.ru.length, `роль «${r.code}»: ru`).toBeGreaterThan(2);
      expect(r.uz.length, `роль «${r.code}»: uz`).toBeGreaterThan(2);
    }
  });

  it('администратор имеет все права системы', () => {
    expect([...role('admin').perms].sort()).toEqual([...allCodes].sort());
  });

  it('директор — всё, кроме администрирования', () => {
    const d = role('director');
    expect(d.perms.filter((p) => p.startsWith('admin.'))).toEqual([]);
    expect([...d.perms].sort()).toEqual(allCodes.filter((c) => !c.startsWith('admin.')).sort());
  });
});

describe('роль «Собственник»', () => {
  it('заведена и названа по-человечески', () => {
    expect(role('owner').ru).toBe('Собственник');
    expect(role('owner').uz).toBe('Mulkdor');
  });

  it('видит всё: каждое право на просмотр у него есть', () => {
    const views = allCodes.filter((c) => c.endsWith('.view'));
    expect([...role('owner').perms].sort()).toEqual([...views].sort());
    // Финансы и отчёты — то, из-за чего роль и заводилась.
    expect(role('owner').perms).toContain('finance.view');
    expect(role('owner').perms).toContain('documents.view');
  });

  it('ничего не администрирует', () => {
    expect(role('owner').perms.filter((p) => p.startsWith('admin.'))).toEqual([]);
  });

  it('ничего не проводит и не правит', () => {
    // Любое право, которое не кончается на `.view`, — это запись или решение.
    const write = role('owner').perms.filter((p) => !p.endsWith('.view'));
    expect(write, 'у собственника право на запись').toEqual([]);
  });
});
