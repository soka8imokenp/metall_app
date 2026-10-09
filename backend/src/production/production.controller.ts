import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ProductionService, type Period } from './production.service.js';
import { ProductionOrdersService, type State } from './orders.service.js';
import {
  ProductionWriteService,
  type ProductionStatusName,
} from './write.service.js';
import { TechCardsService, type TechCardStatusName } from './tech-cards.service.js';
import { ProductionStagesService, type StageMark } from './stages.service.js';
import { ProductionMaterialsService } from './materials.service.js';
import { ProductionOutputsService } from './outputs.service.js';
import { ProductionCostService } from './cost.service.js';
import { ProductionCalendarService } from './calendar.service.js';
import {
  ProductionReportsService,
  REPORT_KINDS,
  type ProductionReportKind,
} from './reports.service.js';
import { WorkCentersService } from './work-centers.service.js';
import { REPORT_FORMATS, sendReportFile, type ReportFormat } from '../common/report-file.js';
import type { Response } from 'express';
import { Res } from '@nestjs/common';
import {
  ProductionControlService,
  type DeviationKindName,
} from './control.service.js';
import { RequirePermissions } from '../auth/auth.guard.js';

class SummaryQuery {
  @IsOptional()
  @IsIn(['7d', '30d', '3m'])
  period?: Period;
}

class OrdersQuery {
  @IsOptional()
  @IsIn(['all', 'planned', 'active', 'done'])
  state?: State;

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

  /** Страница списка: сколько строк пропустить (Э8). */
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  offset?: number;
}

class OrderParams {
  @IsUUID()
  uid!: string;
}

/**
 * Количество и даты приходят строками, а не числами.
 *
 * `decimal(20,6)` в базе и `number` в JSON — разные вещи: число больше 2^53
 * теряет точность ещё в разборе тела запроса, то есть до любой проверки.
 */
const QTY = /^\d{1,13}([.,]\d{1,6})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

class CreateOrderBody {
  @IsOptional()
  @IsUUID()
  companyUid?: string;

  @IsString()
  @MaxLength(64)
  itemCode!: string;

  @Matches(QTY, { message: 'Количество: число больше нуля, до шести знаков после точки' })
  qtyPlanned!: string;

  @Matches(DAY, { message: 'Срок: дата вида ГГГГ-ММ-ДД' })
  dueDate!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  priority?: number;

  @IsOptional()
  @IsUUID()
  responsibleUid?: string;

  @IsOptional()
  @IsUUID()
  salesOrderUid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

class UpdateOrderBody {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  itemCode?: string;

  @IsOptional()
  @Matches(QTY, { message: 'Количество: число больше нуля, до шести знаков после точки' })
  qtyPlanned?: string;

  @IsOptional()
  @Matches(DAY, { message: 'Срок: дата вида ГГГГ-ММ-ДД' })
  dueDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  priority?: number;

  /** Пустая строка — снять ответственного: отличается от «поля нет в правке». */
  @IsOptional()
  @IsString()
  @MaxLength(36)
  responsibleUid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(36)
  salesOrderUid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

const STATUSES = [
  'planned',
  'in_progress',
  'paused',
  'produced',
  'closed',
  'cancelled',
] as const;

class StatusBody {
  /**
   * `draft` в списке нет: черновиком заказ рождается, и возврата в него не
   * бывает — иначе запущенную работу можно было бы отыграть назад без следа.
   */
  @IsIn(STATUSES)
  status!: ProductionStatusName;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

/** Норма расхода и процент отхода приходят строками по той же причине, что и количество. */
const PERCENT = /^\d{1,3}([.,]\d{1,4})?$/;

class CardStageBody {
  @IsInt()
  @Min(1)
  @Max(50)
  seq!: number;

  @IsString()
  @MaxLength(200)
  nameRu!: string;

  @IsString()
  @MaxLength(200)
  nameUz!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  workCenterCode?: string;

  @IsInt()
  @Min(0)
  @Max(100_000)
  normDurationMin!: number;

  @IsOptional()
  @IsBoolean()
  isParallel?: boolean;

