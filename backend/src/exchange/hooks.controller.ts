import { Controller, Headers, Ip, Param, Post, Req } from '@nestjs/common';
import { Matches } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../auth/auth.guard.js';
import { ExchangeInboundService } from './inbound.service.js';

class CodeParams {
  @Matches(/^[a-z][a-z0-9_-]{1,31}$/) code!: string;
}

/**
 * Приём входящих вебхуков (ТЗ 12).
 *
 * Отдельный контроллер, а не маршрут в `ExchangeController`: здесь нет сессии,
 * проверка идёт по ключу подключения, и тело приходит сырыми байтами. Держать
 * это рядом с админскими маршрутами значило бы, что однажды кто-то снимет с
 * одного из них `@RequirePermissions` вместе с соседним.
 *
 * Путь без `/exchange` — чужая система получает короткий адрес
 * `POST /api/v1/hooks/<код>`, и он не меняется, когда админская часть
 * переедет.
 */
@Controller('hooks')
export class HooksController {
  constructor(private readonly inbound: ExchangeInboundService) {}

  /**
   * Тело читается из `req.body` как `Buffer`: `express.raw()` на этом пути стоит
   * в `main.ts`. Байт в байт — иначе подпись не сойдётся: HMAC считается по
   * сырому тексту, а `JSON.parse` + `JSON.stringify` переставят пробелы и
   * порядок ключей, и верная подпись станет неверной.
   */
  @Public()
  @Post(':code')
  intake(
    @Param() p: CodeParams,
    @Req() req: Request,
    @Headers('x-exchange-key') key: string | undefined,
    @Headers('x-exchange-signature') signature: string | undefined,
    @Headers('x-exchange-message-id') messageId: string | undefined,
    @Headers('x-exchange-event') event: string | undefined,
    @Headers('x-forwarded-for') forwarded: string | undefined,
    @Ip() ip: string,
  ) {
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    // За nginx `@Ip()` вернёт адрес самого nginx — для списка разрешённых
    // адресов и для ограничения частоты нужен первый в цепочке, то есть тот,
    // кто действительно пришёл. Так же сделано в приёме заявок с сайта.
    const real = forwarded?.split(',')[0]?.trim() || ip;
    return this.inbound.intake(p.code, bytes, {
      key,
      signature,
      messageId,
      event,
      ip: real,
    });
  }
}
