import { Global, Module } from '@nestjs/common';
import { ResponseService } from './apiResponse.service';

/**
 * @Global() so ResponseService is available everywhere (controllers,
 * AllExceptionsFilter) without importing this module repeatedly, same
 * convention as PrismaModule.
 */
@Global()
@Module({
  providers: [ResponseService],
  exports: [ResponseService],
})
export class ResponseModule {}
