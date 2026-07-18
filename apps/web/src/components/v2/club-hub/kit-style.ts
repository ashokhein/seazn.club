// Kit-colour visuals for the club hub (W1 §5.2). Two pure style builders so the
// server-rendered header (the signature kit stripe) and the client colour
// pickers (chip previews) share one source of truth — and so both stay
// unit-testable without a DOM.
import type { CSSProperties } from "react";

const HEX = /^#[0-9a-f]{6}$/i;
const SLATE_200 = "#e2e8f0";
const CHIP_PRIMARY_FALLBACK = "#f1f5f9"; // slate-100
const CHIP_SECONDARY_FALLBACK = "#cbd5e1"; // slate-300

type Colors = Record<string, string> | null | undefined;

function hex(value: string | undefined): string | null {
  return value && HEX.test(value) ? value : null;
}

/** The 3px signature stripe under the hub title: home primary → secondary, a
 *  hard 50/50 split. Falls back to a flat slate-200 hairline when either home
 *  colour is unset, so the stripe reads as a quiet rule rather than a gap. */
export function kitStripeStyle(colors: Colors): CSSProperties {
  const primary = hex(colors?.home_primary);
  const secondary = hex(colors?.home_secondary);
  if (primary && secondary) {
    return { background: `linear-gradient(90deg, ${primary} 0 50%, ${secondary} 50% 100%)` };
  }
  return { background: SLATE_200 };
}

/** A 14px kit chip beside a colour pair: 135° hard split of primary/secondary.
 *  Unset colours fall back to neutral slate so the chip never disappears. */
export function kitChipStyle(
  primary: string | undefined,
  secondary: string | undefined,
): CSSProperties {
  const a = hex(primary) ?? CHIP_PRIMARY_FALLBACK;
  const b = hex(secondary) ?? CHIP_SECONDARY_FALLBACK;
  return { background: `linear-gradient(135deg, ${a} 0 50%, ${b} 50% 100%)` };
}
