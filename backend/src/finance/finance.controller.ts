import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Transform } from 'class-transformer';
import {
  IsBooleanString,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { FinanceService, type Period } from './finance.service.js';
import {
  OperationsService,
  type OperationStatus,
  type OperationType,
} from './operations.service.js';
import { ApprovalsService } from './approvals.service.js';
import { WriteService } from './write.service.js';
import { BudgetsService } from './budgets.service.js';
import {
  FinanceReportsService,
  FINANCE_REPORT_KINDS,
  MARGIN_BREAKDOWNS,
  type FinanceReportKind,
  type MarginBreakdown,
} from './reports.service.js';
import {
  PDF_ROW_LIMIT,
  REPORT_FORMATS,
  sendReportFile,
  type ReportFormat,
} from '../common/report-file.js';
import { RequirePermissions } from '../auth/auth.guard.js';

const STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'posted',
  'rejected',
  'reversed',
] as const;
const TYPES = ['income', 'expense', 'transfer', 'conversion'] as const;

class SummaryQuery {
  @IsOptional()
  @IsIn(['7d', '30d', '3m'])
  period?: Period;
}

class OperationsQuery {
  @IsOptional()
  @IsIn(STATUSES)
  status?: OperationStatus;

  @IsOptional()
  @IsIn(TYPES)
  type?: OperationType;

  /** Код счёта, а не uid: он же напечатан в журнале и в карточке. */
  @IsOptional()
  @Matches(/^[0-9]{3,6}$/)
  account?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

class ReceivablesQuery {
  @IsOptional()
  @IsBooleanString()
  overdueOnly?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

class PlanFactQuery {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

/** Дата отчёта: календарный день, без времени и без часового пояса. */
const REPORT_DATE = /^\d{4}-\d{2}-\d{2}$/;

class ReportParams {
  /**
   * Вид отчёта — только из списка. Неизвестное имя отбивается здесь, до
   * запроса в базу: иначе «kpi» в адресе вернул бы пустую таблицу, и её
   * прочитали бы как «KPI нулевой», а не как «такого отчёта нет».
   */
  @IsIn(FINANCE_REPORT_KINDS)
  kind!: FinanceReportKind;
}

class ReportQuery {
  @IsOptional()
  @Matches(REPORT_DATE, { message: 'Дата «с»: формат ГГГГ-ММ-ДД' })
  from?: string;

  @IsOptional()
  @Matches(REPORT_DATE, { message: 'Дата «по»: формат ГГГГ-ММ-ДД' })
  to?: string;

  /** Разрез отчёта по марже: заказ, товар, клиент, менеджер (ТЗ 6.7). */
  @IsOptional()
  @IsIn(MARGIN_BREAKDOWNS)
  by?: MarginBreakdown;

  /**
   * Предел строк. Отчёт не листают — его выгружают целиком, поэтому предел
   * здесь на порядок выше списочного. Упёрлись в него — отчёт говорит об этом
   * полем `truncated`, а не молча отдаёт половину.
   */
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(20000)
  limit?: number;
}

class ReportFileQuery extends ReportQuery {
  @IsIn(REPORT_FORMATS)
  format!: ReportFormat;
}

/** Период бюджета: месяц «2026-10» или квартал «2026-Q4» (ТЗ 6.6). */
const BUDGET_PERIOD = /^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/i;

class BudgetBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsOptional() @IsUUID() departmentUid?: string;
  @IsUUID() itemUid!: string;
  @Matches(BUDGET_PERIOD, { message: 'Период: «2026-10» (месяц) или «2026-Q4» (квартал)' })
  period!: string;
  @IsNumber() @IsPositive() amountPlanned!: number;
  @IsOptional() @IsNumber() @Min(1) @Max(100) thresholdWarnPercent?: number;
  @IsOptional() @IsUUID() responsibleUid?: string;
}

class BudgetPatchBody {
  @IsOptional() @IsNumber() @IsPositive() amountPlanned?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(100) thresholdWarnPercent?: number;
  /** Пустая строка снимает ответственного: `null` в JSON-теле не принимаем. */
  @IsOptional() @IsString() @MaxLength(36) responsibleUid?: string;
  @IsOptional() @IsString() @MaxLength(36) departmentUid?: string;
}

class OperationParams {
  @IsUUID()
  uid!: string;
}

/**
 * Тело любого действия над операцией.
 *
 * `version` обязателен и без умолчания: он приходит из карточки, которую
 * человек видит на экране. Сделать его необязательным — значит разрешить
 * слепую запись поверх чужой правки, а заодно и двойное проведение по
 * двойному нажатию.
 */
class ActionBody {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

/**
 * Сумма приходит строкой, а не числом: у `double` копейки на миллиардах
 * теряются молча. Маска допускает до четырёх знаков — ровно столько держит
 * колонка в базе.
 */
const MONEY = /^\d{1,15}([.,]\d{1,4})?$/;

class CreateOperationBody {
  @IsOptional()
  @IsUUID()
  companyUid?: string;

