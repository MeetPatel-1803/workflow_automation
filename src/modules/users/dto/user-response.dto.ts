import { Exclude, Expose } from 'class-transformer';

/**
 * Class-level @Exclude + explicit @Expose = allow-list. Any extra property on
 * the source object (e.g. `passwordHash` from a Prisma row) is dropped right
 * when the instance is built (plainToInstance), before it ever leaves the
 * service — not relied upon solely at serialization time.
 */
@Exclude()
export class UserResponseDto {
  @Expose() id: string;
  @Expose() email: string;
  @Expose() organizationId: string;
}
