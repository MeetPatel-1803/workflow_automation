export const WORKFLOW_EXECUTION_QUEUE = 'workflow-execution';
export const WORKFLOW_EXECUTION_JOB = 'process-tick';

/** Max response body size read from an http step's external call. */
export const HTTP_STEP_MAX_RESPONSE_BYTES = 1_000_000; // 1MB
/** Stored `output.body` is truncated beyond this so a huge response doesn't
 * bloat the StepExecution row — see README "http step output truncation". */
export const HTTP_STEP_STORED_BODY_MAX_CHARS = 10_000;

/** Reconciliation cron cadence (worker process only). */
export const RECONCILIATION_INTERVAL_MS = 60_000;
/** A PENDING execution older than this with (as far as we can tell) no
 * active job is assumed to have lost its enqueue and is re-enqueued. */
export const RECONCILIATION_STUCK_PENDING_MS = 30_000;
