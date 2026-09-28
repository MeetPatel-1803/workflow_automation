import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Shape attached to `request.user` by JwtStrategy.validate(). */
export interface AuthenticatedUser {
  userId: string;
  orgId: string;
  email: string;
}

/**
 * Injects the authenticated user (or one field of it) into a handler:
 *   @CurrentUser() user: AuthenticatedUser
 *   @CurrentUser('orgId') orgId: string
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user: AuthenticatedUser }>();
    return field ? request.user?.[field] : request.user;
  },
);
