import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { NeedsService } from '../warehouse/needs.service.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Тракт уведомлений отдельным модулем: его зовёт и бот (отправляет), и API
 * (настройки человека, состояние «боту не достучаться»). Общий, а не ботовый.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  providers: [NeedsService, NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
