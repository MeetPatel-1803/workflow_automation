import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import Redis from 'ioredis';
import nock from 'nock';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { WorkflowEngineWorkerModule } from '../src/modules/workflow-engine/workflow-engine-worker.module';
import { WorkflowExecutionTickService } from '../src/modules/workflow-engine/workflow-execution-tick.service';
import { WORKFLOW_EXECUTION_QUEUE } from '../src/modules/workflow-engine/workflow-engine.constants';
import { resetDatabase } from './reset-db';

const API = '/api/v1';
const MOCK_HOST = 'http://1.1.1.1'; // literal public IP: skips DNS, passes SSRF check, nock-interceptable

function workflowBody(
  overrides: Partial<{ name: string; steps: unknown[] }> = {},
) {
  return {
    name: 'e2e workflow',
    steps: [
      {
        id: 'call-api',
        type: 'http',
        config: { method: 'GET', url: `${MOCK_HOST}/ok` },
      },
      { id: 'done', type: 'complete' },
    ],
    ...overrides,
  };
}

/** Polls `fn` until `predicate(result)` is true or `timeoutMs` elapses. */
async function poll<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `poll() timed out after ${timeoutMs}ms; last value: ${JSON.stringify(value)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('Workflow execution (e2e)', () => {
  let app: INestApplication<App>;
  const prisma = new PrismaClient();
  let redis: Redis;
  let queue: Queue;
  let tickService: WorkflowExecutionTickService;

  let tokenA: string;
  let tokenB: string;

  const server = () => app.getHttpServer();
  const asA = {
    post: (path: string) =>
      request(server()).post(path).set('Authorization', `Bearer ${tokenA}`),
    get: (path: string) =>
      request(server()).get(path).set('Authorization', `Bearer ${tokenA}`),
  };
  const asB = {
    post: (path: string) =>
      request(server()).post(path).set('Authorization', `Bearer ${tokenB}`),
    get: (path: string) =>
      request(server()).get(path).set('Authorization', `Bearer ${tokenB}`),
  };

  const register = (body: object) =>
    request(server()).post(`${API}/auth/register`).send(body);

  async function createWorkflow(as: typeof asA, body = workflowBody()) {
    const res = await as.post(`${API}/workflows`).send(body).expect(201);
    return res.body.data.id as string;
  }

  function execute(
    as: typeof asA,
    workflowId: string,
    idempotencyKey?: string,
  ) {
    const req = as.post(`${API}/workflows/${workflowId}/execute`);
    if (idempotencyKey) req.set('Idempotency-Key', idempotencyKey);
    return req.send();
  }

  function getExecution(as: typeof asA, executionId: string) {
    return as.get(`${API}/executions/${executionId}`);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, WorkflowEngineWorkerModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    queue = moduleRef.get<Queue>(getQueueToken(WORKFLOW_EXECUTION_QUEUE));
    tickService = moduleRef.get(WorkflowExecutionTickService);

    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      db: Number(process.env.REDIS_DB),
    });

    nock.disableNetConnect();
    nock.enableNetConnect(
      (host) => host.includes('127.0.0.1') || host.includes('localhost'),
    );
  });

  beforeEach(async () => {
    // Some tests deliberately inject a duplicate/concurrent job delivery.
    // queue.obliterate() clears queued/delayed jobs but can't cancel one a
    // worker has already picked up and is actively running — if that
    // in-flight tick is still mid-transaction when the deletes below run,
    // it can insert a StepExecution row referencing a WorkflowExecution
    // this beforeEach is about to delete (FK violation) or recreate. Wait
    // for the queue to be fully idle first so no background tick is still
    // touching the DB.
    await poll(
      () => queue.getJobCounts('active', 'waiting', 'delayed'),
      (counts) => Object.values(counts).every((n) => n === 0),
      5000,
      50,
    );

    await resetDatabase(prisma);
    await redis.flushdb();
    await queue.obliterate({ force: true }).catch(() => undefined);
    nock.cleanAll();

    const a = await register({
      email: 'alice@org-a.com',
      password: 'correct-horse-a',
      organizationName: 'Org A',
    }).expect(201);
    tokenA = a.body.meta.accessToken;

    const b = await register({
      email: 'bob@org-b.com',
      password: 'correct-horse-b',
      organizationName: 'Org B',
    }).expect(201);
    tokenB = b.body.meta.accessToken;
  });

  afterAll(async () => {
    nock.enableNetConnect();
    await app.close();
    await prisma.$disconnect();
    redis.disconnect();
  });

  it('full happy path: http -> condition -> delay -> complete, in order, with correct output', async () => {
    nock(MOCK_HOST).get('/ok').reply(200, { status: 'ready' });

    const workflowId = await createWorkflow(
      asA,
      workflowBody({
        steps: [
          {
            id: 'call-api',
            type: 'http',
            config: { method: 'GET', url: `${MOCK_HOST}/ok` },
          },
          {
            id: 'check',
            type: 'condition',
            config: { field: 'body.status', operator: 'eq', value: 'ready' },
          },
          { id: 'wait', type: 'delay', config: { durationMs: 1200 } },
          { id: 'done', type: 'complete' },
        ],
      }),
    );

    const res = await execute(asA, workflowId).expect(202);
    const executionId = res.body.data.executionId as string;
    expect(res.body.data.status).toBe('PENDING');

    const finished = await poll(
      async () => (await getExecution(asA, executionId)).body.data,
      (d) => d.status === 'COMPLETED' || d.status === 'FAILED',
      8000,
    );

    expect(finished.status).toBe('COMPLETED');
    const steps = finished.stepExecutions as Array<{
      stepId: string;
      status: string;
      attempt: number;
    }>;
    expect(steps.map((s) => s.stepId)).toEqual([
      'call-api',
      'check',
      'wait',
      'done',
    ]);
    expect(steps.every((s) => s.status === 'COMPLETED')).toBe(true);
  }, 15_000);

  it('condition step evaluating false ends the execution FAILED with a clear message', async () => {
    nock(MOCK_HOST).get('/ok').reply(200, { status: 'broken' });

    const workflowId = await createWorkflow(
      asA,
      workflowBody({
        steps: [
          {
            id: 'call-api',
            type: 'http',
            config: { method: 'GET', url: `${MOCK_HOST}/ok` },
          },
          {
            id: 'check',
            type: 'condition',
            config: { field: 'body.status', operator: 'eq', value: 'ready' },
          },
          { id: 'done', type: 'complete' },
        ],
      }),
    );

    const res = await execute(asA, workflowId).expect(202);
    const executionId = res.body.data.executionId as string;

    const finished = await poll(
      async () => (await getExecution(asA, executionId)).body.data,
      (d) => d.status === 'COMPLETED' || d.status === 'FAILED',
    );

    expect(finished.status).toBe('FAILED');
    expect(finished.error).toContain("field 'body.status'");
    expect(finished.error).toContain('ready');
  }, 15_000);

  it('retry then succeed: fails twice, succeeds on the 3rd attempt -> 3 StepExecution rows, COMPLETED', async () => {
    nock(MOCK_HOST).get('/flaky').times(2).reply(500);
    nock(MOCK_HOST).get('/flaky').reply(200, { ok: true });

    const workflowId = await createWorkflow(
      asA,
      workflowBody({
        steps: [
          {
            id: 'call-api',
            type: 'http',
            config: {
              method: 'GET',
              url: `${MOCK_HOST}/flaky`,
              maxAttempts: 3,
              retryDelayMs: 100,
            },
          },
          { id: 'done', type: 'complete' },
        ],
      }),
    );

    // A plain 500 is a SUCCESS at the http-step layer (see README) — retries
    // here must come from something that IS retryable. Use a network error
    // instead of a 500 for the first two attempts.
    nock.cleanAll();
    nock(MOCK_HOST)
      .get('/flaky')
      .times(2)
      .replyWithError('simulated network error');
    nock(MOCK_HOST).get('/flaky').reply(200, { ok: true });

    const res = await execute(asA, workflowId).expect(202);
    const executionId = res.body.data.executionId as string;

    const finished = await poll(
      async () => (await getExecution(asA, executionId)).body.data,
      (d) => d.status === 'COMPLETED' || d.status === 'FAILED',
    );

    expect(finished.status).toBe('COMPLETED');
    const callApiAttempts = (
      finished.stepExecutions as Array<{
        stepId: string;
        attempt: number;
        status: string;
      }>
    )
      .filter((s) => s.stepId === 'call-api')
      .sort((a, b) => a.attempt - b.attempt);
    expect(callApiAttempts.map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(callApiAttempts.map((s) => s.status)).toEqual([
      'RETRYING',
      'RETRYING',
      'COMPLETED',
    ]);
  }, 15_000);

  it('retry exhaustion: always fails, maxAttempts=2 -> exactly 2 attempt rows, execution FAILED', async () => {
    nock(MOCK_HOST)
      .get('/always-fails')
      .times(5)
      .replyWithError('simulated network error');

    const workflowId = await createWorkflow(
      asA,
      workflowBody({
        steps: [
          {
            id: 'call-api',
            type: 'http',
            config: {
              method: 'GET',
              url: `${MOCK_HOST}/always-fails`,
              maxAttempts: 2,
              retryDelayMs: 100,
            },
          },
          { id: 'done', type: 'complete' },
        ],
      }),
    );

    const res = await execute(asA, workflowId).expect(202);
    const executionId = res.body.data.executionId as string;

    const finished = await poll(
      async () => (await getExecution(asA, executionId)).body.data,
      (d) => d.status === 'COMPLETED' || d.status === 'FAILED',
    );

    expect(finished.status).toBe('FAILED');
    const attempts = (
      finished.stepExecutions as Array<{ stepId: string; attempt: number }>
    ).filter((s) => s.stepId === 'call-api');
    expect(attempts).toHaveLength(2);
  }, 15_000);

  it('delay step: sits at WAITING during the window, COMPLETED only after it elapses', async () => {
    nock(MOCK_HOST).get('/ok').reply(200, { ok: true });

    const workflowId = await createWorkflow(
      asA,
      workflowBody({
        steps: [
          {
            id: 'call-api',
            type: 'http',
            config: { method: 'GET', url: `${MOCK_HOST}/ok` },
          },
          { id: 'wait', type: 'delay', config: { durationMs: 1500 } },
          { id: 'done', type: 'complete' },
        ],
      }),
    );

    const res = await execute(asA, workflowId).expect(202);
    const executionId = res.body.data.executionId as string;

    const waiting = await poll(
      async () => (await getExecution(asA, executionId)).body.data,
      (d) =>
        (d.stepExecutions as Array<{ stepId: string; status: string }>).some(
          (s) => s.stepId === 'wait' && s.status === 'WAITING',
        ),
    );
    const waitStep = (
      waiting.stepExecutions as Array<{ stepId: string; status: string }>
    ).find((s) => s.stepId === 'wait');
    expect(waitStep?.status).toBe('WAITING');
    expect(waiting.status).toBe('RUNNING');

    const finished = await poll(
      async () => (await getExecution(asA, executionId)).body.data,
      (d) => d.status === 'COMPLETED',
      8000,
    );
    expect(finished.status).toBe('COMPLETED');
  }, 15_000);

  describe('idempotency', () => {
    it('sequential: the same key called twice returns the SAME executionId, only one row exists', async () => {
      nock(MOCK_HOST).get('/ok').reply(200, { ok: true });
      const workflowId = await createWorkflow(asA);

      const first = await execute(asA, workflowId, 'my-key').expect(202);
      const second = await execute(asA, workflowId, 'my-key').expect(200);

      expect(second.body.data.executionId).toBe(first.body.data.executionId);
      expect(await prisma.workflowExecution.count()).toBe(1);
    });

    it('concurrent: 10 simultaneous requests with the same key create exactly ONE execution', async () => {
      nock(MOCK_HOST).get('/ok').reply(200, { ok: true });
      const workflowId = await createWorkflow(asA);

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          execute(asA, workflowId, 'concurrent-key'),
        ),
      );

      const executionIds = new Set(results.map((r) => r.body.data.executionId));
      expect(executionIds.size).toBe(1);
      expect(results.map((r) => r.status).sort()).toEqual(
        [202, ...Array(9).fill(200)].sort(),
      );
      expect(await prisma.workflowExecution.count()).toBe(1);
    });
  });

  it('duplicate job delivery (different jobIds, same executionId) does not execute the step twice', async () => {
    const scope = nock(MOCK_HOST).get('/ok').reply(200, { ok: true });
    const workflowId = await createWorkflow(asA);

    const created = await prisma.workflowExecution.create({
      data: {
        workflowId,
        organizationId: (
          await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } })
        ).organizationId,
        status: 'PENDING',
      },
    });

    // Two real jobs, different jobIds, identical payload — simulates a
    // redelivery under a different id (same-jobId redelivery is already a
    // BullMQ no-op, confirmed separately — see README "jobId strategy").
    const jobA = await queue.add(
      'process-tick',
      { executionId: created.id },
      { jobId: `${created.id}-a` },
    );
    const jobB = await queue.add(
      'process-tick',
      { executionId: created.id },
      { jobId: `${created.id}-b` },
    );

    await poll(
      async () =>
        (
          await prisma.workflowExecution.findUniqueOrThrow({
            where: { id: created.id },
          })
        ).status,
      (status) => status === 'COMPLETED' || status === 'FAILED',
    );

    // Wait for BOTH manually-added jobs to fully settle (the "loser" no-ops
    // via WorkflowExecutionTickService's defensive guard, but still needs a
    // moment to be picked up and run) before this test returns — otherwise
    // its background activity can still be in flight when the *next* test's
    // beforeEach truncates the tables out from under it.
    const isSettled = async (job: typeof jobA) =>
      ['completed', 'failed'].includes(await job.getState());
    await poll(
      () => isSettled(jobA),
      (settled) => settled,
    );
    await poll(
      () => isSettled(jobB),
      (settled) => settled,
    );

    expect(scope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
    const callApiRows = await prisma.stepExecution.findMany({
      where: { executionId: created.id, stepId: 'call-api' },
    });
    expect(callApiRows).toHaveLength(1); // not executed twice
  }, 15_000);

  it('concurrent invocation of the same execution (bypassing the queue) serializes via FOR UPDATE: the step executes once', async () => {
    let hitCount = 0;
    nock(MOCK_HOST)
      .get('/ok')
      .reply(200, () => {
        hitCount += 1;
        return { ok: true };
      });

    const workflowId = await createWorkflow(asA);
    const workflow = await prisma.workflow.findUniqueOrThrow({
      where: { id: workflowId },
    });
    const execution = await prisma.workflowExecution.create({
      data: {
        workflowId,
        organizationId: workflow.organizationId,
        status: 'PENDING',
      },
    });

    // Direct concurrent invocation, bypassing BullMQ entirely — forces the
    // exact race the FOR UPDATE lock exists to serialize.
    await Promise.all([
      tickService.processTick(execution.id),
      tickService.processTick(execution.id),
    ]);

    // Wait for full completion (not just currentStepId === 'done'), so the
    // 'done' job the winning tick enqueued has also finished before this
    // test returns — otherwise it can still be in flight when the next
    // test's beforeEach truncates the tables out from under it.
    await poll(
      async () =>
        (
          await prisma.workflowExecution.findUniqueOrThrow({
            where: { id: execution.id },
          })
        ).status,
      (status) => status === 'COMPLETED' || status === 'FAILED',
    );

    expect(hitCount).toBe(1);
    const rows = await prisma.stepExecution.findMany({
      where: { executionId: execution.id, stepId: 'call-api' },
    });
    expect(rows).toHaveLength(1);
  }, 15_000);

  it('worker crash mid-step: re-invoking after a crash resumes the SAME attempt, without skipping or duplicating', async () => {
    let hitCount = 0;
    nock(MOCK_HOST)
      .get('/ok')
      .reply(200, () => {
        hitCount += 1;
        return { ok: true };
      });

    const workflowId = await createWorkflow(asA);
    const workflow = await prisma.workflow.findUniqueOrThrow({
      where: { id: workflowId },
    });
    const execution = await prisma.workflowExecution.create({
      data: {
        workflowId,
        organizationId: workflow.organizationId,
        status: 'PENDING',
      },
    });

    // Simulates a worker dying immediately after TX1 (claim) but before the
    // external call or TX2 (persist) ever ran: only claimTick runs, leaving
    // the StepExecution row stuck at RUNNING, attempt 1.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tickService as any).claimTick(execution.id);

    const stuck = await prisma.stepExecution.findFirst({
      where: { executionId: execution.id, stepId: 'call-api' },
    });
    expect(stuck?.status).toBe('RUNNING');
    expect(stuck?.attempt).toBe(1);
    expect(hitCount).toBe(0); // the external call never happened on the "crashed" run

    // A fresh tick (a new worker picking the job back up) should resume the
    // SAME attempt, not create attempt 2 and not skip the step.
    await tickService.processTick(execution.id);

    // Wait for full completion (see the "concurrent invocation" test above
    // for why: currentStepId === 'done' alone doesn't imply the 'done' job
    // itself has finished processing yet).
    await poll(
      async () =>
        (
          await prisma.workflowExecution.findUniqueOrThrow({
            where: { id: execution.id },
          })
        ).status,
      (status) => status === 'COMPLETED' || status === 'FAILED',
    );

    expect(hitCount).toBe(1);
    const rows = await prisma.stepExecution.findMany({
      where: { executionId: execution.id, stepId: 'call-api' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].attempt).toBe(1);
    expect(rows[0].status).toBe('COMPLETED');
  }, 15_000);

  it("tenant isolation: org B cannot GET org A's execution (404)", async () => {
    nock(MOCK_HOST).get('/ok').reply(200, { ok: true });
    const workflowId = await createWorkflow(asA);
    const res = await execute(asA, workflowId).expect(202);
    const executionId = res.body.data.executionId as string;

    await poll(
      async () => (await getExecution(asA, executionId)).body.data.status,
      (status) => status === 'COMPLETED',
    );

    const crossOrg = await getExecution(asB, executionId).expect(404);
    expect(crossOrg.body.meta.message).toBe('Execution not found');
  }, 15_000);

  it('404 on POST /workflows/:id/execute for a workflow that does not exist / belongs to another org', async () => {
    const workflowId = await createWorkflow(asA);
    await execute(asB, workflowId).expect(404);
  });

  it('401 without a token', async () => {
    const workflowId = await createWorkflow(asA);
    await request(server())
      .post(`${API}/workflows/${workflowId}/execute`)
      .expect(401);
    await request(server())
      .get(`${API}/executions/00000000-0000-0000-0000-000000000000`)
      .expect(401);
  });
});
