/** Row shape of the raw SQL list query in WorkflowsService.findAll(). */
export interface WorkflowListRow {
  id: string;
  name: string;
  createdAt: Date;
  stepCount: number;
  /** Total matching rows for the org, via COUNT(*) OVER() — same on every row. */
  total: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
}
