import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiError } from '../../shared/response/apiError.service';
import { WorkflowExecutionQueueService } from '../workflow-engine/workflow-execution-queue.service';
import { ExecutionsService } from './executions.service';

describe('ExecutionsService', () => {
  let service: ExecutionsService;

  const prisma = {
    workflow: { findFirst: jest.fn() },
    workflowExecution: { create: jest.fn(), findFirst: jest.fn() },
    idempotencyRecord: { findUnique: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  };
  const queue = {
    enqueueInitial: jest.fn(),
    enqueueNextStep: jest.fn(),
    enqueueDelayWake: jest.fn(),
    enqueueRetryWake: jest.fn(),
  };

  const ORG_A = 'org-a';
  const WORKFLOW_ID = 'wf-1';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ExecutionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: WorkflowExecutionQueueService, useValue: queue },
      ],
    }).compile();
    service = moduleRef.get(ExecutionsService);
  });

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.workflow.findFirst.mockResolvedValue({ id: WORKFLOW_ID });
  });

  it('404s when the workflow does not exist / belongs to another org', async () => {
    prisma.workflow.findFirst.mockResolvedValue(null);
    const error = await service
      .execute(ORG_A, WORKFLOW_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(404);
    expect(queue.enqueueInitial).not.toHaveBeenCalled();
  });

  describe('without an Idempotency-Key', () => {
    it('always creates a new execution and enqueues it', async () => {
      prisma.workflowExecution.create.mockResolvedValue({
        id: 'exec-1',
        status: 'PENDING',
      });

      const result = await service.execute(ORG_A, WORKFLOW_ID);

      expect(prisma.workflowExecution.create).toHaveBeenCalledWith({
        data: {
          workflowId: WORKFLOW_ID,
          organizationId: ORG_A,
          status: 'PENDING',
        },
      });
      expect(queue.enqueueInitial).toHaveBeenCalledWith('exec-1');
      expect(result).toEqual({
        executionId: 'exec-1',
        status: 'PENDING',
        created: true,
      });
    });
  });

  describe('with an Idempotency-Key', () => {
    const KEY = 'my-idempotency-key';

    it('a new key creates an execution + idempotency record, then enqueues', async () => {
      prisma.idempotencyRecord.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(
        async (cb: (tx: typeof prisma) => Promise<unknown>) => {
          prisma.workflowExecution.create.mockResolvedValue({
            id: 'exec-2',
            status: 'PENDING',
          });
          return cb(prisma as never);
        },
      );

      const result = await service.execute(ORG_A, WORKFLOW_ID, KEY);

      expect(result).toEqual({
        executionId: 'exec-2',
        status: 'PENDING',
        created: true,
      });
      expect(queue.enqueueInitial).toHaveBeenCalledWith('exec-2');
    });

    it('an existing key returns the SAME execution and does not enqueue again', async () => {
      prisma.idempotencyRecord.findUnique.mockResolvedValue({
        execution: { id: 'exec-existing', status: 'RUNNING' },
      });

      const result = await service.execute(ORG_A, WORKFLOW_ID, KEY);

      expect(result).toEqual({
        executionId: 'exec-existing',
        status: 'RUNNING',
        created: false,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(queue.enqueueInitial).not.toHaveBeenCalled();
    });

    it('a concurrent race (P2002 on the transaction) returns the winning execution, not an error', async () => {
      prisma.idempotencyRecord.findUnique
        .mockResolvedValueOnce(null) // first check: no record yet
        .mockResolvedValueOnce({
          execution: { id: 'exec-winner', status: 'PENDING' },
        }); // re-query after P2002

      prisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: {
            modelName: 'IdempotencyRecord',
            target: ['organizationId', 'key'],
          },
        }),
      );

      const result = await service.execute(ORG_A, WORKFLOW_ID, KEY);

      expect(result).toEqual({
        executionId: 'exec-winner',
        status: 'PENDING',
        created: false,
      });
      expect(queue.enqueueInitial).not.toHaveBeenCalled();
    });
  });
});
