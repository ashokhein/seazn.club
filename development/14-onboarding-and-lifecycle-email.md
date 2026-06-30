# 14 — Onboarding, Activation & Lifecycle Email

## 1. Goal

Maximize the metric that matters most for a self-serve product (doc 01): **a new org starts
a tournament within 24 hours.** Achieve it with (a) a guided first-run experience, templates,
and strong empty states, and (b) a reliable transactional + lifecycle email program on a
properly authenticated sending domain.

## 2. Current state

- **Email:** Resend (`src/lib/email.ts`) used only for verification links. **Test mode** —
  sends only to the account owner; in dev the `verify_url` is returned/logged when send fails.
  No domain auth (SPF/DKIM/DMARC) documented; no lifecycle/onboarding email.
- **Onboarding:** after auth, `ensureActiveOrg()` auto-creates "My organization" and lands on
  `/dashboard`. No guided setup, no templates, no sample tournament, minimal empty states.
- **Activation tracking:** none (doc 01 metrics not yet instrumented).

## 3. Part A — Onboarding & activation

### 3.1 Activation funnel (instrument these events)
```
signup → email_verified → org_ready → tournament_created → tournament_started
       → first_result_recorded → tournament_completed
```
Emit a structured analytics event at each step (doc 06/15) with `org_id`, `user_id`,
timestamps. "Activated" = reached `tournament_started`. These power onboarding nudges,
lifecycle email triggers, and the North Star metric.

### 3.2 First-run experience
- **Welcome / goal selection:** after first login, a lightweight wizard: "What are you
  running?" (sport + format) → pre-fills a tournament create form. Skippable.
- **Templates (high leverage):** one-click starting points per sport/format with sensible
  presets (reuse `org_sport_presets`): "Club chess Swiss," "Knockout cup," "Round-robin
  league," "Progress stepladder." Selecting a template opens the create form pre-filled.
- **Sample tournament:** "Create a demo tournament" seeds a small populated example
  (clearly labeled, deletable) so users see live scoring + standings immediately without data
  entry. Builds confidence fast.
- **Checklist widget:** persistent "Getting started" checklist (create org ✓, add players,
  start tournament, record a result, share public page) with progress; dismissible.

### 3.3 Empty states (every primary surface)
- **Dashboard (no tournaments):** large primary CTA "Create your first tournament" +
  template chips + 60-second explainer; not a blank list.
- **Tournament setup (no players):** clear "Add players" affordance, bulk paste/import hint
  (doc 08 team mgmt), and the new image upload field (doc 11).
- **Settings/team (solo):** "Invite a teammate" CTA explaining roles.
- **Seasons/leagues empty:** explain the concept + when to use.

### 3.4 In-product guidance
- Contextual tips (dismissible) on first encounter with scoring, undo, formats.
- Inline explanation of formats at create time (Swiss vs knockout vs round-robin vs
  stepladder) — reduces wrong-format regret.
- "Share" prompt after first completed round → public page (growth loop, doc 06).

### 3.5 Trial onboarding (doc 05)
- Trial banner with days remaining + "what you'll keep on Free."
- Mid-trial and end-of-trial nudges (see lifecycle email below) tied to whether the user has
  activated.

## 4. Part B — Email program

### 4.1 Deliverability foundation (do this before any volume)
- **Verified sending domain** in Resend with **SPF, DKIM, DMARC** records.
- Dedicated subdomain for sending (e.g. `mail.yourdomain.com`); separate **transactional**
  vs **lifecycle/marketing** streams (and ideally separate subdomains/IPs) so a marketing
  issue can't harm transactional deliverability.
- Set `EMAIL_FROM` to an address on the verified domain; configure reply-to.
- Custom **Return-Path** and List-Unsubscribe headers on non-transactional mail.
- Monitor bounces/complaints (Resend webhooks) → suppression list; auto-stop sending to
  hard-bounced/complained addresses.

### 4.2 Email taxonomy

| Stream | Examples | Consent | Unsubscribe |
|--------|----------|---------|-------------|
| **Transactional** | verify email, password reset, invite, ownership transfer, billing receipts, dunning, security alerts | implied (service) | no (required) |
| **Tournament notifications** | round started, your match is ready, results posted, tournament completed (doc 08) | opt-in per prefs | per-category |
| **Lifecycle / onboarding** | welcome, activation nudges, trial reminders, win-back | opt-in / legitimate interest | yes |
| **Product/marketing** | changelog, tips, announcements | explicit opt-in | yes |

