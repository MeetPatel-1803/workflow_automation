import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ReconciliationService } from './reconciliation.service';
import { StepHandlerDispatchService } from './step-handlers/step-handler-dispatch.service';
import { WorkflowEngineModule } from './workflow-engine.module';
import { WorkflowExecutionProcessor } from './workflow-execution.processor';
import { WorkflowExecutionTickService } from './workflow-execution-tick.service';

/**
 * Worker-only: the BullMQ processor, the tick logic it delegates to, and the
 * reconciliation cron. Imported only by src/worker.ts's bootstrap module —
 * never by the API's AppModule — so the reconciliation cron and step
 * execution genuinely only run in the worker process.
 */
@Module({
  imports: [WorkflowEngineModule, ScheduleModule.forRoot()],
  providers: [
    StepHandlerDispatchService,
    WorkflowExecutionTickService,
    WorkflowExecutionProcessor,
    ReconciliationService,
  ],
  exports: [WorkflowExecutionTickService],
})
export class WorkflowEngineWorkerModule {}
