import { Controller, Get, INestApplication, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { CONSTANTS } from '../src/common/constants/app.constants';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../src/common/decorators/current-user.decorator';
import { Public } from '../src/common/decorators/public.decorator';
import { resetDatabase } from './reset-db';

/** Test-only routes: one protected (default), one explicitly public. */
@Controller('test')
class TestProtectedController {
  @Get('protected')
  protected(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentUser('orgId') orgId: string,
    @Req() req: { user: unknown },
  ) {
    return { user, orgId, requestUser: req.user };
  }

  @Public()
  @Get('public')
  open() {
    return { ok: true };
  }
}

const GENERIC_LOGIN_MESSAGE = 'Invalid credentials';
const API = '/api/v1';

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  const prisma = new PrismaClient();
  let redis: Redis;

  const creds = {
    email: 'alice@example.com',
    password: 'correct-horse-battery',
    organizationName: 'Acme Inc',
  };

  const server = () => app.getHttpServer();
  const register = (body: object = creds) =>
    request(server()).post(`${API}/auth/register`).send(body);
  const login = (body: object) =>
    request(server()).post(`${API}/auth/login`).send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [TestProtectedController],
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
    await redis.flushdb(); // reset throttler counters (dedicated test DB index)
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    redis.disconnect();
  });

  describe('POST /auth/register', () => {
    it('201: creates org + user and returns accessToken without passwordHash', async () => {
      const res = await register().expect(201);

      expect(res.body.meta).toMatchObject({
        code: CONSTANTS.META_CODE.SUCCESS,
        message: 'Registered successfully',
      });
      expect(typeof res.body.meta.accessToken).toBe('string');
      expect(res.body.data).toEqual({
        id: expect.any(String),
        email: creds.email,
        organizationId: expect.any(String),
      });
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/i);

      const user = await prisma.user.findUniqueOrThrow({
        where: { email: creds.email },
        include: { organization: { include: { users: true } } },
      });
      expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
      expect(user.organization.name).toBe(creds.organizationName);
      expect(user.organization.users).toHaveLength(1); // sole member
    });

    it('issues an HS256 JWT with { sub, orgId, email } and an exp claim', async () => {
      const res = await register().expect(201);
      const decoded = jwt.decode(res.body.meta.accessToken, {
        complete: true,
      }) as {
        header: { alg: string };
        payload: Record<string, unknown>;
      };
      expect(decoded.header.alg).toBe('HS256');
      expect(decoded.payload).toMatchObject({
        sub: res.body.data.id,
        orgId: res.body.data.organizationId,
        email: creds.email,
      });
      expect(decoded.payload.exp).toEqual(expect.any(Number));
    });

    it('409: duplicate email (case-insensitive) and leaves no orphaned organization', async () => {
      await register().expect(201);
      const res = await register({
        ...creds,
        email: 'ALICE@example.com',
        organizationName: 'Second Org',
      }).expect(409);

      expect(res.body.data).toBeNull();
      expect(res.body.meta).toMatchObject({
        code: CONSTANTS.META_CODE.FAIL,
        statusCode: 409,
        error: 'Conflict',
        message: 'Email already registered',
        path: `${API}/auth/register`,
      });
      expect(await prisma.organization.count()).toBe(1);
      expect(await prisma.user.count()).toBe(1);
    });

    it('409 is returned (not 500) when two identical registrations race', async () => {
      const results = await Promise.all([register(), register()]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await prisma.organization.count()).toBe(1);
    });

    it.each([
      ['invalid email', { ...creds, email: 'not-an-email' }, 'email'],
      ['short password', { ...creds, password: 'short' }, 'password'],
      [
        'empty organizationName',
        { ...creds, organizationName: '' },
        'organizationName',
      ],
      [
        'missing organizationName',
        { email: creds.email, password: creds.password },
        'organizationName',
      ],
    ])('400: %s (field-level message)', async (_label, body, field) => {
      const res = await register(body).expect(400);
      expect(res.body.meta.code).toBe(CONSTANTS.META_CODE.FAIL);
      expect(res.body.meta.statusCode).toBe(400);
      expect(res.body.meta.error).toBe('Bad Request');
      expect(Array.isArray(res.body.meta.message)).toBe(true);
      expect(res.body.meta.message.join(' ')).toContain(field);
      expect(await prisma.user.count()).toBe(0);
    });

    it('400: rejects unexpected extra fields (forbidNonWhitelisted)', async () => {
      const res = await register({ ...creds, isAdmin: true }).expect(400);
      expect(res.body.meta.message.join(' ')).toContain('isAdmin');
    });

    it('error responses use the consistent shape and never leak internals', async () => {
      const res = await register({}).expect(400);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'meta']);
      expect(Object.keys(res.body.meta).sort()).toEqual(
        ['code', 'error', 'message', 'path', 'statusCode', 'timestamp'].sort(),
      );
      expect(new Date(res.body.meta.timestamp).toString()).not.toBe(
        'Invalid Date',
      );
      expect(JSON.stringify(res.body)).not.toMatch(/stack|prisma|at .*\.ts/i);
    });

    it('429: is rate limited to 5 requests/minute', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        // invalid body still counts toward the limit and keeps the test fast
        statuses.push((await register({ email: 'x' })).status);
      }
      expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
      expect(statuses[5]).toBe(429);
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      await register().expect(201);
    });

    it('200: correct credentials return accessToken and user', async () => {
      const res = await login({
        email: creds.email,
        password: creds.password,
      }).expect(200);
      expect(res.body.meta).toMatchObject({
        code: CONSTANTS.META_CODE.SUCCESS,
        message: 'Login successful',
      });
      expect(typeof res.body.meta.accessToken).toBe('string');
      expect(res.body.data.email).toBe(creds.email);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/i);
    });

    it('200: email is matched case-insensitively', async () => {
      await login({
        email: 'Alice@Example.com',
        password: creds.password,
      }).expect(200);
    });

    it('401: wrong password and unknown email return the identical generic response', async () => {
      const wrongPassword = await login({
        email: creds.email,
        password: 'this-is-wrong',
      }).expect(401);
      const unknownEmail = await login({
        email: 'nobody@example.com',
        password: 'this-is-wrong',
      }).expect(401);

      expect(wrongPassword.body.meta.message).toBe(GENERIC_LOGIN_MESSAGE);
      expect(unknownEmail.body.meta.message).toBe(GENERIC_LOGIN_MESSAGE);
      // Same shape and content apart from the timestamp
      const { timestamp: _a, ...metaA } = wrongPassword.body.meta;
      const { timestamp: _b, ...metaB } = unknownEmail.body.meta;
      expect(metaA).toEqual(metaB);
      expect(wrongPassword.body.data).toBeNull();
      expect(unknownEmail.body.data).toBeNull();
    });

    it('400: malformed body', async () => {
      await login({ email: 'nope' }).expect(400);
    });

    it('429: is rate limited to 10 requests/minute', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        statuses.push(
          (await login({ email: creds.email, password: 'wrong-wrong' })).status,
        );
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });

  describe('JwtAuthGuard (global) + @CurrentUser()', () => {
    it('401: no token on a protected route', async () => {
      const res = await request(server())
        .get(`${API}/test/protected`)
        .expect(401);
      expect(res.body.data).toBeNull();
      expect(res.body.meta).toMatchObject({
        code: CONSTANTS.META_CODE.FAIL,
        statusCode: 401,
        error: 'Unauthorized',
      });
    });

    it('200: @Public() route is reachable without a token', async () => {
      await request(server()).get(`${API}/test/public`).expect(200);
    });

    it('200: valid token passes and request.user has the right userId/orgId/email', async () => {
      const reg = await register().expect(201);
      const res = await request(server())
        .get(`${API}/test/protected`)
        .set('Authorization', `Bearer ${reg.body.meta.accessToken}`)
        .expect(200);

      const expected = {
        userId: reg.body.data.id,
        orgId: reg.body.data.organizationId,
        email: creds.email,
      };
      expect(res.body.requestUser).toEqual(expected);
      expect(res.body.user).toEqual(expected);
      expect(res.body.orgId).toBe(expected.orgId);
    });

    it('401: tampered token (payload altered, signature untouched)', async () => {
      const reg = await register().expect(201);
      const [h, p, s] = (reg.body.meta.accessToken as string).split('.');
      const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
      payload.orgId = '00000000-0000-0000-0000-000000000000';
      const forged = [
        h,
        Buffer.from(JSON.stringify(payload)).toString('base64url'),
        s,
      ].join('.');

      await request(server())
        .get(`${API}/test/protected`)
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });

    it('401: token signed with a different secret', async () => {
      const bad = jwt.sign(
        { sub: 'u', orgId: 'o', email: 'a@b.co' },
        'some-other-secret-some-other-secret',
        {
          algorithm: 'HS256',
          expiresIn: '1h',
        },
      );
      await request(server())
        .get(`${API}/test/protected`)
        .set('Authorization', `Bearer ${bad}`)
        .expect(401);
    });

    it('401: expired token (correct secret)', async () => {
      const expired = jwt.sign(
        { sub: 'u', orgId: 'o', email: 'a@b.co' },
        process.env.JWT_SECRET as string,
        { algorithm: 'HS256', expiresIn: -10 },
      );
      const res = await request(server())
        .get(`${API}/test/protected`)
        .set('Authorization', `Bearer ${expired}`)
        .expect(401);
      expect(res.body.meta.message).toBe('Invalid or missing access token');
    });

    it('401: unsigned "alg: none" token', async () => {
      const b64 = (o: object) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
        sub: 'u',
        orgId: 'o',
        email: 'a@b.co',
      })}.`;
      await request(server())
        .get(`${API}/test/protected`)
        .set('Authorization', `Bearer ${none}`)
        .expect(401);
    });

    it('401: garbage bearer value', async () => {
      await request(server())
        .get(`${API}/test/protected`)
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);
    });
  });
});
