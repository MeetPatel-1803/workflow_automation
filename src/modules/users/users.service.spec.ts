import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiError } from '../../shared/response/apiError.service';
import { UsersService } from './users.service';

describe('UsersService', () => {
  let service: UsersService;

  const prisma = {
    user: {
      findMany: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
    },
  };

  const ORG_A = 'org-a';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('listMembers', () => {
    it('scopes the query to the given organizationId and strips passwordHash', async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'u1',
          email: 'a@x.com',
          passwordHash: 'secret',
          organizationId: ORG_A,
          createdAt: new Date(),
        },
      ]);

      const result = await service.listMembers(ORG_A);

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { organizationId: ORG_A },
        orderBy: { createdAt: 'asc' },
      });
      expect(result).toEqual([
        { id: 'u1', email: 'a@x.com', organizationId: ORG_A },
      ]);
      expect(JSON.stringify(result)).not.toContain('passwordHash');
    });
  });

  describe('addMember', () => {
    const dto = { email: 'new@x.com', password: 'correct-horse' };

    it('hashes the password and creates the user under the given organizationId', async () => {
      prisma.user.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'u2', createdAt: new Date(), ...data }),
      );

      const result = await service.addMember(ORG_A, dto);

      const stored = prisma.user.create.mock.calls[0][0].data;
      expect(stored.organizationId).toBe(ORG_A);
      expect(stored.passwordHash).not.toBe(dto.password);
      expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true);
      await expect(
        argon2.verify(stored.passwordHash, dto.password),
      ).resolves.toBe(true);

      expect(result).toEqual({
        id: 'u2',
        email: dto.email,
        organizationId: ORG_A,
      });
      expect(JSON.stringify(result)).not.toContain('passwordHash');
    });

    it('maps a Prisma P2002 unique violation to 409 "Email already registered"', async () => {
      prisma.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { modelName: 'User', target: ['email'] },
        }),
      );

      const error = await service
        .addMember(ORG_A, dto)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(409);
      expect((error as ApiError).message).toBe('Email already registered');
    });
  });

  describe('removeMember', () => {
    it('404s when the target does not exist in the caller organization (cross-tenant safe)', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const error = await service
        .removeMember(ORG_A, 'me', 'someone-elses-id')
        .catch((e: unknown) => e);

      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { id: 'someone-elses-id', organizationId: ORG_A },
        select: { id: true },
      });
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(404);
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('400s when a member tries to remove themselves', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'me' });

      const error = await service
        .removeMember(ORG_A, 'me', 'me')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(400);
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('400s when removing the last remaining member', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u1' });
      prisma.user.count.mockResolvedValue(1);

      const error = await service
        .removeMember(ORG_A, 'me', 'u1')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(400);
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('deletes the target when it belongs to the org, is not the caller, and is not the last member', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u1' });
      prisma.user.count.mockResolvedValue(2);

      await service.removeMember(ORG_A, 'me', 'u1');

      expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
    });
  });
});
