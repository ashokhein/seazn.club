// OpenAPI 3.1 document for /api/v1, generated from the SAME Zod schemas the
// route handlers parse with (PROMPT-11 §6). Choice: Zod 4's native
// z.toJSONSchema over a third-party converter (@asteasolutions/zod-to-openapi)
// — zero extra dependency, JSON Schema 2020-12 output is what OpenAPI 3.1
// consumes natively, and the schemas stay plain Zod.
//
// NOT server-only: also imported by scripts/openapi-gen.ts (the CI drift gate)
// and the vitest route-coverage test.
import { z, type ZodType } from "zod";
import * as S from "./schemas.ts";
import { matchKeyRoute } from "./key-scopes.ts";

// ---------------------------------------------------------------------------
// Route registry — one row per (path, method). The coverage test asserts this
// table matches the route files on disk 1:1, so the served spec cannot drift
// from the implementation.
// ---------------------------------------------------------------------------

type Method = "get" | "post" | "put" | "patch" | "delete";

interface RouteSpec {
  path: string; // OpenAPI template, e.g. /competitions/{id}
  method: Method;
  summary: string;
  tag: string;
  request?: ZodType;
  response?: ZodType; // the `data` member of the envelope
  status?: number; // success status (default 200)
  query?: Record<string, { schema: object; description?: string }>;
  public?: boolean; // no auth, cacheable
  errors?: number[]; // extra documented error statuses
}

