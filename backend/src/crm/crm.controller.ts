import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsBooleanString,
  IsEmail,
  IsIn,
  IsDateString,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PartnersService } from './partners.service.js';
import { LeadsService } from './leads.service.js';
import { DealsService } from './deals.service.js';
import { TasksService } from './tasks.service.js';
import { CrmRefsService } from './refs.service.js';
import { ActivitiesService } from './activities.service.js';
import { PartnerCardService } from './partner-card.service.js';
import { CRM_REPORT_KINDS, CrmReportsService, type CrmReportKind } from './reports.service.js';
import { SiteKeysService } from './site-keys.service.js';
import {
  REPORT_FORMATS,
  sendReportFile,
  PDF_ROW_LIMIT,
  type ReportFormat,
} from '../common/report-file.js';
import { RequirePermissions } from '../auth/auth.guard.js';

const PARTNER_TYPES = ['company', 'person'] as const;
const ROLES = ['any', 'client', 'supplier'] as const;
// «converted» сюда не входит: в клиента обращение переводит только
// превращение — оно и заводит карточку. Руками этот статус не ставят.
const LEAD_STATUSES = ['new', 'qualified', 'rejected'] as const;
const LEAD_FILTER_STATUSES = ['new', 'qualified', 'converted', 'rejected'] as const;

class ReportParams {
  @IsIn(CRM_REPORT_KINDS) kind!: CrmReportKind;
}

class ReportQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(5000)
  limit?: number;
}

class ReportFileQuery extends ReportQuery {
  @IsIn(REPORT_FORMATS) format!: ReportFormat;
}

const TASK_SCOPES = ['overdue', 'today', 'week', 'open', 'closed', 'all'] as const;
const ACTIVITY_TYPES = ['call', 'meeting', 'letter', 'note'] as const;
const DIRECTIONS = ['incoming', 'outgoing'] as const;

class UidParams {
  @IsUUID()
  uid!: string;
}

class PartnersQuery {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsUUID() managerUid?: string;
  @IsOptional() @IsUUID() sourceUid?: string;
  @IsOptional() @IsIn(ROLES) role?: string;
  @IsOptional() @IsBooleanString() all?: string;

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

class PartnerBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsOptional() @IsIn(PARTNER_TYPES) partnerType?: string;

  @IsString() @MinLength(2) @MaxLength(200) nameRu!: string;
  @IsOptional() @IsString() @MaxLength(200) nameUz?: string;

  // ИНН Узбекистана — девять цифр. Длину не навязываем жёстко: у физлица его
  // может не быть вовсе, а у нерезидента формат свой.
  @IsOptional() @IsString() @MaxLength(20) inn?: string;

  @IsOptional() @IsObject() bankDetails?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(300) legalAddress?: string;
  @IsOptional() @IsString() @MaxLength(300) actualAddress?: string;

  @IsOptional() @IsBoolean() isClient?: boolean;
  @IsOptional() @IsBoolean() isSupplier?: boolean;

  @IsOptional() @IsUUID() managerUid?: string;
  @IsOptional() @IsUUID() sourceUid?: string;
  @IsOptional() @IsUUID() priceTypeUid?: string;

  @IsOptional() @IsInt() @Min(0) @Max(365) paymentDelayDays?: number;
  @IsOptional() @IsNumber() @Min(0) debtLimit?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];
}

class PartnerPatchBody extends PartnerBody {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) declare nameRu: string;

  /** Версия карточки: без неё правка затёрла бы чужое сохранение (§1.7). */
  @IsOptional() @IsInt() @Min(1) version?: number;

  @IsOptional() @IsBoolean() isActive?: boolean;
}

class ContactBody {
  @IsString() @MinLength(2) @MaxLength(150) fullName!: string;
  @IsOptional() @IsString() @MaxLength(100) position?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(120) email?: string;
  @IsOptional() @IsString() @MaxLength(60) telegram?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

class ContactPatchBody extends ContactBody {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(150) declare fullName: string;
}

class LeadsQuery {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsIn(LEAD_FILTER_STATUSES) status?: string;
  @IsOptional() @IsUUID() sourceUid?: string;
  @IsOptional() @IsUUID() managerUid?: string;

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

class LeadBody {
  @IsOptional() @IsUUID() companyUid?: string;

  /** Источник обязателен: без него отчёт по источникам пуст (ТЗ 8.1). */
  @IsUUID() sourceUid!: string;

