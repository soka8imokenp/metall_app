import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { currentContext } from '../common/request-context.js';

export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

/**
 * Одно подключение к базе, ролью metall_app.
 *
 * У этой роли нет ни SUPERUSER, ни BYPASSRLS, поэтому политики изоляции
 * действуют на каждый запрос приложения без исключений. Роль владельца схемы
 * (BYPASSRLS) остаётся только у миграций и сида — то есть вне работающего
 * сервиса. Открытого пула с обходом RLS в процессе нет вовсе.
 *
 * Вход в систему раньше требовал такого пула: логин и пароль надо проверить до
 * того, как известны компании пользователя, а без контекста компаний политики
 * не пускают никуда. Теперь это решено на стороне базы:
 *   - `user_account`, `login_log`, `permission`, `role_permission` политик не
 *     несут — это не данные арендатора, и читать их можно без контекста;
 *   - у `user_role_assignment` есть отдельная политика `own_assignments`,
 *     которая пускает строки по `app.user_id`, а не по списку компаний.
 * Этого хватает, чтобы собрать профиль, а дальше запрос идёт уже с контекстом.
 */
/**
 * Сессия базы живёт в UTC, хотя сервер базы настроен на Asia/Tashkent.
 *
 * Драйвер Prisma разбирает `timestamptz` наивно: время, пришедшее как
 * `2026-09-29 16:24:09+05`, он отдаёт как `16:24:09Z`, и так же наивно пишет
 * обратно. Приложение само с собой при этом сходится — записал и прочитал одно
 * и то же, — но с `now()` внутри SQL расходится ровно на смещение пояса.
 *
 * Измерено 29.09.2026: `SELECT now()` через Prisma опережал часы процесса на
 * 300 минут, тот же запрос через `pg` совпадал до секунды. Цена расхождения —
 * задача со сроком «сегодня к 17:00» ложилась в базу как 12:00 и становилась
 * просроченной на пять часов раньше срока.
 *
 * `-c timezone=UTC` убирает смещение в корне: наивный разбор в UTC-сессии и
 * есть UTC. Выражения вида `AT TIME ZONE 'Asia/Tashkent'` в отчётах от этого
 * не страдают — они называют пояс явно. Проверка стоит в `test/db-time.spec.ts`.
 */
const UTC_SESSION = '-c timezone=UTC';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly runtime: PrismaClient;

  constructor() {
    this.runtime = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.APP_DATABASE_URL,
        options: UTC_SESSION,
      }),
    });
  }

  async onModuleInit() {
    await this.runtime.$connect();
  }

  async onModuleDestroy() {
    await this.runtime.$disconnect();
  }

  /**
   * Транзакция с выставленным контекстом арендатора.
   *
   * SET LOCAL, а не SET: значение живёт до конца транзакции и не протекает в
   * следующий запрос, который возьмёт то же соединение из пула. Пустой список
   * компаний означает «ничего не видно», а не «видно всё».
   */
  async withTenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const ctx = currentContext();
    return this.withContext(ctx?.userId ?? null, ctx?.companyIds ?? [], fn);
  }

  /**
   * То же самое, но контекст задан явно, а не взят из контекста запроса.
   *
   * Нужно там, где запрос идёт вне обычного потока: вход в систему (контекста
   * ещё нет) и разбор токена в страже (контекст как раз и собирается). Списком
   * компаний здесь нельзя расширить доступ — он только сужает то, что и так
   * разрешено политиками.
   */
  async withContext<T>(
    userId: bigint | null,
    companyIds: readonly bigint[],
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    const ctx = currentContext();
    const companies = companyIds.join(',');
    const user = userId === null ? '' : String(userId);

    return this.runtime.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.company_ids', ${companies}, true)`;
      await tx.$queryRaw`SELECT set_config('app.user_id', ${user}, true)`;
      // Язык запроса — рядом с остальным контекстом: по нему `app_loc(ru, uz)`
      // выбирает название справочника. Вне запроса остаётся русский.
      await tx.$queryRaw`SELECT set_config('app.locale', ${ctx?.locale ?? 'ru'}, true)`;
      return fn(tx as unknown as Tx);
    });
  }
}
