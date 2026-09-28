import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import morgan from 'morgan';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService<AppConfig, true>);

  app.use(helmet());
  app.enableShutdownHooks(); // runs OnModuleDestroy (Prisma/Redis disconnect) on SIGTERM

  app.setGlobalPrefix('/api/v1');

  app.use(morgan('dev'));

  // Behind a load balancer, trust N hops so rate limiting sees the real client IP.
  const trustProxy = config.get('trustProxy', { infer: true });
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

  const port = config.get('port', { infer: true });
  await app.listen(port);
  new Logger('Bootstrap').log(`API listening on port ${port}`);
}

void bootstrap();
