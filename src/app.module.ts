import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { AuthModule } from './modules/common/auth/auth.module';
import { PrismaModule } from './modules/common/prisma/prisma.module';
import { ValidationModule } from './modules/common/validation/validation.module';

const commonModules = [
  AuthModule,
  PrismaModule,
  ValidationModule.forRoot({
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }),
];

@Module({
  imports: [...commonModules],
  controllers: [HealthController],
})
export class AppModule {}
