import { Module } from '@nestjs/common';
import { RefsController } from './refs.controller.js';
import { RefsService } from './refs.service.js';
import { PlacesService } from './places.service.js';
import { PricesService } from './prices.service.js';
import { CBU_FETCH, cbuFetchLive, RatesService } from './rates.service.js';
import { RatesScheduler } from './rates.scheduler.js';

@Module({
  controllers: [RefsController],
  providers: [
    RefsService,
    PlacesService,
    PricesService,
    RatesService,
    RatesScheduler,
    // Источник курсов отдельным провайдером: в прогонах он подменяется, чтобы
    // проверка разбора и правил не зависела от сайта банка.
    { provide: CBU_FETCH, useValue: cbuFetchLive },
  ],
  exports: [RatesService],
})
export class RefsModule {}
