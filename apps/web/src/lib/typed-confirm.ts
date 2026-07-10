// Type-to-confirm arming rule (v3/03 §3), shared by the ConfirmDialog
// provider and the controlled v2 dialog so the contract is tested once:
// exact match, no trimming, no case folding — the user types the name.

export function isConfirmArmed(typedName: string | undefined, typed: string): boolean {
  return typedName === undefined || typed === typedName;
}
