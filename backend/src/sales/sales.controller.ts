import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
import { SalesService, type Period } from './sales.service.js';
import { OrdersService, type Stage } from './orders.service.js';
import { SalesWriteService, type OrderStatusName } from './write.service.js';
import { RequirePermissions } from '../auth/auth.guard.js';

class SummaryQuery {
  @IsOptional()
  @IsIn(['7d', '30d', '3m'])
  period?: Period;
}

class OrdersQuery {
  @IsOptional()
  @IsIn(['all', 'unpaid', 'paid', 'production', 'shipped'])
  stage?: Stage;

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

class LimitQuery {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

class OrderParams {
  @IsUUID()
  uid!: string;
}

/**
 * Количество, цена и процент — строки, а не `number`: столбцы `decimal`, и
 * разбор через JSON-число потерял бы младшие знаки ещё до валидации.
 */
const QTY = /^\d{1,14}([.,]\d{1,6})?$/;
const MONEY = /^\d{1,15}([.,]\d{1,4})?$/;
const PERCENT = /^\d{1,3}([.,]\d{1,4})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

class OrderLineBody {
  @IsString()
  @MaxLength(60)
  itemCode!: string;

  @Matches(QTY, { message: 'Количество: число, до шести знаков после запятой' })
  qty!: string;

  /**
   * Пусто — цену подставит прайс или индивидуальная цена клиента (ТЗ 9.2).
   * Задана — это ручной ввод: он требует права `sales.price`, если отличается
   * от прайса, и основания в `priceComment` всегда.
   */
  @IsOptional()
  @Matches(MONEY, { message: 'Цена: число, до четырёх знаков после запятой' })
  price?: string;

  @IsOptional()
  @Matches(PERCENT, { message: 'Скидка: процент, до четырёх знаков после запятой' })
  discountPercent?: string;

  @IsOptional()
  @Matches(PERCENT, { message: 'НДС: процент, до четырёх знаков после запятой' })
  vatRate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  priceComment?: string;
}

/** Подсказка цены по клиенту и позиции (ТЗ 9.2). */
class PriceQuery {
  @IsUUID()
  partnerUid!: string;

  @IsString()
  @MaxLength(60)
  itemCode!: string;

  @IsOptional()
  @Matches(DAY, { message: 'Дата: ГГГГ-ММ-ДД' })
  onDate?: string;
}

class CreateOrderBody {
  @IsOptional()
  @IsUUID()
  companyUid?: string;

  @IsUUID()
  partnerUid!: string;

  @IsOptional()
  @Matches(DAY, { message: 'Дата заказа: ГГГГ-ММ-ДД' })
  orderDate?: string;

  @IsOptional()
  @Matches(DAY, { message: 'Дата поставки: ГГГГ-ММ-ДД' })
  deliveryDate?: string;

  @IsOptional()
  @Matches(DAY, { message: 'Срок оплаты: ГГГГ-ММ-ДД' })
  paymentDueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  warehouseCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => OrderLineBody)
  lines!: OrderLineBody[];
}

class StatusBody {
  @IsIn([
    'draft',
    'confirmed',
    'reserved',
    'in_production',
    'picking',
    'shipped',
    'closed',
    'cancelled',
  ])
  status!: OrderStatusName;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

class ShipmentLineBody {
  @IsUUID()
  lineUid!: string;

  @Matches(QTY, { message: 'Количество: число, до шести знаков после запятой' })
  qty!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  batchNumber?: string;

  /** Номера труб: столько же, сколько штук в строке (ТЗ 5.6). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  serialNumbers?: string[];
}

class CreateShipmentBody {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  warehouseCode?: string;

  @IsOptional()
  @IsString()
  shippedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  vehicle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  driver?: string;

  @IsOptional()
  @Matches(QTY, { message: 'Вес нетто: число, до шести знаков после запятой' })
  netWeightT?: string;

  @IsOptional()
  @Matches(QTY, { message: 'Вес брутто: число, до шести знаков после запятой' })
  grossWeightT?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ShipmentLineBody)
  lines!: ShipmentLineBody[];
}

/**
 * Продажи: чтение и документы.
 *
 * На маршрутах записи стоит `sales.view`, а точное право проверяет сервис — и
 * это не ослабление, а единственный способ не соврать. Заказ и ТТН требуют
 * `sales.edit`, отмена заказа — `sales.delete`; декоратор требует все
 * перечисленные права сразу, поэтому `sales.edit` на маршруте смены статуса
 * молча закрыл бы отмену тому, у кого есть право отменять и нет права править.
 */
@Controller('sales')
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly orders: OrdersService,
    private readonly write: SalesWriteService,
  ) {}

  @Get('summary')
  @RequirePermissions('sales.view')
  summary(@Query() query: SummaryQuery) {
    return this.sales.summary(query.period ?? '30d');
  }

  @Get('orders')
  @RequirePermissions('sales.view')
  list(@Query() query: OrdersQuery) {
    return this.orders.list(query.stage ?? 'all', query.search, query.limit ?? 50);
  }

  @Get('orders/:uid')
  @RequirePermissions('sales.view')
  one(@Param() params: OrderParams) {
    return this.orders.one(params.uid);
  }

  @Get('shipments')
  @RequirePermissions('sales.view')
  shipments(@Query() query: LimitQuery) {
    return this.orders.shipments(query.limit ?? 50);
  }

  @Get('refs')
  @RequirePermissions('sales.view')
  refs() {
    return this.write.refs();
  }

  @Get('price')
  @RequirePermissions('sales.view')
  priceHint(@Query() query: PriceQuery) {
    return this.write.priceHint(query);
  }

  @Get('orders/:uid/availability')
  @RequirePermissions('sales.view')
  availability(@Param() params: OrderParams) {
    return this.write.availability(params.uid);
  }

  @Post('orders')
  @RequirePermissions('sales.view')
  createOrder(@Body() body: CreateOrderBody) {
    return this.write.createOrder(body);
  }

  @Post('orders/:uid/status')
  @RequirePermissions('sales.view')
  setStatus(@Param() params: OrderParams, @Body() body: StatusBody) {
    return this.write.setStatus(params.uid, body.status, body.comment);
  }

  /**
   * Заголовок `Idempotency-Key` необязателен, но экран его шлёт всегда: без
   * него повторная отправка формы выпишет вторую ТТН, и со склада уедет вдвое
   * больше товара, чем погрузили.
   */
  @Post('orders/:uid/shipments')
  @RequirePermissions('sales.view')
  createShipment(
    @Param() params: OrderParams,
    @Body() body: CreateShipmentBody,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.write.createShipment({ ...body, orderUid: params.uid }, idempotencyKey);
  }

  @Get('partners')
  @RequirePermissions('sales.view')
  partners(@Query() query: LimitQuery) {
    return this.sales.partners(query.limit ?? 50);
  }
}
