import { Module } from '@nestjs/common';
import { WarehouseController } from './warehouse.controller.js';
import { WarehouseService } from './warehouse.service.js';
import { BatchesService } from './batches.service.js';
import { MovesService } from './moves.service.js';
import { WriteService } from './write.service.js';
import { ReservationsService } from './reservations.service.js';
import { InventoryService } from './inventory.service.js';
import { CodesService } from './codes.service.js';
import { NeedsService } from './needs.service.js';
import { ReportsService } from './reports.service.js';

@Module({
  controllers: [WarehouseController],
  providers: [
    WarehouseService,
    BatchesService,
    MovesService,
    WriteService,
    ReservationsService,
    InventoryService,
    CodesService,
    NeedsService,
    ReportsService,
  ],
  /**
   * Наружу — всё, что нужно боту: он зовёт эти же службы в контексте человека,
   * а не повторяет правила склада у себя. Иначе «списать» в боте и «списать»
   * на экране однажды разойдутся.
   */
  exports: [WarehouseService, MovesService, WriteService, InventoryService, NeedsService],
})
export class WarehouseModule {}
