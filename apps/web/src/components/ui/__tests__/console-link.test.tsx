import { describe, expect, it } from "vitest";
import NextLink from "next/link";
import ConsoleLink from "@/components/ui/console-link";

// Console routes are auth-gated and fully dynamic (private, no-store): a
// viewport prefetch renders the entire target page server-side, DB queries
// included (HAR 2026-07-13: one division view = 26 full renders). ConsoleLink
// pins prefetch off so console surfaces never pay that; callers can still opt
// back in explicitly.
describe("ConsoleLink", () => {
  it("renders next/link with prefetch disabled by default", () => {
    const el = ConsoleLink({ href: "/o/riverside", children: "Riverside" });
    expect(el.type).toBe(NextLink);
    expect(el.props.prefetch).toBe(false);
    expect(el.props.href).toBe("/o/riverside");
    expect(el.props.children).toBe("Riverside");
  });

  it("lets an explicit prefetch prop win", () => {
    const el = ConsoleLink({ href: "/help", prefetch: true, children: "Help" });
    expect(el.props.prefetch).toBe(true);
  });

  it("forwards arbitrary anchor props untouched", () => {
    const el = ConsoleLink({
      href: "/admin/revenue",
      className: "app-nav-link",
      "aria-current": "page",
      children: "Revenue",
    });
    expect(el.props.className).toBe("app-nav-link");
    expect(el.props["aria-current"]).toBe("page");
  });
});
