# 13 — Internal Admin Console & Account Lifecycle

## 1. Goal

Two related capabilities that customers and support force on you immediately after launch:

1. **Internal admin / support console** — operate the SaaS without raw SQL: look up tenants,
   inspect subscription/entitlement state, safely impersonate for support, grant/extend
   trials, resend verification, suspend/reactivate, process deletions.
2. **Account & org lifecycle** — the user-facing edges that are missing today: change email,
   delete account, transfer org ownership, leave org, last-owner protection, and what
   happens to data when people leave.

Both are **trust and operability** features. Without them you debug in production with SQL
(risky, unscalable) and users hit dead ends on basic account actions.

## 2. Current state

- **Auth:** custom JWT in `seazn_session`; active org in `seazn_org`. RBAC `owner/admin/viewer`
  (`org_members`).
- **Org creation:** `ensureActiveOrg()` auto-creates "My organization"; additional orgs via
  `/orgs/new`. Slug auto-generated, immutable; name editable via `PATCH /api/orgs/[id]`.
- **Members:** invites (1h TTL), role change `POST /api/orgs/[id]/members/[userId]/role`
  (owner only).
- **Missing:** no super-admin role, no support tooling, no impersonation, no email change,
  no account deletion, no ownership transfer, no last-owner guard, no leave-org flow,
  no tenant suspend/reactivate UI.

## 3. Part A — Internal admin console

### 3.1 Access model (separate from tenant RBAC)

Do **not** reuse org roles. Add a platform-level staff flag, fully decoupled from tenancy.

