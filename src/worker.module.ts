import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configuration } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { WorkflowEngineWorkerModule } from './modules/workflow-engine/workflow-engine-worker.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * The worker process's own root module — deliberately not AppModule. No
 * HTTP layer, no ThrottlerModule/JwtAuthGuard/ValidationPipe/filters: this
 * process never serves a request, it only pulls jobs off the
 * `workflow-execution` queue and runs step logic against Postgres. Bundled
 * from the same codebase/image as the API (see docker-compose.yml's
 * `worker` service — same image, different command), sharing
 * PrismaService and the step-config DTOs, but running as a genuinely
 * separate process.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: [`.env.${process.env.NODE_ENV ?? 'development'}`, '.env'],
      load: [configuration],
      validate: validateEnv, // fail fast on boot, same as the API
    }),
    PrismaModule,
    WorkflowEngineWorkerModule,
  ],
})
export class WorkerModule {}
