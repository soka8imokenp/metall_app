import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PushService } from './push.service.js';

/**
 * Будильник push: раз в минуту собрать события и разослать по телефонам.
 *
 * Живёт в процессе API, а не бота: push нужен и там, где бот не запущен
 * (нет токена Telegram). Сбор событий (`scan`) безопасно звать из двух
 * процессов: строка очереди одна на (человек, вид, предмет), повтор ничего не
 * добавит.
 *
 * Выключается `PUSH_SCHEDULER=off` и в прогонах тестов — по образцу
 * `backup.scheduler.ts`.
 */
export const pushEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  !env.VITEST && env.PUSH_SCHEDULER !== 'off';

@Injectable()
export class PushScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('push');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
  ) {}

  onModuleInit() {
    if (!pushEnabled()) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.notifications.scan();
      await this.push.deliver();
    } catch (e) {
      this.log.warn(`проход push: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
