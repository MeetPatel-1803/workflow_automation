import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { WORKFLOW_EXECUTION_QUEUE } from './workflow-engine.constants';
import { WorkflowExecutionQueueService } from './workflow-execution-queue.service';

/**
 * Producer-side only: registers the BullMQ connection + the
 * `workflow-execution` queue, and exports WorkflowExecutionQueueService for
 * ExecutionsService to enqueue into. Imported by the API app.
 *
 * The processor, the tick logic, and the reconciliation cron are
 * deliberately NOT here — they live in WorkflowEngineWorkerModule, imported
 * only by the separate worker entrypoint (src/worker.ts), so `api` and
 * `worker` are genuinely separate processes: the API can enqueue jobs
 * without ever running step logic itself, and the worker (not the API) is
 * what actually executes workflows.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const redis = config.get('redis', { infer: true });
        return {
          connection: { host: redis.host, port: redis.port, db: redis.db },
        };
      },
    }),
    BullModule.registerQueue({ name: WORKFLOW_EXECUTION_QUEUE }),
  ],
  providers: [WorkflowExecutionQueueService],
  exports: [WorkflowExecutionQueueService, BullModule],
})
export class WorkflowEngineModule {}