  @IsOptional()
  @Matches(PERCENT, { message: 'Процент отхода: число от 0 до 100' })
  wastePercent?: string;
}

class CardMaterialBody {
  @IsString()
  @MaxLength(64)
  itemCode!: string;

  @Matches(QTY, { message: 'Норма расхода: число больше нуля, до шести знаков после точки' })
  qtyPerUnit!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  stageSeq?: number;

  @IsOptional()
  @IsBoolean()
  isAutoWriteoff?: boolean;
}

class CreateCardBody {
  @IsOptional()
  @IsUUID()
  companyUid?: string;

  @IsString()
  @MaxLength(64)
  itemCode!: string;

  @IsString()
  @MaxLength(200)
  nameRu!: string;

  @IsString()
  @MaxLength(200)
  nameUz!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CardStageBody)
  stages?: CardStageBody[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CardMaterialBody)
  materials?: CardMaterialBody[];
}

class UpdateCardBody {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameRu?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameUz?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CardStageBody)
  stages?: CardStageBody[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CardMaterialBody)
  materials?: CardMaterialBody[];
}

/** Этап заказа: что делают, где, кто и сколько минут на это заложено. */
class OrderStageBody {
  @IsInt()
  @Min(1)
  @Max(50)
  seq!: number;

  @IsString()
  @MaxLength(200)
  nameRu!: string;

  @IsString()
  @MaxLength(200)
  nameUz!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  workCenterCode?: string;

  @IsOptional()
  @IsUUID()
  responsibleUid?: string;

  @IsInt()
  @Min(0)
  @Max(1_000_000)
  plannedDurationMin!: number;
}

class StagesBody {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderStageBody)
  stages!: OrderStageBody[];
}

/** Отметка по этапу. Причина нужна паузе — из неё растёт журнал простоев. */
class MarkBody {
  @IsIn(['start', 'pause', 'resume', 'finish'])
  kind!: StageMark;

  @IsOptional()
  @IsUUID()
  reasonUid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

class StageParams {
  @IsUUID()
  uid!: string;

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(50)
  seq!: number;
}

class MineQuery {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** Строка плана расхода: что и сколько должно уйти по заказу. */
class OrderMaterialBody {
  @IsString()
  @MaxLength(64)
  itemCode!: string;

  @Matches(QTY, { message: 'План расхода: число больше нуля, до шести знаков после точки' })
  qtyPlanned!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  stageSeq?: number;
}

class MaterialsBody {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OrderMaterialBody)
  materials!: OrderMaterialBody[];
}

/** Выдача в цех и возврат: это складское движение, поэтому склад обязателен. */
class MaterialMoveBody {
  @IsString()
  @MaxLength(64)
  itemCode!: string;

  @Matches(QTY, { message: 'Количество: число больше нуля, до шести знаков после точки' })
  qty!: string;

  @IsString()
  @MaxLength(64)
  warehouseCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  locationCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  batchNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

/** Расход: склада не касается, поэтому ни склада, ни партии тут нет. */
class MaterialUseBody {
  @IsString()
  @MaxLength(64)
  itemCode!: string;

  @Matches(QTY, { message: 'Количество: число больше нуля, до шести знаков после точки' })
  qty!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

class MaterialStockQuery {
  @IsString()
  @MaxLength(64)
  itemCode!: string;
}

/**
 * Выпуск: годное, брак, отход, полуфабрикат.
 *
 * Поля разные у разных видов, и проверять их тут построчно значило бы
 * повторять правила службы: склад обязателен у того, что ложится на склад,
 * причина — у брака и отхода. Это решает служба, здесь только формат.
 */
class OutputBody {
  @IsIn(['good', 'defect', 'waste', 'semi'])
  kind!: 'good' | 'defect' | 'waste' | 'semi';

  @Matches(QTY, { message: 'Количество: число больше нуля, до шести знаков после точки' })
  qty!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  stageSeq?: number;

  @IsOptional()
  @IsUUID()
  reasonUid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  itemCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  warehouseCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  locationCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  batchNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

/** Переделка: сколько брака переделываем и к какому сроку. */
class ReworkBody {
  @Matches(QTY, { message: 'Количество: число больше нуля, до шести знаков после точки' })
  qty!: string;

