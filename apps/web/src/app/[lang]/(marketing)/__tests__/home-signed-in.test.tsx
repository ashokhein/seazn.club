import { beforeEach, describe, expect, it, vi } from "vitest";
// prerender, not renderToStaticMarkup: the page nests async server components
// (MarketingNav awaits getCurrentUser), and the synchronous renderer cannot
// await those — it throws "a component suspended while responding to
// synchronous input".
import { prerender } from "react-dom/static";

// The home page used to redirect signed-in visitors to /dashboard, which made
// it unreachable once you had an account: no way to re-read the pitch, check
// what a prospect sees, or follow your own marketing link. These tests pin the
// page open for both states — a returning redirect would fail them loudly
// rather than quietly bouncing users again.
// Hoisted: vi.mock factories run before module-level consts initialise.
const { getCurrentUser, redirect } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error("redirect() must not be called from the marketing home");
  }),
}));

// next/font/google needs the Next build pipeline; the shell only uses the
// returned CSS-variable name.
vi.mock("next/font/google", () => ({
  Barlow_Condensed: () => ({ variable: "--mk-font-display", className: "" }),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser }));
// The footer mounts the LocaleSwitcher, a client island using router hooks;
// stub them so this stays router-free (same approach as marketing-shell.test).
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    redirect,
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    usePathname: () => "/en",
    useSearchParams: () => new URLSearchParams(),
  };
});

import HomePage from "../page";

async function render(): Promise<string> {
  const element = await HomePage({ params: Promise.resolve({ lang: "en" }) });
  const { prelude } = await prerender(element);
  const reader = (prelude as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let html = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html;
}

// Without this the redirect spy carries calls between cases, so a case that
// asserts "not called" passes or fails depending on what ran before it. That
// only shows up when a redirect actually exists — i.e. exactly when the test is
// supposed to be catching one.
beforeEach(() => {
  vi.clearAllMocks();
});

describe("marketing home — signed in", () => {
  it("renders for a signed-in visitor instead of redirecting to the dashboard", async () => {
    getCurrentUser.mockResolvedValue({ id: "u1", email: "organiser@example.com" });
    const html = await render();
    expect(redirect).not.toHaveBeenCalled();
    // The hero's secondary CTA points at the console, not a signup form.
    expect(html).toContain('href="/dashboard"');
    expect(html).not.toContain('href="/login?tab=signup"');
  });

  it("still asks an anonymous visitor to create an account", async () => {
    getCurrentUser.mockResolvedValue(null);
    const html = await render();
    expect(redirect).not.toHaveBeenCalled();
    expect(html).toContain('href="/login?tab=signup"');
  });

  it("survives an auth lookup failure — the page is public, so it renders anyway", async () => {
    getCurrentUser.mockRejectedValue(new Error("session store down"));
    const html = await render();
    expect(html).toContain('href="/login?tab=signup"');
  });
});