```sql
-- greenfield
ALTER TABLE users ADD COLUMN is_staff boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN staff_role text;   -- 'support' | 'billing' | 'superadmin'

CREATE TABLE staff_audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user  uuid NOT NULL REFERENCES users(id),
  action      text NOT NULL,           -- impersonate_start, grant_trial, suspend_org, ...
  target_org  uuid,
  target_user uuid,
  detail      jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

- Staff access guarded by `requireStaff(role)` helper, **MFA-required** (doc 04), and IP/SSO
  restricted for `superadmin` where feasible.
- **Every** staff action writes `staff_audit` (immutable, hash-chained like doc 04 audit).
- Staff console lives under `/admin` route group, separate layout, never linked from the app.

### 3.2 Capabilities (scoped by staff_role)

| Capability | support | billing | superadmin |
|------------|:-------:|:-------:|:----------:|
| Search orgs/users (email, id, name) | ✅ | ✅ | ✅ |
| View org detail (plan, status, usage, members, tournaments) | ✅ | ✅ | ✅ |
| Resend verification / password reset | ✅ | — | ✅ |
| **Impersonate** a user (read-only or read-write, time-boxed) | ✅ (read-only) | — | ✅ |
| Grant / extend trial, apply credit/coupon | — | ✅ | ✅ |
| Change plan / refund (via Stripe) | — | ✅ | ✅ |
| Suspend / reactivate org | — | — | ✅ |
| Process data export / deletion (GDPR) | — | — | ✅ |
| Toggle feature flags / overrides (doc 03 `org_entitlement_overrides`) | — | — | ✅ |

### 3.3 Impersonation (the sensitive one)

- **Consent + audit:** support may impersonate to reproduce issues; default **read-only**
  (mutations blocked) unless `superadmin` and explicitly elevated.
- **Mechanism:** issue a distinct impersonation session token carrying
  `{ act_as: userId, staff: staffId, mode: 'ro'|'rw', exp }`. The app shows a persistent
  **"You are impersonating X" banner**; all writes (if allowed) are audited as the staff user
  acting-as the target.
- **Time-boxed:** short TTL (e.g. 30 min); auto-expires; one active impersonation per staff.
- **Never** expose impersonation to tenant admins.

### 3.4 Support views
- **Org 360:** subscription (Stripe link), entitlements (resolved + overrides), usage vs
  limits, members + roles, recent tournaments + statuses, recent audit, email/verification
  status, lifecycle state.
- **User 360:** orgs + roles, auth method (password/Google), verification, last login,
  open invites.
- **Billing:** subscription timeline, invoices (deep-link to Stripe), dunning state.

### 3.5 APIs
`/api/admin/*` routes, all behind `requireStaff`, all audited:
- `GET /api/admin/orgs?q=`, `GET /api/admin/orgs/[id]`
- `POST /api/admin/orgs/[id]/trial` (grant/extend)
- `POST /api/admin/orgs/[id]/suspend` / `.../reactivate`
- `POST /api/admin/users/[id]/impersonate` → returns impersonation session
- `POST /api/admin/orgs/[id]/overrides` (entitlement override; requires reason)

## 4. Part B — Account & org lifecycle

### 4.1 Change email
- `POST /api/account/email` → write pending email, send verification to **new** address;
  on confirm, swap and notify **old** address ("your email was changed"). Block if new email
  already in use. Re-verify resets `email_verified` semantics safely.

### 4.2 Change password / reset
- Authenticated change (verify current password). Forgot-password flow: tokenized reset link
  (reuse `verification.ts` patterns), single-use, short TTL, invalidate sessions on reset.

### 4.3 Delete account (GDPR, doc 03/04)
- Self-serve request → confirmation → **block if user is the sole owner of any org with
  other members** (must transfer or delete those orgs first).
- On confirm: revoke sessions, anonymize/delete personal data per retention policy, enqueue
  purge job; keep minimal audit record of the deletion event.

### 4.4 Transfer org ownership
- `POST /api/orgs/[id]/transfer-owner { toUserId }` (current owner only; target must be a
  member). Promotes target to `owner`, demotes initiator to `admin` (configurable).
- Enables a leaving owner to hand off without orphaning the tenant.

### 4.5 Last-owner protection (**critical guard, missing today**)
- Reject any operation that would leave an org with **zero owners**: removing the last owner,
  the last owner leaving, or demoting the last owner. Enforce in role-change + remove-member
  + leave flows.

### 4.6 Leave org
- `POST /api/orgs/[id]/leave` for non-last-owner members; clears `seazn_org` if it was active;
  redirect to another org or org creation. Owners must transfer first if they're the last owner.

### 4.7 Remove member
- Owner/admin per existing RBAC; cannot remove the last owner; removed member loses access
  immediately (session/active-org invalidation).

### 4.8 Org deletion
- Owner-only; confirmation with typed org name; sets `deleting` + `purge_after` (doc 03);
  cascades tournaments/players/etc.; storage prefix cleanup (doc 11); audit retained.

### 4.9 Data ownership semantics (decide + document)
- When a creator leaves, their tournaments remain owned by the **org** (already org-scoped) —
  good. Ensure `created_by` set-null on user delete doesn't break references (it currently
  `ON DELETE SET NULL`). Display "created by (former member)" gracefully.

## 5. Session & security implications (doc 04)
- **Server-side session revocation list** (Redis) so email change, password reset, member
  removal, suspension, and impersonation expiry **immediately** invalidate sessions.
- Suspended org (non-payment, doc 05) → members get read-only access, clear banner, no data
  loss.
- All lifecycle actions audited; sensitive ones (delete, transfer, impersonate) require
  re-auth / step-up MFA.

## 6. UI
- **Account settings page:** email, password, connected Google, delete account.
- **Org settings (extend existing `/settings`):** transfer ownership, leave org, delete org,
  member management with last-owner guards surfaced inline.
- **Admin console `/admin`:** search, org/user 360, billing, impersonation banner, audit view.

## 7. Failure modes
- Concurrent role changes racing to remove last owner → enforce guard inside a transaction
  with row locks on `org_members`.
- Email change to an address mid-verification elsewhere → unique constraint + clear error.
- Impersonation token leakage → short TTL, audit, read-only default, revocation list.
- Deletion of an org with active paid subscription → require cancel/settle first or handle
  proration via Stripe.

## 8. Acceptance criteria

**Admin:**
- `is_staff` + `staff_role` model; `/admin` behind `requireStaff` + MFA; every action audited.
- Support can find any org/user, view 360, resend verification, and (read-only) impersonate.
- Billing staff can grant/extend trials and manage Stripe state; superadmin can suspend,
  override entitlements (with reason), and process deletions.

**Lifecycle:**
- Users can change email (double opt-in), reset password, delete account.
- Ownership transfer works; **last-owner protection enforced** across all paths.
- Leave-org and remove-member invalidate access immediately.
- Org deletion cascades data + storage and is audited.

## 9. Phase placement
- **Last-owner protection + transfer ownership + change email + password reset:** pull into
  **Phase 1** (basic correctness for paying customers).
- **Admin/support console + impersonation:** **Phase 1/2** (needed as soon as you have
  customers to support).
- **Full GDPR delete/export tooling:** align with doc 03/04 (Phase 1 for EU GA).

## 10. Open questions / decisions
1. Impersonation: allow read-write for superadmin, or strictly read-only for everyone?
2. Build `/admin` in-app vs a separate internal tool — in-app recommended for reuse + audit.
3. On owner transfer, demote previous owner to `admin` (recommended) or keep co-owner?
4. Retention policy specifics for deleted-account audit records.
