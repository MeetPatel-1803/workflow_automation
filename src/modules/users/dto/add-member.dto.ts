import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class AddMemberDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;

  // Same policy as registration (see RegisterDto): min 8 chars, no complexity
  // rules — out of scope for this assessment.
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}
