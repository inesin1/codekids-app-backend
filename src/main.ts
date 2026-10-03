import 'dotenv/config';
import './instrument';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import helmet from 'helmet';
import { parseTrustedProxies } from './modules/common/business-time';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const trustedProxies = parseTrustedProxies(process.env.TRUSTED_PROXIES);
  const expressApp = app
    .getHttpAdapter()
    .getInstance() as import('express').Express;
  expressApp.set('trust proxy', trustedProxies.length ? trustedProxies : false);

  app.setGlobalPrefix('api');

  app.enableCors({
    origin: [
      /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/,
      /^https:\/\/[\w-]+\.codekids\.cc$/,
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  });

  app.use(helmet({ contentSecurityPolicy: false }));

  app.enableShutdownHooks();

  await app.listen(process.env.PORT || 3000);
}
void bootstrap();
