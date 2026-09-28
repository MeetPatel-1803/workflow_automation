import { Exclude, Expose, Type } from 'class-transformer';
import { StepExecutionResponseDto } from './step-execution-response.dto';

@Exclude()
export class ExecutionDetailResponseDto {
  @Expose() executionId: string;
  @Expose() workflowId: string;
  @Expose() status: string;
  @Expose() currentStep: string | null;
  @Expose() startedAt: Date | null;
  @Expose() completedAt: Date | null;
  @Expose() error: string | null;

  @Expose()
  @Type(() => StepExecutionResponseDto)
  stepExecutions: StepExecutionResponseDto[];
}
