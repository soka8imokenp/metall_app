import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BackupService } from './backup.service.js';

/**
 * Расписание ежедневной копии базы (требование Отабека от 07.10).
 *
 * Сделано по образцу загрузки курсов (`refs/rates.scheduler.ts`) и очереди
 * обменов (`exchange/exchange.scheduler.ts`): свой таймер, `unref`, выключение
 * переменной. `@nestjs/schedule` в проект не добавляю — NestJS здесь
 * ESM-only, а зависимость ради одного будильника окупается плохо.
 *
 * **Почему не cron операционной системы.** Система уезжает на сервер
 * заказчика целиком и должна работать без ручной настройки ОС: человек,
 * который её поставит, не будет дописывать crontab, а если и допишет, то в
 * следующий переезд об этом никто не вспомнит. Расписание внутри службы
 * переезжает вместе с ней.
 *
 * **Как считается момент.** Раз в минуту смотрим на часы и сравниваем с
 * `BACKUP_AT`. Это грубее, чем один точный `setTimeout` на сутки вперёд, и
 * именно поэтому надёжнее: сутки — слишком долго, чтобы верить таймеру,
 * который переживёт перевод часов, сон машины и дрейф. Защита от второго
 * запуска в ту же минуту — отметка о дне, когда копия уже делалась.
 *
 * `BACKUP_SCHEDULER=off` — см. `schedulerEnabled`.
 */

/**
 * Поднимать ли будильник в этом процессе.
 *
 * Включено по умолчанию, и это главное свойство: заказчик ставит систему на
 * свой сервер, ничего не настраивает — и копии начинают делаться сами
 * (уточнение Отабека от 07.10). Выключение всегда осознанное, одним значением
 * `off`, и нужно в двух местах:
 *
 *   - процесс бота — он поднимает те же модули, а будильник должен быть у
 *     одного процесса, иначе `pg_dump` запустится дважды;
 *   - стенд — там копии не хранят, механизм показывается кнопкой.
 *
 * Выключает только `off`. «0», «false», пустая строка и опечатка оставляют
 * расписание включённым: цена ошибки в одну сторону — лишний дамп ночью, в
 * другую — заказчик без копий и без того, кто об этом скажет.
 */
export const schedulerEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  !env.VITEST && env.BACKUP_SCHEDULER !== 'off';

@Injectable()
export class BackupScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('backup');
  private timer: NodeJS.Timeout | null = null;
  /** День, за который копия уже сделана, в виде `2026-10-07`. */
  private doneFor: string | null = null;
  private busy = false;

  constructor(private readonly backup: BackupService) {}

  onModuleInit() {
    if (!schedulerEnabled()) return;
    const { at, dir, keep } = this.backup.settings();
    this.log.log(`копия базы ежедневно в ${at}, каталог ${dir}, храним ${keep}`);
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Один взгляд на часы. Открыт для тестов: проверять расписание ожиданием
   * минуты — значит проверять не расписание, а терпение.
   */
  async tick(now = new Date()): Promise<boolean> {
    const today = dayOf(now);
    if (this.doneFor === today) return false;
    const { hour, minute } = this.backup.at;
    // Не «ровно в 03:20», а «уже 03:20 или позже»: служба, поднятая в 03:40,
    // должна сделать сегодняшнюю копию, а не ждать следующей ночи.
    if (now.getHours() * 60 + now.getMinutes() < hour * 60 + minute) return false;
    if (this.busy) return false;

    // Отметка о сделанном дне живёт в памяти процесса, а выкатка процесс
    // перезапускает: без этого вопроса к журналу каждый дневной перезапуск
    // службы начинал бы ещё один `pg_dump`. Видно на стенде — две копии «по
    // расписанию» подряд после двух выкаток.
    if (await this.backup.madeToday(now)) {
      this.doneFor = today;
      return false;
    }

    this.busy = true;
    // День отмечаем до запуска: упавшая копия не должна запускаться снова
    // каждую минуту до утра. О том, что она упала, скажет уведомление.
    this.doneFor = today;
    try {
      await this.backup.run('schedule', null);
      return true;
    } catch (e) {
      this.log.warn(`расписание копий: ${(e as Error).message}`);
      return false;
    } finally {
      this.busy = false;
    }
  }
}

const dayOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
