import { Injectable, Logger } from '@nestjs/common';
import { Prisma, Workflow } from '@prisma/client';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiError } from '../../shared/response/apiError.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import type { StepDto } from './dto/step.dto';
import { WorkflowDetailDto } from './dto/workflow-detail.dto';
import { WorkflowSummaryDto } from './dto/workflow-summary.dto';
import { computeWorkflowContentHash } from './workflow-content-hash';
import type { PaginatedResult, WorkflowListRow } from './workflows.types';

@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `organizationId`/`createdById` always come from the caller's JWT
   * (@CurrentUser), never from the request body — the DTO has no such
   * fields, so there is nothing for a client to override even by accident.
   */
  async create(
    organizationId: string,
    createdById: string,
    dto: CreateWorkflowDto,
  ): Promise<WorkflowDetailDto> {
    // Re-serialize the validated step instances to plain JSON before storage,
    // so what's persisted is exactly the validated shape — no stray class
    // metadata, no properties a config DTO doesn't declare.
    const steps = instanceToPlain(dto.steps) as Prisma.InputJsonValue;

    // Rejects re-creating an identical workflow (same name AND same steps)
    // in the same org. Enforced by a DB unique constraint on
    // (organizationId, contentHash) — not a "check then insert" — so two
    // concurrent identical requests can't both slip through.
    const contentHash = computeWorkflowContentHash(dto.name, steps);

    let workflow: Workflow;
    try {
      workflow = await this.prisma.workflow.create({
        data: {
          organizationId,
          createdById,
          name: dto.name,
          steps,
          contentHash,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        (error.meta?.target as string[] | undefined)?.includes('contentHash')
      ) {
        throw ApiError.conflict(
          'An identical workflow (same name and steps) already exists in this organization',
        );
      }
      throw error;
    }

    return this.toDetailDto(workflow);
  }

  /**
   * Scoped to `organizationId` at the query level. The list response
   * intentionally omits the `steps` JSONB blob (see WorkflowSummaryDto), so
   * this uses a raw query to avoid transferring it from Postgres at all —
   * `jsonb_array_length` gives the step count, and `COUNT(*) OVER()` gives
   * the total for pagination, in the same round trip.
   */
  async findAll(
    organizationId: string,
    { page, limit }: PaginationQueryDto,
  ): Promise<PaginatedResult<WorkflowSummaryDto>> {
    const offset = (page - 1) * limit;

    const rows = await this.prisma.$queryRaw<WorkflowListRow[]>(Prisma.sql`
      SELECT
        "id",
        "name",
        "createdAt",
        jsonb_array_length("steps") AS "stepCount",
        COUNT(*) OVER()::int AS "total"
      FROM "Workflow"
      WHERE "organizationId" = ${organizationId}
      ORDER BY "createdAt" DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const total = rows.length > 0 ? Number(rows[0].total) : 0;
    const items = rows.map((row) =>
      plainToInstance(WorkflowSummaryDto, {
        id: row.id,
        name: row.name,
        stepCount: Number(row.stepCount),
        createdAt: row.createdAt,
      }),
    );

    return { items, total };
  }

  /**
   * Fetches WHERE id = :id AND organizationId = :organizationId in the same
   * query. A miss — wrong id, or an id that belongs to a different
   * organization — is reported identically as 404 "Workflow not found": a
   * 403 here would confirm the workflow exists to a user who has no
   * business knowing that. See README "Tenant Isolation".
   */
  async findOne(
    organizationId: string,
    id: string,
  ): Promise<WorkflowDetailDto> {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id, organizationId },
    });
    if (!workflow) {
      throw ApiError.notFound('Workflow not found');
    }
    return this.toDetailDto(workflow);
  }

  private toDetailDto(workflow: Workflow): WorkflowDetailDto {
    return plainToInstance(WorkflowDetailDto, {
      ...workflow,
      // Safe: `steps` is only ever written by create() above, straight from
      // a validated CreateWorkflowDto — never mutated any other way.
      steps: workflow.steps as unknown as StepDto[],
    });
  }
}
