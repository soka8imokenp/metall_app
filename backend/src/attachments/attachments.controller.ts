import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AttachmentsService } from './attachments.service.js';
import {
  ATTACHMENT_KINDS,
  OWNER_KINDS,
  dispositionOf,
  type AttachmentKindName,
  type OwnerKind,
} from './attachments.js';
import { MSG } from '../common/messages.js';

class OwnerQuery {
  @IsIn(OWNER_KINDS)
  owner!: OwnerKind;

  @IsUUID()
  uid!: string;
}

/**
 * Загрузка: описание файла — в строке запроса, байты — телом.
 *
 * Не multipart: одно вложение за запрос, и разбор границ формы здесь ничего не
 * добавляет, кроме зависимости и второго способа ошибиться с именем поля.
 * Браузер отправляет `File` как тело `fetch` в одну строку.
 */
class UploadQuery extends OwnerQuery {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsIn(ATTACHMENT_KINDS)
  kind?: AttachmentKindName;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

class UidParams {
  @IsUUID()
  uid!: string;
}

@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /**
   * Права проверяет сервис, а не декоратор маршрута: нужное право зависит от
   * владельца вложения — склад у движения, финансы у платежа. Один общий код
   * на маршруте был бы либо шире нужного, либо запрещал бы половину случаев.
   */
  @Get()
  list(@Query() query: OwnerQuery) {
    return this.attachments.list(query.owner, query.uid);
  }

  @Post()
  upload(@Query() query: UploadQuery, @Req() req: Request) {
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || bytes.length === 0) {
      throw new UnprocessableEntityException(MSG.emptyBody());
    }
    const mimeType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();

    return this.attachments.add({
      owner: query.owner,
      ownerUid: query.uid,
      fileName: query.name,
      mimeType,
      kind: query.kind ?? (mimeType.startsWith('image/') ? 'photo' : 'scan'),
      comment: query.comment,
      bytes,
    });
  }

  /**
   * Выдача файла. `@Res()` без passthrough — как в выгрузке отчётов: иначе
   * конверт-перехватчик обернёт байты в JSON, и файл не сохранится.
   */
  @Get(':uid/file')
  async file(@Param() params: UidParams, @Res() res: Response) {
    const { meta, bytes } = await this.attachments.file(params.uid);

    res.setHeader('Content-Type', meta.mimeType);
    res.setHeader('Content-Length', String(bytes.length));
    // Имя в кавычках плюс filename* по RFC 5987: в имени бывают русские буквы,
    // а без звёздной формы браузер сохранит их как «______».
    res.setHeader(
      'Content-Disposition',
      `${dispositionOf(meta.mimeType)}; filename="${meta.fileName.replace(/[^\x20-\x7e]/g, '_')}"; ` +
        `filename*=UTF-8''${encodeURIComponent(meta.fileName)}`,
    );
    // Вложение — данные арендатора: ни в общий кэш, ни в чужой прокси.
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    res.end(bytes);
  }

  @Delete(':uid')
  remove(@Param() params: UidParams) {
    return this.attachments.remove(params.uid);
  }
}
