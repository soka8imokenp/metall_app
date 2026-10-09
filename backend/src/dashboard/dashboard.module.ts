import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { PlanService } from './plan.service.js';

@Module({
  controllers: [DashboardController],
  providers: [DashboardService, PlanService],
  // Те же цифры, что на экране сводки, показывает раздел «Сводка» в боте:
  // руководитель не должен получать в телефоне другую выручку.
  exports: [DashboardService],
})
export class DashboardModule {}
