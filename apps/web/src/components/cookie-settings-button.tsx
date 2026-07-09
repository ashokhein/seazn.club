"use client";

import { CONSENT_REOPEN_EVENT } from "@/lib/consent";

/**
 * Reopens the cookie-consent banner so a visitor can withdraw or change their
 * analytics choice at any time (GDPR: withdrawal must be as easy as granting).
 * Styleable via className so it can read as a footer link or a button.
 */
export function CookieSettingsButton({
  className,
  children = "Cookie settings",
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(CONSENT_REOPEN_EVENT))}
      className={className}
    >
      {children}
    </button>
  );
}
