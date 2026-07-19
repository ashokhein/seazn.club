/** Parse an admin int-cell raw input into a value storable in
 *  `plan_entitlements.int_value`.
 *
 *  - "" (blank) means unlimited → `null`.
 *  - Otherwise the input MUST be a non-negative INTEGER. Floats ("5.5"),
 *    non-numerics ("abc") and negatives ("-1") are rejected so the editor
 *    never PATCHes a NaN / float / negative into the int column.
 *
 *  Lives in its own module (not the "use client" cell component) so it can be
 *  unit-tested in the default node env without importing React / next/navigation.
 */
export type ParseIntCellResult =
  | { ok: true; value: number | null }
  | { ok: false };

export function parseIntCell(raw: string): ParseIntCellResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  // A run of ASCII digits only: no sign, decimal point or exponent. This alone
  // guarantees a non-negative integer; the Number.isInteger check is a belt-and-
  // suspenders guard against surprising coercions.
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) return { ok: false };
  return { ok: true, value };
}
