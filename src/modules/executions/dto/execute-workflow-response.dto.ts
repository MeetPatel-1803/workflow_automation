import { Exclude, Expose } from 'class-transformer';

@Exclude()
export class ExecuteWorkflowResponseDto {
  @Expose() executionId: string;
  @Expose() status: string;
}
