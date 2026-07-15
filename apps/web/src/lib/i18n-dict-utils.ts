// Pure dictionary tooling shared by the i18n CLI scripts (parity, key codegen,
// translation). Self-contained (only node:crypto) so `scripts/i18n/*.ts` can
// import it relatively under `node --experimental-strip-types`, and the
// apps/web vitest can import it via the `@/` alias.
import { createHash } from "node:crypto";

/** Flatten a (possibly nested) dictionary object to dot-path leaf keys. */
export function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v)
      ? flattenKeys(v as Record<string, unknown>, path)
      : [path];
  });
}

/** Keys present in `enKeys` but not `locKeys` (missing), and vice-versa (extra). */
export function diffKeys(
  enKeys: string[],
  locKeys: string[],
): { missing: string[]; extra: string[] } {
  const enSet = new Set(enKeys);
  const locSet = new Set(locKeys);
  return {
    missing: enKeys.filter((k) => !locSet.has(k)),
    extra: locKeys.filter((k) => !enSet.has(k)),
  };
}

/** Stable content hash for a source string — the translation manifest key. */
export function hashValue(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** Flat en keys whose source string hash differs from the manifest (new or
 *  changed) — the incremental translation work set. */
export function changedKeys(
  enFlat: Record<string, string>,
  manifest: Record<string, string>,
  hash: (s: string) => string = hashValue,
): string[] {
  return Object.keys(enFlat).filter((k) => manifest[k] !== hash(enFlat[k]));
}
