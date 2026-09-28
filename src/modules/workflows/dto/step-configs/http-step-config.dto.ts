import {
  IsIn,
  IsInt,
  IsOptional,
  IsUrl,
  Max,
  Min,
  Validate,
} from 'class-validator';
import { IsStringRecord } from '../../validators/is-string-record.validator';

export enum HttpMethod {
  GET = 'GET',
  POST = 'POST',
  PUT = 'PUT',
  PATCH = 'PATCH',
  DELETE = 'DELETE',
}

const HTTP_METHODS = Object.values(HttpMethod);

export class HttpStepConfigDto {
  @IsIn(HTTP_METHODS, {
    message: `method must be one of: ${HTTP_METHODS.join(', ')}`,
  })
  method: HttpMethod;

  @IsUrl(
    { require_protocol: true },
    { message: 'url must be a valid absolute URL (e.g. https://example.com)' },
  )
  url: string;

  @IsOptional()
  @Validate(IsStringRecord, {
    message: 'headers must be an object of string keys to string values',
  })
  headers?: Record<string, string>;

  // JSON-serializable request body — shape is opaque to us and depends on the
  // target API, so we intentionally don't validate its structure further.
  @IsOptional()
  body?: unknown;

  // Bounded so a misconfigured step can't tie up a worker indefinitely.
  @IsOptional()
  @IsInt()
  @Min(100, { message: 'timeoutMs must be at least 100ms' })
  @Max(60_000, { message: 'timeoutMs must be at most 60000ms (60s)' })
  timeoutMs: number = 10_000;

  // Business-level retry (distinct from BullMQ's own infra-level `attempts`
  // — see README "How retries work"). Only meaningful for http steps: a
  // network error/timeout is retryable; a non-2xx status is not (see the
  // http step handler) and a condition's false result never is. Condition/
  // delay/complete step configs deliberately do NOT declare these fields, so
  // the global ValidationPipe's forbidNonWhitelisted rejects them there at
  // 400 rather than silently ignoring a no-op retry config.
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'maxAttempts must be at least 1' })
  @Max(10, { message: 'maxAttempts must be at most 10' })
  maxAttempts: number = 1;

  @IsOptional()
  @IsInt()
  @Min(100, { message: 'retryDelayMs must be at least 100ms' })
  @Max(60_000, { message: 'retryDelayMs must be at most 60000ms (60s)' })
  retryDelayMs: number = 1_000;
}
