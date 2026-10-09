import { Body, Controller, Headers, Ip, Post } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Public } from '../auth/auth.guard.js';
import { PublicLeadsService } from './public-leads.service.js';

/** Метки визита с сайта. Всё необязательно: их может не быть вовсе. */
class MarksBody {
  @IsOptional() @IsString() @MaxLength(120) visitorId?: string;
  @IsOptional() @IsString() @MaxLength(500) landing?: string;
  @IsOptional() @IsString() @MaxLength(500) referrer?: string;
  @IsOptional() @IsString() @MaxLength(120) source?: string;
  @IsOptional() @IsString() @MaxLength(120) medium?: string;
  @IsOptional() @IsString() @MaxLength(200) campaign?: string;
  @IsOptional() @IsString() @MaxLength(200) content?: string;
  @IsOptional() @IsString() @MaxLength(300) term?: string;
  @IsOptional() @IsString() @MaxLength(200) clickId?: string;
  @IsOptional() @IsString() @MaxLength(120) analyticsId?: string;
  @IsOptional() @IsString() @MaxLength(60) formCode?: string;
  @IsOptional() @IsString() @MaxLength(40) firstAt?: string;
  @IsOptional() @IsString() @MaxLength(120) firstSource?: string;
  @IsOptional() @IsString() @MaxLength(120) firstMedium?: string;
  @IsOptional() @IsString() @MaxLength(200) firstCampaign?: string;
  @IsOptional() @IsString() @MaxLength(500) firstLanding?: string;
  @IsOptional() @IsString() @MaxLength(500) firstReferrer?: string;
}

class PublicLeadBody {
  @IsString() @MaxLength(80) key!: string;
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(50) phone?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
  /** Ловушка для ботов: поле скрыто стилем, человек его не заполняет. */
  @IsOptional() @IsString() @MaxLength(200) company?: string;
  @IsOptional() @ValidateNested() @Type(() => MarksBody) marks?: MarksBody;
}

/**
 * Открытый приём заявок с сайта. Единственный маршрут без входа, кроме пароля.
 *
 * Ответ всегда одинаковый и без данных: страница сайта не должна узнавать
 * ничего о системе — ни номера обращения, ни имени компании.
 */
@Controller('public')
export class PublicController {
  constructor(private readonly leads: PublicLeadsService) {}

  @Public()
  @Post('leads')
  async lead(
    @Body() body: PublicLeadBody,
    @Headers('origin') origin: string | undefined,
    @Headers('x-forwarded-for') forwarded: string | undefined,
    @Ip() ip: string,
  ) {
    // Сервис слушает только 127.0.0.1 и доступен снаружи лишь через наш
    // туннель, поэтому адрес посетителя берём из его заголовка: без этого все
    // заявки выглядели бы пришедшими с одного адреса, и ограничение частоты
    // било бы по всем сразу.
    const real = forwarded?.split(',')[0]?.trim() || ip;
    return this.leads.intake(
      {
        key: body.key,
        name: body.name,
        phone: body.phone,
        email: body.email,
        comment: body.comment,
        trap: body.company,
        marks: body.marks,
      },
      { origin, ip: real },
    );
  }
}
