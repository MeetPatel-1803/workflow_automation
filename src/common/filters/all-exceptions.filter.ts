import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';
import { ApiError } from '../../shared/response/apiError.service';
import { ResponseService } from '../../shared/response/apiResponse.service';

interface Resolved {
  statusCode: number;
  message: string | string[];
}

/**
 * Single choke point for every error. Always responds through
 * ResponseService.error(...), i.e. { data: null, meta: { code: FAIL, message,
 * statusCode, error, timestamp, path } }. Unknown errors are logged
 * server-side and returned as an opaque 500 — never leak stack traces or
 * driver/Prisma internals in the body.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly responseService: ResponseService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { statusCode, message } = this.resolve(exception);

    if (statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${statusCode}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body = this.responseService.error(message, {
      statusCode,
      error: STATUS_CODES[statusCode] ?? 'Error',
      timestamp: new Date().toISOString(),
      path: (request.originalUrl ?? request.url).split('?')[0],
    });
    response.status(statusCode).json(body);
  }

  private resolve(exception: unknown): Resolved {
    if (exception instanceof ApiError) {
      return { statusCode: exception.statusCode, message: exception.message };
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const res = exception.getResponse();
      const message =
        typeof res === 'string'
          ? res
          : res && typeof res === 'object' && 'message' in res
            ? (res as { message: string | string[] }).message
            : exception.message;
      return { statusCode, message };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    };
  }
}
