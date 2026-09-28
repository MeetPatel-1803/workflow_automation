import { Injectable } from '@nestjs/common';
import { StepType } from '../../workflows/dto/step-type.enum';
import { completeStepHandler } from './complete-step.handler';
import { conditionStepHandler } from './condition-step.handler';
import { delayStepHandler } from './delay-step.handler';
import { httpStepHandler } from './http-step.handler';
import type {
  StepHandler,
  StepHandlerContext,
  StepHandlerOutcome,
} from './step-handler.types';

const HANDLERS: Record<StepType, StepHandler> = {
  [StepType.HTTP]: httpStepHandler,
  [StepType.CONDITION]: conditionStepHandler,
  [StepType.DELAY]: delayStepHandler,
  [StepType.COMPLETE]: completeStepHandler,
};

@Injectable()
export class StepHandlerDispatchService {
  dispatch(context: StepHandlerContext): Promise<StepHandlerOutcome> {
    return HANDLERS[context.step.type](context);
  }
}
