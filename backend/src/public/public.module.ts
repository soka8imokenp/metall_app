import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PublicController } from './public.controller.js';
import { PublicLeadsService } from './public-leads.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [PublicController],
  providers: [PublicLeadsService],
})
export class PublicModule {}
