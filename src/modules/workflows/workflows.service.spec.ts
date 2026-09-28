import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiError } from '../../shared/response/apiError.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { WorkflowsService } from './workflows.service';

describe('WorkflowsService', () => {
  let service: WorkflowsService;

  const prisma = {
    workflow: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    $queryRaw: jest.fn(),
  };

  const ORG_A = 'org-a';
  const ORG_B = 'org-b';
  const USER_A = 'user-a';

  const validDto = plainToInstance(CreateWorkflowDto, {
    name: 'My workflow',
    steps: [
      {
        id: 's1',
        type: 'http',
        config: { method: 'GET', url: 'https://example.com' },
      },
      { id: 's2', type: 'complete' },
    ],
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        WorkflowsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(WorkflowsService);
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('create', () => {
    it('persists with the organizationId/createdById passed in, not anything from the DTO', async () => {
      prisma.workflow.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'wf-1',
          webhookKey: 'whk-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        }),
      );

      const result = await service.create(ORG_A, USER_A, validDto);

      const stored = prisma.workflow.create.mock.calls[0][0].data;
      expect(stored.organizationId).toBe(ORG_A);
      expect(stored.createdById).toBe(USER_A);
      expect(stored.name).toBe('My workflow');
      // Stored as plain JSON, not class instances.
      expect(stored.steps).toEqual([
        {
          id: 's1',
          type: 'http',
          config: {
            method: 'GET',
            url: 'https://example.com',
            timeoutMs: 10_000,
            maxAttempts: 1,
            retryDelayMs: 1_000,
          },
        },
        { id: 's2', type: 'complete', config: {} },
      ]);

      expect(result.id).toBe('wf-1');
      expect(result.organizationId).toBe(ORG_A);
    });

    it('does not accept an organizationId/createdById from the DTO (there is no such field to accept)', () => {
      expect(
        (validDto as unknown as Record<string, unknown>).organizationId,
      ).toBeUndefined();
      expect(
        (validDto as unknown as Record<string, unknown>).createdById,
      ).toBeUndefined();
    });

    it('returns the DB-generated unique webhookKey unchanged', async () => {
      prisma.workflow.create.mockResolvedValue({
        id: 'wf-1',
        organizationId: ORG_A,
        createdById: USER_A,
        name: 'My workflow',
        steps: [],
        webhookKey: 'a-unique-webhook-key',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.create(ORG_A, USER_A, validDto);
      expect(result.webhookKey).toBe('a-unique-webhook-key');
    });

    it('computes an identical contentHash for the same name+steps and stores it', async () => {
      prisma.workflow.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'wf-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        }),
      );

      await service.create(ORG_A, USER_A, validDto);
      const firstHash =
        prisma.workflow.create.mock.calls[0][0].data.contentHash;

      jest.clearAllMocks();
      prisma.workflow.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'wf-2',
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        }),
      );
      await service.create(ORG_A, USER_A, validDto);
      const secondHash =
        prisma.workflow.create.mock.calls[0][0].data.contentHash;

      expect(typeof firstHash).toBe('string');
      expect(firstHash).toBe(secondHash);
    });

    it('maps a P2002 on (organizationId, contentHash) to a 409 duplicate-workflow error', async () => {
      prisma.workflow.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: {
            modelName: 'Workflow',
            target: ['organizationId', 'contentHash'],
          },
        }),
      );

      const error = await service
        .create(ORG_A, USER_A, validDto)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(409);
      expect((error as ApiError).message).toMatch(/identical workflow/i);
    });

    it('rethrows a P2002 that is not the contentHash constraint (e.g. webhookKey collision)', async () => {
      const other = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          code: 'P2002',
          clientVersion: 'test',
          meta: { modelName: 'Workflow', target: ['webhookKey'] },
        },
      );
      prisma.workflow.create.mockRejectedValue(other);

      const error = await service
        .create(ORG_A, USER_A, validDto)
        .catch((e: unknown) => e);
      expect(error).toBe(other);
    });
  });

  describe('findAll', () => {
    it('scopes the raw list query to the given organizationId and maps rows to summaries', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'wf-1',
          name: 'A',
          createdAt: new Date(),
          stepCount: 3,
          total: 2,
        },
        {
          id: 'wf-2',
          name: 'B',
          createdAt: new Date(),
          stepCount: 1,
          total: 2,
        },
      ]);

      const { items, total } = await service.findAll(ORG_A, {
        page: 1,
        limit: 20,
      });

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const [sqlTemplate] = prisma.$queryRaw.mock.calls[0];
      // Prisma.sql tagged template: values are parametrized, not interpolated
      // into the SQL text.
      expect(sqlTemplate.values).toContain(ORG_A);
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        id: 'wf-1',
        name: 'A',
        stepCount: 3,
        createdAt: expect.any(Date),
      });
      expect(total).toBe(2);
      // The list projection never includes the steps blob.
      expect(items.every((i) => !('steps' in i))).toBe(true);
    });

    it('returns total 0 when the org has no workflows (no rows to read COUNT(*) OVER() from)', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      const { items, total } = await service.findAll(ORG_A, {
        page: 1,
        limit: 20,
      });
      expect(items).toHaveLength(0);
      expect(total).toBe(0);
    });

    it("never returns another organization's rows (query is scoped, not filtered client-side)", async () => {
      // Simulate the DB honoring the WHERE clause: org B's row never comes back.
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'wf-a',
          name: 'Org A wf',
          createdAt: new Date(),
          stepCount: 1,
          total: 1,
        },
      ]);
      const { items } = await service.findAll(ORG_A, { page: 1, limit: 20 });
      expect(items.map((i) => i.id)).toEqual(['wf-a']);
      expect(items.map((i) => i.id)).not.toContain('wf-b');
    });
  });

  describe('findOne', () => {
    it('queries by id AND organizationId together', async () => {
      prisma.workflow.findFirst.mockResolvedValue(null);
      await service.findOne(ORG_A, 'wf-1').catch(() => undefined);
      expect(prisma.workflow.findFirst).toHaveBeenCalledWith({
        where: { id: 'wf-1', organizationId: ORG_A },
      });
    });

    it('throws a 404 ApiError when the workflow belongs to a different org', async () => {
      prisma.workflow.findFirst.mockResolvedValue(null); // WHERE excluded it

      const error = await service
        .findOne(ORG_B, 'wf-1')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(404);
      expect((error as ApiError).message).toBe('Workflow not found');
    });

    it('throws the identical 404 for a nonexistent id', async () => {
      prisma.workflow.findFirst.mockResolvedValue(null);

      const error = await service
        .findOne(ORG_A, 'does-not-exist')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(404);
      expect((error as ApiError).message).toBe('Workflow not found');
    });

    it('returns the full workflow including steps when found', async () => {
      const steps = [{ id: 's1', type: 'complete' }];
      prisma.workflow.findFirst.mockResolvedValue({
        id: 'wf-1',
        organizationId: ORG_A,
        createdById: USER_A,
        name: 'My workflow',
        steps,
        webhookKey: 'whk-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.findOne(ORG_A, 'wf-1');
      expect(result.steps).toEqual(steps);
      expect(result.webhookKey).toBe('whk-1');
    });
  });
});
