// Registration reference numbers (v3/05 §3, PROMPT-34). Human-quotable,
// self-checking, generated server-side with a collision-retry loop against
// the registrations.ref_code unique index.
//
// Alphabet: crockford-base32 spirit — no 0/O, 1/I, and (per crockford) no
// L/U either, so a ref survives being read over a phone. 30 characters.
//
// Shape: 6 random chars + 2 checksum chars = SZ-XXXX-XXXX. The design doc's
// mask sketch (`SZ-XXXX-XX`) can't hold its own stated composition ("6 random
// chars + 2-char checksum, ~1B space at 6 chars"), so the composition wins:
// 30^6 ≈ 729M payload space, dash-grouped 4+4 for quotability.

export const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

const PAYLOAD_LEN = 6;
const CODE_LEN = PAYLOAD_LEN + 2; // + 2 checksum chars
const BASE = REF_ALPHABET.length; // 30
const MOD = BASE * BASE; // two check characters

/** Weighted polynomial checksum: every single-character flip and most
 *  transpositions change the sum (weights 31^k are all coprime to 900). */
function checksum(payload: string): string {
  let sum = 0;
  for (const ch of payload) {
    sum = (sum * 31 + REF_ALPHABET.indexOf(ch)) % MOD;
  }
  return `${REF_ALPHABET[Math.floor(sum / BASE)]}${REF_ALPHABET[sum % BASE]}`;
}

/** Dash-group a raw 8-char payload+checksum string as SZ-XXXX-XXXX. */
export function formatRefCode(chars: string): string {
  return `SZ-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Unbiased random alphabet indices via rejection sampling. */
function randomChars(n: number): string {
  const chars: string[] = [];
  const buf = new Uint8Array(n * 2);
  while (chars.length < n) {
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (chars.length === n) break;
      if (byte >= 240) continue; // 240 = 8 * 30 — reject the biased tail
      chars.push(REF_ALPHABET[byte % BASE]!);
    }
  }
  return chars.join("");
}

export function generateRefCode(): string {
  const payload = randomChars(PAYLOAD_LEN);
  return formatRefCode(payload + checksum(payload));
}

/** Uppercase, strip separators/prefix noise, re-shape. Returns the canonical
 *  SZ-XXXX-XXXX form, or the cleaned input if it can't be a ref (callers
 *  then fail the validity check rather than throw). */
export function normalizeRefCode(raw: string): string {
  let s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.startsWith("SZ")) s = s.slice(2);
  return s.length === CODE_LEN ? formatRefCode(s) : raw.trim().toUpperCase();
}

export function isValidRefCode(raw: string): boolean {
  const m = /^SZ-([A-Z2-9]{4})-([A-Z2-9]{4})$/.exec(normalizeRefCode(raw));
  if (!m) return false;
  const chars = `${m[1]}${m[2]}`;
  for (const ch of chars) {
    if (!REF_ALPHABET.includes(ch)) return false;
  }
  const payload = chars.slice(0, PAYLOAD_LEN);
  return checksum(payload) === chars.slice(PAYLOAD_LEN);
}
