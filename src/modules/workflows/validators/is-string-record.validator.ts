import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Extra strictness beyond what the assessment enumerates: HttpStepConfigDto's
 * optional `headers` must be a plain object of string -> string (not e.g.
 * arrays, numbers, or nested objects) — the execution engine will hand these
 * straight to an HTTP client's headers option.
 */
@ValidatorConstraint({ name: 'IsStringRecord', async: false })
export class IsStringRecord implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined) return true; // @IsOptional() handles absence
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    return Object.values(value).every((v) => typeof v === 'string');
  }
}
