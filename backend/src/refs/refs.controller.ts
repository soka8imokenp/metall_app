import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsBooleanString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { RefsService } from './refs.service.js';
import { RatesService } from './rates.service.js';
import { PlacesService } from './places.service.js';
import { PricesService } from './prices.service.js';
import { RequirePermissions } from '../auth/auth.guard.js';

const ITEM_TYPES = ['raw', 'goods', 'component', 'semi', 'finished'] as const;
const REASON_KINDS = ['write_off', 'downtime', 'defect', 'inventory'] as const;
const COSTING_METHODS = ['fifo', 'weighted_average'] as const;
const PRICE_KINDS = ['retail', 'wholesale', 'contract', 'cash', 'cashless'] as const;
const BELOW_COST_MODES = ['block', 'approve'] as const;
/** Дата без времени: прайс действует днями, а не секундами. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

class UidParams {
  @IsUUID()
  uid!: string;
}

class ListQuery {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

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

class UnitFactorDto {
  @IsString()
  @MaxLength(12)
  unit!: string;

  @IsNumber()
  @IsPositive()
  factor!: number;
}

class ItemBody {
  @IsOptional()
  @IsUUID()
  companyUid?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameRu!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameUz?: string;

  @IsIn(ITEM_TYPES)
  itemType!: string;

  @IsString()
  @MaxLength(12)
  baseUnit!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  vatRate?: number;

  @IsOptional() @IsBoolean() trackBatches?: boolean;
  @IsOptional() @IsBoolean() trackSerials?: boolean;
  @IsOptional() @IsBoolean() isWeighted?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;

  @IsOptional() @IsNumber() @Min(0) minQty?: number;
  @IsOptional() @IsNumber() @Min(0) criticalQty?: number;

  @IsOptional() @IsString() @MaxLength(60) barcode?: string;

  // --- характеристики металлопроката (ТЗ 5.2) ---
  @IsOptional() @IsString() @MaxLength(60) pipeType?: string;
  @IsOptional() @IsString() @MaxLength(60) steelGrade?: string;
  @IsOptional() @IsNumber() @IsPositive() diameterMm?: number;
  @IsOptional() @IsNumber() @IsPositive() wallThicknessMm?: number;
  @IsOptional() @IsNumber() @IsPositive() lengthMm?: number;
  @IsOptional() @IsNumber() @IsPositive() weightKgPerUnit?: number;
  @IsOptional() @IsString() @MaxLength(60) insulationType?: string;
  @IsOptional() @IsString() @MaxLength(60) gost?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => UnitFactorDto)
  units?: UnitFactorDto[];
}

/** Правка: то же тело, но всё необязательно — меняют одно поле, а не карточку целиком. */
class ItemPatchBody {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) code?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) nameRu?: string;
  @IsOptional() @IsString() @MaxLength(200) nameUz?: string;
  @IsOptional() @IsIn(ITEM_TYPES) itemType?: string;
  @IsOptional() @IsString() @MaxLength(12) baseUnit?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) vatRate?: number;
  @IsOptional() @IsBoolean() trackBatches?: boolean;
  @IsOptional() @IsBoolean() trackSerials?: boolean;
  @IsOptional() @IsBoolean() isWeighted?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsNumber() @Min(0) minQty?: number;
  @IsOptional() @IsNumber() @Min(0) criticalQty?: number;
  @IsOptional() @IsString() @MaxLength(60) barcode?: string;
  @IsOptional() @IsString() @MaxLength(60) pipeType?: string;
  @IsOptional() @IsString() @MaxLength(60) steelGrade?: string;
  @IsOptional() @IsNumber() @IsPositive() diameterMm?: number;
  @IsOptional() @IsNumber() @IsPositive() wallThicknessMm?: number;
  @IsOptional() @IsNumber() @IsPositive() lengthMm?: number;
  @IsOptional() @IsNumber() @IsPositive() weightKgPerUnit?: number;
  @IsOptional() @IsString() @MaxLength(60) insulationType?: string;
  @IsOptional() @IsString() @MaxLength(60) gost?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => UnitFactorDto)
  units?: UnitFactorDto[];
}

class WarehouseBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsString() @MinLength(1) @MaxLength(30) code!: string;
  @IsString() @MinLength(1) @MaxLength(120) nameRu!: string;
  @IsOptional() @IsString() @MaxLength(120) nameUz?: string;
  @IsOptional() @IsString() @MaxLength(200) address?: string;
}