  @IsString() @MinLength(2) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(120) email?: string;
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
  @IsOptional() @IsUUID() managerUid?: string;
}

class LeadPatchBody {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(120) email?: string;
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
  @IsOptional() @IsIn(LEAD_STATUSES) status?: string;
  /** Причина отказа: отдельно от комментария заявки (ТЗ 8.1). */
  @IsOptional() @IsString() @MaxLength(300) rejectReason?: string;
  @IsOptional() @IsUUID() sourceUid?: string;
  @IsOptional() @IsUUID() managerUid?: string;
}

class ConvertBody {
  /** Либо связать с уже заведённым клиентом, либо завести нового из обращения. */
  @IsOptional() @IsUUID() partnerUid?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) nameRu?: string;
  @IsOptional() @IsString() @MaxLength(20) inn?: string;
  @IsOptional() @IsIn(PARTNER_TYPES) partnerType?: string;

  @IsOptional() @IsBoolean() withDeal?: boolean;
  @IsOptional() @IsString() @MaxLength(200) dealTitle?: string;
  @IsOptional() @IsNumber() @Min(0) dealAmount?: number;
}

const DEAL_STATUSES = ['open', 'won', 'lost'] as const;

class BoardQuery {
  @IsOptional() @IsUUID() managerUid?: string;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
}

const DEAL_SORTS = [
  'number',
  'title',
  'partner',
  'amount',
  'stage',
  'manager',
  'created',
  'closed',
  'expected',
] as const;

class SiteKeyBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsString() @MinLength(3) @MaxLength(120) name!: string;
  /** Адреса страниц, с которых принимаем форму. Пусто — принимаем отовсюду. */
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(200, { each: true })
  origins?: string[];
}

class SiteKeyPatchBody {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(120) name?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(200, { each: true })
  origins?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class DealsQuery {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsIn(DEAL_STATUSES) status?: string;
  @IsOptional() @IsUUID() stageUid?: string;
  @IsOptional() @IsUUID() managerUid?: string;
  @IsOptional() @IsUUID() partnerUid?: string;
  @IsOptional() @IsUUID() companyUid?: string;

  /** Имя столбца в запрос не приходит: только ключ из списка. */
  @IsOptional() @IsIn(DEAL_SORTS) sort?: string;
  @IsOptional() @IsIn(['asc', 'desc']) dir?: string;

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

class DealBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsUUID() partnerUid!: string;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsOptional() @IsNumber() @Min(0) amount?: number;
  @IsOptional() @IsDateString() expectedCloseDate?: string;
  @IsOptional() @IsUUID() managerUid?: string;
  @IsOptional() @IsUUID() stageUid?: string;
}

class DealPatchBody {
  @IsOptional() @IsInt() @Min(1) version?: number;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @IsNumber() @Min(0) amount?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) probability?: number;
  @IsOptional() @IsDateString() expectedCloseDate?: string;
  @IsOptional() @IsUUID() managerUid?: string;
}

class MoveBody {
  @IsUUID() stageUid!: string;
  @IsOptional() @IsInt() @Min(1) version?: number;
}

class WinBody {
  @IsOptional() @IsInt() @Min(1) version?: number;
  /** Чем закончилась — словами. Обязателен на обоих исходах. */
  @IsString() @MinLength(3) @MaxLength(500) comment!: string;
}

class LoseBody {
  @IsOptional() @IsInt() @Min(1) version?: number;
  /** Причина из справочника — обязательна (ТЗ 8.3). */
  @IsUUID() reasonUid!: string;
  @IsString() @MinLength(3) @MaxLength(500) comment!: string;
}

/**
 * CRM (ТЗ §8). Клиенты (Э1), лиды (Э2), воронка и сделки (Э3).
 *
 * Право на чтение — `crm.view`, на запись — `crm.edit`. Отдельного права на
 * контактные лица нет: телефон контактного лица правит тот же менеджер, что
 * ведёт клиента, и разделять это значило бы завести право, которое никому
 * нельзя выдать отдельно.
 */

const LEAD_CHANNELS = ['site', 'ads', 'call', 'manual', 'telegram', 'other'] as const;

class RefsQuery {
  @IsOptional() @IsBooleanString() all?: string;
}

class StageBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsString() @MinLength(1) @MaxLength(30) code!: string;
  @IsString() @MinLength(1) @MaxLength(120) nameRu!: string;
  @IsOptional() @IsString() @MaxLength(120) nameUz?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) probabilityDefault?: number;
}

class StagePatchBody {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(30) code?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) nameRu?: string;
  @IsOptional() @IsString() @MaxLength(120) nameUz?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) probabilityDefault?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class StageOrderBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsArray() @ArrayMaxSize(50) @IsUUID(undefined, { each: true }) uids!: string[];
}

class SourceBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsString() @MinLength(1) @MaxLength(30) code!: string;
  @IsString() @MinLength(1) @MaxLength(120) nameRu!: string;
  @IsOptional() @IsString() @MaxLength(120) nameUz?: string;
  @IsIn(LEAD_CHANNELS) channel!: string;
}

class SourcePatchBody {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(30) code?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) nameRu?: string;
  @IsOptional() @IsString() @MaxLength(120) nameUz?: string;
  @IsOptional() @IsIn(LEAD_CHANNELS) channel?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class LostReasonBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsString() @MinLength(1) @MaxLength(30) code!: string;
  @IsString() @MinLength(1) @MaxLength(120) nameRu!: string;
  @IsOptional() @IsString() @MaxLength(120) nameUz?: string;
}

class LostReasonPatchBody {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(30) code?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) nameRu?: string;
  @IsOptional() @IsString() @MaxLength(120) nameUz?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class TaskTypeBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsString() @MinLength(1) @MaxLength(30) code!: string;
  @IsString() @MinLength(1) @MaxLength(120) nameRu!: string;
  @IsOptional() @IsString() @MaxLength(120) nameUz?: string;
  @IsIn(ACTIVITY_TYPES) activityKind!: string;
}