const PAGE_QUERY = {
  cursor: { schema: { type: "string" }, description: "Opaque cursor from a previous page" },
  limit: { schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
};

const pageOf = (item: ZodType) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const ROUTES: RouteSpec[] = [
  // Competitions
  { path: "/competitions", method: "get", summary: "List competitions", tag: "competitions", response: pageOf(S.Competition), query: PAGE_QUERY },
  { path: "/competitions", method: "post", summary: "Create a competition", tag: "competitions", request: S.CreateCompetition, response: S.Competition, status: 201, errors: [409] },
  { path: "/competitions/{id}", method: "get", summary: "Get a competition", tag: "competitions", response: S.Competition },
  { path: "/competitions/{id}", method: "patch", summary: "Update a competition", tag: "competitions", request: S.PatchCompetition, response: S.Competition, errors: [409] },
  { path: "/competitions/{id}", method: "delete", summary: "Delete a competition (no recorded play)", tag: "competitions", response: z.object({ deleted: z.boolean() }), errors: [409] },
  // Divisions
  { path: "/competitions/{id}/divisions", method: "get", summary: "List divisions", tag: "divisions", response: z.array(S.Division) },
  { path: "/competitions/{id}/divisions", method: "post", summary: "Create a division (pins sport module version)", tag: "divisions", request: S.CreateDivision, response: S.Division, status: 201, errors: [409, 422] },
  { path: "/divisions/{id}", method: "get", summary: "Get a division", tag: "divisions", response: S.Division },
  { path: "/divisions/{id}", method: "patch", summary: "Update a division (format edits 409 FORMAT_LOCKED once fixtures exist)", tag: "divisions", request: S.PatchDivision, response: S.Division, errors: [409, 422] },
  { path: "/divisions/{id}/logo-upload-url", method: "post", summary: "Signed upload URL for the division card logo (session-only; not key-accessible)", tag: "divisions" },
  { path: "/divisions/{id}", method: "delete", summary: "Delete a setup division (204) or purge a 30-day archive; started/resulted → 409 DIVISION_HAS_RESULTS {archive: true}", tag: "divisions", status: 204, errors: [409] },
  { path: "/divisions/{id}/archive", method: "post", summary: "Archive: hidden from console/public/quota, restorable", tag: "divisions", response: S.Division, errors: [409] },
  { path: "/divisions/{id}/archive", method: "delete", summary: "Restore an archived division (quota re-checked)", tag: "divisions", response: S.Division, errors: [402] },
  // Entrants
  { path: "/divisions/{id}/entrants", method: "get", summary: "List entrants", tag: "entrants", response: z.array(S.Entrant) },
  { path: "/divisions/{id}/entrants", method: "post", summary: "Register entrant(s) — object or bulk array", tag: "entrants", request: S.CreateEntrants, response: z.union([S.Entrant, z.array(S.Entrant)]), status: 201, errors: [422] },
  { path: "/entrants/{id}", method: "get", summary: "Get an entrant with members", tag: "entrants", response: S.Entrant },
  { path: "/entrants/{id}", method: "patch", summary: "Set status, seed or edit members (no fixture surgery — see /withdraw)", tag: "entrants", request: S.PatchEntrant, response: S.Entrant, errors: [422] },
  { path: "/entrants/{id}/withdraw", method: "post", summary: "Withdraw with fixture surgery (spec 05 §5): tables expunge (<50% played) or walk over remaining; brackets walk over; open formats void remaining", tag: "entrants", errors: [409, 422] },
  { path: "/divisions/{id}/roster", method: "get", summary: "Every (person → team entrant) membership in the division (same-division double-roster warning)", tag: "entrants" },
  // Persons
  { path: "/persons", method: "get", summary: "List persons", tag: "persons", response: pageOf(S.Person), query: PAGE_QUERY },
  { path: "/persons", method: "post", summary: "Create a person", tag: "persons", request: S.CreatePerson, response: S.Person, status: 201 },
  { path: "/persons/{id}", method: "get", summary: "Get a person", tag: "persons", response: S.Person },
  { path: "/persons/{id}", method: "patch", summary: "Update a person", tag: "persons", request: S.PatchPerson, response: S.Person },
  { path: "/persons/{id}/merge", method: "post", summary: "Merge a duplicate person into this one", tag: "persons", request: S.MergePersons, response: S.Person, errors: [422] },
  { path: "/persons/{id}/photo", method: "post", summary: "Upload a player photo (multipart `file`); public display gated by public_photo consent", tag: "persons", response: S.Person, errors: [400, 404, 415, 502] },
  { path: "/entrants/{id}/badge", method: "post", summary: "Upload an entrant crest/badge (multipart `file`) — stored in assets, badge_url set to the path; external URLs via PATCH /entrants/{id}", tag: "entrants", response: S.Entrant, errors: [400, 404, 415, 502] },
  { path: "/entrants/{id}/badge", method: "delete", summary: "Clear the entrant badge (display falls back to team logo, then monogram)", tag: "entrants", response: S.Entrant, errors: [404] },
  { path: "/persons/{id}/profiles/{sport}", method: "get", summary: "Get a per-sport profile", tag: "persons" },
  { path: "/persons/{id}/profiles/{sport}", method: "put", summary: "Upsert a per-sport profile", tag: "persons", request: S.PutProfile, errors: [422] },
  // Player accounts (PROMPT-53) — session-only, never key-accessible
  { path: "/persons/{id}/claim-invites", method: "post", summary: "Invite the person to claim their profile (session editors only; claim_url embeds the one-time secret; revokes any prior open invite)", tag: "player-accounts", request: S.CreateClaimInvite, response: S.CreatedPersonClaim, status: 201, errors: [409] },
  { path: "/persons/{id}/claim-invites", method: "get", summary: "The person's open claim invite, if any (never the secret)", tag: "player-accounts", response: S.PersonClaim.nullable() },
  { path: "/persons/{id}/claim-invites", method: "delete", summary: "Withdraw the open claim invite (idempotent)", tag: "player-accounts", response: S.PersonClaim.nullable() },
  { path: "/persons/{id}/unlink", method: "post", summary: "Staff unlink: detach the player login and revoke live claims (audited — claim rows are retained)", tag: "player-accounts" },
  { path: "/me/fixtures", method: "get", summary: "Player home read: upcoming fixtures, recent results and teams for every claimed person of the caller, across orgs (session only)", tag: "player-accounts", response: S.MyFixtures },
  { path: "/me/fixtures/{id}/availability", method: "put", summary: "RSVP in/out/maybe + note for the caller's person on this fixture (session only)", tag: "player-accounts", request: S.PutAvailability, response: S.Availability, errors: [403, 422] },
  { path: "/me/persons", method: "get", summary: "The caller's claimed player profiles with consent state (session only)", tag: "player-accounts", response: z.array(S.MyPerson) },
  { path: "/me/persons/{id}/consent", method: "patch", summary: "Player-owned consent flags; under-16 → 403 CONSENT_LOCKED (guardian gate)", tag: "player-accounts", request: S.PatchMyConsent, response: S.MyPerson, errors: [403] },
  { path: "/fixtures/{id}/checkin-link", method: "post", summary: "Mint the fixture's self-check-in QR link (session editors only; signed token, dies at local midnight)", tag: "player-accounts", response: S.CheckinLink, status: 201, errors: [422] },
  // Stages
  { path: "/divisions/{id}/stages", method: "get", summary: "List stages", tag: "stages", response: z.array(S.Stage) },
  { path: "/divisions/{id}/stages", method: "post", summary: "Define the stage graph", tag: "stages", request: S.CreateStages, response: z.union([S.Stage, z.array(S.Stage)]), status: 201, errors: [409] },
  { path: "/divisions/{id}/stages", method: "put", summary: "Replace the stage graph (v8 Settings format; 409 FORMAT_LOCKED once fixtures exist)", tag: "stages", request: S.CreateStages, response: z.array(S.Stage), errors: [409] },
  { path: "/stages/{id}/generate", method: "post", summary: "Generate fixtures (idempotent, returns diff)", tag: "stages", response: S.GenerateResult, errors: [422] },
  { path: "/stages/{id}/complete", method: "post", summary: "Guarded stage completion / progression", tag: "stages", response: S.CompleteResult, errors: [422] },
  { path: "/stages/{id}/standings", method: "get", summary: "Standings snapshot", tag: "stages", query: { pool_id: { schema: { type: "string", format: "uuid" } } } },
  { path: "/stages/{id}", method: "delete", summary: "Delete a stage (last-in-graph, no played fixtures)", tag: "stages", response: z.object({ deleted: z.boolean() }), errors: [409] },
  // Scheduling console (doc 12 §4, PROMPT-17)
  { path: "/format-preview", method: "post", summary: "Example fixtures for a stage graph (placeholder entrants; no persistence)", tag: "scheduling", request: z.object({ count: z.number().int().min(2).max(64).default(8), stages: z.array(z.object({ kind: z.string(), name: z.string(), config: z.record(z.string(), z.unknown()), qualification: z.unknown().nullable() })) }), response: z.object({ phases: z.array(z.object({ title: z.string(), note: z.string().optional(), sections: z.array(z.object({ title: z.string(), matches: z.array(z.object({ home: z.string(), away: z.string() })) })) })) }) },
  { path: "/divisions/{id}/schedule-settings", method: "get", summary: "Get scheduling settings (defaults when unset)", tag: "scheduling", response: S.ScheduleSettings },
  { path: "/divisions/{id}/schedule-settings", method: "put", summary: "Upsert scheduling settings (constraint fields are Pro)", tag: "scheduling", request: S.PutScheduleSettings, response: S.ScheduleSettings, errors: [402] },
  { path: "/stages/{id}/schedule/auto", method: "post", summary: "Run the pure calendar pass — propose only, nothing persisted", tag: "scheduling", request: S.AutoScheduleRequest, response: S.AutoScheduleResult },
  { path: "/stages/{id}/schedule/apply", method: "post", summary: "Persist an assignment set; blocking conflicts → 409", tag: "scheduling", request: S.ApplyScheduleRequest, response: S.ApplyScheduleResult, errors: [402, 409, 422] },
  { path: "/divisions/{id}/schedule/validate", method: "post", summary: "Full board conflict report (doc 12 §2 taxonomy)", tag: "scheduling", response: S.ValidateScheduleResult },
  { path: "/divisions/{id}/publish-schedule", method: "post", summary: "Publish the timetable (division → scheduled)", tag: "scheduling", response: S.PublishScheduleResult, errors: [422] },
  { path: "/divisions/{id}/start", method: "post", summary: "Start the tournament (quick-start generates fixtures)", tag: "scheduling", response: S.StartDivisionResult, errors: [422] },
  // Fixtures & scoring
  { path: "/fixtures/{id}", method: "get", summary: "Get a fixture", tag: "fixtures", response: S.Fixture },
  { path: "/fixtures/{id}", method: "patch", summary: "Schedule move, venue, officials, pin/lock — blocking conflicts → 409", tag: "fixtures", request: S.PatchFixture, response: S.Fixture, errors: [402, 409, 422] },
  { path: "/fixtures/{id}/lineups/{entrantId}", method: "get", summary: "Get a side's lineup", tag: "fixtures" },
  { path: "/fixtures/{id}/lineups/{entrantId}", method: "put", summary: "Replace a side's lineup", tag: "fixtures", request: S.PutLineup, errors: [422] },
  { path: "/fixtures/{id}/events", method: "post", summary: "Append a score event (THE scoring endpoint)", tag: "scoring", request: S.AppendEventRequest, response: S.AppendEventResponse, status: 201, errors: [409, 422, 429] },
  { path: "/fixtures/{id}/events", method: "get", summary: "Read the ledger after ?since_seq=", tag: "scoring", response: z.array(S.ScoreEvent), query: { since_seq: { schema: { type: "integer", minimum: 0, default: 0 } } } },
  { path: "/fixtures/{id}/state", method: "get", summary: "Live state (ETag = ledger seq)", tag: "scoring", response: S.FixtureState },
  { path: "/fixtures/{id}/finalize", method: "post", summary: "Lock the ledger (core.finalize)", tag: "scoring", request: z.object({ expected_seq: z.number().int().min(0) }), response: S.AppendEventResponse, errors: [409, 422] },
  // Device links (doc 13 §7, PROMPT-21)
  { path: "/fixtures/{id}/device-links", method: "post", summary: "Mint a day-of device link (editor session only; secret shown once; revokes prior active links; expiry = end of the fixture's local day)", tag: "device-links", request: S.CreateDeviceLink, response: S.CreatedDeviceLink, status: 201, errors: [402, 422, 429] },
  { path: "/fixtures/{id}/device-links", method: "get", summary: "The fixture's active device link, if any (never the secret)", tag: "device-links", response: S.DeviceLink.nullable() },
  { path: "/fixtures/{id}/device-links/{linkId}", method: "delete", summary: "Revoke a device link (immediate 401 for the holder)", tag: "device-links", response: S.DeviceLink },
  // Scorer console (doc 13 §6, PROMPT-18)
  { path: "/me/assigned-fixtures", method: "get", summary: "Fixtures covered by the caller's scorer assignments (session only)", tag: "scorers", response: z.array(S.AssignedFixture), query: { date: { schema: { type: "string", format: "date" }, description: "Narrow to one day (YYYY-MM-DD)" } } },
  // Officiating portal (PROMPT-57)
  { path: "/me/assigned-fixtures/{id}/response", method: "patch", summary: "Accept or decline an officiating assignment (assigned official's session only; declines flag for a manual re-pick, never auto-reassign)", tag: "officials", request: S.OfficiatingResponseInput, response: S.OfficiatingResponseOut, errors: [422] },
  { path: "/me/availability/officiating", method: "post", summary: "Mark a blackout date on every officiating profile linked to the caller (upsert on note)", tag: "officials", request: S.OfficiatingBlackoutInput, response: S.OfficiatingBlackout, status: 201 },
  { path: "/me/availability/officiating", method: "delete", summary: "Clear a blackout date (idempotent)", tag: "officials", query: { date: { schema: { type: "string", format: "date" }, description: "The date to clear (YYYY-MM-DD)" } } },
  { path: "/me/officiating-claims/{id}/accept", method: "post", summary: "Accept a pending officiating invite by id (v11.1 — /me 'Pending invites' card; no token in the URL, the session's verified email proves it; routes through the same accept core as /claim/{token})", tag: "officials", response: S.OfficiatingClaimAccepted, errors: [403, 404, 409] },
  // API keys
  { path: "/orgs/{id}/api-keys", method: "get", summary: "List API keys", tag: "api-keys", response: z.array(S.ApiKey) },
  { path: "/orgs/{id}/api-keys", method: "post", summary: "Create an API key (secret shown once)", tag: "api-keys", request: S.CreateApiKey, response: S.CreatedApiKey, status: 201, errors: [402] },
  { path: "/orgs/{id}/api-keys/{keyId}", method: "delete", summary: "Revoke an API key", tag: "api-keys", response: S.ApiKey },
  // Sponsor CRM (v10 PROMPT-56)
  { path: "/orgs/{id}/sponsors", method: "get", summary: "List sponsors, tier-ranked (title → gold → silver → partner)", tag: "sponsors", response: z.array(S.Sponsor) },
  { path: "/orgs/{id}/sponsors", method: "post", summary: "Create a sponsor (tiers above partner / competition scoping are Pro `sponsors.tiers`)", tag: "sponsors", request: S.CreateSponsor, response: S.Sponsor, status: 201, errors: [402] },
  { path: "/orgs/{id}/sponsors/{sponsorId}", method: "patch", summary: "Update a sponsor (promoting tier / scoping is Pro `sponsors.tiers`)", tag: "sponsors", request: S.PatchSponsor, response: S.Sponsor, errors: [402] },
  { path: "/orgs/{id}/sponsors/{sponsorId}", method: "delete", summary: "Delete a sponsor", tag: "sponsors" },
  { path: "/orgs/{id}/sponsors/reorder", method: "post", summary: "Persist a new display order (ids in render order)", tag: "sponsors", request: S.ReorderSponsors, errors: [422] },
  { path: "/orgs/{id}/sponsor-packages", method: "get", summary: "List sponsorship packages", tag: "sponsors", response: z.array(S.SponsorPackage) },
  { path: "/orgs/{id}/sponsor-packages", method: "post", summary: "Create a priced sponsorship package (Pro `sponsors.monetize`)", tag: "sponsors", request: S.CreateSponsorPackage, response: S.SponsorPackage, status: 201, errors: [402] },
  { path: "/orgs/{id}/sponsor-packages/{packageId}", method: "delete", summary: "Retire a package (soft — orders keep referencing it)", tag: "sponsors", response: S.SponsorPackage },
  { path: "/orgs/{id}/sponsor-orders", method: "get", summary: "List sponsor orders (payment audit trail)", tag: "sponsors", response: z.array(S.SponsorOrder) },
  { path: "/orgs/{id}/sponsor-orders", method: "post", summary: "Start a package checkout — pending order + Connect destination-charge session + invoice email; 409 when the org isn't Connect-onboarded", tag: "sponsors", request: S.StartSponsorCheckout, response: S.SponsorCheckoutStarted, status: 201, errors: [402, 409, 422] },
  { path: "/orgs/{id}/sponsor-orders/{orderId}/refund", method: "post", summary: "Full refund of a paid order — transfer reversed, platform fee returned, placement deactivated", tag: "sponsors", response: S.SponsorOrder, errors: [422] },
  // Public (no auth, cacheable, consent-filtered)
  { path: "/public/orgs/{orgSlug}/competitions/{slug}", method: "get", summary: "Public competition: description + divisions", tag: "public", public: true },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/divisions/{divisionSlug}/schedule", method: "get", summary: "Public schedule", tag: "public", public: true },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/divisions/{divisionSlug}/standings", method: "get", summary: "Public standings", tag: "public", public: true },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/divisions/{divisionSlug}/entrants", method: "get", summary: "Public entrants (consent-filtered)", tag: "public", public: true },
  { path: "/public/fixtures/{id}", method: "get", summary: "Public live fixture summary", tag: "public", public: true },
  { path: "/public/fixtures/{id}/realtime-token", method: "get", summary: "Realtime subscriber token (403 unless the org has the realtime entitlement)", tag: "public", public: true },
  { path: "/public/discovery", method: "get", summary: "Discovery directory (doc 15 §4): opted-in public competitions, cursor-paginated", tag: "public", public: true, query: { sport: { schema: { type: "string" } }, country: { schema: { type: "string" } }, status: { schema: { type: "string", enum: ["live", "upcoming"] } }, q: { schema: { type: "string" } }, cursor: { schema: { type: "string" } }, limit: { schema: { type: "integer", minimum: 1, maximum: 48 } } } },
  // Registration & entry fees (doc 16 §1.1, PROMPT-20a)
  { path: "/divisions/{id}/registration-settings", method: "get", summary: "Division registration settings (defaults when unset)", tag: "registration", response: S.RegistrationSettings },
  { path: "/divisions/{id}/registration-settings", method: "put", summary: "Upsert registration settings (entry fees are Pro)", tag: "registration", request: S.PutRegistrationSettings, response: S.RegistrationSettings, errors: [402, 422] },
  { path: "/divisions/{id}/registrations", method: "get", summary: "Organiser registration list (?status=)", tag: "registration", response: z.array(S.Registration), query: { status: { schema: { type: "string", enum: ["pending", "paid", "confirmed", "waitlisted", "withdrawn"] } } } },
  { path: "/divisions/{id}/registrations/export", method: "get", summary: "CSV export of registrations (Pro `exports`)", tag: "registration", errors: [402] },
  { path: "/registrations/{id}/confirm", method: "post", summary: "Approve: materialise the entrant (idempotent)", tag: "registration", response: S.Registration, errors: [422] },
  { path: "/registrations/{id}/mark-paid", method: "post", summary: "Record an offline (cash/bank) payment — confirms the entry", tag: "registration", response: S.Registration, errors: [422] },
  { path: "/registrations/{id}/waive", method: "post", summary: "Confirm without payment (fee waived, audited)", tag: "registration", response: S.Registration, errors: [422] },
  { path: "/registrations/{id}/waitlist", method: "post", summary: "Move a pending registration to the waitlist", tag: "registration", response: S.Registration, errors: [422] },
  { path: "/registrations/{id}/withdraw", method: "post", summary: "Withdraw: frees the spot, auto-promotes, auto-refunds pre-lock", tag: "registration", response: S.Registration },
  { path: "/registrations/{id}/refund", method: "post", summary: "Manual refund (post-lock discretion; partial allowed; audited)", tag: "registration", request: S.RefundRegistration, response: S.Registration, errors: [422] },
  { path: "/registrations/{id}/remind", method: "post", summary: "Email an unpaid registrant a payment reminder (offline pay)", tag: "registration", response: z.object({ sent: z.boolean() }), errors: [422] },
  { path: "/registrations/{id}/evidence", method: "get", summary: "Dispute evidence pack as a printable HTML attachment — registration record, receipt reconstruction, activity log, fixtures (session console, not key-accessible)", tag: "registration", errors: [404] },
  { path: "/orgs/{id}/connect", method: "get", summary: "Stripe Connect status (?refresh=1 re-reads from Stripe)", tag: "registration", response: S.ConnectStatus, query: { refresh: { schema: { type: "string", enum: ["1"] } } } },
  { path: "/orgs/{id}/connect", method: "post", summary: "Create the Express account + onboarding link (Pro)", tag: "registration", request: S.CreateConnectOnboarding, response: S.ConnectOnboardingLink, errors: [402] },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/registration", method: "get", summary: "Public register panel: open divisions, fees, remaining capacity", tag: "public", public: true, response: S.PublicRegistrationInfo },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/register", method: "post", summary: "Submit a registration (fee → Stripe Checkout URL)", tag: "public", public: true, request: S.PublicRegisterRequest, response: S.PublicRegisterResponse, status: 201, errors: [422, 429, 503] },
  { path: "/public/registrations/{id}", method: "get", summary: "Registrant status view (?token=; ?reconcile=1 after checkout)", tag: "public", public: true, response: S.PublicRegistrationStatus, errors: [401] },
  { path: "/public/registrations/{id}/withdraw", method: "post", summary: "Registrant self-withdraw (token)", tag: "public", public: true, request: S.PublicRegistrationToken, response: S.PublicRegistrationStatus },
  { path: "/public/registrations/{id}/checkout", method: "post", summary: "(Re)open Stripe Checkout for a pending paid registration", tag: "public", public: true, request: S.PublicRegistrationToken, errors: [422, 503] },
  { path: "/public/registrations/{id}/ics", method: "get", summary: "Confirmation .ics for the competition dates (?token=)", tag: "public", public: true, errors: [401] },
  { path: "/public/registrations/by-ref/{ref}/withdraw", method: "post", summary: "Self-withdraw via reference number — the ref locates, the email token authorises (v3/05 §3)", tag: "public", public: true, request: S.PublicRegistrationToken, errors: [404] },
  // Clubs & bulk import (Jul3/01, PROMPT-21)
  { path: "/clubs", method: "get", summary: "List clubs", tag: "clubs", response: z.array(S.Club) },
  { path: "/clubs", method: "post", summary: "Create a club (Pro `clubs.hierarchy`)", tag: "clubs", request: S.CreateClub, response: S.Club, status: 201, errors: [402, 409] },
  { path: "/clubs/{id}", method: "get", summary: "Club detail: teams across divisions", tag: "clubs", response: S.ClubDetail },
  { path: "/clubs/{id}", method: "patch", summary: "Update a club", tag: "clubs", request: S.PatchClub, response: S.Club, errors: [402] },
  { path: "/clubs/{id}", method: "delete", summary: "Delete a club (teams survive, badges fall back)", tag: "clubs", errors: [402] },
  // Teams (Pro clubs.hierarchy) — parent-club teams and their persistent squads.
  { path: "/clubs/{id}/teams", method: "post", summary: "Add a team under a club (Pro `clubs.hierarchy`)", tag: "clubs", request: S.CreateTeam, status: 201, errors: [402, 404, 409] },
  { path: "/teams", method: "get", summary: "List teams with their division entries", tag: "clubs" },
  { path: "/teams/{id}/squad", method: "get", summary: "Get a team's persistent squad", tag: "clubs", errors: [404] },
  { path: "/teams/{id}/squad", method: "put", summary: "Replace a team's squad (auto-seeds entrant rosters on enrollment)", tag: "clubs", request: S.SetTeamSquad, errors: [402, 404] },
  { path: "/teams/{id}/logo", method: "post", summary: "Set a team badge: multipart `file` (v3/03 §5; overrides the club badge for this team)", tag: "clubs", errors: [404, 422] },
  { path: "/teams/{id}/logo", method: "delete", summary: "Clear a team badge (falls back to the club badge)", tag: "clubs", errors: [404] },
  { path: "/clubs/logos", method: "post", summary: "Bulk logo assign: multipart `files` + `mapping` JSON + `assign_remaining` (Jul3/01 §5; Pro `logos.bulk` for >1 file)", tag: "clubs", response: z.array(S.LogoAssignment), errors: [402, 422] },
  { path: "/imports", method: "post", summary: "Upload a participants spreadsheet (multipart `file`) → dry-run { importId, plan }; writes nothing (Jul3/01 §6)", tag: "clubs", response: S.ImportPreview, status: 201, errors: [402, 413, 422] },
  { path: "/imports/{id}", method: "get", summary: "Re-preview a stored import against current state", tag: "clubs", response: S.ImportPreview },
  { path: "/imports/{id}/commit", method: "post", summary: "Execute the plan in one transaction (Idempotency-Key header)", tag: "clubs", response: S.ImportCommitResult, status: 201, errors: [402, 422] },
  { path: "/participants/export", method: "get", summary: "Participants CSV/XLSX: club + division columns, empty-spot rows intact (Pro `exports`)", tag: "clubs", errors: [402], query: { format: { schema: { type: "string", enum: ["csv", "xlsx"] } }, club_id: { schema: { type: "string" } }, division_id: { schema: { type: "string" } } } },
  // Referee & officials assignment (Jul3/02, PROMPT-22)
  { path: "/officials", method: "get", summary: "List officials (people or team-as-referee entrants)", tag: "officials", response: z.array(S.Official) },
  { path: "/officials", method: "post", summary: "Create an official (multi-role is Pro `officials.roles_multi`)", tag: "officials", request: S.CreateOfficial, response: S.Official, status: 201, errors: [402] },
  { path: "/officials/{id}", method: "get", summary: "Get an official", tag: "officials", response: S.Official },
  { path: "/officials/{id}", method: "patch", summary: "Update an official", tag: "officials", request: S.PatchOfficial, response: S.Official, errors: [402] },
  { path: "/officials/{id}", method: "delete", summary: "Delete an official", tag: "officials" },
  { path: "/officials/import", method: "post", summary: "Bulk CSV/XLSX import (multipart `file`: Name, Roles, MaxPerDay)", tag: "officials", status: 201, errors: [422] },
  { path: "/officials/{id}/invite", method: "post", summary: "Invite the official to claim their profile through the shared person-claim rail (session editors only; claim_url embeds the one-time secret)", tag: "officials", request: S.CreateClaimInvite, response: S.CreatedPersonClaim, status: 201, errors: [409] },
  { path: "/divisions/{id}/officials/auto", method: "post", summary: "Propose assignments — pure engine pass with locked rows as obstacles; writes nothing (Pro `officials.auto`)", tag: "officials", request: S.AutoAssignOfficials, response: S.OfficialsProposal, errors: [402] },
  { path: "/divisions/{id}/officials/apply", method: "post", summary: "Persist a proposal transactionally; emits `officials_assigned` (Pro `officials.auto`)", tag: "officials", request: S.ApplyOfficials, errors: [402, 422] },
  { path: "/fixtures/{id}/officials", method: "patch", summary: "Manual set/move/lock — single-role manual assignment free on every plan", tag: "officials", request: S.PatchFixtureOfficials, errors: [402] },
  { path: "/stages/{id}/officials/source", method: "post", summary: "Resolve rank/result sourcing → officiating entrants; pending until the source decides (Pro `officials.auto`)", tag: "officials", request: S.SourceOfficials, errors: [402] },
  // Schedule undo, versioning & safe destructive ops (Jul3/03, PROMPT-23)
  { path: "/divisions/{id}/undo", method: "post", summary: "Undo the last structural edit: appends the inverse event, moves the watermark (results-guarded)", tag: "history", request: S.HistoryStep, errors: [409, 422] },
  { path: "/divisions/{id}/redo", method: "post", summary: "Redo the next edit (Word-like linear history)", tag: "history", request: S.HistoryStep, errors: [409, 422] },
  { path: "/divisions/{id}/history", method: "get", summary: "Ledger slice: type, actor, time, undoable/undone", tag: "history" },
  { path: "/divisions/{id}/checkpoints", method: "get", summary: "Named save points", tag: "history" },
  { path: "/divisions/{id}/checkpoints", method: "post", summary: "Create a save point at the current watermark (>1 is Pro `schedule.versioning`)", tag: "history", request: S.CreateCheckpoint, status: 201, errors: [402] },
  { path: "/divisions/{id}/restore", method: "post", summary: "Undo back to a checkpoint (confirm: true; results-guarded)", tag: "history", request: S.RestoreCheckpoint, errors: [422] },
  { path: "/divisions/{id}/locks", method: "patch", summary: "Whole-division freeze + multi-site scope locks (scopes are Pro)", tag: "history", request: S.DivisionLocks, errors: [402] },
  { path: "/schedule/clear", method: "post", summary: "Scoped clear (stage/pools/rounds/courts; confirm: true; locked + decided survive; undoable)", tag: "history", request: S.ClearSchedule, errors: [422] },
  { path: "/pools/{id}/clear-entrants", method: "post", summary: "Remove all teams in a pool, keep the pool (confirm: true; blocked once decided; undoable)", tag: "history", request: S.ClearPoolEntrants, errors: [422] },
  // Scheduling constraints v2 & AI (Jul3/04, PROMPT-24)
  { path: "/schedule/shift", method: "post", summary: "Bulk time shift: push everything in scope by ±N minutes (schedule_shifted event; undoable; all plans)", tag: "scheduling", request: S.ScheduleShift, errors: [422] },
  { path: "/divisions/{id}/schedule/report", method: "get", summary: "Wait-time diagnostics: min/max gap per entrant + worst waits (16 Sep; all plans)", tag: "scheduling" },
  { path: "/divisions/{id}/schedule/ai-constraints", method: "post", summary: "Prose → Zod-validated SchedulingConstraints; propose-only, human applies (Pro `scheduling.ai`)", tag: "scheduling", request: S.AiConstraintsRequest, errors: [402, 422] },
  // Custom points & rank control (Jul3/05, PROMPT-25)
  { path: "/stages/{id}/standings/override", method: "post", summary: "Pin final ranks (placement games decide 3rd/4th); cascade orders the unlocked remainder; audited rank_overridden (Pro `tiebreakers.custom`)", tag: "stages", request: S.OverrideStandings, errors: [402, 422] },
  // Rich exports & print templates (Jul3/06, PROMPT-26)
  { path: "/divisions/{id}/exports/{kind}", method: "get", summary: "Templated export (timetable|standings|roster|participants|scoresheet|officials_rota) as PDF/XLSX; page-break + landscape knobs free, branding Pro `exports.branded` (Pro `exports`)", tag: "exports", errors: [402, 404], query: { format: { schema: { type: "string", enum: ["pdf", "xlsx"] } }, pageBreaks: { schema: { type: "string", enum: ["auto", "per_pitch", "per_team", "per_division"] } }, landscape: { schema: { type: "string", enum: ["true"] } }, blank: { schema: { type: "string", enum: ["true"] } } } },
  { path: "/competitions/{id}/exports/timetable", method: "get", summary: "Competition-wide pretty timetable PDF, one division per page (Pro `exports`)", tag: "exports", errors: [402], query: { pretty: { schema: { type: "string", enum: ["true"] } } } },
  // Matchday documents (v12/Task 14): officials rota kind above; admit tickets + the caller's own cross-org rota below.
  { path: "/competitions/{id}/exports/tickets", method: "get", summary: "2-up admit tickets (PDF only) for every confirmed registration, name-masked, QR carries the /r/{ref} URL (Pro `exports`)", tag: "exports", errors: [400, 402], query: { format: { schema: { type: "string", enum: ["pdf"] } } } },
  { path: "/me/rota.pdf", method: "get", summary: "The caller's own officiating rota PDF across every organisation — free, session-only, no org tenant", tag: "officials" },
  // Player statistics (Jul3/07, PROMPT-27)
  { path: "/divisions/{id}/stats/players", method: "get", summary: "Division leaderboard from the score-event fold, sortable by any declared metric; flags requires_detailed_scoring instead of wrong zeros (Pro `stats.player`)", tag: "stats", errors: [402], query: { metric: { schema: { type: "string" } }, sort: { schema: { type: "string", enum: ["asc", "desc"] } } } },
  { path: "/persons/{id}/stats", method: "get", summary: "A player's card stats, keyed per division (Pro `stats.player`)", tag: "stats", errors: [402], query: { division_id: { schema: { type: "string", format: "uuid" } } } },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/divisions/{divisionSlug}/stats", method: "get", summary: "Consent-filtered public leaderboard (minors' names gated)", tag: "public", public: true },
  // Format engine extensions (Jul3/08, PROMPT-28)
  { path: "/stages/{id}/challenges", method: "post", summary: "Ladder challenge: creates the fixture on demand; result reorders the ladder (Pro `formats.advanced`)", tag: "stages", request: S.LadderChallenge, status: 201, errors: [402, 422] },
  { path: "/stages/{id}/fixtures", method: "post", summary: "Ad-hoc single fixture (replay / friendly / tie-breaker) on a league, group or swiss stage; the match folds into the standings. Bracket kinds 422.", tag: "stages", request: S.AddFixture, status: 201, errors: [422] },
  { path: "/stages/{id}/americano", method: "get", summary: "Americano rotation grid + personal-points leaderboard (Jul3/08 §3)", tag: "stages", errors: [422] },
];

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

