import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { SimpleAuthGuard } from './guards/auth.guard';

@Module({
  imports: [ConfigModule.forRoot()],
  providers: [
    {
      provide: APP_GUARD,
      useClass: SimpleAuthGuard,
    },
  ],
})
export class AuthModule {}
