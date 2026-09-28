import axios, { type AxiosError } from 'axios';
import type { HttpStepConfigDto } from '../../workflows/dto/step-configs/http-step-config.dto';
import {
  assertSafeExternalUrl,
  UnsafeExternalUrlError,
} from '../ssrf/assert-safe-external-url';
import {
  HTTP_STEP_MAX_RESPONSE_BYTES,
  HTTP_STEP_STORED_BODY_MAX_CHARS,
} from '../workflow-engine.constants';
import type {
  StepHandlerContext,
  StepHandlerOutcome,
} from './step-handler.types';

/**
 * http step: makes the configured request and reports the outcome.
 *
 * Failure classification (see README "How http step failures are
 * classified"): a network error, DNS failure, connection refused, or
 * timeout is RETRYABLE (transient, may succeed on a later attempt). A
 * completed response — even a 4xx/5xx — is always a SUCCESS at this layer;
 * `axios.validateStatus` is set to accept every status code, so the
 * business meaning of a non-2xx status is left entirely to a downstream
 * `condition` step. An SSRF-blocked or malformed URL, and an
 * over-size response, are NON-retryable — retrying changes nothing about
 * either.
 */
export async function httpStepHandler({
  step,
}: StepHandlerContext): Promise<StepHandlerOutcome> {
  const config = step.config as HttpStepConfigDto;

  try {
    await assertSafeExternalUrl(config.url);
  } catch (error) {
    return {
      kind: 'failure',
      retryable: false,
      error: error instanceof Error ? error.message : 'Blocked URL',
    };
  }

  try {
    const response = await axios.request({
      method: config.method,
      url: config.url,
      headers: config.headers,
      data: config.body,
      timeout: config.timeoutMs,
      // SSRF: never auto-follow redirects (a redirect to an internal IP is
      // a classic bypass of hostname-based checks). Supporting redirects
      // safely would mean re-validating each Location header manually;
      // out of scope here — see README "SSRF protections".
      maxRedirects: 0,
      maxContentLength: HTTP_STEP_MAX_RESPONSE_BYTES,
      maxBodyLength: HTTP_STEP_MAX_RESPONSE_BYTES,
      // Never throw on a non-2xx — see the failure-classification note above.
      validateStatus: () => true,
    });

    const rawBody: unknown = response.data;
    const serialized =
      typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody ?? null);
    const truncated = serialized.length > HTTP_STEP_STORED_BODY_MAX_CHARS;
    const headers =
      typeof (response.headers as { toJSON?: () => unknown })?.toJSON ===
      'function'
        ? (response.headers as { toJSON: () => unknown }).toJSON()
        : response.headers;

    return {
      kind: 'success',
      output: {
        statusCode: response.status,
        headers,
        body: truncated
          ? `${serialized.slice(0, HTTP_STEP_STORED_BODY_MAX_CHARS)}…[truncated]`
          : rawBody,
        truncated,
      },
    };
  } catch (error) {
    if (error instanceof UnsafeExternalUrlError) {
      return { kind: 'failure', retryable: false, error: error.message };
    }
    if (axios.isAxiosError(error)) {
      if (
        error.message.includes('maxContentLength') ||
        error.message.includes('maxBodyLength')
      ) {
        return {
          kind: 'failure',
          retryable: false,
          error: `Response exceeded max size (${HTTP_STEP_MAX_RESPONSE_BYTES} bytes)`,
        };
      }
      // Since validateStatus always returns true, a completed response never
      // reaches this branch — every axios error here means the request
      // itself never completed (DNS, connection, timeout): retryable.
      return {
        kind: 'failure',
        retryable: true,
        error: describeAxiosError(error),
      };
    }
    return {
      kind: 'failure',
      retryable: true,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function describeAxiosError(error: AxiosError): string {
  if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
    return `Request timed out after ${error.config?.timeout ?? '?'}ms`;
  }
  return error.message;
}
