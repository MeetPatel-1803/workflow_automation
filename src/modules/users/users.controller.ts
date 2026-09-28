import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { ApiResponse } from '../../shared/response/apiResponse.service';
import { ResponseService } from '../../shared/response/apiResponse.service';
import { AddMemberDto } from './dto/add-member.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UsersService } from './users.service';

/**
 * No @Public() here: JwtAuthGuard is global, so every route below requires a
 * valid token. `orgId` is always read from that token (@CurrentUser), never
 * from the request body/params — this is what keeps a user scoped to their
 * own organization's members (and, later, its workflows).
 */
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly responseService: ResponseService,
  ) {}

  @Get()
  async list(
    @CurrentUser('orgId') orgId: string,
  ): Promise<ApiResponse<UserResponseDto[]>> {
    const members = await this.usersService.listMembers(orgId);
    return this.responseService.success(
      members,
      'Members fetched successfully',
    );
  }

  @Post()
  async add(
    @CurrentUser('orgId') orgId: string,
    @Body() dto: AddMemberDto,
  ): Promise<ApiResponse<UserResponseDto>> {
    const member = await this.usersService.addMember(orgId, dto);
    return this.responseService.success(member, 'Member added successfully');
  }

  @HttpCode(HttpStatus.OK)
  @Delete(':id')
  async remove(
    @CurrentUser('orgId') orgId: string,
    @CurrentUser('userId') requestingUserId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApiResponse<null>> {
    await this.usersService.removeMember(orgId, requestingUserId, id);
    return this.responseService.success(null, 'Member removed successfully');
  }
}