  @Matches(DAY, { message: 'Срок: дата в виде ГГГГ-ММ-ДД' })
  dueDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

class CardsQuery {
  @IsOptional()
  @IsIn(['draft', 'active', 'archived'])
  status?: TechCardStatusName;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  itemCode?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

class CardParams {
  @IsUUID()
  uid!: string;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

class CalendarQuery {
  @IsOptional()
  @Matches(DAY, { message: 'Начало периода — дата в виде ГГГГ-ММ-ДД' })
  from?: string;

  @IsOptional()
  @Matches(DAY, { message: 'Конец периода — дата в виде ГГГГ-ММ-ДД' })
  to?: string;
}

class WorkWeekBody {
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  days!: number[];
}

class CalendarDayBody {
  @Matches(DAY, { message: 'Дата дня — в виде ГГГГ-ММ-ДД' })
  day!: string;

  @IsBoolean()
  isWorking!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  comment?: string;
}

class ShiftBody {
  @IsString()
  @MaxLength(16)
  code!: string;

  @IsString()
  @MaxLength(120)
  nameRu!: string;

  @IsString()
  @MaxLength(120)
  nameUz!: string;

  @Matches(TIME, { message: 'Начало смены — время в виде ЧЧ:ММ' })
  startsAt!: string;

  @Matches(TIME, { message: 'Конец смены — время в виде ЧЧ:ММ' })
  endsAt!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class ShiftParams {
  @IsUUID()
  uid!: string;
}

class DayParams {
  @Matches(DAY, { message: 'Дата дня — в виде ГГГГ-ММ-ДД' })
  day!: string;
}

class DeviationsQuery {
  @IsOptional()
  @IsIn(['7d', '30d', '3m'])
  period?: Period;

  @IsOptional()
  @IsIn(['downtime', 'overuse', 'defect', 'delay'])
  kind?: DeviationKindName;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

class ProductionReportParams {
  @IsIn(REPORT_KINDS)
  kind!: ProductionReportKind;
}

class ProductionReportQuery {
  @IsOptional()
  @Matches(DAY, { message: 'Дата «с»: формат ГГГГ-ММ-ДД' })
  from?: string;

  @IsOptional()
  @Matches(DAY, { message: 'Дата «по»: формат ГГГГ-ММ-ДД' })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20000)
  limit?: number;
}

class ProductionReportFileQuery extends ProductionReportQuery {
  @IsIn(REPORT_FORMATS)
  format!: ReportFormat;
}

class WorkCenterBody {
  @IsString()
  @MaxLength(32)
  code!: string;

  @IsString()
  @MaxLength(120)
  nameRu!: string;

  @IsString()
  @MaxLength(120)
  nameUz!: string;

  @IsOptional()
  @Matches(QTY, { message: 'Сменная мощность: число, до шести знаков после точки' })
  capacityPerShift?: string;

  @IsOptional()
  @Matches(QTY, { message: 'Стоимость часа: число, до шести знаков после точки' })
  costPerHour?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class WorkCenterParams {
  @IsString()
  @MaxLength(32)
  code!: string;
}

class DowntimeBody {
  @IsString()
  @MaxLength(64)
  workCenterCode!: string;

  @IsUUID()
  reasonUid!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  minutes!: number;

  @IsOptional()
  @Matches(DAY, { message: 'Дата простоя — в виде ГГГГ-ММ-ДД' })
  occurredAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  comment?: string;
}

/**
 * Производство: чтение и жизненный цикл заказа (ТЗ 4.1).
 *
 * Отметки по этапам (запуск, пауза, возобновление, завершение) пишутся в
 * журнал событий, по которому потом считают фактическое время и простои, —
 * это следующий заход, и здесь их ещё нет. Правило заведено так: кнопка,
 * которая меняет только вид на экране, мастеру врёт, поэтому её нет вовсе.
 */
@Controller('production')
export class ProductionController {
  constructor(
    private readonly production: ProductionService,
    private readonly orders: ProductionOrdersService,
    private readonly write: ProductionWriteService,
    private readonly cards: TechCardsService,
    private readonly stages: ProductionStagesService,
    private readonly materials: ProductionMaterialsService,
    private readonly productionOutputs: ProductionOutputsService,
    private readonly cost_: ProductionCostService,
    private readonly calendar: ProductionCalendarService,
    private readonly control: ProductionControlService,
    private readonly reports: ProductionReportsService,
    private readonly centers: WorkCentersService,
  ) {}