### 4.3 Preferences & compliance
```sql
-- greenfield
CREATE TABLE email_preferences (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tournament_updates boolean NOT NULL DEFAULT true,
  lifecycle      boolean NOT NULL DEFAULT true,
  product_news   boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_suppression (
  email      text PRIMARY KEY,
  reason     text NOT NULL,        -- bounce | complaint | unsubscribe_all
  created_at timestamptz NOT NULL DEFAULT now()
);
```
- One-click unsubscribe per category + global; honor before every non-transactional send.
- GDPR/CAN-SPAM: physical address in footer, clear sender, no dark patterns.

### 4.4 Lifecycle journeys (triggered by activation events §3.1)

| Trigger | Email | Goal |
|---------|-------|------|
| `email_verified` & no org activity | **Welcome** + "create your first tournament" (+ template links) | start activation |
| `org_ready` & no `tournament_created` in 24h | **Nudge:** "Run your first event in 5 minutes" + sample tournament | activation |
| `tournament_created` & not `started` in 48h | **Nudge:** "Ready to go live?" | activation |
| `tournament_completed` (first) | **Celebrate** + "share your public page" + invite teammates | retention + growth |
| Trial day 7 / day 12 / day 14 | **Trial reminders** (value recap, what they keep, upgrade CTA) | conversion (doc 05) |
| Near plan limit | **Upgrade nudge** (doc 05 entitlements) | expansion |
| No activity 30 days | **Win-back** | reactivation |

- All journeys suppressed once the desired action occurs (don't nag activated users).
- Respect preferences + suppression; cap frequency.

### 4.5 Implementation
- Extend `src/lib/email.ts` with templated, typed senders; move bodies to maintainable
  templates (React Email or MJML → HTML) with plaintext alternatives.
- **Send via the job queue** (doc 02), not inline in request handlers; retries + dead-letter.
- Lifecycle triggers fire from analytics events / scheduled jobs evaluating funnel state.
- Idempotency: dedupe so a user can't get the same journey email twice (store sent-journey
  records keyed by `user_id + journey_step`).

### 4.6 Internationalization
- Templates localizable (doc 15 l10n); locale from user/org; date/time via `ClientTime`
  conventions.

## 5. Analytics & measurement
- Per-email: delivered, open, click (privacy-aware), and downstream conversion (did the
  nudge cause activation?).
- Funnel dashboard (doc 01 metrics): activation rate, time-to-first-tournament, trial→paid,
  email-attributed activation.
- A/B test subject lines and onboarding variants (flagging, doc 02) — `LATER`.

## 6. Security & failure modes
- Never include secrets/tokens beyond single-use, short-TTL links; verification/reset links
  expire and are single-use (existing pattern).
- Suppression honored atomically; a send failure never blocks the underlying app action
  (e.g. signup succeeds even if welcome email fails — current dev behavior generalized).
- Rate-limit invite/verification emails per user/org to prevent abuse (doc 04).
- Webhook (bounce/complaint) endpoint signature-verified.

## 7. Acceptance criteria
- Sending domain authenticated (SPF/DKIM/DMARC); transactional vs lifecycle streams separated;
  bounce/complaint suppression active.
- First-run wizard + templates + optional sample tournament + dashboard empty-state CTA shipped.
- Activation events instrumented end-to-end; "activated" measurable.
- Lifecycle journeys (welcome, activation nudges, trial reminders, win-back) live, sent via
  queue, honoring preferences + suppression, deduped.
- Users can manage email preferences and unsubscribe per category.

## 8. Phase placement
- **Deliverability foundation + transactional reliability:** **Phase 1** (required before
  paid signups + billing emails).
- **Onboarding wizard + templates + empty states:** **Phase 1/2** (drives conversion).
- **Full lifecycle journeys + preferences UI:** **Phase 2**.

## 9. Open questions / decisions
1. Email template tooling: React Email vs MJML?
2. Separate sending subdomain/IP for marketing now, or after volume grows?
3. Sample tournament: seed real rows (deletable) vs a read-only demo mode?
4. Which onboarding step is the hard "aha" to optimize for — first result recorded vs public
   page shared?
