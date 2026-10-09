import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { DocumentTypesService } from './types.service.js';
import { NumberingService } from './numbering.service.js';
import { DocumentsFromSourceService } from './from-source.service.js';
import { DocumentTemplatesService } from './templates.service.js';
import { DocumentRenderService } from './render.service.js';
import { DocumentWorkflowService } from './workflow.service.js';

@Module({
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    DocumentTypesService,
    NumberingService,
    DocumentsFromSourceService,
    DocumentTemplatesService,
    DocumentRenderService,
    DocumentWorkflowService,
  ],
  // Выдачу номера дальше возьмёт создание документа из источника (Э3) —
  // оно живёт в этом же модуле, но службу экспортируем сразу: номер нужен
  // и продажам, когда счёт выписывают прямо из заказа.
  //
  // Реестр, маршрут и печать отдаём наружу для раздела «Документы» в боте:
  // согласование должно идти теми же правилами, что на экране, а не второй
  // их копией.
  // Создание из источника — тоже наружу: счёт из заказа выписывают и из бота,
  // и реквизиты со строками обязан собирать один и тот же код.
  exports: [
    NumberingService,
    DocumentsService,
    DocumentWorkflowService,
    DocumentRenderService,
    DocumentsFromSourceService,
  ],
})
export class DocumentsModule {}