  // --- Отчёты модуля (ТЗ 4.1, Э8) -----------------------------------------

  /**
   * Отчёт и его выгрузка — один расчёт, поэтому строит их один сервис. Пути
   * разные только потому, что ответы разной природы: здесь конверт `{data,
   * meta}`, там файл.
   */
  @Get('reports/:kind')
  @RequirePermissions('production.view')
  report(@Param() params: ProductionReportParams, @Query() query: ProductionReportQuery) {
    return this.reports.build({
      kind: params.kind,
      from: query.from,
      to: query.to,
      limit: query.limit ?? 1000,
    });
  }

  @Get('reports/:kind/file')
  @RequirePermissions('production.view')
  async reportFile(
    @Param() params: ProductionReportParams,
    @Query() query: ProductionReportFileQuery,
    @Res() res: Response,
  ) {
    const report = await this.reports.build({
      kind: params.kind,
      from: query.from,
      to: query.to,
      limit: query.limit ?? 20000,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    await sendReportFile(res, report, `proizvodstvo-${params.kind}-${stamp}`, query.format);
  }

  // --- Справочник участков (ТЗ 4.1) ---------------------------------------

  @Get('work-centers')
  @RequirePermissions('production.view')
  workCenters() {
    return this.centers.list();
  }

  @Post('work-centers')
  @RequirePermissions('production.manage')
  createWorkCenter(@Body() body: WorkCenterBody) {
    return this.centers.save(body);
  }

  @Patch('work-centers/:code')
  @RequirePermissions('production.manage')
  updateWorkCenter(@Param() params: WorkCenterParams, @Body() body: WorkCenterBody) {
    return this.centers.save(body, params.code);
  }

  // --- Календарь завода: смены, рабочая неделя, выходные (ТЗ 4.1) ---------

  @Get('calendar')
  @RequirePermissions('production.view')
  calendarView(@Query() query: CalendarQuery) {
    return this.calendar.view(query.from, query.to);
  }

  @Post('calendar/week')
  @RequirePermissions('production.manage')
  setWorkWeek(@Body() body: WorkWeekBody) {
    return this.calendar.setWorkWeek(body.days);
  }

  /** Праздник среди недели или рабочая суббота — исключением, а не календарём на год. */
  @Post('calendar/days')
  @RequirePermissions('production.manage')
  setCalendarDay(@Body() body: CalendarDayBody) {
    return this.calendar.setDay(body.day, body.isWorking, body.comment);
  }

  @Post('calendar/days/:day/clear')
  @RequirePermissions('production.manage')
  clearCalendarDay(@Param() params: DayParams) {
    return this.calendar.clearDay(params.day);
  }

  @Post('calendar/shifts')
  @RequirePermissions('production.manage')
  createShift(@Body() body: ShiftBody) {
    return this.calendar.saveShift(body);
  }

  @Patch('calendar/shifts/:uid')
  @RequirePermissions('production.manage')
  updateShift(@Param() params: ShiftParams, @Body() body: ShiftBody) {
    return this.calendar.saveShift(body, params.uid);
  }

  // --- Контроль: отклонения и простои (ТЗ 4.1) ----------------------------

  @Get('deviations')
  @RequirePermissions('production.view')
  deviations(@Query() query: DeviationsQuery) {
    return this.control.deviations(query.period ?? '30d', query.kind, query.limit ?? 100);
  }

  /** Простой участка руками: линия стояла и без заказа, и это надо записать. */
  @Post('deviations/downtime')
  @RequirePermissions('production.manage')
  registerDowntime(@Body() body: DowntimeBody) {
    return this.control.registerDowntime(body);
  }

  @Get('summary')
  @RequirePermissions('production.view')
  summary(@Query() query: SummaryQuery) {
    return this.production.summary(query.period ?? '30d');
  }

  @Get('orders')
  @RequirePermissions('production.view')
  list(@Query() query: OrdersQuery) {
    return this.orders.list(
      query.state ?? 'all',
      query.search,
      query.limit ?? 50,
      query.offset ?? 0,
    );
  }

  /** Что подставлять в форму заведения: продукция, ответственные, заказы продаж. */
  @Get('options')
  @RequirePermissions('production.view')
  options() {
    return this.write.options();
  }

  @Get('orders/:uid')
  @RequirePermissions('production.view')
  one(@Param() params: OrderParams) {
    return this.orders.one(params.uid);
  }

  @Post('orders')
  @RequirePermissions('production.manage')
  create(@Body() body: CreateOrderBody) {
    return this.write.create(body);
  }

  @Patch('orders/:uid')
  @RequirePermissions('production.manage')
  update(@Param() params: OrderParams, @Body() body: UpdateOrderBody) {
    return this.write.update(params.uid, {
      ...body,
      // Пустая строка приходит из формы, когда поле очистили: это «снять», а
      // не «не трогать». Отличие держится здесь, а не в службе.
      ...(body.responsibleUid === undefined
        ? {}
        : { responsibleUid: body.responsibleUid === '' ? null : body.responsibleUid }),
      ...(body.salesOrderUid === undefined
        ? {}
        : { salesOrderUid: body.salesOrderUid === '' ? null : body.salesOrderUid }),
    });
  }

  @Post('orders/:uid/status')
  @RequirePermissions('production.manage')
  setStatus(@Param() params: OrderParams, @Body() body: StatusBody) {
    return this.write.setStatus(params.uid, body.status, body.comment);
  }

  // --- Этапы заказа и отметки цеха (ТЗ 4.1) --------------------------------

  /** Мои задания: этапы, которые отмечать мне. */
  @Get('my-stages')
  @RequirePermissions('production.view')
  myStages(@Query() query: MineQuery) {
    return this.stages.mine(query.limit ?? 50);
  }

  /** Развернуть этапы из техкарты той версии, которую помнит заказ. */
  @Post('orders/:uid/stages/from-card')
  @RequirePermissions('production.manage')
  stagesFromCard(@Param() params: OrderParams) {
    return this.stages.planFromCard(params.uid);
  }

  /** Задать этапы руками — списком целиком. */
  @Put('orders/:uid/stages')
  @RequirePermissions('production.manage')
  stagesReplace(@Param() params: OrderParams, @Body() body: StagesBody) {
    return this.stages.replace(params.uid, body.stages);
  }

  /**
   * Отметка по этапу. Право своё: у станка стоит не тот, кто планирует, и
   * `production.work` не даёт ни заводить заказы, ни менять нормы.
   */
  @Post('orders/:uid/stages/:seq/mark')
  @RequirePermissions('production.work')
  stageMark(@Param() params: StageParams, @Body() body: MarkBody) {
    return this.stages.mark(params.uid, params.seq, body.kind, {
      reasonUid: body.reasonUid,
      comment: body.comment,
    });
  }

  // --- Материалы заказа: план, выдача в цех, возврат, расход (ТЗ 4.1) ------

  /** Где взять материал: склад, ячейка, партия и свободный остаток. */
  @Get('orders/:uid/materials/stock')
  @RequirePermissions('production.view')
  materialsStock(@Param() params: OrderParams, @Query() query: MaterialStockQuery) {
    return this.materials.whereToTake(params.uid, query.itemCode);
  }

  @Post('orders/:uid/materials/from-card')
  @RequirePermissions('production.manage')
  materialsFromCard(@Param() params: OrderParams) {
    return this.materials.planFromCard(params.uid);
  }

  @Put('orders/:uid/materials')
  @RequirePermissions('production.manage')
  materialsReplace(@Param() params: OrderParams, @Body() body: MaterialsBody) {
    return this.materials.replace(params.uid, body.materials);
  }

  /**
   * Выдача и возврат — складские движения, поэтому право складское: остаток
   * меняет движение, а не заказ. Проверку повторяет и сама служба.
   */
  @Post('orders/:uid/materials/issue')
  @RequirePermissions('warehouse.move')
  materialsIssue(@Param() params: OrderParams, @Body() body: MaterialMoveBody) {
    return this.materials.issue(params.uid, body);
  }

  @Post('orders/:uid/materials/return')
  @RequirePermissions('warehouse.move')
  materialsReturn(@Param() params: OrderParams, @Body() body: MaterialMoveBody) {
    return this.materials.returnToStock(params.uid, body);
  }

  /** Разложить этапы заказа по сменам: план дат и ответ «успеваем ли к сроку». */
  @Post('orders/:uid/stages/schedule')
  @RequirePermissions('production.manage')
  scheduleStages(@Param() params: OrderParams) {
    return this.calendar.scheduleStages(params.uid);
  }

  // --- Себестоимость заказа (ТЗ 4.7) --------------------------------------

  /** Текущий расчёт со строками и история: видно, почему цифра изменилась. */
  @Get('orders/:uid/cost')
  @RequirePermissions('production.view')
  cost(@Param() params: OrderParams) {
    return this.cost_.current(params.uid);
  }

  /** Посчитать и зафиксировать: снимок, а не формула на лету. */
  @Post('orders/:uid/cost')
  @RequirePermissions('production.manage')
  calculateCost(@Param() params: OrderParams) {
    return this.cost_.calculate(params.uid);
  }

  // --- Выпуск заказа: годное, брак, отход, переделка (ТЗ 4.1) -------------

  @Get('orders/:uid/outputs')
  @RequirePermissions('production.view')
  outputs(@Param() params: OrderParams) {
    return this.productionOutputs.list(params.uid);
  }

  /**
   * Записать выпуск. Годное и полуфабрикат уходят на склад тем же действием:
   * продукция, которой нет на складе, не продаётся и не считается.
   */
  @Post('orders/:uid/output')
  @RequirePermissions('production.manage')
  registerOutput(@Param() params: OrderParams, @Body() body: OutputBody) {
    return this.productionOutputs.register(params.uid, body);
  }

  /** Переделка брака — дочерний заказ, а не правка этого. */
  @Post('orders/:uid/rework')
  @RequirePermissions('production.manage')
  rework(@Param() params: OrderParams, @Body() body: ReworkBody) {
    return this.productionOutputs.rework(params.uid, body);
  }

  /** Сколько материала ушло в работу. Склада не касается — только заказа. */
  @Post('orders/:uid/materials/use')
  @RequirePermissions('production.manage')
  materialsUse(@Param() params: OrderParams, @Body() body: MaterialUseBody) {
    return this.materials.use(params.uid, body);
  }

  // --- Техкарты (ТЗ 4.1): норма, по которой считают заказ -------------------

  @Get('tech-cards')
  @RequirePermissions('production.view')
  cardList(@Query() query: CardsQuery) {
    return this.cards.list({
      status: query.status,
      itemCode: query.itemCode,
      limit: query.limit ?? 100,
    });
  }

  @Get('tech-cards/:uid')
  @RequirePermissions('production.view')
  card(@Param() params: CardParams) {
    return this.cards.one(params.uid);
  }

  @Post('tech-cards')
  @RequirePermissions('production.manage')
  cardCreate(@Body() body: CreateCardBody) {
    return this.cards.create(body);
  }

  @Patch('tech-cards/:uid')
  @RequirePermissions('production.manage')
  cardUpdate(@Param() params: CardParams, @Body() body: UpdateCardBody) {
    return this.cards.update(params.uid, body);
  }

  /** Правка действующей карты — это новая версия, а не правка на месте. */
  @Post('tech-cards/:uid/new-version')
  @RequirePermissions('production.manage')
  cardNewVersion(@Param() params: CardParams) {
    return this.cards.newVersion(params.uid);
  }

  @Post('tech-cards/:uid/activate')
  @RequirePermissions('production.manage')
  cardActivate(@Param() params: CardParams) {
    return this.cards.activate(params.uid);
  }

  @Post('tech-cards/:uid/archive')
  @RequirePermissions('production.manage')
  cardArchive(@Param() params: CardParams) {
    return this.cards.archive(params.uid);
  }
}
