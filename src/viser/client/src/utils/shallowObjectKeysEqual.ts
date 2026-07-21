/**
 * Shallow object keys equality function for store selectors.
 * Prevents re-renders when object keys haven't changed.
 * Compares objects by checking if they have the same set of keys.
 */
export function shallowObjectKeysEqual<T extends Record<string, any>>(
  a: T | undefined,
  b: T | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);

  if (keysA.length !== keysB.length) return false;

  // Check if all keys in A exist in B.
  for (const key of keysA) {
    if (!(key in b)) return false;
  }

  return true;
}

/**
 * Shallow object equality (keys AND values, compared with ===) for store
 * selectors that derive a fresh object each call.
 */
export function shallowObjectEqual<T extends Record<string, any>>(
  a: T | undefined,
  b: T | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;

  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    // Object.is, not ===: a NaN value (e.g. a non-finite GUI order) must
    // compare equal to itself, or the selector's fresh object never matches
    // the cache and every snapshot read allocates + re-renders.
    if (!(key in b) || !Object.is(a[key], b[key])) return false;
  }
  return true;
}
