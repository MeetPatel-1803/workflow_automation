import {
  Controller,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiError } from '../../shared/response/apiError.service';
import type { ApiResponse } from '../../shared/response/apiResponse.service';
import { ResponseService } from '../../shared/response/apiResponse.service';
import { ExecuteWorkflowResponseDto } from './dto/execute-workflow-response.dto';
import { ExecutionsService } from './executions.service';
import { OrgThrottlerGuard } from './org-throttler.guard';

const ONE_MINUTE_MS = 60_000;
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

function normalizeIdempotencyKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined; // treat a blank header as absent
  if (trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw ApiError.badRequest(
      `Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    );
  }
  return trimmed;
}

/**
 * Separate from WorkflowsController (different module, same 'workflows'
 * path prefix — Nest routes purely by registered path/method, so two
 * controller classes sharing a prefix is fine) since scheduling an
 * execution is this module's responsibility, not WorkflowsModule's.
 */
@Controller('workflows')
export class WorkflowExecutionController {
  constructor(
    private readonly executionsService: ExecutionsService,
    private readonly responseService: ResponseService,
  ) {}

  // Per-org limit (OrgThrottlerGuard, named 'perOrgExecute' throttler — see
  // AppModule) in addition to the global per-IP default: an org shouldn't be
  // able to flood the queue regardless of how many IPs it spreads requests
  // across, and one IP shouldn't be able to exhaust another org's budget.
  @UseGuards(OrgThrottlerGuard)
  @Throttle({ perOrgExecute: { limit: 20, ttl: ONE_MINUTE_MS } })
  @Post(':id/execute')
  async execute(
    @CurrentUser('orgId') organizationId: string,
    @Param('id', ParseUUIDPipe) workflowId: string,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<ExecuteWorkflowResponseDto>> {
    const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
    const result = await this.executionsService.execute(
      organizationId,
      workflowId,
      idempotencyKey,
    );

    // 202 for a brand-new execution (accepted for async processing, nothing
    // has run yet); 200 when this is an idempotent replay returning an
    // execution that already existed — see README "How idempotency works".
    res.status(result.created ? HttpStatus.ACCEPTED : HttpStatus.OK);

    return this.responseService.success(
      { executionId: result.executionId, status: result.status },
      result.created
        ? 'Execution accepted'
        : 'Existing execution returned for this idempotency key',
    );
  }
}
