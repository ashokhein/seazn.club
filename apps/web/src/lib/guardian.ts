// Guardian gate (PROMPT-53, owner decision 2026-07-13): claimed players under
// 16 (by persons.dob) cannot edit their own consent flags — organiser-set
// values hold. Full guardian-link accounts are out of scope. Pure and shared
// by the server enforcement (usecases/me.ts) and the /me consent card UI.
// dob itself never leaves the server — only this derived flag does.

const CONSENT_SELF_SERVICE_AGE = 16;

/** True when consent stays organiser-managed: dob known AND age < 16.
 *  Unknown/unparseable dob fails open to self-service (the gate keys off
 *  "dob says under 16", not "dob doesn't say adult"). Date-only UTC math —
 *  the birthday itself unlocks. */
export function consentLocked(dob: string | null, now: Date = new Date()): boolean {
  if (!dob) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  let age = now.getUTCFullYear() - year;
  const beforeBirthday =
    now.getUTCMonth() + 1 < month ||
    (now.getUTCMonth() + 1 === month && now.getUTCDate() < day);
  if (beforeBirthday) age -= 1;
  return age < CONSENT_SELF_SERVICE_AGE;
}
