import { Injectable } from '@nestjs/common';
import { CONSTANTS } from '../../common/constants/app.constants';

export interface ResponseMeta {
  code: number;
  message?: string | string[];
  [key: string]: unknown;
}

export interface ApiResponse<T> {
  data: T;
  meta: ResponseMeta;
}

export type ResponseExtras = Record<string, unknown>;

/**
 * Every controller builds its HTTP response through this service, and
 * AllExceptionsFilter is the only other place that builds one (for errors).
 * `meta.code` is a fixed success/fail flag (see app.constants.ts), not the
 * HTTP status — the real status is still set via @HttpCode / thrown errors.
 */
@Injectable()
export class ResponseService {
  /** Wraps a successful payload. Pass `null` for endpoints with no payload. */
  success<T>(
    data: T,
    message?: string,
    extras?: ResponseExtras,
  ): ApiResponse<T> {
    return {
      data,
      meta: { code: CONSTANTS.META_CODE.SUCCESS, message, ...extras },
    };
  }

  /** Used by AllExceptionsFilter for every error response. */
  error(
    message?: string | string[],
    extras?: ResponseExtras,
  ): ApiResponse<null> {
    return {
      data: null,
      meta: { code: CONSTANTS.META_CODE.FAIL, message, ...extras },
    };
  }
}
