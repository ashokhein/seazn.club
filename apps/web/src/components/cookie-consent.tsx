"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

const KEY = "seazn_cookie_consent";

export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem(KEY)) setVisible(true);
  }, []);

  function accept() {
    localStorage.setItem(KEY, "accepted");
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-xl rounded-2xl border border-purple-100 bg-white p-4 shadow-xl sm:left-6 sm:right-auto sm:max-w-sm">
      <p className="text-sm text-slate-600">
        We use essential cookies to keep you logged in. No tracking or
        advertising cookies.{" "}
        <Link href="/legal/cookie-policy" className="text-purple-600 underline">
          Cookie policy
        </Link>
        .
      </p>
      <div className="mt-3 flex gap-2">
        <button onClick={accept} className="btn btn-primary text-xs">
          Accept
        </button>
        <button
          onClick={() => setVisible(false)}
          className="btn btn-ghost text-xs"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
