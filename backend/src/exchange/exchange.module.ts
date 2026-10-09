import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ExchangeController } from './exchange.controller.js';
import { HooksController } from './hooks.controller.js';
import { ExchangeSystemsService } from './systems.service.js';
import { ExchangeSubscriptionsService } from './subscriptions.service.js';
import { ExchangeInboundService } from './inbound.service.js';
import { ExchangeOutboxService } from './outbox.service.js';
import { ExchangeMappingService } from './mapping.service.js';
import { ExchangeJournalService } from './journal.service.js';
import { ExchangeItemsFileService } from './items-file.service.js';
import { ExchangeScheduler } from './exchange.scheduler.js';

/**
 * Обменный слой (ТЗ 12): подключения внешних систем, входящие и исходящие
 * вебхуки, карта соответствий, импорт и экспорт файлов, журнал обменов.
 *
 * Конкретных коннекторов (1С, REGOS, банк, телефония) здесь нет и по этой
 * задаче не будет: по ним нет ни доступов, ни документации. Сделан каркас,
 * к которому коннектор присоединяется подпиской и ключом, без правки кода.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ExchangeController, HooksController],
  providers: [
    ExchangeSystemsService,
    ExchangeSubscriptionsService,
    ExchangeInboundService,
    ExchangeOutboxService,
    ExchangeMappingService,
    ExchangeJournalService,
    ExchangeItemsFileService,
    ExchangeScheduler,
  ],
  exports: [ExchangeOutboxService],
})
export class ExchangeModule {}
