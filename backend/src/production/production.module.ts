import { Module } from '@nestjs/common';
import { ProductionController } from './production.controller.js';
import { ProductionService } from './production.service.js';
import { ProductionOrdersService } from './orders.service.js';
import { ProductionWriteService } from './write.service.js';
import { TechCardsService } from './tech-cards.service.js';
import { ProductionStagesService } from './stages.service.js';
import { ProductionMaterialsService } from './materials.service.js';
import { ProductionOutputsService } from './outputs.service.js';
import { ProductionCostService } from './cost.service.js';
import { ProductionCalendarService } from './calendar.service.js';
import { ProductionControlService } from './control.service.js';
import { ProductionReportsService } from './reports.service.js';
import { WorkCentersService } from './work-centers.service.js';
import { WarehouseModule } from '../warehouse/warehouse.module.js';

@Module({
  // Выдача материала в цех — складское движение: его делает служба склада,
  // а не копия её правил в производстве.
  imports: [WarehouseModule],
  controllers: [ProductionController],
  providers: [
    ProductionService,
    ProductionOrdersService,
    ProductionWriteService,
    TechCardsService,
    ProductionStagesService,
    ProductionMaterialsService,
    ProductionOutputsService,
    ProductionCostService,
    ProductionCalendarService,
    ProductionControlService,
    ProductionReportsService,
    WorkCentersService,
  ],
  exports: [
    // Бот зовёт те же службы, что экран: список и карточка заказа, сводка
    // цеха и журнал отклонений. Своего чтения производства у него нет.
    ProductionService,
    ProductionOrdersService,
    ProductionControlService,
    ProductionWriteService,
    TechCardsService,
    ProductionStagesService,
    ProductionMaterialsService,
    ProductionOutputsService,
    ProductionCostService,
    ProductionCalendarService,
  ],
})
export class ProductionModule {}
