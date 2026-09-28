import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsString,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CompleteStepConfigDto } from './step-configs/complete-step-config.dto';
import { ConditionStepConfigDto } from './step-configs/condition-step-config.dto';
import { DelayStepConfigDto } from './step-configs/delay-step-config.dto';
import { HttpStepConfigDto } from './step-configs/http-step-config.dto';
import { StepType } from './step-type.enum';

export type StepConfig =
  | HttpStepConfigDto
  | ConditionStepConfigDto
  | DelayStepConfigDto
  | CompleteStepConfigDto;

const CONFIG_CLASS_BY_TYPE: Record<StepType, new () => StepConfig> = {
  [StepType.HTTP]: HttpStepConfigDto,
  [StepType.CONDITION]: ConditionStepConfigDto,
  [StepType.DELAY]: DelayStepConfigDto,
  [StepType.COMPLETE]: CompleteStepConfigDto,
};

/**
 * class-transformer's built-in @Type() discriminator support expects the
 * discriminator property to live ON the nested object itself
 * (e.g. `config.type`). Ours lives on the sibling StepDto (`step.type`), so
 * we resolve the target class ourselves from `obj` (the raw step object)
 * and hand-build the instance — @ValidateNested() below then validates
 * whichever concrete class we picked, exactly as if @Type() had done it.
 */
function transformStepConfig({ value, obj }: TransformFnParams): StepConfig {
  const type = (obj as { type?: unknown }).type as StepType;
  const ConfigClass = CONFIG_CLASS_BY_TYPE[type];
  // Unknown `type` is already rejected by @IsEnum on the sibling field; we
  // still need *something* here to avoid throwing during transform, and an
  // empty CompleteStepConfigDto adds no validation errors of its own.
  return buildConfigInstance(ConfigClass ?? CompleteStepConfigDto, value);
}

// Builds a real instance of `cls` from `value` so the @ValidateNested() below
// sees actual class-validator metadata on `config` (not a plain object) —
// this is what a plain `@Type(() => X)` would normally do for us, but only
// for a fixed `X`; here `X` depends on the sibling `type` field.
function buildConfigInstance<T extends object>(
  cls: new () => T,
  value: unknown,
): T {
  const instance = new cls();
  Object.assign(instance, value ?? {});
  return instance;
}

export class StepDto {
  // The user-facing step identifier referenced by condition steps and
  // execution tracking — NOT the DB primary key.
  @IsString()
  @IsNotEmpty({ message: 'id must be a non-empty string' })
  id: string;

  @IsEnum(StepType, {
    message: `type must be one of: ${Object.values(StepType).join(', ')}`,
  })
  type: StepType;

  // Skipped entirely for `complete` steps (no config to validate); required
  // and validated against its type's shape for every other step type.
  @ValidateIf((step: StepDto) => step.type !== StepType.COMPLETE)
  @ValidateNested()
  @Transform(transformStepConfig)
  config?: StepConfig;
}
