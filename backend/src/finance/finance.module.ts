import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller.js';
import { FinanceService } from './finance.service.js';
import { OperationsService } from './operations.service.js';
import { ApprovalsService } from './approvals.service.js';
import { WriteService } from './write.service.js';
import { BudgetsService } from './budgets.service.js';
import { FinanceReportsService } from './reports.service.js';

@Module({
  controllers: [FinanceController],
  providers: [
    FinanceService,
    OperationsService,
    ApprovalsService,
    WriteService,
    BudgetsService,
    FinanceReportsService,
  ],
  /**
   * Наружу — всё, что умеет деньги. Бот не повторяет правила у себя: он зовёт
   * эти же службы в контексте вошедшего человека. Иначе «провести» в боте и
   * «провести» на экране однажды разойдутся, и сойтись им будет негде.
   */
  exports: [FinanceService, OperationsService, ApprovalsService, WriteService],
})
export class FinanceModule {}
