import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';
import { OrdersService } from './orders.service.js';
import { SalesWriteService } from './write.service.js';

@Module({
  controllers: [SalesController],
  providers: [SalesService, OrdersService, SalesWriteService],
  // Те же службы зовёт раздел «Продажи» в боте: правила заказа и отгрузки
  // живут здесь, а не в двух местах.
  exports: [SalesService, OrdersService, SalesWriteService],
})
export class SalesModule {}
