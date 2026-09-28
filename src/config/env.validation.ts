import { plainToInstance, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/**
 * Schema for the process environment. Validated once at boot (ConfigModule
 * `validate` hook) so the app refuses to start on missing/invalid config.
 */
export class EnvironmentVariables {
  @IsOptional()
  @IsIn(['development', 'production', 'test'])
  NODE_ENV: string = 'development';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  @IsNotEmpty()
  @Matches(/^postgres(ql)?:\/\//, {
    message: 'DATABASE_URL must be a postgres:// or postgresql:// URL',
  })
  DATABASE_URL: string;

  @IsString()
  @MinLength(32, { message: 'JWT_SECRET must be at least 32 characters long' })
  @Matches(/^(?!(.)\1+$)/s, {
    message: 'JWT_SECRET must not be a single repeated character',
  })
  @Matches(/^(?!.*(replace-with|change-?me)).*$/is, {
    message: 'JWT_SECRET is still set to the example placeholder',
  })
  JWT_SECRET: string;

  /** jsonwebtoken duration: seconds as a number ("3600") or "15m", "1h", "7d"... */
  @IsString()
  @Matches(/^\d+\s?(ms|s|m|h|d|w|y)?$/, {
    message: 'JWT_EXPIRES_IN must be a duration such as 3600, 15m, 1h or 7d',
  })
  JWT_EXPIRES_IN: string = '1h';

  @IsString()
  @IsNotEmpty()
  REDIS_HOST: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_PORT: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  REDIS_DB: number = 0;

  /** Number of reverse-proxy hops to trust when resolving the client IP. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  TRUST_PROXY?: number;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
  });
  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map(
        (e) =>
          `  - ${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`,
      )
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return validated;
}