class WarehousePatchBody {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(30) code?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) nameRu?: string;
  @IsOptional() @IsString() @MaxLength(120) nameUz?: string;
  @IsOptional() @IsString() @MaxLength(200) address?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class ZoneBody {
  @IsUUID() warehouseUid!: string;
  @IsString() @MinLength(1) @MaxLength(30) code!: string;
  @IsString() @MinLength(1) @MaxLength(120) nameRu!: string;
  @IsOptional() @IsString() @MaxLength(120) nameUz?: string;
}

class LocationBody {
  @IsUUID() zoneUid!: string;
  @IsString() @MinLength(1) @MaxLength(30) code!: string;
  @IsOptional() @IsString() @MaxLength(60) barcode?: string;
}

class LocationPatchBody {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(30) code?: string;
  @IsOptional() @IsString() @MaxLength(60) barcode?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class ReasonBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsIn(REASON_KINDS) kind!: string;
  @IsString() @MinLength(1) @MaxLength(120) nameRu!: string;
  @IsOptional() @IsString() @MaxLength(120) nameUz?: string;
}

class ReasonPatchBody {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) nameRu?: string;
  @IsOptional() @IsString() @MaxLength(120) nameUz?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class LevelBody {
  @IsUUID() itemUid!: string;
  @IsUUID() warehouseUid!: string;
  @IsNumber() @Min(0) minQty!: number;
  @IsNumber() @Min(0) criticalQty!: number;
  @IsOptional() @IsString() @MaxLength(200) comment?: string;
}

class SettingsQuery {
  @IsOptional()
  @IsUUID()
  companyUid?: string;
}

class SettingsBody {
  @IsOptional()
  @IsUUID()
  companyUid?: string;

  @IsOptional()
  @IsIn(COSTING_METHODS)
  costingMethod?: string;

  /** ТЗ 9.2: продажа дешевле себестоимости — запрет или по праву. */
  @IsOptional()
  @IsIn(BELOW_COST_MODES)
  belowCostMode?: string;

  /**
   * Порог «крупного платежа» и предел на получателя за окно — в базовой валюте
   * компании (требование заказчика 07.10).
   *
   * `null` присылают, чтобы снять ограничение, и `@IsOptional()` его
   * пропускает: для class-validator `null` — это «значения нет». Нам он нужен
   * именно как значение, и сервис различает `null` и `undefined` сам.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  approvalLimitSingle?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  approvalLimitPeriod?: number | null;

  /** Окно предела в днях: день, неделя, месяц. Больше года смысла не имеет. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(366)
  approvalPeriodDays?: number;
}

class PriceTypeBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsString() @MinLength(2) @MaxLength(32) code!: string;
  @IsString() @MinLength(1) @MaxLength(80) nameRu!: string;
  @IsOptional() @IsString() @MaxLength(80) nameUz?: string;
  @IsIn(PRICE_KINDS) kind!: string;
}

class PriceTypePatchBody {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) nameRu?: string;
  @IsOptional() @IsString() @MaxLength(80) nameUz?: string;
  @IsOptional() @IsIn(PRICE_KINDS) kind?: string;
}

class PricesQuery {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsString() @Matches(DAY, { message: 'onDate: дата в виде ГГГГ-ММ-ДД' }) onDate?: string;
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(0) offset?: number;
}

class PriceHistoryQuery {
  @IsUUID() itemUid!: string;
  @IsUUID() priceTypeUid!: string;
}

class PriceBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsString() @MinLength(1) @MaxLength(60) itemCode!: string;
  @IsString() @MinLength(1) @MaxLength(32) priceTypeCode!: string;
  @IsNumber() @IsPositive() price!: number;
  @IsOptional() @IsString() @Matches(DAY, { message: 'validFrom: дата в виде ГГГГ-ММ-ДД' }) validFrom?: string;
}

class PartnerPricesQuery {
  @IsUUID() partnerUid!: string;
  @IsOptional() @IsString() @Matches(DAY, { message: 'onDate: дата в виде ГГГГ-ММ-ДД' }) onDate?: string;
}

class PartnerPriceBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsUUID() partnerUid!: string;
  @IsString() @MinLength(1) @MaxLength(60) itemCode!: string;
  @IsNumber() @IsPositive() price!: number;
  @IsOptional() @IsString() @Matches(DAY, { message: 'validFrom: дата в виде ГГГГ-ММ-ДД' }) validFrom?: string;
}

/** Код валюты — три латинские буквы, как у ЦБ РУз и в ISO 4217. */
const CCY = /^[A-Za-z]{3}$/;

class CurrencyParams {
  @IsString() @Matches(CCY, { message: 'code: код валюты из трёх латинских букв' })
  @Transform(({ value }) => String(value).toUpperCase())
  code!: string;
}

class RateBody {
  @IsString() @Matches(DAY, { message: 'rateDate: дата в виде ГГГГ-ММ-ДД' }) rateDate!: string;
  /** Проверку «больше нуля» делает служба: её отказ написан словами. */
  @IsNumber() rate!: number;
}

class RatesQuery {
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(400) limit?: number;
}

class SyncBody {
  @IsOptional() @IsBoolean() force?: boolean;
}

class CurrencyBody {
  @IsString() @Matches(CCY, { message: 'code: код валюты из трёх латинских букв' }) code!: string;
}

class AutoloadBody {
  @IsBoolean() autoload!: boolean;
}

/**
 * Справочники (ТЗ 5.2, 5.3, 5.7, 5.10).
 *
 * Чтение — правом `warehouse.view`: справочник видит каждый, кто работает со
 * складом, иначе форма операции останется без подбора. Запись — отдельным
 * правом `refs.edit`: движение делает кладовщик у полки, а номенклатуру и
 * склады заводит тот, кто отвечает за то, как это всё названо и посчитано.
 */
@Controller('refs')
export class RefsController {
  constructor(
    private readonly refs: RefsService,
    private readonly places: PlacesService,
    private readonly prices: PricesService,
    private readonly rates: RatesService,
  ) {}

