// Organiser payment instructions are Markdown with one token: {{reference}}
// becomes the registrant's generated ref code wherever the instructions are
// shown — so "quote {{reference}} on your bank transfer" personalises itself.
// Public pages render the Markdown through lib/prose; the email panels are
// plain-text, so they get a readable stripped version instead.

/** Substitute the {{reference}} token. Before a reference exists (the public
 *  registration form) it degrades to a generic phrase. */
export function fillPaymentInstructions(
  instructions: string,
  reference?: string | null,
): string {
  return instructions.replaceAll("{{reference}}", reference ?? "your registration reference");
}

/** Markdown → readable plain text for the email panels: links become
 *  "label: url", emphasis/heading/quote markers drop, structure survives. */
export function paymentInstructionsText(instructions: string): string {
  return instructions
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1: $2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(\*|_)(?=\S)([^*_\n]*\S)\1/g, "$2")
    .replace(/^>\s?/gm, "")
    .trim();
}
