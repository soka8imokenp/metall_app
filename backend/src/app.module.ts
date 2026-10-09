import { MiddlewareConsumer, Module, NestModule, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthGuard } from './auth/auth.guard.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { SalesModule } from './sales/sales.module.js';
import { ProductionModule } from './production/production.module.js';
import { WarehouseModule } from './warehouse/warehouse.module.js';
import { FinanceModule } from './finance/finance.module.js';
import { AttachmentsModule } from './attachments/attachments.module.js';
import { RefsModule } from './refs/refs.module.js';
import { CrmModule } from './crm/crm.module.js';
import { PublicModule } from './public/public.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { AdminModule } from './admin/admin.module.js';
import { SearchModule } from './search/search.module.js';
import { ExchangeModule } from './exchange/exchange.module.js';
import { BackupModule } from './backup/backup.module.js';
import { PushModule } from './push/push.module.js';
import { UpdatesModule } from './updates/updates.module.js';
import { ContextMiddleware } from './common/context.middleware.js';
import { EnvelopeInterceptor } from './common/envelope.interceptor.js';
import { IdempotencyInterceptor } from './common/idempotency.interceptor.js';
import { ErrorFilter } from './common/error.filter.js';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    DashboardModule,
    SalesModule,
    ProductionModule,
    WarehouseModule,
    FinanceModule,
    AttachmentsModule,
    RefsModule,
    CrmModule,
    PublicModule,
    DocumentsModule,
    AdminModule,
    SearchModule,
    ExchangeModule,
    BackupModule,
    PushModule,
    UpdatesModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    // После конверта, то есть внутри него: хранится и повторяется сам ответ
    // обработчика, а конверт с новым requestId надевается и на повтор.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: ErrorFilter },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // На все маршруты, включая /auth/login: requestId и локаль нужны и там,
    // а контекст должен существовать раньше, чем до него доберётся guard.
    // '{*path}' вместо '*': path-to-regexp новых версий звёздочку без имени
    // не принимает и ругается на авто-преобразование.
    consumer.apply(ContextMiddleware).forRoutes('{*path}');
  }
}
