import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import type { StepDto } from '../dto/step.dto';

@ValidatorConstraint({ name: 'UniqueStepIds', async: false })
class UniqueStepIdsConstraint implements ValidatorConstraintInterface {
  validate(steps: unknown): boolean {
    if (!Array.isArray(steps)) return true; // let @IsArray report that separately
    const ids = (steps as StepDto[])
      .map((step) => step?.id)
      .filter((id): id is string => typeof id === 'string');
    return new Set(ids).size === ids.length;
  }

  defaultMessage(): string {
    return 'steps must not contain duplicate step ids';
  }
}

/** Applied to CreateWorkflowDto.steps: every step.id must be unique. */
export function UniqueStepIds(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: UniqueStepIdsConstraint,
    });
  };
}
