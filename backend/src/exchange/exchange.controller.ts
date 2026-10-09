import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import type { Request, Response } from 'express';
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
  MinLength,
} from 'class-validator';
import { RequirePermissions } from '../auth/auth.guard.js';
import { MSG } from '../common/messages.js';
import { sendReportFile, type ReportFormat } from '../common/report-file.js';
import { ExchangeSystemsService } from './systems.service.js';
import { ExchangeSubscriptionsService } from './subscriptions.service.js';
import { ExchangeJournalService } from './journal.service.js';
import { ExchangeMappingService } from './mapping.service.js';
import { ExchangeOutboxService } from './outbox.service.js';
import { ExchangeItemsFileService } from './items-file.service.js';

const SYSTEM_CODE_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const DIRECTIONS = ['in', 'out'] as const;
const STATUSES = ['pending', 'done', 'failed', 'dead'] as const;
/** Форматы выгрузки обмена: только то, что читает чужая программа и человек. */
const FILE_FORMATS = ['xlsx', 'csv'] as const;

class UidParams {
  @IsUUID() uid!: string;
}

class SystemCreateBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @Matches(SYSTEM_CODE_RE, {
    message: 'Код системы: латиница, цифры, дефис и подчёркивание',
  })
  code!: string;
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) allowedIps?: string[];
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
  /** Нужна ли подпись входящих. По умолчанию да: без неё хватает одного ключа. */
  @IsOptional() @IsBoolean() withSecret?: boolean;
}

class SystemPatchBody {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) allowedIps?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
}

class KeyBody {
  @IsOptional() @IsBoolean() withSecret?: boolean;
}

class SubscriptionBody {
  @IsString() @MaxLength(80) event!: string;
  @IsString() @MaxLength(500) url!: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class MappingBody {
  @IsUUID() systemUid!: string;
  @IsString() @MinLength(1) @MaxLength(60) entityType!: string;
  @IsString() @MinLength(1) @MaxLength(200) externalId!: string;
  @IsUUID() internalUid!: string;
}

class MessagesQuery {
  @IsOptional() @IsUUID() systemUid?: string;
  @IsOptional() @IsIn(DIRECTIONS) direction?: string;
  @IsOptional() @IsIn(STATUSES) status?: string;
  @IsOptional() @IsString() @MaxLength(80) event?: string;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(0) offset?: number;
}

class MappingQuery {
  @IsOptional() @IsUUID() systemUid?: string;
  @IsOptional() @IsString() @MaxLength(60) entityType?: string;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(500) limit?: number;
}

class ItemsFileQuery {
  @IsIn(FILE_FORMATS) format!: string;
}

class ImportQuery {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @IsIn(['true', 'false']) dryRun?: string;
  @IsOptional() @IsUUID() systemUid?: string;
}

/**
 * Обменный слой: подключения, подписки, журнал обменов, карта соответствий,
 * импорт и экспорт файлов (ТЗ 12).
 *
 * Право на все маршруты — `admin.users`, то же, что у журналов действий и
 * входов. Своего права (`admin.integrations`) обмен по смыслу просит: ключ
 * внешней системы это доступ к данным компании, и давать его тому, кто просто
 * заводит людей, в разделённых ролях неправильно. Но заказчик отложил
 * разделение ролей на конец проекта, и заводить право сейчас значит кроить
 * права дважды — раздел «Настройки» целиком уже закрыт `admin.users`, и вкладка
 * обмена стоит в нём за тем же замком. Вынесено в открытые вопросы этапа ролей.
 */
@Controller('exchange')
export class ExchangeController {
  constructor(
    private readonly systems: ExchangeSystemsService,
    private readonly subs: ExchangeSubscriptionsService,
    private readonly journal: ExchangeJournalService,
    private readonly mapping: ExchangeMappingService,
    private readonly outbox: ExchangeOutboxService,
    private readonly itemsFile: ExchangeItemsFileService,
  ) {}

  // --- подключения ----------------------------------------------------------

  @Get('systems')
  @RequirePermissions('admin.users')
  listSystems() {
    return this.systems.list();
  }

