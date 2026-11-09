import './tracing';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { nestLogger } from './observability';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: nestLogger });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
void bootstrap();