  @IsIn(TYPES)
  operationType!: OperationType;

  @Matches(/^[0-9]{3,6}$/)
  accountCode!: string;

  @Matches(/^[0-9]{3,6}$/)
  counterAccountCode!: string;

  @Matches(MONEY)
  amount!: string;

  @Matches(/^[A-Z]{3}$/)
  currencyCode!: string;

  @IsOptional()
  @Matches(MONEY)
  rate?: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @IsDateString()
  plannedDate?: string;

  @IsOptional()
  @IsUUID()
  cashflowItemUid?: string;

  @IsOptional()
  @IsUUID()
  partnerUid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;

  /** Заказ, который оплачивают. Проверки — в службе, одни для всех экранов. */
  @IsOptional()
  @IsUUID()
  salesOrderUid?: string;
}

class PatchOperationBody {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @Matches(/^[0-9]{3,6}$/)
  accountCode?: string;

  @IsOptional()
  @Matches(/^[0-9]{3,6}$/)
  counterAccountCode?: string;

  @IsOptional()
  @Matches(MONEY)
  amount?: string;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currencyCode?: string;

  @IsOptional()
  @Matches(MONEY)
  rate?: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @IsDateString()
  plannedDate?: string;

  @IsOptional()
  @IsUUID()
  cashflowItemUid?: string;

  @IsOptional()
  @IsUUID()
  partnerUid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

/**
 * Финансы: чтение и согласование операций.
 *
 * Деньгами двигает только `post`, и только из статуса «утверждена». Право
 * `finance.post` даёт завести и провести, `finance.approve` — утвердить или
 * отклонить; у бухгалтера есть первое и нет второго, поэтому сам себе свою же
 * заявку он не согласует.
 */
@Controller('finance')
export class FinanceController {
  constructor(
    private readonly finance: FinanceService,
    private readonly operations: OperationsService,
    private readonly approvals: ApprovalsService,
    private readonly write: WriteService,
    private readonly budgets: BudgetsService,
    private readonly reports: FinanceReportsService,
  ) {}

  /**
   * Отчёты финансов (ТЗ 6.9): ДДС, остатки по кассам и счетам, дебиторская и
   * кредиторская задолженность, план-факт, прибыли и убытки, маржа, сводный.
   *
   * Отчёт и его выгрузка — один и тот же расчёт, поэтому строит их один
   * сервис. Разные пути у них только потому, что ответы разной природы: здесь
   * конверт `{data, meta}`, там файл. Класть файл в конверт значило бы отдавать
   * base64, а по нему браузер файла не сохранит.
   *
   * Вход в раздел даёт `finance.view`: отчёт показывает те же числа, что и
   * вкладки, только собранные. Отдельного права «на отчёты» нет — это значило
   * бы, что те же деньги кому-то видно по одному адресу и не видно по другому.
   *
   * Но прибыль — своё право, `finance.profit.view` (требование заказчика
   * 07.10: финансист видит аналитику, не видя чистой прибыли учредителей).
   * Его проверяет сам построитель, а не маршрут: через `build` идут и ответ, и
   * файл, и сводка, и проверка на маршруте повторялась бы трижды.
   */
  @Get('reports/:kind')
  @RequirePermissions('finance.view')
  report(@Param() params: ReportParams, @Query() query: ReportQuery) {
    return this.reports.build({
      kind: params.kind,
      from: query.from,
      to: query.to,
      by: query.by,
      limit: query.limit ?? 1000,
    });
  }

  /**
   * Выгрузка отчёта файлом: Excel, CSV или печатная форма PDF.
   *
   * `@Res()` без `passthrough` — сознательно: Nest тогда не досылает ответ сам,
   * а конверт-перехватчик не пытается завернуть файл в JSON. Иначе на один
   * запрос ушло бы два ответа.
   */
  @Get('reports/:kind/file')
  @RequirePermissions('finance.view')
  async reportFile(
    @Param() params: ReportParams,
    @Query() query: ReportFileQuery,
    @Res() res: Response,
  ) {
    const report = await this.reports.build({
      kind: params.kind,
      from: query.from,
      to: query.to,
      by: query.by,
      // Выгрузка — это весь отчёт, а не первая тысяча строк: файл на то и
      // файл. Предел остаётся, но верхний, чтобы запросом не выложить базу.
      // У PDF он ниже: его печатают, а не считают в нём.
      limit: query.limit ?? (query.format === 'pdf' ? PDF_ROW_LIMIT : 20000),
    });

    const stamp = new Date().toISOString().slice(0, 10);
    await sendReportFile(res, report, `finansy-${params.kind}-${stamp}`, query.format);
  }

