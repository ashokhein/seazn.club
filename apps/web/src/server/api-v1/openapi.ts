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
  { path: "/divisions/{id}", method: "patch", summary: "Update a division", tag: "divisions", request: S.PatchDivision, response: S.Division },
  // Entrants
  { path: "/divisions/{id}/entrants", method: "get", summary: "List entrants", tag: "entrants", response: z.array(S.Entrant) },
  { path: "/divisions/{id}/entrants", method: "post", summary: "Register entrant(s) — object or bulk array", tag: "entrants", request: S.CreateEntrants, response: z.union([S.Entrant, z.array(S.Entrant)]), status: 201, errors: [422] },
  { path: "/entrants/{id}", method: "get", summary: "Get an entrant with members", tag: "entrants", response: S.Entrant },
  { path: "/entrants/{id}", method: "patch", summary: "Withdraw, seed or edit members", tag: "entrants", request: S.PatchEntrant, response: S.Entrant, errors: [422] },
  // Persons
  { path: "/persons", method: "get", summary: "List persons", tag: "persons", response: pageOf(S.Person), query: PAGE_QUERY },
  { path: "/persons", method: "post", summary: "Create a person", tag: "persons", request: S.CreatePerson, response: S.Person, status: 201 },
  { path: "/persons/{id}", method: "get", summary: "Get a person", tag: "persons", response: S.Person },
  { path: "/persons/{id}", method: "patch", summary: "Update a person", tag: "persons", request: S.PatchPerson, response: S.Person },
  { path: "/persons/{id}/merge", method: "post", summary: "Merge a duplicate person into this one", tag: "persons", request: S.MergePersons, response: S.Person, errors: [422] },
  { path: "/persons/{id}/profiles/{sport}", method: "get", summary: "Get a per-sport profile", tag: "persons" },
  { path: "/persons/{id}/profiles/{sport}", method: "put", summary: "Upsert a per-sport profile", tag: "persons", request: S.PutProfile, errors: [422] },
  // Stages
  { path: "/divisions/{id}/stages", method: "get", summary: "List stages", tag: "stages", response: z.array(S.Stage) },
  { path: "/divisions/{id}/stages", method: "post", summary: "Define the stage graph", tag: "stages", request: S.CreateStages, response: z.union([S.Stage, z.array(S.Stage)]), status: 201, errors: [409] },
  { path: "/stages/{id}/generate", method: "post", summary: "Generate fixtures (idempotent, returns diff)", tag: "stages", response: S.GenerateResult, errors: [422] },
  { path: "/stages/{id}/complete", method: "post", summary: "Guarded stage completion / progression", tag: "stages", response: S.CompleteResult, errors: [422] },
  { path: "/stages/{id}/standings", method: "get", summary: "Standings snapshot", tag: "stages", query: { pool_id: { schema: { type: "string", format: "uuid" } } } },
  // Fixtures & scoring
  { path: "/fixtures/{id}", method: "get", summary: "Get a fixture", tag: "fixtures", response: S.Fixture },
  { path: "/fixtures/{id}", method: "patch", summary: "Schedule, venue, officials", tag: "fixtures", request: S.PatchFixture, response: S.Fixture },
  { path: "/fixtures/{id}/lineups/{entrantId}", method: "get", summary: "Get a side's lineup", tag: "fixtures" },
  { path: "/fixtures/{id}/lineups/{entrantId}", method: "put", summary: "Replace a side's lineup", tag: "fixtures", request: S.PutLineup, errors: [422] },
  { path: "/fixtures/{id}/events", method: "post", summary: "Append a score event (THE scoring endpoint)", tag: "scoring", request: S.AppendEventRequest, response: S.AppendEventResponse, status: 201, errors: [409, 422, 429] },
  { path: "/fixtures/{id}/events", method: "get", summary: "Read the ledger after ?since_seq=", tag: "scoring", response: z.array(S.ScoreEvent), query: { since_seq: { schema: { type: "integer", minimum: 0, default: 0 } } } },
  { path: "/fixtures/{id}/state", method: "get", summary: "Live state (ETag = ledger seq)", tag: "scoring", response: S.FixtureState },
  { path: "/fixtures/{id}/finalize", method: "post", summary: "Lock the ledger (core.finalize)", tag: "scoring", request: z.object({ expected_seq: z.number().int().min(0) }), response: S.AppendEventResponse, errors: [409, 422] },
  // API keys
  { path: "/orgs/{id}/api-keys", method: "get", summary: "List API keys", tag: "api-keys", response: z.array(S.ApiKey) },
  { path: "/orgs/{id}/api-keys", method: "post", summary: "Create an API key (secret shown once)", tag: "api-keys", request: S.CreateApiKey, response: S.CreatedApiKey, status: 201, errors: [402] },
  { path: "/orgs/{id}/api-keys/{keyId}", method: "delete", summary: "Revoke an API key", tag: "api-keys", response: S.ApiKey },
  // Public (no auth, cacheable, consent-filtered)
  { path: "/public/orgs/{orgSlug}/competitions/{slug}", method: "get", summary: "Public competition: description + divisions", tag: "public", public: true },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/divisions/{divisionSlug}/schedule", method: "get", summary: "Public schedule", tag: "public", public: true },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/divisions/{divisionSlug}/standings", method: "get", summary: "Public standings", tag: "public", public: true },
  { path: "/public/orgs/{orgSlug}/competitions/{slug}/divisions/{divisionSlug}/entrants", method: "get", summary: "Public entrants (consent-filtered)", tag: "public", public: true },
  { path: "/public/fixtures/{id}", method: "get", summary: "Public live fixture summary", tag: "public", public: true },
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

function operation(route: RouteSpec): Record<string, unknown> {
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
  return {
    summary: route.summary,
    tags: [route.tag],
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
            content: { "application/json": { schema: toSchema(route.request) } },
          },
        }
      : {}),
    responses,
    security: route.public ? [] : [{ sessionCookie: [] }, { apiKey: [] }],
  };
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const full = `/api/v1${route.path}`;
    paths[full] = paths[full] ?? {};
    paths[full][route.method] = operation(route);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "seazn.club platform API",
      version: "1.0.0",
      description:
        "Versioned REST API (design doc engine/08). Every response is " +
        "`{ ok, data | error, requestId }`. Additive changes land in place; " +
        "breaking changes move to /api/v2 with Sunset headers on deprecation.",
    },
    servers: [{ url: "https://seazn.club" }],
    tags: [
      { name: "competitions" }, { name: "divisions" }, { name: "entrants" },
      { name: "persons" }, { name: "stages" }, { name: "fixtures" },
      { name: "scoring" }, { name: "api-keys" }, { name: "public" },
    ],
    components: {
      securitySchemes: {
        sessionCookie: { type: "apiKey", in: "cookie", name: "safe_session" },
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "Pro API key: `Authorization: Bearer sk_live_…` (entitlement api.access)",
        },
      },
    },
    paths,
  };
}
