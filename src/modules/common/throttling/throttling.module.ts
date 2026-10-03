import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PostgresThrottlerStorage } from './postgres-throttler.storage';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [PostgresThrottlerStorage],
  exports: [PostgresThrottlerStorage],
})
export class ThrottlingModule {}