  @Get('summary')
  @RequirePermissions('finance.view')
  summary(@Query() query: SummaryQuery) {
    return this.finance.summary(query.period ?? '30d');
  }

  @Get('operations')
  @RequirePermissions('finance.view')
  list(@Query() query: OperationsQuery) {
    return this.operations.list({
      status: query.status,
      type: query.type,
      account: query.account,
      search: query.search,
      limit: query.limit ?? 100,
    });
  }

  @Get('operations/:uid')
  @RequirePermissions('finance.view')
  card(@Param() params: OperationParams) {
    return this.operations.card(params.uid);
  }

  @Get('receivables')
  @RequirePermissions('finance.view')
  receivables(@Query() query: ReceivablesQuery) {
    return this.finance.receivables({
      overdueOnly: query.overdueOnly === 'true',
      limit: query.limit ?? 100,
    });
  }

  @Get('budgets/plan-fact')
  @RequirePermissions('finance.view')
  planFact(@Query() query: PlanFactQuery) {
    return this.finance.planFact({ from: query.from, to: query.to });
  }

  // --- бюджеты на запись (ТЗ 6.6) ---
  //
  // Чтение — `finance.view`, запись — `finance.approve`: план это решение о
  // деньгах, а не проводка. Бухгалтер с `finance.post` проводит платежи, но
  // сколько можно потратить за месяц, решает тот, кто согласовывает.

  @Get('budgets/refs')
  @RequirePermissions('finance.view')
  budgetRefs() {
    return this.budgets.refs();
  }

  @Post('budgets')
  @RequirePermissions('finance.approve')
  createBudget(@Body() body: BudgetBody) {
    return this.budgets.create(body as never);
  }

  @Patch('budgets/:uid')
  @RequirePermissions('finance.approve')
  updateBudget(@Param() params: OperationParams, @Body() body: BudgetPatchBody) {
    return this.budgets.update(params.uid, {
      ...body,
      // Пустая строка — это «снять»: из формы приходит именно она.
      ...(body.responsibleUid === '' ? { responsibleUid: null } : {}),
      ...(body.departmentUid === '' ? { departmentUid: null } : {}),
    } as never);
  }

  @Delete('budgets/:uid')
  @RequirePermissions('finance.approve')
  deleteBudget(@Param() params: OperationParams) {
    return this.budgets.remove(params.uid);
  }

  @Post('operations/:uid/submit')
  @RequirePermissions('finance.post')
  submit(@Param() params: OperationParams, @Body() body: ActionBody) {
    return this.approvals.apply(params.uid, 'submit', body);
  }

  @Post('operations/:uid/approve')
  @RequirePermissions('finance.approve')
  approve(@Param() params: OperationParams, @Body() body: ActionBody) {
    return this.approvals.apply(params.uid, 'approve', body);
  }

  @Post('operations/:uid/reject')
  @RequirePermissions('finance.approve')
  reject(@Param() params: OperationParams, @Body() body: ActionBody) {
    return this.approvals.apply(params.uid, 'reject', body);
  }

  @Post('operations/:uid/post')
  @RequirePermissions('finance.post')
  post(@Param() params: OperationParams, @Body() body: ActionBody) {
    return this.approvals.apply(params.uid, 'post', body);
  }

  @Get('refs')
  @RequirePermissions('finance.view')
  refs() {
    return this.write.refs();
  }

  /**
   * Заголовок `Idempotency-Key` необязателен, но экран его шлёт всегда: без
   * него повторная отправка формы заведёт вторую такую же заявку, а по двум
   * одинаковым платежам потом не разобрать, какой настоящий.
   */
  @Post('operations')
  @RequirePermissions('finance.post')
  create(@Body() body: CreateOperationBody, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.write.create(body, idempotencyKey);
  }

  @Patch('operations/:uid')
  @RequirePermissions('finance.post')
  patch(@Param() params: OperationParams, @Body() body: PatchOperationBody) {
    return this.write.patch(params.uid, body);
  }

  @Post('operations/:uid/reverse')
  @RequirePermissions('finance.post')
  reverse(@Param() params: OperationParams, @Body() body: ActionBody) {
    return this.write.reverse(params.uid, body);
  }
}
