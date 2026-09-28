import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { CONSTANTS } from '../src/common/constants/app.constants';
import { resetDatabase } from './reset-db';

const API = '/api/v1';

/** A minimal, always-valid workflow body: one http step, then complete. */
function workflowBody(
  overrides: Partial<{ name: string; steps: unknown[] }> = {},
) {
  return {
    name: 'My workflow',
    steps: [
      {
        id: 'call-api',
        type: 'http',
        config: { method: 'GET', url: 'https://example.com' },
      },
      { id: 'done', type: 'complete' },
    ],
    ...overrides,
  };
}

describe('Workflows (e2e)', () => {
  let app: INestApplication<App>;
  const prisma = new PrismaClient();
  let redis: Redis;

  let tokenA: string;
  let orgAId: string;
  let tokenB: string;
  let orgBId: string;

  const server = () => app.getHttpServer();
  // supertest needs the HTTP verb chained before `.set(...)`, so these wrap
  // get/post with the caller's bearer token already attached.
  const asA = {
    get: (path: string) =>
      request(server()).get(path).set('Authorization', `Bearer ${tokenA}`),
    post: (path: string) =>
      request(server()).post(path).set('Authorization', `Bearer ${tokenA}`),
  };
  const asB = {
    get: (path: string) =>
      request(server()).get(path).set('Authorization', `Bearer ${tokenB}`),
    post: (path: string) =>
      request(server()).post(path).set('Authorization', `Bearer ${tokenB}`),
  };

  const register = (body: object) =>
    request(server()).post(`${API}/auth/register`).send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      db: Number(process.env.REDIS_DB),
    });
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await redis.flushdb();

    // Two separate users, two separate orgs — the fixtures every test below
    // uses to assert tenant isolation.
    const a = await register({
      email: 'alice@org-a.com',
      password: 'correct-horse-a',
      organizationName: 'Org A',
    }).expect(201);
    tokenA = a.body.meta.accessToken;
    orgAId = a.body.data.organizationId;

    const b = await register({
      email: 'bob@org-b.com',
      password: 'correct-horse-b',
      organizationName: 'Org B',
    }).expect(201);
    tokenB = b.body.meta.accessToken;
    orgBId = b.body.data.organizationId;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    redis.disconnect();
  });

  describe('POST /workflows', () => {
    it('401: no auth token', async () => {
      await request(server())
        .post(`${API}/workflows`)
        .send(workflowBody())
        .expect(401);
    });

    it('201: valid body — response includes id and webhookKey, scoped to the caller org', async () => {
      const res = await asA
        .post(`${API}/workflows`)
        .send(workflowBody())
        .expect(201);

      expect(res.body.meta).toMatchObject({
        code: CONSTANTS.META_CODE.SUCCESS,
        message: 'Workflow created successfully',
      });
      expect(res.body.data).toMatchObject({
        id: expect.any(String),
        organizationId: orgAId,
        name: 'My workflow',
        webhookKey: expect.any(String),
        createdById: expect.any(String),
      });
      expect(res.body.data.steps).toHaveLength(2);

      const row = await prisma.workflow.findUniqueOrThrow({
        where: { id: res.body.data.id },
      });
      expect(row.organizationId).toBe(orgAId);
    });

    it('400: invalid steps (duplicate ids)', async () => {
      await asA
        .post(`${API}/workflows`)
        .send(
          workflowBody({
            steps: [
              {
                id: 'dup',
                type: 'http',
                config: { method: 'GET', url: 'https://example.com' },
              },
              { id: 'dup', type: 'complete' },
            ],
          }),
        )
        .expect(400);
      expect(await prisma.workflow.count()).toBe(0);
    });

    it('400: invalid steps (missing complete step)', async () => {
      await asA
        .post(`${API}/workflows`)
        .send(
          workflowBody({
            steps: [
              {
                id: 's1',
                type: 'http',
                config: { method: 'GET', url: 'https://example.com' },
              },
            ],
          }),
        )
        .expect(400);
    });

    it('400: mismatched type/config', async () => {
      await asA
        .post(`${API}/workflows`)
        .send(
          workflowBody({
            steps: [
              {
                id: 's1',
                type: 'delay',
                config: { url: 'https://example.com' },
              },
              { id: 's2', type: 'complete' },
            ],
          }),
        )
        .expect(400);
    });

    it('409: re-submitting the identical payload (same name + same steps) in the same org', async () => {
      await asA.post(`${API}/workflows`).send(workflowBody()).expect(201);

      const res = await asA
        .post(`${API}/workflows`)
        .send(workflowBody())
        .expect(409);

      expect(res.body.meta.message).toMatch(/identical workflow/i);
      expect(await prisma.workflow.count()).toBe(1);
    });

    it('201: same name but different steps is allowed', async () => {
      await asA
        .post(`${API}/workflows`)
        .send(workflowBody({ name: 'Same name' }))
        .expect(201);

      await asA
        .post(`${API}/workflows`)
        .send(
          workflowBody({
            name: 'Same name',
            steps: [
              {
                id: 'call-api',
                type: 'http',
                config: { method: 'POST', url: 'https://example.com/other' },
              },
              { id: 'done', type: 'complete' },
            ],
          }),
        )
        .expect(201);

      expect(await prisma.workflow.count()).toBe(2);
    });

    it('201: same steps but different name is allowed', async () => {
      await asA
        .post(`${API}/workflows`)
        .send(workflowBody({ name: 'Name A' }))
        .expect(201);
      await asA
        .post(`${API}/workflows`)
        .send(workflowBody({ name: 'Name B' }))
        .expect(201);
      expect(await prisma.workflow.count()).toBe(2);
    });

    it('201: the identical payload is allowed again in a different org', async () => {
      await asA.post(`${API}/workflows`).send(workflowBody()).expect(201);
      await asB.post(`${API}/workflows`).send(workflowBody()).expect(201);
      expect(await prisma.workflow.count()).toBe(2);
    });
  });

  describe('GET /workflows', () => {
    it('401: no auth token', async () => {
      await request(server()).get(`${API}/workflows`).expect(401);
    });

    it("200: org A only sees its own workflows, never org B's", async () => {
      await asA
        .post(`${API}/workflows`)
        .send(workflowBody({ name: 'A1' }))
        .expect(201);
      await asA
        .post(`${API}/workflows`)
        .send(workflowBody({ name: 'A2' }))
        .expect(201);
      await asB
        .post(`${API}/workflows`)
        .send(workflowBody({ name: 'B1' }))
        .expect(201);

      const res = await asA.get(`${API}/workflows`).expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.data.map((w: { name: string }) => w.name).sort()).toEqual(
        ['A1', 'A2'],
      );
      expect(res.body.meta).toMatchObject({
        code: CONSTANTS.META_CODE.SUCCESS,
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
      });
    });

    it('list items are summaries: no `steps` field, but include stepCount', async () => {
      await asA.post(`${API}/workflows`).send(workflowBody()).expect(201);
      const res = await asA.get(`${API}/workflows`).expect(200);

      expect(res.body.data[0]).toEqual({
        id: expect.any(String),
        name: 'My workflow',
        stepCount: 2,
        createdAt: expect.any(String),
      });
    });

    it('?page=2&limit=5 returns correct pagination metadata', async () => {
      for (let i = 0; i < 12; i++) {
        await asA
          .post(`${API}/workflows`)
          .send(workflowBody({ name: `wf-${i}` }))
          .expect(201);
      }

      const res = await asA.get(`${API}/workflows?page=2&limit=5`).expect(200);

      expect(res.body.data).toHaveLength(5);
      expect(res.body.meta).toMatchObject({
        page: 2,
        limit: 5,
        total: 12,
        totalPages: 3,
      });
    });

    it('400: invalid pagination params', async () => {
      await asA.get(`${API}/workflows?page=0`).expect(400);
      await asA.get(`${API}/workflows?limit=101`).expect(400);
    });
  });

  describe('GET /workflows/:id', () => {
    it('401: no auth token', async () => {
      await request(server())
        .get(`${API}/workflows/${'0'.repeat(8)}-0000-0000-0000-000000000000`)
        .expect(401);
    });

    it('200: org A fetching its own workflow gets full detail including steps', async () => {
      const created = await asA
        .post(`${API}/workflows`)
        .send(workflowBody())
        .expect(201);

      const res = await asA
        .get(`${API}/workflows/${created.body.data.id}`)
        .expect(200);

      expect(res.body.data.id).toBe(created.body.data.id);
      expect(res.body.data.steps).toEqual(created.body.data.steps);
      expect(res.body.data.webhookKey).toBe(created.body.data.webhookKey);
    });

    it("404: org A requesting org B's workflow (not 403)", async () => {
      const createdByB = await asB
        .post(`${API}/workflows`)
        .send(workflowBody())
        .expect(201);

      const res = await asA
        .get(`${API}/workflows/${createdByB.body.data.id}`)
        .expect(404);

      expect(res.body.meta.message).toBe('Workflow not found');
    });

    it('404: identical response shape for cross-org and completely nonexistent ids', async () => {
      const createdByB = await asB
        .post(`${API}/workflows`)
        .send(workflowBody())
        .expect(201);

      const crossOrg = await asA
        .get(`${API}/workflows/${createdByB.body.data.id}`)
        .expect(404);
      const nonexistent = await asA
        .get(`${API}/workflows/ffffffff-ffff-ffff-ffff-ffffffffffff`)
        .expect(404);

      // Everything except `path` (which trivially differs — the two requests
      // hit different URLs) and `timestamp` must be identical: same status,
      // same code, same error, same message.
      const {
        timestamp: _a,
        path: _pathA,
        ...metaCrossOrg
      } = crossOrg.body.meta;
      const {
        timestamp: _b,
        path: _pathB,
        ...metaNonexistent
      } = nonexistent.body.meta;
      expect(metaCrossOrg).toEqual(metaNonexistent);
      expect(crossOrg.body.data).toBeNull();
      expect(nonexistent.body.data).toBeNull();
    });

    it('400: malformed id (not a UUID)', async () => {
      await asA.get(`${API}/workflows/not-a-uuid`).expect(400);
    });
  });
});
