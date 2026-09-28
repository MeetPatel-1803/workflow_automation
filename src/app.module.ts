import {
  ClassSerializerInterceptor,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { AppConfig, configuration } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { AuthModule } from './modules/auth/auth.module';
import { ExecutionsModule } from './modules/executions/executions.module';
import { UsersModule } from './modules/users/users.module';
import { WorkflowEngineModule } from './modules/workflow-engine/workflow-engine.module';
import { WorkflowsModule } from './modules/workflows/workflows.module';
import { PrismaModule } from './prisma/prisma.module';
import { ResponseModule } from './shared/response/response.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // .env.test wins in the test environment; real env vars always win over files.
      envFilePath: [`.env.${process.env.NODE_ENV ?? 'development'}`, '.env'],
      load: [configuration],
      validate: validateEnv, // fail fast on boot
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const redis = config.get('redis', { infer: true });
        return {
          // Global default: 100 req/min per IP. Stricter per-route limits are
          // applied with @Throttle() (see AuthController) and will be added
          // per module as the system grows.
          //
          // `perOrgExecute` is tracked by organizationId, not IP (see
          // OrgThrottlerGuard) — it must be registered here too, not just
          // referenced via @Throttle(), for a guard to actually count
          // against it. Its limit/ttl below is only the module-level
          // default; WorkflowExecutionController's @Throttle() overrides it
          // per-route.
          throttlers: [
            { name: 'default', ttl: 60_000, limit: 100 },
            { name: 'perOrgExecute', ttl: 60_000, limit: 20 },
          ],
          // Shared Redis storage so limits hold across multiple API instances.
          storage: new ThrottlerStorageRedisService({
            host: redis.host,
            port: redis.port,
            db: redis.db,
          }),
        };
      },
    }),
    ResponseModule,
    PrismaModule,
    AuthModule,
    UsersModule,
    WorkflowsModule,
    WorkflowEngineModule,
    ExecutionsModule,
  ],
  providers: [
    // Guard order matters: throttle first (also protects @Public routes and
    // unauthenticated floods), then authenticate.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule {}
