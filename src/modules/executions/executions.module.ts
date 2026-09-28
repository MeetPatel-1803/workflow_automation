import { Module } from '@nestjs/common';
import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';
import { ExecutionsController } from './executions.controller';
import { ExecutionsService } from './executions.service';
import { WorkflowExecutionController } from './workflow-execution.controller';

@Module({
  imports: [WorkflowEngineModule],
  controllers: [WorkflowExecutionController, ExecutionsController],
  providers: [ExecutionsService],
})
export class ExecutionsModule {}
