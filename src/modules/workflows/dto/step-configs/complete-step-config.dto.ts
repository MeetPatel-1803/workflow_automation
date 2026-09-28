/**
 * The terminal marker step — intentionally takes no config. Validation of
 * `config` is skipped entirely for `complete` steps (see StepDto), so this
 * class exists only to give the discriminated union a concrete type to
 * resolve to; it has nothing to validate.
 */
export class CompleteStepConfigDto {}
