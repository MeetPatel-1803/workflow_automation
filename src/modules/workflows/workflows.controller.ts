import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { ApiResponse } from '../../shared/response/apiResponse.service';
import { ResponseService } from '../../shared/response/apiResponse.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { WorkflowDetailDto } from './dto/workflow-detail.dto';
import { WorkflowSummaryDto } from './dto/workflow-summary.dto';
import { WorkflowsService } from './workflows.service';

/**
 * No @Public() here: JwtAuthGuard is global, so every route below requires a
 * valid token. `organizationId` is always read from that token
 * (@CurrentUser), never from the request body/params/query — this is the
 * tenant-isolation-by-construction guarantee, not a query-time filter added
 * as an afterthought.
 */
@Controller('workflows')
export class WorkflowsController {
  constructor(
    private readonly workflowsService: WorkflowsService,
    private readonly responseService: ResponseService,
  ) {}

  @Post()
  async create(
    @CurrentUser('orgId') organizationId: string,
    @CurrentUser('userId') createdById: string,
    @Body() dto: CreateWorkflowDto,
  ): Promise<ApiResponse<WorkflowDetailDto>> {
    const workflow = await this.workflowsService.create(
      organizationId,
      createdById,
      dto,
    );
    return this.responseService.success(
      workflow,
      'Workflow created successfully',
    );
  }

  @Get()
  async findAll(
    @CurrentUser('orgId') organizationId: string,
    @Query() pagination: PaginationQueryDto,
  ): Promise<ApiResponse<WorkflowSummaryDto[]>> {
    const { items, total } = await this.workflowsService.findAll(
      organizationId,
      pagination,
    );
    const { page, limit } = pagination;
    const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;

    return this.responseService.success(
      items,
      'Workflows fetched successfully',
      {
        page,
        limit,
        total,
        totalPages,
      },
    );
  }

  @Get(':id')
  async findOne(
    @CurrentUser('orgId') organizationId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApiResponse<WorkflowDetailDto>> {
    const workflow = await this.workflowsService.findOne(organizationId, id);
    return this.responseService.success(
      workflow,
      'Workflow fetched successfully',
    );
  }
}
