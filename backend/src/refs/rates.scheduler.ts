import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RatesService } from './rates.service.js';

/**
 * Загрузка курсов с ЦБ РУз по расписанию.
 *
 * Банк публикует официальный курс раз в рабочий день, поэтому минутного опроса
 * здесь не нужно: раз в час достаточно, чтобы курс нового дня появился в
 * системе сам, без человека и без кнопки. Сама служба в сеть не пойдёт, если
 * курс на сегодня уже лежит в базе.
 *
 * Таймер `unref` — чтобы он не держал процесс при остановке службы, и выключен
 * в прогонах: тест не должен ходить в сеть и считать чужие обращения к банку.
 */
@Injectable()
export class RatesScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('rates');
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;

  constructor(private readonly rates: RatesService) {}

  onModuleInit() {
    if (process.env.VITEST || process.env.RATES_AUTOLOAD === 'off') return;
    // Бот зовёт те же службы и ставит эту переменную сам: расписание должно
    // быть у одного процесса, иначе банк опрашивают двое.
    if (process.env.RATES_SCHEDULER === 'off') return;
    // Первая попытка — через 10 секунд после старта: сразу после выкатки курс
    // должен быть на сегодня, а не ждать часа.
    this.first = setTimeout(() => void this.run(), 10_000);
    this.first.unref();
    this.timer = setInterval(() => void this.run(), 60 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
  }

  private async run() {
    try {
      await this.rates.ensureFresh();
    } catch (e) {
      // Недоступный банк не должен ронять службу: курс останется прошлый, и
      // об этом скажет сам экран.
      this.log.warn(`расписание курсов: ${(e as Error).message}`);
    }
  }
}
