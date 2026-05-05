/**
 * Shallow array equality function for store selectors.
 * Prevents re-renders when array contents haven't changed.
 */
export function shallowArrayEqual<T>(
  a: T[] | undefined,
  b: T[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
