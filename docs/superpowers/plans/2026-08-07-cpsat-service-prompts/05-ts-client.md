# Prompt 05: TS-side codegen + client wrapper

**Context**: `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`,
section "Contract" (TS side: `ts-proto` + `@grpc/grpc-js`) and "Internal
communication — auth & transport" (deadline = `wall_seconds` + margin,
no automatic retries on timeout — a solve is seconds of CPU, not a cheap
idempotent GET).

**Acceptance criteria**: `solveBuild()` attaches the shared secret as
gRPC metadata on every call, and a call that exceeds its deadline
rejects with a clear error rather than hanging.

**Do not touch**: `packages/engine/src/scheduling/build.ts` — this
prompt only builds the client; wiring it into `solveBuild` is Prompt 06.

**Files:**
- Create: `packages/engine/scripts/gen-proto.ts`, `packages/engine/src/scheduling/cpsat-client.ts`
- Modify: `packages/engine/package.json` (add `ts-proto`, `@grpc/grpc-js` deps + `gen:proto` script)
- Test: `packages/engine/src/scheduling/cpsat-client.test.ts`

**Interfaces:**
- Consumes: `proto/scheduler.proto` (Prompt 01).
- Produces: `solveBuild(input: SolveBuildInput, opts: { host: string; secret: string; wallSeconds: number }): Promise<SolveBuildOutcome>` — Prompt 06 (`build.ts`'s `solveBuild` function) calls this exact function.

- [ ] **Step 1: Install codegen deps and write the generation script**

Run: `cd packages/engine && npm install --save @grpc/grpc-js && npm install --save-dev ts-proto grpc-tools`

```typescript
// packages/engine/scripts/gen-proto.ts
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const outDir = path.join(root, "packages/engine/src/scheduling/generated");
execSync(
  `npx protoc --plugin=protoc-gen-ts_proto=${root}/node_modules/.bin/protoc-gen-ts_proto ` +
    `--ts_proto_out=${outDir} --ts_proto_opt=outputServices=grpc-js,esModuleInterop=true ` +
    `-I ${root}/proto ${root}/proto/scheduler.proto`,
  { stdio: "inherit" },
);
console.log(`Generated TS proto stubs in ${outDir}`);
```

Add to `packages/engine/package.json` scripts: `"gen:proto": "node --experimental-strip-types scripts/gen-proto.ts"`.

Run: `cd packages/engine && npm run gen:proto`
Expected: `packages/engine/src/scheduling/generated/scheduler.ts` is created (mechanically generated — do not hand-edit it).

- [ ] **Step 2: Write the failing test for the client wrapper**

```typescript
// packages/engine/src/scheduling/cpsat-client.test.ts
import { describe, expect, it, vi } from "vitest";
import { solveBuild } from "./cpsat-client.ts";

describe("solveBuild", () => {
  it("attaches the shared secret as call metadata", async () => {
    const mockClient = { solveBuild: vi.fn((req, meta, cb) => cb(null, { assignments: [], status: 1, tiersCompleted: 0, objectiveValues: [], elapsedMs: 0, wallExhausted: false })) };
    const result = await solveBuild(
      { courts: ["Court 1"], fixtures: [], grid: { slots: [], stepMinutes: 10 }, existing: [], dependencies: [], constraints: { matchMinutes: 30, gapMinutes: 10 }, wallSeconds: 8 },
      { secret: "s3cr3t", wallSeconds: 8, client: mockClient as never },
    );
    expect(mockClient.solveBuild).toHaveBeenCalled();
    const [, metadata] = mockClient.solveBuild.mock.calls[0]!;
    expect(metadata.get("x-internal-secret")).toEqual(["s3cr3t"]);
    expect(result.status).toBe("FEASIBLE");
  });

  it("rejects the call when it exceeds the deadline margin", async () => {
    const mockClient = { solveBuild: vi.fn((_req, _meta, cb) => { /* never calls back */ }) };
    await expect(
      solveBuild(
        { courts: [], fixtures: [], grid: { slots: [], stepMinutes: 10 }, existing: [], dependencies: [], constraints: { matchMinutes: 30, gapMinutes: 10 }, wallSeconds: 0.05 },
        { secret: "s3cr3t", wallSeconds: 0.05, client: mockClient as never },
      ),
    ).rejects.toThrow(/deadline/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/engine && npx vitest run src/scheduling/cpsat-client.test.ts`
Expected: FAIL — `cpsat-client.ts` doesn't exist.

- [ ] **Step 4: Write `cpsat-client.ts`**

```typescript
// packages/engine/src/scheduling/cpsat-client.ts
import * as grpc from "@grpc/grpc-js";
import { SchedulerServiceClient } from "./generated/scheduler.ts";

export interface SolveBuildInput {
  courts: string[];
  fixtures: { fixtureId: string; entrantIds: string[]; divisionId: string }[];
  grid: { slots: { court: string; startAtMs: number }[]; stepMinutes: number };
  existing: { fixtureId: string; court: string; startAtMs: number }[];
  dependencies: { beforeFixtureId: string; afterFixtureId: string }[];
  constraints: { matchMinutes: number; gapMinutes: number; restByDivision?: Record<string, number>; dayCapByDivision?: Record<string, number> };
  wallSeconds: number;
}

export interface SolveBuildOutcome {
  assignments: { fixtureId: string; court: string; startAtMs: number }[];
  status: "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "UNKNOWN" | "ERROR";
  tiersCompleted: number;
  objectiveValues: { name: string; valueMs: number }[];
  elapsedMs: number;
  wallExhausted: boolean;
  error?: { code: string; message: string };
}

const STATUS_NAMES = ["UNSPECIFIED", "OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN", "ERROR"] as const;

let cachedClient: SchedulerServiceClient | undefined;

function clientFor(host: string): SchedulerServiceClient {
  cachedClient ??= new SchedulerServiceClient(host, grpc.credentials.createInsecure());
  return cachedClient;
}

export async function solveBuild(
  input: SolveBuildInput,
  opts: { host?: string; secret: string; wallSeconds: number; client?: Pick<SchedulerServiceClient, "solveBuild"> },
): Promise<SolveBuildOutcome> {
  const client = opts.client ?? clientFor(opts.host ?? process.env.CPSAT_SERVICE_HOST ?? "cp-sat.internal:50051");
  const metadata = new grpc.Metadata();
  metadata.set("x-internal-secret", opts.secret);
  const deadline = new Date(Date.now() + (opts.wallSeconds + 2) * 1000);

  return new Promise((resolve, reject) => {
    client.solveBuild(
      input as never,
      metadata,
      { deadline },
      (err: grpc.ServiceError | null, res: never) => {
        if (err) {
          reject(err.code === grpc.status.DEADLINE_EXCEEDED ? new Error(`cp-sat solveBuild exceeded deadline: ${err.message}`) : err);
          return;
        }
        const r = res as { status: number; assignments: unknown; tiersCompleted: number; objectiveValues: unknown; elapsedMs: number; wallExhausted: boolean; error?: { code: string; message: string } };
        resolve({
          assignments: r.assignments as SolveBuildOutcome["assignments"],
          status: STATUS_NAMES[r.status] as SolveBuildOutcome["status"],
          tiersCompleted: r.tiersCompleted,
          objectiveValues: r.objectiveValues as SolveBuildOutcome["objectiveValues"],
          elapsedMs: r.elapsedMs,
          wallExhausted: r.wallExhausted,
          error: r.error,
        });
      },
    );
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/engine && npx vitest run src/scheduling/cpsat-client.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/scripts/gen-proto.ts packages/engine/src/scheduling/cpsat-client.ts packages/engine/src/scheduling/cpsat-client.test.ts packages/engine/package.json packages/engine/src/scheduling/generated
git commit -m "feat(engine): add generated proto stubs and cp-sat gRPC client wrapper"
```

`generated/scheduler.ts` is mechanically produced — commit it (CI shouldn't need `protoc` installed just to typecheck); regenerate via `npm run gen:proto` whenever `proto/scheduler.proto` changes.

**Verify**: `cd packages/engine && npx vitest run src/scheduling/cpsat-client.test.ts` → 2 passed, 0 failed.

**Output cap**: final message under 15 lines — pass count, confirm generated file exists and is committed, note any ts-proto option deviation.
