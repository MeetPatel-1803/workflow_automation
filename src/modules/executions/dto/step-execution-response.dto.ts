import { Exclude, Expose } from 'class-transformer';

@Exclude()
export class StepExecutionResponseDto {
  @Expose() id: string;
  @Expose() stepId: string;
  @Expose() stepType: string;
  @Expose() attempt: number;
  @Expose() status: string;
  @Expose() input: unknown;
  @Expose() output: unknown;
  @Expose() error: string | null;
  @Expose() startedAt: Date | null;
  @Expose() completedAt: Date | null;
}
