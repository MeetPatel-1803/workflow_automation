import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import type { ApiResponse } from '../../shared/response/apiResponse.service';
import { ResponseService } from '../../shared/response/apiResponse.service';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { UserResponseDto } from '../users/dto/user-response.dto';

const ONE_MINUTE_MS = 60_000;

@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly responseService: ResponseService,
  ) {}

  // Stricter than the global default: slows automated account creation.
  @Throttle({ default: { limit: 5, ttl: ONE_MINUTE_MS } })
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
  ): Promise<ApiResponse<UserResponseDto>> {
    const { user, accessToken } = await this.authService.register(dto);
    return this.responseService.success(user, 'Registered successfully', {
      accessToken,
    });
  }

  // Brute-force protection.
  @Throttle({ default: { limit: 10, ttl: ONE_MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(@Body() dto: LoginDto): Promise<ApiResponse<UserResponseDto>> {
    const { user, accessToken } = await this.authService.login(dto);
    return this.responseService.success(user, 'Login successful', {
      accessToken,
    });
  }
}
