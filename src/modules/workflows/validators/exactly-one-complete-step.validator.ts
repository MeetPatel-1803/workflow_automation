import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { StepType } from '../dto/step-type.enum';
import type { StepDto } from '../dto/step.dto';

@ValidatorConstraint({ name: 'ExactlyOneCompleteStep', async: false })
class ExactlyOneCompleteStepConstraint implements ValidatorConstraintInterface {
  validate(steps: unknown): boolean {
    if (!Array.isArray(steps) || steps.length === 0) return true; // @ArrayMinSize reports emptiness
    const typed = steps as StepDto[];
    const completeIndices = typed
      .map((step, index) => (step?.type === StepType.COMPLETE ? index : -1))
      .filter((index) => index !== -1);
    return (
      completeIndices.length === 1 && completeIndices[0] === typed.length - 1
    );
  }

  defaultMessage(): string {
    return 'steps must contain exactly one "complete" step, and it must be the last step in the array';
  }
}

/**
 * Applied to CreateWorkflowDto.steps. Decision: `complete` is required,
 * exactly one, and must be the final element — the simplest shape to reason
 * about and to execute (the engine can stop as soon as it runs the last
 * step, no separate "is this workflow done" check needed). See README
 * "Technical Decisions".
 */
export function ExactlyOneCompleteStep(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: ExactlyOneCompleteStepConstraint,
    });
  };
}
