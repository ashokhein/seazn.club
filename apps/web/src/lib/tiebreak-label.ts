// Localized tie-break rule name ("points", "head-to-head", ...) for the
// standings cascade trace caption. The engine's tieBreakLabel()
// (packages/engine, sport-agnostic) only ever produces English rule names —
// this app-level wrapper routes the same rule keys through the `ui` catalog
// instead, falling back to the raw key for any rule not yet in the catalog
// (design/fix-ui/03-console-division.md: "entire tie-break criteria list ...
// untranslated English" inside an otherwise fully French caption). Pure/
// client-safe (no server imports) so it's usable from both the division page
// and unit tests without dragging in DB/server-only dependencies.
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";

export function localizedTieBreakLabel(dict: Dict, key: string): string {
  const messageKey = `div.detail.tiebreak.rule.${key}` as MessageKey;
  const label = t(dict, messageKey);
  return label === messageKey ? key : label;
}
