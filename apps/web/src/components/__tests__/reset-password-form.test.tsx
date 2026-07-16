import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ResetPasswordForm } from "../reset-password-form";
import { DictProvider } from "@/components/i18n/dict-provider";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const stub = {
  "resetPw.title": "TITLE-XX",
  "resetPw.subtitle": "SUB-XX",
  "resetPw.newLabel": "NEW-XX",
  "resetPw.confirmLabel": "CONFIRM-XX",
  "resetPw.saving": "SAVING-XX",
  "resetPw.submit": "SUBMIT-XX",
  "resetPw.missingToken": "MISSING-XX",
  "resetPw.requestNew": "REQUEST-XX",
};

const render = (token: string | null) =>
  renderToStaticMarkup(
    <DictProvider dict={stub} locale="fr">
      <ResetPasswordForm token={token} />
    </DictProvider>,
  );

describe("ResetPasswordForm", () => {
  it("reads the reset copy from the dict (not hardcoded English)", () => {
    const html = render("tok");
    expect(html).toContain("TITLE-XX");
    expect(html).toContain("NEW-XX");
    expect(html).toContain("CONFIRM-XX");
    expect(html).toContain("SUBMIT-XX");
    expect(html).not.toContain("Choose a new password");
  });

  it("localizes the missing-token state", () => {
    const html = render(null);
    expect(html).toContain("MISSING-XX");
    expect(html).toContain("REQUEST-XX");
  });
});
