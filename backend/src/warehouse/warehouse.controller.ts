import { Body, Controller, Delete, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBooleanString,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { WarehouseService, type Period } from './warehouse.service.js';
import { BatchesService } from './batches.service.js';
import {
  MovesService,
  OPERATION_TYPES,
  type OperationTypeName,
} from './moves.service.js';
import { WriteService, type MoveKind } from './write.service.js';
import { ReservationsService } from './reservations.service.js';
import { InventoryService } from './inventory.service.js';
import { CodesService } from './codes.service.js';
import { NeedsService } from './needs.service.js';
import { ReportsService, REPORT_KINDS, type ReportKind } from './reports.service.js';
import {
  REPORT_FORMATS,
  sendReportFile,
  PDF_ROW_LIMIT,
  type ReportFormat,
} from '../common/report-file.js';
import { RequirePermissions } from '../auth/auth.guard.js';

class SummaryQuery {
  @IsOptional()
  @IsIn(['7d', '30d', '3m'])
  period?: Period;
}

class StockQuery {
  @IsOptional()
  @IsUUID()
  warehouse?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsBooleanString()
  critical?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

class BatchParams {
  @IsUUID()
  uid!: string;
}

class SerialsQuery {
  @IsString()
  @MaxLength(60)
  itemCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  warehouseCode?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

/** Номер трубы человек читает с бирки и вбивает руками — это не uuid. */
class SerialParams {
  @IsString()
  @MaxLength(60)
  number!: string;
}

/** Дата фильтра — только `ГГГГ-ММ-ДД`: разбирать «вчера» и «25.09» сервер не берётся. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class MovesQueryDto {
  @IsOptional()
  @IsUUID()
  warehouse?: string;

  @IsOptional()
  @IsIn(OPERATION_TYPES)
  operationType?: OperationTypeName;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  itemCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  batchNumber?: string;

  @IsOptional()
  @IsUUID()
  partner?: string;

  @IsOptional()
  @Matches(DATE, { message: 'Дата «с»: формат ГГГГ-ММ-ДД' })
  from?: string;

  @IsOptional()
  @Matches(DATE, { message: 'Дата «по»: формат ГГГГ-ММ-ДД' })
  to?: string;

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

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  offset?: number;
}

class MoveParams {
  @IsUUID()
  uid!: string;
}

/**
 * Количество и себестоимость — строки, а не `number`: столбец `decimal(20,6)`,
 * и разбор через JSON-число потерял бы младшие знаки ещё до валидации.
 */
const QTY = /^\d{1,14}([.,]\d{1,6})?$/;
const COST = /^\d{1,15}([.,]\d{1,4})?$/;

class CreateMoveBody {
  @IsOptional()
  @IsUUID()
  companyUid?: string;

  @IsIn([
    'receipt',
    'write_off',
    'transfer',
    'issue_to_production',
    'return_from_production',
    'return_from_client',
    'surplus',
  ])
  operationType!: MoveKind;

  @IsString()
  @MaxLength(60)
  itemCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  batchNumber?: string;

  /** Штучный учёт: номер обязателен у позиции с `trackSerials`, количество 1. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  serialNumber?: string;

  @Matches(QTY, { message: 'Количество: число, до шести знаков после запятой' })
  qty!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  fromWarehouseCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  fromLocationCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  toWarehouseCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  toLocationCode?: string;

  @IsOptional()
  @Matches(COST, { message: 'Себестоимость: число, до четырёх знаков после запятой' })
  unitCost?: string;

  @IsOptional()
  @IsNumberString()
  reasonId?: string;

  @IsOptional()
  @IsUUID()
  partnerUid?: string;

  @IsOptional()
  @IsString()
  movedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

class ReservationsQuery {
  @IsOptional()
  @IsUUID()
  warehouse?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  itemCode?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

class CreateReservationBody {
  @IsOptional()
  @IsUUID()
  companyUid?: string;

  @IsString()
  @MaxLength(60)
  itemCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  batchNumber?: string;

  @IsString()
  @MaxLength(60)
  warehouseCode!: string;

  @Matches(QTY, { message: 'Количество: число, до шести знаков после запятой' })
  qty!: string;

  @IsOptional()
  @Matches(DATE, { message: 'Срок резерва: ГГГГ-ММ-ДД' })
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  salesOrderNumber?: string;
}

class ReservationParams {
  @IsUUID()
  uid!: string;
}

class InventoryQuery {
  @IsOptional()
  @IsUUID()
  warehouse?: string;

  @IsOptional()
  @IsIn(['draft', 'counting', 'review', 'approved', 'cancelled'])
  status?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

class CreateSheetBody {
  @IsOptional()
  @IsUUID()
  companyUid?: string;

  @IsString()
  @MaxLength(60)
  warehouseCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  zoneCode?: string;

  @IsOptional()
  @IsIn(['block', 'mark'])
  blockMode?: 'block' | 'mark';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

class CountBody {
  // Ноль — законный результат подсчёта: «на полке пусто» тоже надо записать.
  @Matches(QTY, { message: 'Количество: число, до шести знаков после запятой' })
  qty!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

class ReverseBody {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

class ScanQuery {
  // Сканер эмулирует клавиатуру и шлёт ровно то, что напечатано на этикетке.
  // Длина ограничена сверху: залипшая клавиша не должна уйти в базу строкой
  // на мегабайт.
  @IsString()
  @MaxLength(120)
  code!: string;
}

class NeedsQuery {
  @IsOptional()
  @IsUUID()
  warehouse?: string;

  @IsOptional()
  @IsIn(['critical', 'below_min'])
  state?: 'critical' | 'below_min';

  /**
   * Показать и позиции без нехватки. По умолчанию отчёт — это тревога: строки,
   * где всё в порядке, в нём только мешают. Но «посмотреть уровни целиком» —
   * законный вопрос, и заводить под него второй путь незачем.
   */
  @IsOptional()
  @IsBooleanString()
  all?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

class ReportParams {
  @IsIn(REPORT_KINDS)
  kind!: ReportKind;
}

class ReportQuery {
  @IsOptional()
  @IsUUID()
  warehouse?: string;

  @IsOptional()
  @Matches(DATE, { message: 'Дата «с»: формат ГГГГ-ММ-ДД' })
  from?: string;

  @IsOptional()
  @Matches(DATE, { message: 'Дата «по»: формат ГГГГ-ММ-ДД' })
  to?: string;

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

class LabelsBody {
  @IsUUID()
  templateUid!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  codes!: string[];

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(50)
  copies?: number;
}

/**
 * Склад: чтение и операции.
 *
 * На маршрутах записи стоит `warehouse.view`, а точное право проверяет сервис —
 * и это не ослабление, а единственный способ не соврать. Приходу нужно
 * `warehouse.move`, списанию — `warehouse.writeoff`; декоратор требует все
 * перечисленные права сразу, поэтому `warehouse.move` на маршруте молча закрыл
 * бы списание тому, у кого есть право списывать и нет права перемещать. Сейчас
 * такая роль в сиде не заведена, но опираться на состав сида в страже нельзя.
 */
@Controller('warehouse')
export class WarehouseController {
  constructor(
    private readonly warehouse: WarehouseService,
    private readonly batches: BatchesService,
    private readonly moves: MovesService,
    private readonly write: WriteService,
    private readonly reserve: ReservationsService,
    private readonly inventory: InventoryService,
    private readonly codes: CodesService,
    private readonly needs: NeedsService,
    private readonly reports: ReportsService,
  ) {}

  @Get('summary')
  @RequirePermissions('warehouse.view')
  summary(@Query() query: SummaryQuery) {
    return this.warehouse.summary(query.period ?? '30d');
  }

  @Get('stock')
  @RequirePermissions('warehouse.view')
  stock(@Query() query: StockQuery) {
    return this.warehouse.stock({
      warehouseUid: query.warehouse,
      search: query.search,
      criticalOnly: query.critical === 'true',
      limit: query.limit ?? 100,
    });
  }

  /**
   * Журнал движений. Отдельный список, а не карточка партии: кладовщик ищет
   * «что было на этом складе за неделю», не зная номера партии заранее.
   */
  @Get('moves')
  @RequirePermissions('warehouse.view')
  movesList(@Query() query: MovesQueryDto) {
    return this.moves.list({
      warehouseUid: query.warehouse,
      operationType: query.operationType,
      itemCode: query.itemCode,
      batchNumber: query.batchNumber,
      partnerUid: query.partner,
      from: query.from,
      to: query.to,
      search: query.search,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
  }

  @Get('batches/:uid')
  @RequirePermissions('warehouse.view')
  trace(@Param() params: BatchParams) {
    return this.batches.trace(params.uid);
  }

  @Get('serials')
  @RequirePermissions('warehouse.view')
  serials(@Query() query: SerialsQuery) {
    return this.batches.serials({
      itemCode: query.itemCode,
      warehouseCode: query.warehouseCode,
      limit: query.limit ?? 200,
    });
  }

  @Get('serials/:number')
  @RequirePermissions('warehouse.view')
  serialTrace(@Param() params: SerialParams) {
    return this.batches.serialTrace(params.number);
  }

  @Get('refs')
  @RequirePermissions('warehouse.view')
  refs() {
    return this.write.refs();
  }

  /**
   * Заголовок `Idempotency-Key` необязателен, но экран его шлёт всегда: без него
   * повторная отправка формы заведёт второй приход, и на складе окажется вдвое
   * больше товара, чем привезли.
   */
  @Post('moves')
  @RequirePermissions('warehouse.view')
  create(@Body() body: CreateMoveBody, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.write.create(body, idempotencyKey);
  }

  @Post('moves/:uid/reverse')
  @RequirePermissions('warehouse.view')
  reverse(@Param() params: MoveParams, @Body() body: ReverseBody) {
    return this.write.reverse(params.uid, body.comment);
  }

  /**
   * Резервы. Право на маршруте — `warehouse.view`, точное право проверяет
   * сервис: постановке и снятию нужно `warehouse.move`, а превышению
   * доступного ещё и `sales.order.oversell`.
   */
  @Get('reservations')
  @RequirePermissions('warehouse.view')
  reservations(@Query() query: ReservationsQuery) {
    return this.reserve.list({
      warehouseUid: query.warehouse,
      itemCode: query.itemCode,
      limit: query.limit ?? 50,
    });
  }

  @Post('reservations')
  @RequirePermissions('warehouse.view')
  reserveCreate(@Body() body: CreateReservationBody) {
    return this.reserve.create(body);
  }

  @Delete('reservations/:uid')
  @RequirePermissions('warehouse.view')
  reserveRelease(@Param() params: ReservationParams) {
    return this.reserve.release(params.uid);
  }

  /**
   * Инвентаризация (ТЗ 5.8). Смотреть листы может всякий, кто видит склад:
   * пересчёт объясняет расхождения в остатке, и прятать его от продаж незачем.
   * Кто может считать и кто утверждать — проверяет сервис, права разные.
   */
  @Get('inventory')
  @RequirePermissions('warehouse.view')
  sheets(@Query() query: InventoryQuery) {
    return this.inventory.list({
      warehouseUid: query.warehouse,
      status: query.status,
      limit: query.limit ?? 50,
    });
  }

  @Get('inventory/:uid')
  @RequirePermissions('warehouse.view')
  sheet(@Param() params: ReservationParams) {
    return this.inventory.get(params.uid);
  }

  @Post('inventory')
  @RequirePermissions('warehouse.view')
  sheetCreate(@Body() body: CreateSheetBody) {
    return this.inventory.create(body);
  }

  @Post('inventory/lines/:uid/count')
  @RequirePermissions('warehouse.view')
  sheetCount(@Param() params: ReservationParams, @Body() body: CountBody) {
    return this.inventory.count(params.uid, body);
  }

  @Post('inventory/:uid/finish')
  @RequirePermissions('warehouse.view')
  sheetFinish(@Param() params: ReservationParams) {
    return this.inventory.finish(params.uid);
  }

  @Post('inventory/:uid/approve')
  @RequirePermissions('warehouse.view')
  sheetApprove(@Param() params: ReservationParams) {
    return this.inventory.approve(params.uid);
  }

  @Delete('inventory/:uid')
  @RequirePermissions('warehouse.view')
  sheetCancel(@Param() params: ReservationParams) {
    return this.inventory.cancel(params.uid);
  }

  /**
   * Сканер и этикетки (ТЗ 5.9). Право на чтение: код ничего не меняет, он
   * только называет объект. Что кладовщику после скана позволено сделать,
   * решают уже маршруты записи.
   */
  @Get('scan')
  @RequirePermissions('warehouse.view')
  scan(@Query() query: ScanQuery) {
    return this.codes.scan(query.code);
  }

  /**
   * Потребность в закупке (ТЗ 5.10). Право — `warehouse.view`: отчёт только
   * читает и уровни не правит. Заводить под него право закупщика пока нечем —
   * самой закупки в системе нет, а право без роли, которая его носит, ничего
   * не закрывает.
   */
  @Get('purchase-needs')
  @RequirePermissions('warehouse.view')
  purchaseNeeds(@Query() query: NeedsQuery) {
    return this.needs.purchaseNeeds({
      warehouseUid: query.warehouse,
      state: query.state,
      all: query.all === 'true',
      limit: query.limit ?? 200,
    });
  }

  /**
   * Отчёты склада (ТЗ 5.1): остатки, движение, доступное и зарезервированное,
   * оборачиваемость, расхождения инвентаризации.
   *
   * Отчёт и его выгрузка — один и тот же расчёт, поэтому строит их один
   * сервис. Разные пути у них только потому, что ответы разной природы: здесь
   * конверт `{data, meta}`, там файл. Класть файл в конверт значило бы отдавать
   * base64, а по нему браузер файла не сохранит.
   */
  @Get('reports/:kind')
  @RequirePermissions('warehouse.view')
  report(@Param() params: ReportParams, @Query() query: ReportQuery) {
    return this.reports.build({
      kind: params.kind,
      warehouseUid: query.warehouse,
      from: query.from,
      to: query.to,
      limit: query.limit ?? 1000,
    });
  }

  /**
   * Выгрузка отчёта файлом.
   *
   * `@Res()` без `passthrough` — сознательно: Nest тогда не досылает ответ сам,
   * а конверт-перехватчик не пытается завернуть файл в JSON. Иначе на один
   * запрос ушло бы два ответа.
   */
  @Get('reports/:kind/file')
  @RequirePermissions('warehouse.view')
  async reportFile(
    @Param() params: ReportParams,
    @Query() query: ReportFileQuery,
    @Res() res: Response,
  ) {
    const report = await this.reports.build({
      kind: params.kind,
      warehouseUid: query.warehouse,
      from: query.from,
      to: query.to,
      // Выгрузка — это весь отчёт, а не первая тысяча строк: файл на то и
      // файл. Предел остаётся, но верхний, чтобы запросом не выложить базу.
      // У PDF он ниже: его печатают, а не считают в нём.
      limit: query.limit ?? (query.format === 'pdf' ? PDF_ROW_LIMIT : 20000),
    });

    const stamp = new Date().toISOString().slice(0, 10);
    await sendReportFile(res, report, `sklad-${params.kind}-${stamp}`, query.format);
  }

  @Get('labels/templates')
  @RequirePermissions('warehouse.view')
  labelTemplates() {
    return this.codes.templates();
  }

  @Post('labels')
  @RequirePermissions('warehouse.view')
  labels(@Body() body: LabelsBody) {
    return this.codes.labels(body);
  }
}