  /** Ключ (и секрет, если заказан) есть только в этом ответе. Дальше — хвост. */
  @Post('systems')
  @RequirePermissions('admin.users')
  createSystem(@Body() body: SystemCreateBody) {
    return this.systems.create({
      companyUid: body.companyUid,
      code: body.code,
      name: body.name,
      allowedIps: body.allowedIps,
      comment: body.comment,
      withSecret: body.withSecret ?? true,
    });
  }

  @Patch('systems/:uid')
  @RequirePermissions('admin.users')
  updateSystem(@Param() p: UidParams, @Body() body: SystemPatchBody) {
    return this.systems.update(p.uid, body);
  }

  @Post('systems/:uid/key')
  @RequirePermissions('admin.users')
  rotateKey(@Param() p: UidParams, @Body() body: KeyBody) {
    return this.systems.rotateKey(p.uid, body.withSecret);
  }

  // --- подписки на события --------------------------------------------------

  @Get('systems/:uid/subscriptions')
  @RequirePermissions('admin.users')
  listSubs(@Param() p: UidParams) {
    return this.subs.list(p.uid);
  }

  @Put('systems/:uid/subscriptions')
  @RequirePermissions('admin.users')
  putSub(@Param() p: UidParams, @Body() body: SubscriptionBody) {
    return this.subs.put(p.uid, body);
  }

  @Delete('subscriptions/:uid')
  @RequirePermissions('admin.users')
  removeSub(@Param() p: UidParams) {
    return this.subs.remove(p.uid);
  }

  /** Каталог событий: то, что система действительно сообщала хоть раз. */
  @Get('events')
  @RequirePermissions('admin.users')
  events() {
    return this.journal.events();
  }

  // --- журнал обменов -------------------------------------------------------

  @Get('messages')
  @RequirePermissions('admin.users')
  messages(@Query() q: MessagesQuery) {
    return this.journal.messages({
      systemUid: q.systemUid,
      direction: q.direction,
      status: q.status,
      event: q.event,
      search: q.search,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    });
  }

  @Get('messages/facets')
  @RequirePermissions('admin.users')
  facets() {
    return this.journal.facets();
  }

  /**
   * Повтор неудачного обмена кнопкой. Счёт попыток обнуляется, срок — сейчас:
   * человек нажал её потому, что на той стороне починили, и ждать ещё час
   * после этого бессмысленно.
   */
  @Post('messages/:uid/retry')
  @RequirePermissions('admin.users')
  retry(@Param() p: UidParams) {
    return this.outbox.retry(p.uid);
  }

  // --- карта соответствий ---------------------------------------------------

  @Get('refs')
  @RequirePermissions('admin.users')
  refs(@Query() q: MappingQuery) {
    return this.mapping.list({
      systemUid: q.systemUid,
      entityType: q.entityType,
      search: q.search,
      limit: q.limit ?? 100,
    });
  }

  @Put('refs')
  @RequirePermissions('admin.users')
  putRef(@Body() body: MappingBody) {
    return this.mapping.put(body);
  }

  @Delete('refs/:uid')
  @RequirePermissions('admin.users')
  removeRef(@Param() p: UidParams) {
    return this.mapping.remove(p.uid);
  }

  // --- файлы ----------------------------------------------------------------

  /**
   * Выгрузка номенклатуры. `@Res()` без passthrough — как у отчётов: иначе
   * конверт-перехватчик обернёт байты в JSON, и файл не сохранится.
   */
  @Get('items/file')
  @RequirePermissions('admin.users')
  async itemsFileDownload(@Query() q: ItemsFileQuery, @Res() res: Response) {
    const table = await this.itemsFile.table();
    await sendReportFile(res, table, 'nomenklatura', q.format as ReportFormat);
  }

  /**
   * Загрузка номенклатуры. Тело запроса — сам файл, как у вложений: предел
   * размера стоит в `main.ts` на этом пути.
   */
  @Post('items/import')
  @RequirePermissions('admin.users')
  importItems(@Query() q: ImportQuery, @Req() req: Request) {
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || bytes.length === 0) throw new UnprocessableEntityException(MSG.emptyBody());
    return this.itemsFile.importFile(bytes, {
      fileName: q.name,
      dryRun: q.dryRun === 'true',
      systemUid: q.systemUid,
    });
  }
}
