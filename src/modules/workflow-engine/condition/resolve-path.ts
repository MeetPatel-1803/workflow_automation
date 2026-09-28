/**
 * Simple dot-path traversal (e.g. "data.status" -> obj.data.status).
 * Deliberately NOT eval()/new Function() — see README "Security decisions".
 * Returns undefined for any missing/non-object intermediate segment rather
 * than throwing, since "field not present" is itself a meaningful (falsy)
 * comparison outcome for a condition step, not a crash.
 */
export function resolvePath(source: unknown, path: string): unknown {
  const segments = path.split('.').filter((segment) => segment.length > 0);
  let current: unknown = source;
  for (const segment of segments) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== 'object'
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
