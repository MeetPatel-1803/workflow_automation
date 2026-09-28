import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  // Standalone application context — no HTTP listener. See worker.module.ts.
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks(); // graceful Prisma/Redis disconnect on SIGTERM
  new Logger('WorkerBootstrap').log('Workflow execution worker started');
}

void bootstrap();