class TaskTypePatchBody {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(30) code?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) nameRu?: string;
  @IsOptional() @IsString() @MaxLength(120) nameUz?: string;
  @IsOptional() @IsIn(ACTIVITY_TYPES) activityKind?: string;
  @IsOptional() @IsInt() @Min(0) @Max(9999) seq?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class TasksQuery {
  @IsOptional() @IsIn(TASK_SCOPES) scope?: string;
  @IsOptional() @IsUUID() assigneeUid?: string;
  @IsOptional() @IsUUID() partnerUid?: string;
  @IsOptional() @IsUUID() dealUid?: string;
  @IsOptional() @IsUUID() typeUid?: string;

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

class TaskBody {
  @IsUUID() typeUid!: string;
  @IsString() @MinLength(2) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsDateString() dueAt!: string;
  @IsOptional() @IsUUID() assigneeUid?: string;
  @IsOptional() @IsUUID() partnerUid?: string;
  @IsOptional() @IsUUID() dealUid?: string;
}

class TaskPatchBody {
  @IsOptional() @IsUUID() typeUid?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsDateString() dueAt?: string;
  @IsOptional() @IsUUID() assigneeUid?: string;
  @IsOptional() @IsInt() @Min(1) version?: number;
}

class TaskCloseBody {
  @IsOptional() @IsString() @MaxLength(2000) result?: string;
  @IsOptional() @IsInt() @Min(1) version?: number;
}

class ActivitiesQuery {
  @IsOptional() @IsUUID() partnerUid?: string;
  @IsOptional() @IsUUID() dealUid?: string;
  @IsOptional() @IsIn(ACTIVITY_TYPES) type?: string;

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

class ActivityBody {
  @IsIn(ACTIVITY_TYPES) type!: string;
  @IsString() @MinLength(2) @MaxLength(200) subject!: string;
  @IsOptional() @IsString() @MaxLength(4000) note?: string;
  @IsOptional() @IsDateString() at?: string;
  @IsOptional() @IsIn(DIRECTIONS) direction?: string;
  @IsOptional() @IsInt() @Min(0) @Max(86400) durationSec?: number;
  @IsOptional() @IsUUID() partnerUid?: string;
  @IsOptional() @IsUUID() dealUid?: string;
}

@Controller('crm')
export class CrmController {
  constructor(
    private readonly partners: PartnersService,
    private readonly leads: LeadsService,
    private readonly deals: DealsService,
    private readonly tasks: TasksService,
    private readonly refs: CrmRefsService,
    private readonly activities: ActivitiesService,
    private readonly partnerCard: PartnerCardService,
    private readonly reports: CrmReportsService,
    private readonly siteKeys: SiteKeysService,
  ) {}

  // --- воронка и сделки (ТЗ 8.3) ---
  // Маршруты со словами (`board`, `stages`) объявлены раньше `deals/:uid`:
  // иначе `board` приняли бы за uid и ответили 400.

  @Get('deal-stages')
  @RequirePermissions('crm.view')
  dealStages() {
    return this.deals.stages();
  }

  @Get('lost-reasons')
  @RequirePermissions('crm.view')
  lostReasons() {
    return this.deals.lostReasons();
  }

  @Get('deals/board')
  @RequirePermissions('crm.view')
  board(@Query() query: BoardQuery) {
    return this.deals.board(query);
  }

  @Get('deals')
  @RequirePermissions('crm.view')
  listDeals(@Query() query: DealsQuery) {
    return this.deals.list(query);
  }

  @Get('deals/:uid')
  @RequirePermissions('crm.view')
  deal(@Param() params: UidParams) {
    return this.deals.card(params.uid);
  }

  @Post('deals')
  @RequirePermissions('crm.edit')
  createDeal(@Body() body: DealBody) {
    return this.deals.create(body as never);
  }

  @Patch('deals/:uid')
  @RequirePermissions('crm.edit')
  updateDeal(@Param() params: UidParams, @Body() body: DealPatchBody) {
    return this.deals.update(params.uid, body as never);
  }

  @Post('deals/:uid/move')
  @RequirePermissions('crm.edit')
  moveDeal(@Param() params: UidParams, @Body() body: MoveBody) {
    return this.deals.move(params.uid, body);
  }

  @Post('deals/:uid/win')
  @RequirePermissions('crm.edit')
  winDeal(@Param() params: UidParams, @Body() body: WinBody) {
    return this.deals.win(params.uid, body);
  }

  @Post('deals/:uid/lose')
  @RequirePermissions('crm.edit')
  loseDeal(@Param() params: UidParams, @Body() body: LoseBody) {
    return this.deals.lose(params.uid, body);
  }

  // --- отчёты (ТЗ 8: «отчёты по менеджерам, источникам, конверсии и причинам
  // отказов»). Отчёт и его выгрузка — один и тот же расчёт, поэтому строит их
  // один сервис. Разные пути только потому, что ответы разной природы: здесь
  // конверт `{data, meta}`, там файл.

  @Get('reports/:kind')
  @RequirePermissions('crm.view')
  report(@Param() params: ReportParams, @Query() query: ReportQuery) {
    return this.reports.build({
      kind: params.kind,
      from: query.from,
      to: query.to,
      limit: query.limit ?? 1000,
    });
  }

  @Get('reports/:kind/file')
  @RequirePermissions('crm.view')
  async reportFile(
    @Param() params: ReportParams,
    @Query() query: ReportFileQuery,
    @Res() res: Response,
  ) {
    const report = await this.reports.build({
      kind: params.kind,
      from: query.from,
      to: query.to,
      // Excel и CSV открывают, чтобы считать, — там отчёт целиком. PDF
      // печатают, и двадцать тысяч строк это триста листов.
      limit: query.limit ?? (query.format === 'pdf' ? PDF_ROW_LIMIT : 20000),
    });

    const stamp = new Date().toISOString().slice(0, 10);
    await sendReportFile(res, report, `crm-${params.kind}-${stamp}`, query.format);
  }

  // --- справочники CRM (ТЗ 8.3, 8.4) ---
  //
  // Чтение — правом `crm.view`: из справочника подбирают в формах, и без него
  // не заведёшь ни обращение, ни задачу. Запись — правом `refs.edit`, тем же,
  // что у складских справочников: это работа того, кто отвечает за названия,
  // а не того, кто ведёт клиента.

  @Get('refs')
  @RequirePermissions('crm.view')
  crmRefs(@Query() query: RefsQuery) {
    return this.refs.all(query.all === 'true');
  }

  @Post('refs/stages')
  @RequirePermissions('refs.edit')
  createStage(@Body() body: StageBody) {
    return this.refs.createStage(body);
  }

  @Patch('refs/stages/:uid')
  @RequirePermissions('refs.edit')
  updateStage(@Param() params: UidParams, @Body() body: StagePatchBody) {
    return this.refs.updateStage(params.uid, body);
  }

  @Delete('refs/stages/:uid')
  @RequirePermissions('refs.edit')
  deleteStage(@Param() params: UidParams) {
    return this.refs.deleteStage(params.uid);
  }

  @Post('refs/stages/order')
  @RequirePermissions('refs.edit')
  reorderStages(@Body() body: StageOrderBody) {
    return this.refs.reorderStages(body);
  }

  @Post('refs/sources')
  @RequirePermissions('refs.edit')
  createSource(@Body() body: SourceBody) {
    return this.refs.createSource(body);
  }

  @Patch('refs/sources/:uid')
  @RequirePermissions('refs.edit')
  updateSource(@Param() params: UidParams, @Body() body: SourcePatchBody) {
    return this.refs.updateSource(params.uid, body);
  }

  @Delete('refs/sources/:uid')
  @RequirePermissions('refs.edit')
  deleteSource(@Param() params: UidParams) {
    return this.refs.deleteSource(params.uid);
  }

  @Post('refs/lost-reasons')
  @RequirePermissions('refs.edit')
  createLostReason(@Body() body: LostReasonBody) {
    return this.refs.createLostReason(body);
  }

  @Patch('refs/lost-reasons/:uid')
  @RequirePermissions('refs.edit')
  updateLostReason(@Param() params: UidParams, @Body() body: LostReasonPatchBody) {
    return this.refs.updateLostReason(params.uid, body);
  }

  @Delete('refs/lost-reasons/:uid')
  @RequirePermissions('refs.edit')
  deleteLostReason(@Param() params: UidParams) {
    return this.refs.deleteLostReason(params.uid);
  }

  @Post('refs/task-types')
  @RequirePermissions('refs.edit')
  createTaskType(@Body() body: TaskTypeBody) {
    return this.refs.createTaskType(body);
  }

  @Patch('refs/task-types/:uid')
  @RequirePermissions('refs.edit')
  updateTaskType(@Param() params: UidParams, @Body() body: TaskTypePatchBody) {
    return this.refs.updateTaskType(params.uid, body);
  }

  @Delete('refs/task-types/:uid')
  @RequirePermissions('refs.edit')
  deleteTaskType(@Param() params: UidParams) {
    return this.refs.deleteTaskType(params.uid);
  }

  // --- задачи и активности (ТЗ 8.4) ---

  @Get('tasks')
  @RequirePermissions('crm.view')
  listTasks(@Query() query: TasksQuery) {
    return this.tasks.list(query);
  }

  @Get('tasks/:uid')
  @RequirePermissions('crm.view')
  task(@Param() params: UidParams) {
    return this.tasks.one(params.uid);
  }

  @Post('tasks')
  @RequirePermissions('crm.edit')
  createTask(@Body() body: TaskBody) {
    return this.tasks.create(body as never);
  }

  @Patch('tasks/:uid')
  @RequirePermissions('crm.edit')
  updateTask(@Param() params: UidParams, @Body() body: TaskPatchBody) {
    return this.tasks.update(params.uid, body as never);
  }

  @Post('tasks/:uid/complete')
  @RequirePermissions('crm.edit')
  completeTask(@Param() params: UidParams, @Body() body: TaskCloseBody) {
    return this.tasks.complete(params.uid, body);
  }

  @Post('tasks/:uid/cancel')
  @RequirePermissions('crm.edit')
  cancelTask(@Param() params: UidParams, @Body() body: TaskCloseBody) {
    return this.tasks.cancel(params.uid, body);
  }

  @Get('activities')
  @RequirePermissions('crm.view')
  listActivities(@Query() query: ActivitiesQuery) {
    return this.activities.list(query);
  }

  @Post('activities')
  @RequirePermissions('crm.edit')
  createActivity(@Body() body: ActivityBody) {
    return this.activities.create(body as never);
  }

  @Get('partners')
  @RequirePermissions('crm.view')
  list(@Query() query: PartnersQuery) {
    return this.partners.list({
      search: query.search,
      managerUid: query.managerUid,
      sourceUid: query.sourceUid,
      role: query.role,
      all: query.all === 'true',
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Get('partners/options')
  @RequirePermissions('crm.view')
  options() {
    return this.partners.options();
  }

  @Get('partners/:uid')
  @RequirePermissions('crm.view')
  card(@Param() params: UidParams) {
    return this.partners.card(params.uid);
  }

  @Post('partners')
  @RequirePermissions('crm.edit')
  create(@Body() body: PartnerBody) {
    return this.partners.create(body as never);
  }

  @Patch('partners/:uid')
  @RequirePermissions('crm.edit')
  update(@Param() params: UidParams, @Body() body: PartnerPatchBody) {
    return this.partners.update(params.uid, body as never);
  }

  @Delete('partners/:uid')
  @RequirePermissions('crm.edit')
  remove(@Param() params: UidParams) {
    return this.partners.remove(params.uid);
  }

  // --- вкладки карточки клиента (ТЗ 8.2) ---
  //
  // Право на все вкладки одно — `crm.view`. Заказы, долг и платежи клиента
  // названы в ТЗ содержимым его карточки: менеджер смотрит их перед тем, как
  // обещать отгрузку. Разрезать карточку по правам финансов значило бы
  // показывать половину экрана с необъяснимыми пустыми вкладками.

  @Get('partners/:uid/deals')
  @RequirePermissions('crm.view')
  partnerDeals(@Param() params: UidParams) {
    return this.partnerCard.deals(params.uid);
  }

  @Get('partners/:uid/orders')
  @RequirePermissions('crm.view')
  partnerOrders(@Param() params: UidParams) {
    return this.partnerCard.orders(params.uid);
  }

  @Get('partners/:uid/documents')
  @RequirePermissions('crm.view')
  partnerDocuments(@Param() params: UidParams) {
    return this.partnerCard.documents(params.uid);
  }

  @Get('partners/:uid/finance')
  @RequirePermissions('crm.view')
  partnerFinance(@Param() params: UidParams) {
    return this.partnerCard.finance(params.uid);
  }

  @Get('partners/:uid/history')
  @RequirePermissions('crm.view')
  partnerHistory(@Param() params: UidParams) {
    return this.partnerCard.history(params.uid);
  }

  // --- лиды (ТЗ 8.1) ---

  @Get('leads')
  @RequirePermissions('crm.view')
  listLeads(@Query() query: LeadsQuery) {
    return this.leads.list(query);
  }

  @Get('leads/:uid')
  @RequirePermissions('crm.view')
  lead(@Param() params: UidParams) {
    return this.leads.one(params.uid);
  }

  @Post('leads')
  @RequirePermissions('crm.edit')
  createLead(@Body() body: LeadBody) {
    return this.leads.create(body as never);
  }

  @Patch('leads/:uid')
  @RequirePermissions('crm.edit')
  updateLead(@Param() params: UidParams, @Body() body: LeadPatchBody) {
    return this.leads.update(params.uid, body as never);
  }

  @Post('leads/:uid/convert')
  @RequirePermissions('crm.edit')
  convertLead(@Param() params: UidParams, @Body() body: ConvertBody) {
    return this.leads.convert(params.uid, body as never);
  }

  @Post('partners/:uid/contacts')
  @RequirePermissions('crm.edit')
  addContact(@Param() params: UidParams, @Body() body: ContactBody) {
    return this.partners.addContact(params.uid, body as never);
  }

  @Patch('contacts/:uid')
  @RequirePermissions('crm.edit')
  updateContact(@Param() params: UidParams, @Body() body: ContactPatchBody) {
    return this.partners.updateContact(params.uid, body as never);
  }

  @Delete('contacts/:uid')
  @RequirePermissions('crm.edit')
  removeContact(@Param() params: UidParams) {
    return this.partners.removeContact(params.uid);
  }

  // --- приём заявок с сайта ---
  // Сам приём живёт в открытом модуле `public`; здесь — ключи и правила,
  // которыми заявка раскладывается по источникам.

  @Get('site-keys')
  @RequirePermissions('crm.view')
  listSiteKeys() {
    return this.siteKeys.list();
  }

  @Post('site-keys')
  @RequirePermissions('crm.edit')
  createSiteKey(@Body() body: SiteKeyBody) {
    return this.siteKeys.create(body as never);
  }

  @Patch('site-keys/:uid')
  @RequirePermissions('crm.edit')
  updateSiteKey(@Param() params: UidParams, @Body() body: SiteKeyPatchBody) {
    return this.siteKeys.update(params.uid, body as never);
  }

  @Get('source-rules')
  @RequirePermissions('crm.view')
  sourceRules() {
    return this.siteKeys.rules();
  }
}
