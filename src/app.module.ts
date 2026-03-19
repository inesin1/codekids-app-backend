import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { AuthModule } from './modules/common/auth/auth.module';
import { PrismaModule } from './modules/common/prisma/prisma.module';
import { UsersModule } from './modules/core/users/users.module';
import { ValidationModule } from './modules/common/validation/validation.module';
import { ConfigModule } from '@nestjs/config';

const commonModules = [
  ConfigModule.forRoot(),
  AuthModule,
  PrismaModule,
  ValidationModule.forRoot({
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }),
];

const coreModules = [UsersModule];

@Module({
  imports: [...commonModules, ...coreModules],
  controllers: [HealthController],
})
export class AppModule {}
