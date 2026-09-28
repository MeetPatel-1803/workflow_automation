import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { plainToInstance } from 'class-transformer';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiError } from '../../shared/response/apiError.service';
import { AddMemberDto } from './dto/add-member.dto';
import { UserResponseDto } from './dto/user-response.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Members of `orgId`. `orgId` must come from the caller's JWT
   * (@CurrentUser('orgId')) — never from client-supplied input — so a user
   * can only ever see members of their own organization.
   */
  async listMembers(orgId: string): Promise<UserResponseDto[]> {
    const members = await this.prisma.user.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
    });
    return members.map((member) => plainToInstance(UserResponseDto, member));
  }

  /** Adds a new member to `orgId`. Email is unique system-wide (see schema). */
  async addMember(orgId: string, dto: AddMemberDto): Promise<UserResponseDto> {
    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });

    try {
      const member = await this.prisma.user.create({
        data: { email: dto.email, passwordHash, organizationId: orgId },
      });
      return plainToInstance(UserResponseDto, member);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw ApiError.conflict('Email already registered');
      }
      throw error;
    }
  }

  /**
   * Removes `targetUserId` from `orgId`. `orgId` and `requestingUserId` must
   * come from the caller's JWT. A target that doesn't exist, or that belongs
   * to a different organization, is reported as 404 (not 403) so this
   * endpoint never confirms whether a given user id exists elsewhere.
   */
  async removeMember(
    orgId: string,
    requestingUserId: string,
    targetUserId: string,
  ): Promise<void> {
    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, organizationId: orgId },
      select: { id: true },
    });
    if (!target) {
      throw ApiError.notFound('Member not found');
    }

    if (targetUserId === requestingUserId) {
      throw ApiError.badRequest('You cannot remove yourself');
    }

    const memberCount = await this.prisma.user.count({
      where: { organizationId: orgId },
    });
    if (memberCount <= 1) {
      throw ApiError.badRequest(
        'An organization must have at least one member',
      );
    }

    await this.prisma.user.delete({ where: { id: targetUserId } });
  }
}
