// UI copy layer (v3/11 gap 4 → v5 i18n cycle 47). The English catalog now lives
// in dictionaries/en/ui.json (namespace `ui`) so it flows through the same Claude
// translation pipeline + parity gate as every other namespace. This module keeps
// the typed key surface and the client-safe *English* msg() lookup. Localized
// copy uses useMsg() (client, via <DictProvider>) or msgFor() (server, in
// lib/messages-i18n). Keys are dot-namespaced by surface: `chip.*` status
// vocabulary, `visibility.*` the picker, `confirm.*` dialogs, `card.*` grids,
// `me.*`/`checkin.*` player surfaces. `tips.*` live in config/tips.ts.
import uiEn from "@/dictionaries/en/ui.json";

export const messages = uiEn;
export type MessageKey = keyof typeof messages;

/** Client-safe *English* copy lookup with `{placeholder}` interpolation. Never
 *  throws. Imports only the en catalog, so it stays out of the locale bundles —
 *  for localized copy use useMsg() (client) or msgFor() (server). */
export function msg(key: MessageKey, vars?: Record<string, string | number>): string {
  const raw: string = (messages as Record<string, string>)[key];
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m,
  );
}
