import { Exclude, Expose } from 'class-transformer';
import type { StepDto } from './step.dto';

/**
 * GET /workflows/:id and POST /workflows response shape — the full
 * definition, including `webhookKey`. `webhookKey` is sensitive-ish (it's a
 * bearer-style secret for the public webhook endpoint added in a later
 * module): this app has no request/response access-logging middleware, so
 * there's nowhere it would currently leak into logs, but avoid adding one
 * without redacting this field.
 */
@Exclude()
export class WorkflowDetailDto {
  @Expose() id: string;
  @Expose() organizationId: string;
  @Expose() name: string;
  @Expose() steps: StepDto[];
  @Expose() webhookKey: string;
  @Expose() createdById: string;
  @Expose() createdAt: Date;
  @Expose() updatedAt: Date;
}
