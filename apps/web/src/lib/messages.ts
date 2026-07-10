// UI copy layer (v3/11 gap 4): every string v3 surfaces add lives here as a
// flat key → English string map. No i18n library, no locale routing yet —
// the point is that when pt-BR lands (v4), translation is a second map, not a
// rewrite of every component. Later v3 prompts extend this file.
//
// Keys are dot-namespaced by surface: `chip.*` status vocabulary,
// `visibility.*` the picker, `confirm.*` dialogs, `card.*` grids,
// `tips.*` live in config/tips.ts (same pattern, richer shape).

export const messages = {
  // ── Status chip vocabulary (v3/03 §1) ──
  "chip.draft": "Draft",
  "chip.registration": "Registration open",
  "chip.live": "Live",
  "chip.completed": "Completed",
  "chip.archived": "Archived",
  "chip.frozen": "Read-only",
  "chip.scheduled": "Scheduled",

  // ── Card grids (v3/03 §2) ──
  "card.empty.competitions": "No competitions yet — create one in about two minutes.",
  "card.empty.competitions.cta": "Create your first competition",
  "card.empty.divisions":
    "No divisions yet. A division picks the sport, its variant and format — entrants and fixtures live inside it.",
  "card.empty.divisions.cta": "Add a division",
  "card.view.cards": "Cards",
  "card.view.list": "List",
  "card.actions": "Actions",
  "card.next.none": "Nothing scheduled yet",
  "card.progress.none": "No fixtures yet",

  // ── ConfirmDialog (v3/03 §3) ──
  "confirm.cancel": "Cancel",
  "confirm.typed.instruction": "Type {name} to confirm",
  "confirm.downgrade.title": "Downgrade to Community?",
  "confirm.downgrade.body":
    "Pro features become unavailable immediately. Anything over the Community limits is frozen, not deleted.",
  "confirm.downgrade.label": "Downgrade",
  "confirm.leaveOrg.title": "Leave this organisation?",
  "confirm.leaveOrg.body": "You lose access to {name} immediately. An owner can invite you back.",
  "confirm.leaveOrg.label": "Leave organisation",
  "confirm.transferOwner.title": "Transfer ownership?",
  "confirm.transferOwner.body":
    "You become an admin and cannot undo this yourself — only the new owner can transfer it back.",
  "confirm.transferOwner.label": "Transfer ownership",
  "confirm.restoreCheckpoint.title": "Restore this save point?",
  "confirm.restoreCheckpoint.body":
    "Schedule edits made after {name} are undone. Results are never touched.",
  "confirm.restoreCheckpoint.label": "Restore",
  "confirm.clearSlots.title": "Clear unlocked slots?",
  "confirm.clearSlots.body":
    "Every unlocked timetable slot in this division is cleared. Locked slots and results stay.",
  "confirm.clearSlots.label": "Clear slots",
  "confirm.deleteClub.title": "Delete this club?",
  "confirm.deleteClub.body":
    "{name} is removed. Its teams stay — their badges fall back to no club badge.",
  "confirm.deleteClub.label": "Delete club",
  "confirm.withdrawRegistration.title": "Withdraw this registration?",
  "confirm.withdrawRegistration.body": "The entrant comes off the list and their spot frees up.",
  "confirm.withdrawRegistration.label": "Withdraw",
  "confirm.refundRegistration.title": "Refund this registration?",
  "confirm.refundRegistration.body": "The remaining amount is refunded to the payer.",
  "confirm.refundRegistration.label": "Refund",
  "confirm.withdrawOwnRegistration.title": "Withdraw your registration?",
  "confirm.withdrawOwnRegistration.body": "This frees your spot. You can register again while registration is open.",
  "confirm.withdrawOwnRegistration.label": "Withdraw",
  "confirm.revokeKey.title": "Revoke this API key?",
  "confirm.revokeKey.body": "Integrations using {name} stop working immediately. This cannot be undone.",
  "confirm.revokeKey.label": "Revoke key",
  "confirm.deleteStage.title": "Delete this stage?",
  "confirm.deleteStage.body": "{name} and its fixtures are removed. Completed results in other stages stay.",
  "confirm.deleteStage.label": "Delete stage",

  // ── Visibility picker (v3/03 §7) ──
  "visibility.legend": "Who can see this",
  "visibility.private.label": "Private",
  "visibility.private.consequence": "Only your team can see it.",
  "visibility.unlisted.label": "Link only",
  "visibility.unlisted.consequence":
    "Anyone with the link can view. Hidden from Google and our directory.",
  "visibility.public.label": "Public",
  "visibility.public.consequence":
    "Anyone can find it — Google, and the Seazn discover page.",
  "visibility.share.label": "Share link",
  "visibility.share.copy": "Copy link",
  "visibility.share.copied": "Copied",
  "visibility.youth.title": "This competition includes youth divisions",
  "visibility.youth.body":
    "Making it visible publishes players' names on the public page. Confirm you hold guardian consent for every under-age player before continuing.",
  "visibility.youth.confirm": "I hold guardian consent — continue",
  "visibility.youth.cancel": "Keep it private",

  // ── Mobile primitives (v3/02) ──
  "sheet.close": "Close",
  "table.actions": "Actions",
} as const;

export type MessageKey = keyof typeof messages;

/** Copy lookup with `{placeholder}` interpolation. Never throws. */
export function msg(key: MessageKey, vars?: Record<string, string | number>): string {
  const raw: string = messages[key];
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m,
  );
}
