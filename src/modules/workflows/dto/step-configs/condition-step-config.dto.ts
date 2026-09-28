import { IsDefined, IsIn, IsNotEmpty, IsString } from 'class-validator';

export enum ConditionOperator {
  EQ = 'eq',
  NEQ = 'neq',
  GT = 'gt',
  GTE = 'gte',
  LT = 'lt',
  LTE = 'lte',
  CONTAINS = 'contains',
}

const CONDITION_OPERATORS = Object.values(ConditionOperator);

/**
 * Fixed field/operator/value comparison — deliberately NOT an arbitrary
 * expression language. There is no eval()/new Function() anywhere in this
 * codebase, and this shape is why: the execution engine only ever needs to
 * read `field` (a dotted path into the previous step's output, e.g.
 * "data.status"), look up `operator` in a fixed table, and compare against
 * `value`. See README "Security Decisions".
 */
export class ConditionStepConfigDto {
  @IsString()
  @IsNotEmpty({ message: 'field must be a non-empty path, e.g. "status"' })
  field: string;

  @IsIn(CONDITION_OPERATORS, {
    message: `operator must be one of: ${CONDITION_OPERATORS.join(', ')}`,
  })
  operator: ConditionOperator;

  // The comparison value: any JSON-serializable type, including `null` (a
  // legitimate thing to compare a field against) — only `undefined` (missing
  // entirely) is rejected.
  @IsDefined({ message: 'value is required' })
  value: unknown;
}
