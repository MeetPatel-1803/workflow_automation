import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/**
 * Tracks by organizationId instead of IP — so one org flooding
 * POST /workflows/:id/execute can't be worked around by spreading requests
 * across many client IPs, and conversely one IP can't exhaust another org's
 * budget. Runs *in addition to* the global IP-based ThrottlerGuard (see
 * README "Rate limiting"): both guards fire for this route, each against
 * its own named throttler config, so both protections apply at once.
 *
 * Requires JwtAuthGuard to have already populated request.user (this guard
 * is only ever applied to already-protected routes).
 */
@Injectable()
export class OrgThrottlerGuard extends ThrottlerGuard {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const orgId = (req.user as AuthenticatedUser | undefined)?.orgId;
    return orgId ?? (req.ip as string);
  }
}
