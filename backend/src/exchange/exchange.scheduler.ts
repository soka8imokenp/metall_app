import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ExchangeOutboxService } from './outbox.service.js';

/**
 * Проход очереди исходящих вебхуков по расписанию (ТЗ 12).
 *
 * Сделано по образцу загрузки курсов (`refs/rates.scheduler.ts`): таймер
 * `unref`, чтобы не держать процесс при остановке службы, и выключен в
 * прогонах — тест не должен ходить в сеть. Тесты зовут `tick()` сами, иначе они
 * проверяли бы не очередь, а то, успел ли таймер.
 *
 * Минута, а не час: обмен ждать не должен, а нарастающая задержка на самих
 * строках всё равно не даёт обстреливать упавшего получателя.
 *
 * Переменная `EXCHANGE_SCHEDULER=off` — для бота, как у курсов: бот поднимает те
 * же модули, и расписание должно быть у одного процесса, иначе один и тот же
 * обмен уйдёт дважды.
 */
@Injectable()
export class ExchangeScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('exchange');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly outbox: ExchangeOutboxService) {}

  onModuleInit() {
    if (process.env.VITEST || process.env.EXCHANGE_SCHEDULER === 'off') return;
    this.timer = setInterval(() => void this.run(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async run() {
    // Проход может затянуться на медленном получателе, а таймер ждать не будет.
    // Без этого замка два прохода взяли бы одну строку и отправили её дважды.
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await this.outbox.tick();
      if (res.sent || res.failed) {
        this.log.log(`очередь обменов: отправлено ${res.sent}, не вышло ${res.failed}`);
      }
    } catch (e) {
      this.log.warn(`проход очереди обменов: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
