/**
 * Время в базе и время в приложении — один и тот же момент.
 *
 * Драйвер Prisma разбирает `timestamptz` наивно, и на сервере базы с поясом
 * Asia/Tashkent это давало расхождение ровно на смещение пояса: приложение
 * сходилось само с собой, но с `now()` внутри SQL — нет. Задача со сроком
 * «сегодня к 17:00» ложилась как 12:00 и становилась просроченной на пять
 * часов раньше. Лечится сессией в UTC (`-c timezone=UTC`), и эта проверка
 * стоит, чтобы настройку не потеряли при следующей правке подключения.
 */
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service.js';

let prisma: PrismaService;

beforeAll(async () => {
  prisma = new PrismaService();
  await prisma.onModuleInit();
});

afterAll(async () => {
  await prisma?.onModuleDestroy();
});

describe('часы базы и часы приложения', () => {
  it('сессия приложения работает в UTC', async () => {
    const rows = await prisma.runtime.$queryRawUnsafe<{ tz: string }[]>(
      `SELECT current_setting('TimeZone') AS tz`,
    );
    expect(rows[0]!.tz).toBe('UTC');
  });

  it('now() из базы совпадает с часами процесса', async () => {
    const before = Date.now();
    const rows = await prisma.runtime.$queryRawUnsafe<{ n: Date }[]>('SELECT now() AS n');
    const dbNow = new Date(rows[0]!.n).getTime();
    expect(Math.abs(dbNow - before)).toBeLessThan(60_000);
  });

  it('записанный момент сравнивается с now() базы без смещения', async () => {
    const rows = await prisma.runtime.$queryRawUnsafe<{ past: boolean; future: boolean }[]>(
      `SELECT $1::timestamptz < now() AS past, $2::timestamptz > now() AS future`,
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000),
    );
    expect(rows[0]!.past).toBe(true);
    expect(rows[0]!.future).toBe(true);
  });
});
