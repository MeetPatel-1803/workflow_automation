import type { UserResponseDto } from '../users/dto/user-response.dto';

export interface JwtPayload {
  sub: string;
  orgId: string;
  email: string;
}

/**
 * What AuthService.register/login return: only the domain payload. The
 * controller splits this into the response envelope — `user` becomes `data`,
 * `accessToken` becomes part of `meta` (see AuthController).
 */
export interface AuthResult {
  user: UserResponseDto;
  accessToken: string;
}
