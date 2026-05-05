/** Normalize a scale value to a 3-tuple. */
export function normalizeScale(
  s: number | [number, number, number],
): [number, number, number] {
  return typeof s === "number" ? [s, s, s] : s;
}
