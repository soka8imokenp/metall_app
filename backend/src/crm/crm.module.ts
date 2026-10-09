import { Module } from '@nestjs/common';
import { CrmController } from './crm.controller.js';
import { PartnersService } from './partners.service.js';
import { LeadsService } from './leads.service.js';
import { DealsService } from './deals.service.js';
import { TasksService } from './tasks.service.js';
import { CrmRefsService } from './refs.service.js';
import { ActivitiesService } from './activities.service.js';
import { PartnerCardService } from './partner-card.service.js';
import { CrmReportsService } from './reports.service.js';
import { SiteKeysService } from './site-keys.service.js';

@Module({
  controllers: [CrmController],
  providers: [
    PartnersService,
    LeadsService,
    DealsService,
    TasksService,
    CrmRefsService,
    ActivitiesService,
    PartnerCardService,
    CrmReportsService,
    SiteKeysService,
  ],
})
export class CrmModule {}
