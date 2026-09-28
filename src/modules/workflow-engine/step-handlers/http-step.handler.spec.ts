import nock from 'nock';
import { HttpMethod } from '../../workflows/dto/step-configs/http-step-config.dto';
import { StepType } from '../../workflows/dto/step-type.enum';
import type { StepDto } from '../../workflows/dto/step.dto';
import { HTTP_STEP_MAX_RESPONSE_BYTES } from '../workflow-engine.constants';
import { httpStepHandler } from './http-step.handler';

function httpStep(config: {
  method?: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}): StepDto {
  return {
    id: 'http-step',
    type: StepType.HTTP,
    config: {
      method: HttpMethod.GET,
      timeoutMs: 10_000,
      maxAttempts: 1,
      retryDelayMs: 1000,
      ...config,
    },
  } as StepDto;
}

describe('httpStepHandler', () => {
  beforeAll(() => nock.disableNetConnect());
  afterEach(() => nock.cleanAll());
  afterAll(() => nock.enableNetConnect());

  it('success: returns statusCode/headers/body for a 2xx response', async () => {
    nock('http://1.1.1.1')
      .get('/ok')
      .reply(200, { hello: 'world' }, { 'content-type': 'application/json' });

    const outcome = await httpStepHandler({
      step: httpStep({ url: 'http://1.1.1.1/ok' }),
      attempt: 1,
      previousOutput: undefined,
    });

    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      const output = outcome.output as { statusCode: number; body: unknown };
      expect(output.statusCode).toBe(200);
      expect(output.body).toEqual({ hello: 'world' });
    }
  });

  it('a non-2xx response is still a SUCCESS at this layer (condition step interprets it)', async () => {
    nock('http://1.1.1.1').get('/broken').reply(500, { error: 'boom' });

    const outcome = await httpStepHandler({
      step: httpStep({ url: 'http://1.1.1.1/broken' }),
      attempt: 1,
      previousOutput: undefined,
    });

    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect((outcome.output as { statusCode: number }).statusCode).toBe(500);
    }
  });

  it('does not follow redirects: a 3xx is returned as-is, Location is never fetched', async () => {
    nock('http://1.1.1.1')
      .get('/redir')
      .reply(302, undefined, { location: 'http://169.254.169.254/secret' });
    const metadataScope = nock('http://169.254.169.254')
      .get('/secret')
      .reply(200, 'should never be hit');

    const outcome = await httpStepHandler({
      step: httpStep({ url: 'http://1.1.1.1/redir' }),
      attempt: 1,
      previousOutput: undefined,
    });

    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect((outcome.output as { statusCode: number }).statusCode).toBe(302);
    }
    expect(metadataScope.isDone()).toBe(false);
  });

  it('SSRF-blocked URL: non-retryable failure, no network call made', async () => {
    const scope = nock('http://127.0.0.1')
      .get('/')
      .reply(200, 'should never be hit');

    const outcome = await httpStepHandler({
      step: httpStep({ url: 'http://127.0.0.1/' }),
      attempt: 1,
      previousOutput: undefined,
    });

    expect(outcome).toMatchObject({ kind: 'failure', retryable: false });
    expect(scope.isDone()).toBe(false);
  });

  it('network error: retryable failure', async () => {
    nock('http://1.1.1.1')
      .get('/fail')
      .replyWithError('simulated network error');

    const outcome = await httpStepHandler({
      step: httpStep({ url: 'http://1.1.1.1/fail' }),
      attempt: 1,
      previousOutput: undefined,
    });

    expect(outcome).toMatchObject({ kind: 'failure', retryable: true });
  });

  it('timeout: retryable failure', async () => {
    nock('http://1.1.1.1').get('/slow').delay(300).reply(200, 'too slow');

    const outcome = await httpStepHandler({
      step: httpStep({ url: 'http://1.1.1.1/slow', timeoutMs: 50 }),
      attempt: 1,
      previousOutput: undefined,
    });

    expect(outcome).toMatchObject({ kind: 'failure', retryable: true });
  });

  it('over-size response: non-retryable failure', async () => {
    nock('http://1.1.1.1')
      .get('/huge')
      .reply(200, 'x'.repeat(HTTP_STEP_MAX_RESPONSE_BYTES + 1000));

    const outcome = await httpStepHandler({
      step: httpStep({ url: 'http://1.1.1.1/huge' }),
      attempt: 1,
      previousOutput: undefined,
    });

    expect(outcome).toMatchObject({ kind: 'failure', retryable: false });
  });
});