function toSchema(schema: ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

function envelope(data?: ZodType): Record<string, unknown> {
  return {
    type: "object",
    required: ["ok", "data", "requestId"],
    properties: {
      ok: { const: true },
      data: data ? toSchema(data) : {},
      requestId: { type: "string", format: "uuid" },
    },
  };
}

const ERROR_ENVELOPE = {
  type: "object",
  required: ["ok", "error", "requestId"],
  properties: {
    ok: { const: false },
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        current_seq: { type: "integer", description: "On SEQ_CONFLICT (409): the ledger tip to resync from" },
      },
      additionalProperties: true,
    },
    requestId: { type: "string", format: "uuid" },
  },
} as const;

function pathParams(path: string): object[] {
  const params = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  return params.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: name.endsWith("Slug") || name === "slug" || name === "sport"
      ? { type: "string" }
      : { type: "string", format: "uuid" },
  }));
}

// ---------------------------------------------------------------------------
// Examples — deterministic sample values derived from the JSON schema so
// every operation ships with at least one example (v3/08 §3) without
// hand-maintaining ~100 of them.
// ---------------------------------------------------------------------------

function exampleOf(schema: unknown, depth = 0): unknown {
  if (depth > 6 || typeof schema !== "object" || schema === null) return null;
  const s = schema as Record<string, unknown>;
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  if (Array.isArray(s.examples) && s.examples.length > 0) return s.examples[0];
  const first = (k: "anyOf" | "oneOf" | "allOf") =>
    Array.isArray(s[k]) && (s[k] as unknown[]).length > 0 ? (s[k] as unknown[])[0] : null;
  const union = first("anyOf") ?? first("oneOf") ?? first("allOf");
  if (union) return exampleOf(union, depth + 1);
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = new Set((s.required as string[]) ?? []);
      for (const [name, prop] of Object.entries(props)) {
        // Keep examples focused: required fields plus the first few optionals.
        if (required.has(name) || Object.keys(out).length < 4) {
          out[name] = exampleOf(prop, depth + 1);
        }
      }
      return out;
    }
    case "array":
      return [exampleOf(s.items, depth + 1)];
    case "string":
      if (s.format === "uuid") return "3f1a2b04-8c1d-4e5f-9a6b-7c8d9e0f1a2b";
      if (s.format === "date") return "2026-08-01";
      if (s.format === "date-time") return "2026-08-01T09:00:00Z";
      return "example";
    case "integer":
    case "number":
      return typeof s.minimum === "number" ? s.minimum : 1;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return null;
  }
}