  // --- номенклатура ---
  @Get('items')
  @RequirePermissions('warehouse.view')
  items(@Query() query: ListQuery) {
    return this.refs.items({
      search: query.search,
      limit: query.limit,
      all: query.all === 'true',
    });
  }

  @Post('items')
  @RequirePermissions('refs.edit')
  createItem(@Body() body: ItemBody) {
    return this.refs.createItem(body as never);
  }

  @Patch('items/:uid')
  @RequirePermissions('refs.edit')
  updateItem(@Param() params: UidParams, @Body() body: ItemPatchBody) {
    return this.refs.updateItem(params.uid, body as never);
  }

  @Delete('items/:uid')
  @RequirePermissions('refs.edit')
  deleteItem(@Param() params: UidParams) {
    return this.refs.deleteItem(params.uid);
  }

  // --- настройки учёта ---
  @Get('settings')
  @RequirePermissions('warehouse.view')
  settings(@Query() query: SettingsQuery) {
    return this.places.settings(query.companyUid);
  }

  @Patch('settings')
  @RequirePermissions('settings.edit')
  setSettings(@Body() body: SettingsBody) {
    return this.places.setSettings(body);
  }

  // --- типы цен и прайс-лист (ТЗ 9.2) ---
  //
  // Чтение — правом `sales.view`: цена нужна тому, кто выписывает заказ, а не
  // кладовщику у полки. Запись — `refs.edit`: прайс назначает тот, кто
  // отвечает за цифры, а не каждый менеджер в своём заказе.

  @Get('price-types')
  @RequirePermissions('sales.view')
  priceTypes(@Query() query: SettingsQuery) {
    return this.prices.priceTypes(query.companyUid);
  }

  @Post('price-types')
  @RequirePermissions('refs.edit')
  createPriceType(@Body() body: PriceTypeBody) {
    return this.prices.createPriceType(body as never);
  }

  @Patch('price-types/:uid')
  @RequirePermissions('refs.edit')
  updatePriceType(@Param() params: UidParams, @Body() body: PriceTypePatchBody) {
    return this.prices.updatePriceType(params.uid, body as never);
  }

  @Delete('price-types/:uid')
  @RequirePermissions('refs.edit')
  deletePriceType(@Param() params: UidParams) {
    return this.prices.deletePriceType(params.uid);
  }

  @Get('prices')
  @RequirePermissions('sales.view')
  pricesList(@Query() query: PricesQuery) {
    return this.prices.prices(query);
  }

  @Get('prices/history')
  @RequirePermissions('sales.view')
  priceHistory(@Query() query: PriceHistoryQuery) {
    return this.prices.priceHistory(query);
  }

  @Post('prices')
  @RequirePermissions('refs.edit')
  setPrice(@Body() body: PriceBody) {
    return this.prices.setPrice(body as never);
  }

  @Delete('prices/:uid')
  @RequirePermissions('refs.edit')
  deletePrice(@Param() params: UidParams) {
    return this.prices.deletePrice(params.uid);
  }

  @Get('partner-prices')
  @RequirePermissions('sales.view')
  partnerPrices(@Query() query: PartnerPricesQuery) {
    return this.prices.partnerPrices(query);
  }

  @Post('partner-prices')
  @RequirePermissions('refs.edit')
  setPartnerPrice(@Body() body: PartnerPriceBody) {
    return this.prices.setPartnerPrice(body as never);
  }

