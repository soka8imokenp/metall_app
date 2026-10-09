import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PUSH_SEND, PushService, expoPushSend } from './push.service.js';
import { PushScheduler } from './push.scheduler.js';

/**
 * Push только в процессе API: бот поднимает `NotificationsModule`, но не этот
 * модуль — иначе будильник работал бы в двух процессах и слал бы дважды.
 */
@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  providers: [PushService, PushScheduler, { provide: PUSH_SEND, useValue: expoPushSend }],
  exports: [PushService],
})
export class PushModule {}
