import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { StepDto } from './step.dto';
import { ExactlyOneCompleteStep } from '../validators/exactly-one-complete-step.validator';
import { UniqueStepIds } from '../validators/unique-step-ids.validator';
import { ValidConditionReferences } from '../validators/valid-condition-references.validator';

const MAX_STEPS = 50;

export class CreateWorkflowDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'steps must contain at least 1 step' })
  @ArrayMaxSize(MAX_STEPS, {
    message: `steps must contain at most ${MAX_STEPS} steps`,
  })
  @ValidateNested({ each: true })
  @Type(() => StepDto)
  @UniqueStepIds()
  @ExactlyOneCompleteStep()
  @ValidConditionReferences()
  steps: StepDto[];
}
