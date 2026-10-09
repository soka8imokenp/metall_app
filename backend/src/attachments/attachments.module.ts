import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';

@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  // Наружу — для бота: фото чека и снимок при списании прикладывает он, а
  // проверки размера, типа и права живут в службе и повторять их нельзя.
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
