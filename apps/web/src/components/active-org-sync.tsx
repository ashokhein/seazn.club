"use client";
// URL beats cookie (v3/01 §2): /o pages authorise from the path, but the
// seazn_org cookie still backs legacy redirects and org-less API routes.
// Server Components can't set cookies (Next 16), so the org layout renders
// this sync when the path org differs from the cookie org.
import { useEffect } from "react";

export function ActiveOrgSync({ orgId, stale }: { orgId: string; stale: boolean }) {
  useEffect(() => {
    if (!stale) return;
    void fetch("/api/orgs/active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org_id: orgId }),
    });
  }, [orgId, stale]);
  return null;
}
