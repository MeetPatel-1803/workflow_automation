import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { plainToInstance } from 'class-transformer';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiError } from '../../shared/response/apiError.service';
import type { AuthResult, JwtPayload } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { UserResponseDto } from '../users/dto/user-response.dto';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  /** Hash verified against when the email is unknown, to equalise timing. */
  private dummyHash: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await argon2.hash('timing-equalisation-dummy', {
      type: argon2.argon2id,
    });
  }

  async register(dto: RegisterDto): Promise<AuthResult> {
    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });

    let user: { id: string; email: string; organizationId: string };
    try {
      // One transaction: no orphan Organization if the User insert fails.
      user = await this.prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: { name: dto.organizationName },
        });
        return tx.user.create({
          data: {
            email: dto.email,
            passwordHash,
            organizationId: organization.id,
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Two distinct unique constraints can fire here: Organization.name
        // (checked first, inside the transaction) and User.email.
        throw error.meta?.modelName === 'Organization'
          ? ApiError.conflict('Organization name already taken')
          : ApiError.conflict('Email already registered');
      }
      throw error;
    }

    const payload: JwtPayload = {
      sub: user.id,
      orgId: user.organizationId,
      email: user.email,
    };
    const accessToken = await this.jwt.signAsync(payload);

    return { user: plainToInstance(UserResponseDto, user), accessToken };
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    // Always run exactly one argon2 verification, whether or not the user exists.
    const passwordOk = await argon2.verify(
      user?.passwordHash ?? this.dummyHash,
      dto.password,
    );

    if (!user || !passwordOk) {
      throw ApiError.unauthorized('Invalid credentials');
    }

    const payload: JwtPayload = {
      sub: user.id,
      orgId: user.organizationId,
      email: user.email,
    };
    const accessToken = await this.jwt.signAsync(payload);

    return { user: plainToInstance(UserResponseDto, user), accessToken };
  }
}
