import { createHash } from 'node:crypto';

/**
 * Deep-sorts object keys (arrays keep their order — step order is
 * meaningful) so the hash below doesn't depend on incidental property
 * insertion order, only on actual content.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * sha256 of the canonicalized { name, steps } — used to reject creating a
 * workflow that is identical (same name AND same steps, order-sensitive on
 * steps) to one that already exists in the same organization. See README
 * "Duplicate workflow detection".
 */
export function computeWorkflowContentHash(
  name: string,
  steps: unknown,
): string {
  const canonical = canonicalize({ name, steps });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
