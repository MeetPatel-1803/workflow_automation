/** Discriminator values for StepDto.type — keep in sync with the config DTOs in dto/step-configs/. */
export enum StepType {
  HTTP = 'http',
  CONDITION = 'condition',
  DELAY = 'delay',
  COMPLETE = 'complete',
}