/** The key scope this operation needs, from the SAME allowlist the auth
 *  wrapper enforces (key-scopes.ts) — spec and door cannot disagree. */
function requiredScope(route: RouteSpec): string | null {
  if (route.public) return null;
  const concrete = route.path.replace(/\{[^}]+\}/g, "seg");
  return matchKeyRoute(route.method.toUpperCase(), `/api/v1${concrete}`)?.scope ?? null;
}

function operation(route: RouteSpec): Record<string, unknown> {
  const scope = requiredScope(route);
  const responses: Record<string, unknown> = {
    [String(route.status ?? 200)]: {
      description: "Success",
      content: { "application/json": { schema: envelope(route.response) } },
    },
    "400": { description: "Validation error", content: { "application/json": { schema: ERROR_ENVELOPE } } },
  };
  if (!route.public) {
    responses["401"] = { description: "Not authenticated", content: { "application/json": { schema: ERROR_ENVELOPE } } };
  }
  responses["404"] = { description: "Not found", content: { "application/json": { schema: ERROR_ENVELOPE } } };
  for (const status of route.errors ?? []) {
    responses[String(status)] = {
      description: { 402: "Plan upgrade required", 409: "Conflict", 422: "Rejected by the engine", 429: "Rate limited" }[status] ?? "Error",
      content: { "application/json": { schema: ERROR_ENVELOPE } },
    };
  }
  // Response example: success envelope around a data sample.
  const success = responses[String(route.status ?? 200)] as {
    content?: { "application/json": { schema: unknown; example?: unknown } };
  };
  if (success?.content) {
    success.content["application/json"].example = {
      ok: true,
      data: route.response ? exampleOf(toSchema(route.response)) : {},
      requestId: "3f1a2b04-8c1d-4e5f-9a6b-7c8d9e0f1a2b",
    };
  }
  return {
    summary: route.summary,
    tags: [route.tag],
    // x-required-scope (v3/08 §3): which API-key scope unlocks this
    // operation; "none" = session-only, never key-accessible.
    ...(route.public ? {} : { "x-required-scope": scope ?? "none" }),
    parameters: [
      ...pathParams(route.path),
      ...Object.entries(route.query ?? {}).map(([name, q]) => ({
        name,
        in: "query",
        required: false,
        schema: q.schema,
        ...(q.description ? { description: q.description } : {}),
      })),
    ],
    ...(route.request
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: toSchema(route.request),
                example: exampleOf(toSchema(route.request)),
              },
            },
          },
        }
      : {}),
    responses,
    security: route.public ? [] : [{ sessionCookie: [] }, { apiKey: [] }],
  };
}

