import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsBooleanString,
  IsDateString,
  IsIn,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DocumentsService } from './documents.service.js';
import { DocumentTypesService } from './types.service.js';
import { DocumentsFromSourceService } from './from-source.service.js';
import { DocumentTemplatesService } from './templates.service.js';
import { DocumentRenderService } from './render.service.js';
import { DocumentWorkflowService } from './workflow.service.js';
import { DOCUMENT_ACTIONS, type DocumentAction } from './workflow.js';
import { RequirePermissions } from '../auth/auth.guard.js';
import { MSG } from '../common/messages.js';

/** Печатная форма отдаётся как вложение: своим MIME и с именем в двух формах. */
const FILE_MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
} as const;

function sendFile(
  res: Response,
  buffer: Buffer,
  fileName: string,
  format: keyof typeof FILE_MIME = 'docx',
) {
  res.setHeader('Content-Type', FILE_MIME[format]);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fileName.replace(/[^\x20-\x7e]/g, '_')}"; ` +
      `filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');
  res.end(buffer);
}

const DOCUMENT_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'signed',
  'returned',
  'cancelled',
] as const;

class UidParams {
  @IsUUID() uid!: string;
}

class TypesQuery {
  @IsOptional() @IsBooleanString() all?: string;
}

const COUNTER_SCOPES = ['company', 'company_period'] as const;

class TypeBody {
  @IsOptional() @IsUUID() companyUid?: string;
  @IsString() @MaxLength(20) code!: string;
  @IsString() @MaxLength(120) nameRu!: string;
  @IsString() @MaxLength(120) nameUz!: string;
  @IsString() @MaxLength(60) numberingMask!: string;
  @IsOptional() @IsIn(COUNTER_SCOPES) counterScope?: 'company' | 'company_period';
}

class TypePatchBody {
  @IsOptional() @IsString() @MaxLength(20) code?: string;
  @IsOptional() @IsString() @MaxLength(120) nameRu?: string;
  @IsOptional() @IsString() @MaxLength(120) nameUz?: string;
  @IsOptional() @IsString() @MaxLength(60) numberingMask?: string;
  @IsOptional() @IsIn(COUNTER_SCOPES) counterScope?: 'company' | 'company_period';
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class SourcesQuery {
  @IsIn(DocumentsFromSourceService.SOURCES) kind!: string;
  @IsOptional() @IsString() @MaxLength(60) search?: string;
}

class FromSourceBody {
  @IsUUID() documentTypeUid!: string;
  @IsIn(DocumentsFromSourceService.SOURCES) sourceType!: string;
  @IsUUID() sourceUid!: string;
  @IsOptional() @IsIn(['ru', 'uz']) locale?: 'ru' | 'uz';
  @IsOptional() @IsDateString() documentDate?: string;
}

class SampleQuery {
  @IsString() @MaxLength(60) mask!: string;
  @IsOptional() @IsIn(COUNTER_SCOPES) counterScope?: 'company' | 'company_period';
  @IsOptional() @IsString() @MaxLength(20) code?: string;
  /** Для существующего типа пример считается от его счётчика. */
  @IsOptional() @IsUUID() typeUid?: string;
}

class ListQuery {
  @IsOptional() @IsString() @MaxLength(60) search?: string;
  @IsOptional() @IsUUID() typeUid?: string;
  @IsOptional() @IsString() @MaxLength(20) typeCode?: string;
  @IsOptional() @IsIn(DOCUMENT_STATUSES) status?: string;
  @IsOptional() @IsUUID() partnerUid?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;

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


class TemplatesQuery {
  @IsOptional() @IsUUID() typeUid?: string;
}

/**
 * Загрузка шаблона: описание — в строке запроса, файл — телом, как у вложений.
 * Одна и та же причина: multipart здесь не добавляет ничего, кроме второго
 * способа ошибиться с именем поля формы.
 */
class TemplateUploadQuery {
  @IsUUID() documentTypeUid!: string;
  @IsIn(['ru', 'uz']) locale!: 'ru' | 'uz';
  @IsString() @MaxLength(200) name!: string;
}

class FieldMapBody {
  /**
   * Тег из файла → имя нашего поля. Пустой объект — это тоже ответ:
   * «сопоставлять нечего», и он должен проходить.
   */
  @IsObject() fieldMap!: Record<string, string>;
}

class FileQuery {
  @IsOptional() @IsIn(['docx', 'pdf']) format?: 'docx' | 'pdf';
}

class ActionBody {
  @IsIn(DOCUMENT_ACTIONS) action!: DocumentAction;
  /** Возврат и отмена требуют слов — проверяет это сервис по таблице переходов. */
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
}

class LineBody {
  @IsString() @MaxLength(300) name!: string;
  @IsString() @MaxLength(40) qty!: string;
  @IsString() @MaxLength(40) price!: string;
  @IsOptional() @IsString() @MaxLength(20) unitCode?: string;
  @IsOptional() @IsString() @MaxLength(60) unitName?: string;
  @IsOptional() @IsString() @MaxLength(60) itemCode?: string;
  @IsOptional() @IsString() @MaxLength(20) discountPercent?: string;
  @IsOptional() @IsString() @MaxLength(20) vatRate?: string;
}

class PatchBody {
  /** Версия, которую правят: без неё двое затрут работу друг друга. */
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional() @IsDateString() documentDate?: string;
  @IsOptional() @IsIn(['ru', 'uz']) locale?: 'ru' | 'uz';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineBody)
  lines?: LineBody[];
}

class VersionParams {
  @IsUUID() uid!: string;

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  version!: number;
}

/**
 * Документы (ТЗ 7).
 *
 * Чтение — правом `documents.view`. Права на запись (`documents.edit`,
 * `documents.approve`) заведены в справочнике прав и понадобятся на следующих
 * этапах: создание из источника, согласование, шаблоны.
 */
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly types_: DocumentTypesService,
    private readonly fromSource: DocumentsFromSourceService,
    private readonly templates: DocumentTemplatesService,
    private readonly render: DocumentRenderService,
    private readonly workflow: DocumentWorkflowService,
  ) {}

  /**
   * Основной сценарий ТЗ 7.1: менеджер стоит в заказе, жмёт «Счёт» и получает
   * заполненный черновик. Заполняет сервер — реквизиты, строки, суммы и срок
   * оплаты уже есть в системе, а перепечатывание руками добавляет опечатки.
   */
  /** Поиск источника по номеру — для формы «выписать документ». */
  @Get('sources')
  @RequirePermissions('documents.edit')
  sources(@Query() query: SourcesQuery) {
    return this.fromSource.sources(query.kind, query.search ?? '');
  }

  @Post('from-source')
  @RequirePermissions('documents.edit')
  createFromSource(@Body() body: FromSourceBody) {
    return this.fromSource.create(body as never);
  }

  @Get('types')
  @RequirePermissions('documents.view')
  types(@Query() query: TypesQuery) {
    return this.types_.list(query.all === 'true');
  }

  /**
   * Пример номера по маске — подсказка в форме, а не выдача номера: счётчик
   * она не трогает. Считает сервер, чтобы правила разбора маски были в одном
   * месте: собранный на фронте пример разошёлся бы с тем, что напечатается.
   */
  @Get('types/sample')
  @RequirePermissions('documents.view')
  sample(@Query() query: SampleQuery) {
    return this.types_.sample(
      query.mask,
      query.counterScope ?? 'company_period',
      query.code ?? '',
      query.typeUid,
    );
  }

  @Post('types')
  @RequirePermissions('refs.edit')
  createType(@Body() body: TypeBody) {
    return this.types_.create(body);
  }

  @Patch('types/:uid')
  @RequirePermissions('refs.edit')
  patchType(@Param() params: UidParams, @Body() body: TypePatchBody) {
    return this.types_.patch(params.uid, body);
  }

  @Delete('types/:uid')
  @RequirePermissions('refs.edit')
  removeType(@Param() params: UidParams) {
    return this.types_.remove(params.uid);
  }

  // --- шаблоны печатных форм (ТЗ 7.2) --------------------------------------
  //
  // Правит их администратор, поэтому право то же, что у справочников
  // (`refs.edit`), а не `documents.edit`: менеджер выписывает документы, но
  // бумагу, по которой печатает вся компания, меняет не он.

  /** Список полей — то, с чем администратор сопоставляет теги файла. */
  @Get('templates/fields')
  @RequirePermissions('refs.edit')
  templateFields() {
    return this.templates.fields();
  }

  @Get('templates')
  @RequirePermissions('refs.edit')
  templatesList(@Query() query: TemplatesQuery) {
    return this.templates.list(query.typeUid);
  }

  @Post('templates/upload')
  @RequirePermissions('refs.edit')
  templateUpload(@Query() query: TemplateUploadQuery, @Req() req: Request) {
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || bytes.length === 0) {
      throw new UnprocessableEntityException(MSG.emptyBody());
    }
    return this.templates.upload({
      documentTypeUid: query.documentTypeUid,
      locale: query.locale,
      fileName: query.name,
      file: bytes,
    });
  }

  @Patch('templates/:uid/field-map')
  @RequirePermissions('refs.edit')
  templateFieldMap(@Param() params: UidParams, @Body() body: FieldMapBody) {
    return this.templates.setFieldMap(params.uid, body.fieldMap);
  }

  /** Проверка на настоящем документе — до публикации, отдельным действием. */
  @Post('templates/:uid/check')
  @RequirePermissions('refs.edit')
  templateCheck(@Param() params: UidParams) {
    return this.templates.check(params.uid);
  }

  @Post('templates/:uid/publish')
  @RequirePermissions('refs.edit')
  templatePublish(@Param() params: UidParams) {
    return this.templates.publish(params.uid);
  }

  @Post('templates/:uid/unpublish')
  @RequirePermissions('refs.edit')
  templateUnpublish(@Param() params: UidParams) {
    return this.templates.unpublish(params.uid);
  }

  @Get('templates/:uid/file')
  @RequirePermissions('refs.edit')
  async templateFile(@Param() params: UidParams, @Res() res: Response) {
    const { buffer, fileName } = await this.templates.file(params.uid);
    sendFile(res, buffer, fileName);
  }

  @Delete('templates/:uid')
  @RequirePermissions('refs.edit')
  templateRemove(@Param() params: UidParams) {
    return this.templates.remove(params.uid);
  }

  @Get()
  @RequirePermissions('documents.view')
  list(@Query() query: ListQuery) {
    return this.documents.list(query);
  }

  @Get(':uid')
  @RequirePermissions('documents.view')
  one(@Param() params: UidParams) {
    return this.documents.one(params.uid);
  }

  /**
   * Печатная форма документа.
   *
   * Право `documents.edit`, а не `view`: печать — выпуск бумаги наружу, а не
   * просмотр карточки.
   *
   * DOCX — то, что ещё правят; PDF — то, что отправляют и подписывают. Оба
   * собираются из одного шаблона, поэтому это один маршрут с `format`, а не
   * два: иначе они однажды разошлись бы содержимым.
   */
  @Get(':uid/file')
  @RequirePermissions('documents.edit')
  async file(
    @Param() params: UidParams,
    @Query() query: FileQuery,
    @Res() res: Response,
  ) {
    const format = query.format ?? 'docx';
    const { buffer, fileName } =
      format === 'pdf' ? await this.render.pdf(params.uid) : await this.render.docx(params.uid);
    sendFile(res, buffer, fileName, format);
  }

  // --- согласование, версии, журнал (ТЗ 7.4) -------------------------------

  /**
   * Движение по маршруту.
   *
   * Одно действие — один маршрут, а не `PATCH status`: «отправить на
   * согласование» и «отменить» это разные события с разными правами и
   * разными требованиями к словам. Право на конкретное действие проверяет
   * служба по таблице переходов; здесь стоит общее `documents.view`, потому
   * что более узкое запретило бы половину действий тому, кому они положены.
   */
  @Post(':uid/actions')
  @RequirePermissions('documents.view')
  act(@Param() params: UidParams, @Body() body: ActionBody) {
    return this.workflow.act(params.uid, body.action, body.comment);
  }

  @Patch(':uid')
  @RequirePermissions('documents.edit')
  patch(@Param() params: UidParams, @Body() body: PatchBody) {
    return this.workflow.patch(params.uid, body);
  }

  @Get(':uid/versions')
  @RequirePermissions('documents.view')
  versions(@Param() params: UidParams) {
    return this.workflow.versions(params.uid);
  }

  @Get(':uid/history')
  @RequirePermissions('documents.view')
  history(@Param() params: UidParams) {
    return this.workflow.history(params.uid);
  }

  /** Печатная форма прежней редакции — та самая, которой её печатали. */
  @Get(':uid/versions/:version/file')
  @RequirePermissions('documents.edit')
  async versionFile(
    @Param() params: VersionParams,
    @Query() query: FileQuery,
    @Res() res: Response,
  ) {
    const format = query.format ?? 'docx';
    const { buffer, fileName } = await this.render.versionFile(
      params.uid,
      params.version,
      format,
    );
    sendFile(res, buffer, fileName, format);
  }
}
