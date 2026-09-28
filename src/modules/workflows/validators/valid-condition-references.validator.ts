import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { StepType } from '../dto/step-type.enum';
import type { StepDto } from '../dto/step.dto';

@ValidatorConstraint({ name: 'ValidConditionReferences', async: false })
class ValidConditionReferencesConstraint implements ValidatorConstraintInterface {
  validate(steps: unknown): boolean {
    if (!Array.isArray(steps)) return true;
    const typed = steps as StepDto[];
    return !(typed.length > 0 && typed[0]?.type === StepType.CONDITION);
  }

  defaultMessage(): string {
    return 'a "condition" step cannot be the first step — it evaluates the previous step\'s output';
  }
}

/**
 * Applied to CreateWorkflowDto.steps. Only checks that the step array is
 * well-formed enough to evaluate a condition at runtime (i.e. it has a
 * predecessor) — it does not (and cannot, statically) verify that
 * `field`/`operator` will resolve to something meaningful against whatever
 * the previous step actually returns; that's inherently a runtime concern.
 */
export function ValidConditionReferences(
  validationOptions?: ValidationOptions,
) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: ValidConditionReferencesConstraint,
    });
  };
}
