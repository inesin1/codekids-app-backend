import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import helmet from 'helmet';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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

  await app.listen(3000);
}
bootstrap();
