import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminUsersService } from './users.service.js';
import { AdminRolesService } from './roles.service.js';
import { AdminJournalService } from './journal.service.js';
import { TelegramLinkService } from './telegram-link.service.js';

@Module({
  controllers: [AdminController],
  providers: [AdminUsersService, AdminRolesService, AdminJournalService, TelegramLinkService],
  // Служба привязки нужна и боту, когда он появится: он позовёт `claim` прямо,
  // без маршрута — см. комментарий в самой службе.
  exports: [TelegramLinkService],
})
export class AdminModule {}
