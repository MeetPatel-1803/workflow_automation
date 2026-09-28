import { Exclude, Expose } from 'class-transformer';

/**
 * GET /workflows (list) response shape. Deliberately excludes the `steps`
 * JSONB blob — a workflow can have up to 50 steps with arbitrary per-step
 * config, and the list endpoint has no use for the full payload. Callers
 * that need the full definition use GET /workflows/:id. See README
 * "Technical Decisions".
 */
@Exclude()
export class WorkflowSummaryDto {
  @Expose() id: string;
  @Expose() name: string;
  @Expose() stepCount: number;
  @Expose() createdAt: Date;
}
