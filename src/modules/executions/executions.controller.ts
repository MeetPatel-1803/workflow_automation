import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { ApiResponse } from '../../shared/response/apiResponse.service';
import { ResponseService } from '../../shared/response/apiResponse.service';
import { ExecutionDetailResponseDto } from './dto/execution-detail-response.dto';
import { ExecutionsService } from './executions.service';

@Controller('executions')
export class ExecutionsController {
  constructor(
    private readonly executionsService: ExecutionsService,
    private readonly responseService: ResponseService,
  ) {}

  @Get(':id')
  async findOne(
    @CurrentUser('orgId') organizationId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApiResponse<ExecutionDetailResponseDto>> {
    const execution = await this.executionsService.findOne(organizationId, id);
    return this.responseService.success(
      execution,
      'Execution fetched successfully',
    );
  }
}
