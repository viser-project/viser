/** Coerce a Mantine ``NumberInput`` onChange payload to a finite number, or
 * ``null`` when it should be ignored.
 *
 * Mantine's ``NumberInput.onChange`` emits ``number | string`` -- a string for
 * the empty field *and* for in-progress/partial input like ``"-"``, ``"1."``,
 * ``"1e"``, or ``"1.2.3"``. Committing those would send ``NaN`` (which becomes
 * ``null`` over JSON) or a raw string to the server, corrupting a numeric
 * handle. Callers should skip the update when this returns ``null``. */
export function finiteNumberOrNull(value: number | string): number | null {
  if (value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