  @Delete('partner-prices/:uid')
  @RequirePermissions('refs.edit')
  deletePartnerPrice(@Param() params: UidParams) {
    return this.prices.deletePartnerPrice(params.uid);
  }

  // --- места хранения ---
  @Get('places')
  @RequirePermissions('warehouse.view')
  placesTree(@Query() query: ListQuery) {
    return this.places.places(query.all === 'true');
  }

  @Post('warehouses')
  @RequirePermissions('refs.edit')
  createWarehouse(@Body() body: WarehouseBody) {
    return this.places.createWarehouse(body);
  }

  @Patch('warehouses/:uid')
  @RequirePermissions('refs.edit')
  updateWarehouse(@Param() params: UidParams, @Body() body: WarehousePatchBody) {
    return this.places.updateWarehouse(params.uid, body);
  }

  @Post('zones')
  @RequirePermissions('refs.edit')
  createZone(@Body() body: ZoneBody) {
    return this.places.createZone(body);
  }

  @Post('locations')
  @RequirePermissions('refs.edit')
  createLocation(@Body() body: LocationBody) {
    return this.places.createLocation(body);
  }

  @Patch('locations/:uid')
  @RequirePermissions('refs.edit')
  updateLocation(@Param() params: UidParams, @Body() body: LocationPatchBody) {
    return this.places.updateLocation(params.uid, body);
  }

  @Delete('locations/:uid')
  @RequirePermissions('refs.edit')
  deleteLocation(@Param() params: UidParams) {
    return this.places.deleteLocation(params.uid);
  }

  // --- причины списания ---
  @Get('reasons')
  @RequirePermissions('warehouse.view')
  reasons(@Query() query: ListQuery) {
    return this.places.reasons(query.all === 'true');
  }

  @Post('reasons')
  @RequirePermissions('refs.edit')
  createReason(@Body() body: ReasonBody) {
    return this.places.createReason(body);
  }

  @Patch('reasons/:uid')
  @RequirePermissions('refs.edit')
  updateReason(@Param() params: UidParams, @Body() body: ReasonPatchBody) {
    return this.places.updateReason(params.uid, body);
  }

  @Delete('reasons/:uid')
  @RequirePermissions('refs.edit')
  deleteReason(@Param() params: UidParams) {
    return this.places.deleteReason(params.uid);
  }

  // --- валюты и курсы (ТЗ 6.1-6.3) ---
  //
  // Чтение — правом `finance.view`: курс нужен тому, кто работает с деньгами.
  // Запись — `refs.edit`, как у остальных справочников: курс задаёт тот, кто
  // отвечает за то, по чему считаются суммы, а не каждый, кто их видит.
  @Get('currencies')
  @RequirePermissions('finance.view')
  currencies() {
    return this.rates.list();
  }

  @Get('currencies/available')
  @RequirePermissions('refs.edit')
  availableCurrencies() {
    return this.rates.available();
  }

  @Get('currencies/:code/rates')
  @RequirePermissions('finance.view')
  currencyRates(@Param() params: CurrencyParams, @Query() query: RatesQuery) {
    return this.rates.history(params.code, query.limit ?? 30);
  }

  @Post('currencies/sync')
  @RequirePermissions('refs.edit')
  syncCurrencies(@Body() body: SyncBody) {
    return this.rates.sync({ force: body.force ?? false, userDriven: true });
  }

  @Post('currencies/:code/rates')
  @RequirePermissions('refs.edit')
  setRate(@Param() params: CurrencyParams, @Body() body: RateBody) {
    return this.rates.setRate(params.code, body);
  }

  @Post('currencies')
  @RequirePermissions('refs.edit')
  addCurrency(@Body() body: CurrencyBody) {
    return this.rates.addCurrency(body.code);
  }

  @Patch('currencies/:code')
  @RequirePermissions('refs.edit')
  setCurrencyAutoload(@Param() params: CurrencyParams, @Body() body: AutoloadBody) {
    return this.rates.setAutoload(params.code, body.autoload);
  }

  // --- уровни запаса на склад ---
  @Get('stock-levels')
  @RequirePermissions('warehouse.view')
  levels() {
    return this.places.levels();
  }

  @Post('stock-levels')
  @RequirePermissions('refs.edit')
  setLevel(@Body() body: LevelBody) {
    return this.places.setLevel(body);
  }

  @Delete('stock-levels/:uid')
  @RequirePermissions('refs.edit')
  deleteLevel(@Param() params: UidParams) {
    return this.places.deleteLevel(params.uid);
  }
}
