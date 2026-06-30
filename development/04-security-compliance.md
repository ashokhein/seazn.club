# 04 — Security & Compliance

## 1. Goal

Reach the security bar enterprise buyers gate on: strong auth (incl. SSO/SCIM), granular
authorization, hardened application security, auditability, and a compliance roadmap
(GDPR → SOC 2 → ISO 27001).

## 2. Current state

- AuthN: bcrypt passwords + `jose` JWT in httpOnly cookie `safe_session`; Google OAuth
  (manual). Email verification gates password signups. Active org in `safe_org` cookie.
- AuthZ: org-scoped RBAC (`owner`/`admin`/`viewer`) via `requireOrgRole`,
  `requireTournamentEditor`.
- `audit_log` exists (human-readable). Single `AUTH_SECRET`. No MFA, SSO, rate limiting,
  CSRF tokens, or security headers documented.

## 3. Authentication

### 3.1 Keep & harden existing
- Passwords: bcrypt (cost ≥ 12) → evaluate argon2id `LATER`. Enforce breach check
  (k-anonymity Have-I-Been-Pwned API) and a sane password policy.
- JWT: short-lived access claim + rotation. Move `AUTH_SECRET` to a managed secret store;
  support **key rotation** with a key id (`kid`) in the JWT header and a keyring so old
  tokens validate during rollover.
- Sessions: httpOnly + `Secure` + `SameSite=Lax`; add server-side session revocation list
  (Redis) so logout/role-change/disable invalidates immediately.

### 3.2 MFA / TOTP (`SHOULD`, paid tiers)
- TOTP enrollment (RFC 6238), recovery codes (hashed), optional WebAuthn `LATER`.
- Step-up MFA for sensitive actions (billing change, member removal, data export).

### 3.3 SSO — SAML 2.0 / OIDC (`MUST` for Enterprise)
- **Recommendation: buy** via WorkOS (or Auth0) to avoid maintaining SAML edge cases.
- Per-org IdP config: `org_sso_connections` (provider, metadata URL, domain claim).
- **IdP-initiated + SP-initiated** flows; JIT user provisioning into the org with a default
  role; domain-based routing (email domain → org connection).
- Enforce "SSO required" toggle per org (disables password login for that org's domain).

### 3.4 SCIM provisioning (`MUST` for Enterprise)
- SCIM 2.0 endpoint (via WorkOS Directory Sync or native) to auto create/deactivate
  members and map IdP groups → roles.

## 4. Authorization

### 4.1 Today's RBAC is sufficient for SMB
`owner > admin(editor) > viewer`. Keep as default roles.

### 4.2 Custom roles & granular permissions (`Enterprise`, doc 01 `rbac.custom`)
- Permission catalog (verbs × resources): `tournament.create`, `tournament.score`,
  `member.manage`, `billing.manage`, `org.rename`, `export.run`, `audit.read`...
- Role = named set of permissions, scoped to org; optional **per-tournament delegation**
  (e.g. a "Scorekeeper" who can only `tournament.score` on assigned events).
- Enforce via a single `can(user, permission, resource)` helper; map default roles onto the
  permission catalog so existing code keeps working.

## 5. Application security

| Control | Design |
|---------|--------|
| **Rate limiting** | Redis sliding-window on `/api/auth/*`, invites, result writes, webhooks. Per-IP + per-account. `src/lib/ratelimit.ts`. |
| **CSRF** | Cookie auth + state-changing routes: require `Origin`/`Sec-Fetch-Site` checks **and** a double-submit CSRF token for browser POSTs. API tokens (doc 08) are exempt (bearer, not cookie). |
| **Security headers** | CSP (nonce-based, lock script-src), HSTS (preload), `X-Frame-Options: DENY` (allow only slideshow embed origins), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. Set in `middleware.ts` / `next.config`. |
| **Input validation** | Zod everywhere (already). Add max sizes, array bounds, and reject unknown keys (`.strict()`). |
| **Output / XSS** | Public + slideshow pages render user content (player/org names) — ensure no `dangerouslySetInnerHTML`; sanitize any rich text. |
| **File upload** | Signed-URL uploads validate content-type + size; scan/transform via worker; never trust client MIME (doc 08). |
| **Secrets** | Managed store; no secrets in repo; gitleaks in CI; rotation runbook. |
| **Dependencies** | Dependabot/Renovate + Snyk; SBOM; pin and review. |
| **SSRF/egress** | Outbound (webhooks to customer URLs, IdP metadata) via allowlist + timeouts + no internal IP ranges. |
| **Brute force / enumeration** | Generic auth errors, constant-time compares, lockout/backoff, captcha on abuse. |

## 6. Auditing & logging

- Extend `audit_log` to a **tamper-evident, exportable** trail: actor (user/IdP/system),
  action, resource, before/after summary, IP, user-agent, request id, timestamp.
- **Hash-chain** each audit row (`prev_hash`) so deletion/tampering is detectable; periodic
  anchor to object storage.
- **Export** (`audit.export` entitlement): scheduled or on-demand to customer SIEM
  (download + optional S3/webhook push). Retention per plan.
- Application logs are **structured JSON** with request id + org id (never secrets/PII bodies).

## 7. Data protection

- **In transit:** TLS 1.2+ everywhere; HSTS.
- **At rest:** DB + object storage encryption (managed). Field-level encryption `LATER` for
  anything sensitive (likely minimal — this is sports data).
- **PII inventory:** emails, names, optional player images. Document data flows for DPA.
- **Residency:** logical region tag now (doc 03); physical separation `LATER`.

## 8. Compliance roadmap (sequenced by demand)

| Stage | Standard | Effort | Trigger |
|-------|----------|--------|---------|
| 1 | **GDPR / CCPA** | weeks | Any EU/consumer users. DPA, cookie consent, export/delete (doc 03), privacy policy, sub-processor list. |
| 2 | **SOC 2 Type II** | 6–12 mo | First serious enterprise deals. Automate with Vanta/Drata; needs policies, access reviews, monitoring, vendor mgmt, pen test. |
| 3 | **ISO 27001** | +months | International/large enterprise. Builds on SOC 2 controls. |
| — | **PCI** | minimal | Delegated to Stripe; never store PAN (doc 05). |

**Penetration testing:** annual third-party + automated DAST in CI; bug bounty `LATER`.

## 9. Security operations

- Incident response runbook (severity, on-call, comms, post-mortem).
- Vulnerability management SLAs (critical: patch ≤ 72h).
- Access reviews quarterly (least privilege; SSO for internal tools).
- Backups tested; restore drills (doc 07).

## 10. Acceptance criteria

- Auth hardening list implemented for the phase (secret rotation, session revocation, rate
  limits, headers, CSRF) before public paid launch.
- SSO + SCIM available behind `sso` entitlement for Enterprise.
- Permission catalog + `can()` helper in place before selling custom roles.
- Audit trail tamper-evident and exportable behind `audit.export`.
- GDPR artifacts (DPA, consent, export/delete) shipped before EU GA.

## 11. Open questions / decisions

1. Buy SSO/SCIM (WorkOS/Auth0) vs build SAML natively?
2. MFA mandatory for all paid, or opt-in with enforce-per-org?
3. Which SOC 2 automation vendor, and target audit window?
4. Argon2id vs bcrypt long-term for password hashing?
