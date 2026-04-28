import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { AuthModule } from './modules/common/auth/auth.module';
import { PrismaModule } from './modules/common/prisma/prisma.module';
import { UsersModule } from './modules/core/users/users.module';
import { EnrollmentsModule } from './modules/core/enrollments/enrollments.module';
import { LessonsModule } from './modules/core/lessons/lessons.module';
import { PayoutsModule } from './modules/core/payouts/payouts.module';
import { ValidationModule } from './modules/common/validation/validation.module';
import { ConfigModule } from '@nestjs/config';

const commonModules = [
  ConfigModule.forRoot({ isGlobal: true }),
  AuthModule,
  PrismaModule,
  ValidationModule.forRoot({
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }),
];

const coreModules = [
  UsersModule,
  EnrollmentsModule,
  LessonsModule,
  PayoutsModule,
];

@Module({
  imports: [...commonModules, ...coreModules],
  controllers: [HealthController],
})
export class AppModule {}