export function buildOpenApiDocument(
  opts: { published?: boolean } = {},
): Record<string, unknown> {
  // Published spec (v3/08 §3): exactly the key-scoped surface plus the
  // public read API — session-only/internal operations stay out of it.
  const routes = opts.published
    ? ROUTES.filter((r) => r.public || requiredScope(r) !== null)
    : ROUTES;
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const full = `/api/v1${route.path}`;
    paths[full] = paths[full] ?? {};
    paths[full][route.method] = operation(route);
  }
  const usedTags = new Set(routes.map((r) => r.tag));
  const tags = [
    { name: "competitions" }, { name: "divisions" }, { name: "entrants" },
    { name: "persons" }, { name: "stages" }, { name: "fixtures" },
    { name: "scoring" }, { name: "scheduling" }, { name: "scorers" },
    { name: "device-links" }, { name: "api-keys" }, { name: "registration" },
    { name: "clubs" }, { name: "officials" }, { name: "sponsors" }, { name: "history" },
    { name: "exports" }, { name: "stats" }, { name: "public" },
  ].filter((t) => usedTags.has(t.name));
  return {
    openapi: "3.1.0",
    info: {
      title: "seazn.club platform API",
      version: "1.0.0",
      description:
        "Versioned REST API (design doc engine/08). Every response is " +
        "`{ ok, data | error, requestId }`. Additive changes land in place; " +
        "breaking changes move to /api/v2 with Sunset headers on deprecation." +
        (opts.published
          ? "\n\nAuthenticate with an API key (`Authorization: Bearer sc_…`, " +
            "created in org settings — Pro). Keys carry a scope — `read`, " +
            "`score` or `manage`; each operation lists its requirement as " +
            "`x-required-scope`. Keys are rate-limited per minute (60 rpm, " +
            "300 rpm on Pro) with `X-RateLimit-*` headers on every response. " +
            "The `public` tag needs no key at all."
          : ""),
    },
    servers: [{ url: "https://seazn.club" }],
    tags,
    components: {
      securitySchemes: {
        sessionCookie: { type: "apiKey", in: "cookie", name: "seazn_session" },
        apiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "Pro API key: `Authorization: Bearer sc_…` (entitlement api.access). " +
            "Scopes: read < score < manage; see x-required-scope per operation.",
        },
        deviceLink: {
          type: "http",
          scheme: "bearer",
          description:
            "Day-of device link (doc 13 §7): `Authorization: Bearer dl_…` — " +
            "accepted ONLY by its fixture's scoring surface (append events, " +
            "void own events pre-finalize, read state/events, realtime " +
            "token). Expired/revoked → 401 LINK_EXPIRED / LINK_REVOKED.",
        },
      },
    },
    paths,
  };
}
