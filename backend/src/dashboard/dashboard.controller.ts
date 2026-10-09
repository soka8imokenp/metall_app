import { Controller, Get, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { DashboardService, type Period } from './dashboard.service.js';
import { PlanService, type PlanTab } from './plan.service.js';
import { RequirePermissions } from '../auth/auth.guard.js';

class SummaryQuery {
  @IsOptional()
  @IsIn(['7d', '30d', '3m'])
  period?: Period;
}

class PlanQuery {
  @IsOptional()
  @IsIn(['plan', 'done'])
  tab?: PlanTab;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly plan: PlanService,
  ) {}

  @Get('summary')
  @RequirePermissions('dashboard.view')
  summary(@Query() query: SummaryQuery) {
    return this.dashboard.summary(query.period ?? '30d');
  }

  @Get('plan')
  @RequirePermissions('dashboard.view')
  planRows(@Query() query: PlanQuery) {
    return this.plan.rows(query.tab ?? 'plan', query.limit ?? 50);
  }
}
