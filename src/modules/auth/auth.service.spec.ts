import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { ApiError } from '../../shared/response/apiError.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from './auth.service';

// argon2 exports are non-configurable, so wrap verify to allow call counting
// while keeping the real implementation.
jest.mock('argon2', () => {
  const actual = jest.requireActual<typeof import('argon2')>('argon2');
  return { ...actual, verify: jest.fn(actual.verify) };
});
const realVerify = jest.requireActual<typeof import('argon2')>('argon2').verify;

describe('AuthService', () => {
  let service: AuthService;

  const tx = {
    organization: { create: jest.fn() },
    user: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(),
    user: { findUnique: jest.fn() },
  };
  const jwt = { signAsync: jest.fn() };

  const registerDto = {
    email: 'alice@example.com',
    password: 'correct-horse',
    organizationName: 'Acme',
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
    await service.onModuleInit();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    (argon2.verify as jest.Mock).mockImplementation(realVerify);
    jwt.signAsync.mockResolvedValue('signed.jwt.token');
    prisma.$transaction.mockImplementation(
      (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    );
  });

  describe('register', () => {
    it('creates org + user in one transaction and returns token + user without passwordHash', async () => {
      tx.organization.create.mockResolvedValue({ id: 'org-1', name: 'Acme' });
      tx.user.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'user-1', createdAt: new Date(), ...data }),
      );

      const result = await service.register(registerDto);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.organization.create).toHaveBeenCalledWith({
        data: { name: 'Acme' },
      });

      const stored = tx.user.create.mock.calls[0][0].data;
      expect(stored.organizationId).toBe('org-1');
      expect(stored.passwordHash).not.toBe(registerDto.password);
      expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true);
      await expect(
        argon2.verify(stored.passwordHash, registerDto.password),
      ).resolves.toBe(true);

      expect(jwt.signAsync).toHaveBeenCalledWith({
        sub: 'user-1',
        orgId: 'org-1',
        email: 'alice@example.com',
      });
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.user).toEqual({
        id: 'user-1',
        email: 'alice@example.com',
        organizationId: 'org-1',
      });
      expect(JSON.stringify(result)).not.toContain('passwordHash');
    });

    it('maps a Prisma P2002 unique violation on User.email to 409 "Email already registered"', async () => {
      tx.organization.create.mockResolvedValue({ id: 'org-1', name: 'Acme' });
      tx.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { modelName: 'User', target: ['email'] },
        }),
      );

      const error = await service
        .register(registerDto)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(409);
      expect((error as ApiError).message).toBe('Email already registered');
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('maps a Prisma P2002 unique violation on Organization.name to 409 "Organization name already taken"', async () => {
      tx.organization.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { modelName: 'Organization', target: ['name'] },
        }),
      );

      const error = await service
        .register(registerDto)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(409);
      expect((error as ApiError).message).toBe(
        'Organization name already taken',
      );
      expect(tx.user.create).not.toHaveBeenCalled();
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('rethrows unexpected errors untouched', async () => {
      const boom = new Error('db down');
      prisma.$transaction.mockRejectedValue(boom);
      await expect(service.register(registerDto)).rejects.toBe(boom);
    });
  });

  describe('login', () => {
    const password = 'correct-horse';
    let passwordHash: string;

    beforeAll(async () => {
      passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    });

    it('returns token + user for correct credentials', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'alice@example.com',
        passwordHash,
        organizationId: 'org-1',
        createdAt: new Date(),
      });

      const result = await service.login({
        email: 'alice@example.com',
        password,
      });

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.user).toEqual({
        id: 'user-1',
        email: 'alice@example.com',
        organizationId: 'org-1',
      });
      expect(JSON.stringify(result)).not.toContain('passwordHash');
    });

    it('rejects a wrong password and a nonexistent email with the identical error', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        email: 'alice@example.com',
        passwordHash,
        organizationId: 'org-1',
      });
      const wrongPassword = await service
        .login({ email: 'alice@example.com', password: 'nope-nope-nope' })
        .catch((e: unknown) => e);

      prisma.user.findUnique.mockResolvedValueOnce(null);
      const unknownEmail = await service
        .login({ email: 'ghost@example.com', password })
        .catch((e: unknown) => e);

      expect(wrongPassword).toBeInstanceOf(ApiError);
      expect(unknownEmail).toBeInstanceOf(ApiError);
      const a = wrongPassword as ApiError;
      const b = unknownEmail as ApiError;
      expect(a.statusCode).toBe(401);
      expect(b.statusCode).toBe(401);
      expect(a.message).toBe(b.message);
      expect(a.message).toBe('Invalid credentials');
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('still performs an argon2 verification when the email is unknown (timing equalisation)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      (argon2.verify as jest.Mock).mockClear();

      await service
        .login({ email: 'ghost@example.com', password })
        .catch(() => undefined);

      expect(argon2.verify).toHaveBeenCalledTimes(1);
    });
  });
});
