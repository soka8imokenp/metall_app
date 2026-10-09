import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AdminModule } from '../admin/admin.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
// Деньгами распоряжаются службы финансов, и бот зовёт их, а не повторяет их
// правила у себя. Модуль финансов отдаёт их наружу именно для этого.
import { FinanceModule } from '../finance/finance.module.js';
import { WarehouseModule } from '../warehouse/warehouse.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { DashboardModule } from '../dashboard/dashboard.module.js';
// Производство: заказы цеха, этапы и выпуск — те же службы, что у экрана.
import { ProductionModule } from '../production/production.module.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';
// Курс валют: та же служба, что отдаёт панель курса в браузере и ходит в ЦБ РУз.
import { RefsModule } from '../refs/refs.module.js';
import { BotService } from './bot.service.js';
import { BotFinance } from './finance.bot.js';
import { BotWarehouse } from './warehouse.bot.js';
import { BotSales } from './sales.bot.js';
import { BotDocuments } from './documents.bot.js';
import { BotChief } from './chief.bot.js';
import { BotProduction } from './production.bot.js';
import { BotRates } from './rates.bot.js';
import { DigestService } from './digest.service.js';
import { TelegramApi } from './telegram.api.js';

/**
 * Бот — отдельный процесс на тех же службах, что и веб (`src/bot.main.ts`).
 *
 * Отдельный, потому что у него своя жизнь: длинный опрос Telegram, свой
 * перезапуск, и падать вместе с API он не должен. На тех же службах, потому
 * что иначе пришлось бы заводить второй вход в систему — со своей проверкой
 * пароля, своим журналом и своим пониманием прав. Второй вход рано или поздно
 * разойдётся с первым.
 */
@Module({
  imports: [
    PrismaModule,
    AuthModule,
    AdminModule,
    NotificationsModule,
    FinanceModule,
    WarehouseModule,
    SalesModule,
    DocumentsModule,
    DashboardModule,
    ProductionModule,
    // Вложения: фото чека в финансах и снимок при списании на складе.
    AttachmentsModule,
    RefsModule,
  ],
  providers: [
    DigestService,
    BotFinance,
    BotWarehouse,
    BotSales,
    BotDocuments,
    BotChief,
    BotProduction,
    BotRates,
    BotService,
    {
      provide: TelegramApi,
      useFactory: () => {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан: боту нечем представиться');
        return new TelegramApi(token);
      },
    },
  ],
  exports: [BotService],
})
export class BotModule {}
