import { IsInt, Max, Min } from 'class-validator';

const ONE_SECOND_MS = 1_000;
const TWENTY_FOUR_HOURS_MS = 86_400_000;

export class DelayStepConfigDto {
  // Max is a configurable limit against typo'd durations, not an
  // architectural ceiling — see README "Technical Decisions".
  @IsInt()
  @Min(ONE_SECOND_MS, { message: 'durationMs must be at least 1000ms (1s)' })
  @Max(TWENTY_FOUR_HOURS_MS, {
    message: 'durationMs must be at most 86400000ms (24h)',
  })
  durationMs: number;
}
