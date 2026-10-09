import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { BackupController } from './backup.controller.js';
import { BackupService } from './backup.service.js';
import { BackupScheduler } from './backup.scheduler.js';

/**
 * Ежедневная резервная копия базы средствами самой системы (требование
 * Отабека от 07.10): расписание внутри службы, журнал копий, экран в
 * «Настройках».
 *
 * Почему без cron операционной системы, почему дамп на диск рядом с системой
 * и почему нет восстановления кнопкой — в `backup.scheduler.ts`,
 * `backup.service.ts` и `backup.controller.ts` соответственно.
 */
@Module({
  imports: [PrismaModule],
  controllers: [BackupController],
  providers: [BackupService, BackupScheduler],
  exports: [BackupService],
})
export class BackupModule {}
