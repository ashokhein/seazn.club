// Shared building blocks for every email template. Kept framework-free (plain
// string HTML) so templates render identically in the Resend send path and in
// any preview tooling.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

export function btn(label: string, href: string): string {
  return `<p style="margin:24px 0"><a href="${href}" style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">${label}</a></p>`;
}

export function card(title: string, body: string, cta: string, footer: string): string {
  return `<div style="font-family:system-ui,Segoe UI,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto">
  <h2 style="color:#6b21a8">${title}</h2>
  <p style="color:#334155">${body}</p>
  ${cta}
  ${footer ? `<p style="color:#94a3b8;font-size:12px">${footer}</p>` : ""}
</div>`;
}
