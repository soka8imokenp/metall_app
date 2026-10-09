import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { UpdatesController } from './updates.controller.js';
import { UpdatesService } from './updates.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [UpdatesController],
  providers: [UpdatesService],
  exports: [UpdatesService],
})
export class UpdatesModule {}
