import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import { HealthController } from './health.controller';
import { AuditModule } from './modules/common/audit/audit.module';
import { AuthModule } from './modules/common/auth/auth.module';
import { PrismaModule } from './modules/common/prisma/prisma.module';
import { UsersModule } from './modules/core/users/users.module';
import { EnrollmentsModule } from './modules/core/enrollments/enrollments.module';
import { CoursesModule } from './modules/core/courses/courses.module';
import { LessonsModule } from './modules/core/lessons/lessons.module';
import { PayoutsModule } from './modules/core/payouts/payouts.module';
import { ValidationModule } from './modules/common/validation/validation.module';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

const commonModules = [
  ConfigModule.forRoot({ isGlobal: true }),
  ScheduleModule.forRoot(),
  ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
  // saveReq: guard проставляет request.user после middleware,
  // поэтому AuditService читает актора из запроса в момент записи
  ClsModule.forRoot({
    global: true,
    middleware: { mount: true, saveReq: true },
  }),
  AuthModule,
  PrismaModule,
  AuditModule,
  ValidationModule.forRoot({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
  }),
];

const coreModules = [
  UsersModule,
  CoursesModule,
  EnrollmentsModule,
  LessonsModule,
  PayoutsModule,
];

@Module({
  imports: [...commonModules, ...coreModules],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
