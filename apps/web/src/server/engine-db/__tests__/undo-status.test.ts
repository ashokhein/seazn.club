// Undo/status coherence — v3/09 §1+§2 (PROMPT-38). The cricket "undo last made
// scoring disappear" regression (intake #29) was fixtures.status drifting from
// the fold after a void: status said in_play while the fold was back in the
// pre phase, so the console rendered neither a Start button nor a pad. These
// tests pin status to the void-resolved ledger at the persistence layer, the
// 409 nothing-to-undo contract at the usecase layer, and the badminton
// headline (intake #28a) at the state read the header renders from.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { badminton } from "@seazn/engine/sports/setbased";
import { cricket } from "@seazn/engine/sports/cricket";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { appendEvent } from "../append-event";
import { getFixtureState } from "@/server/usecases/fixtures";
import { scoreEvent } from "@/server/usecases/scoring";
import type { AuthCtx } from "@/server/api-v1/auth";

const HAS_DB = !!process.env.DATABASE_URL;

interface Seed {
  orgId: string;
  fixtureId: string;
  home: string;
  away: string;
  auth: AuthCtx;
}

// Fresh org → competition → ACTIVE division (scoring open) → fixture.
async function seed(sportKey: string, config: unknown): Promise<Seed> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id
  `;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values (${sportKey}, ${sportKey}, '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing
  `;
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Comp " + suffix}, ${"comp-" + suffix}, 'private')
    returning id
  `;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version, status)
    values (${competitionId}, 'Div', ${"div-" + suffix}, ${sportKey}, 'default',
            ${sql.json(config as never)}, '1.0.0', 'active')
    returning id
  `;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name) values (${divisionId}, 1, 'league', 'League')
    returning id
  `;
  const [{ id: home }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed) values (${divisionId}, 'individual', 'Home', 1)
    returning id
  `;
  const [{ id: away }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed) values (${divisionId}, 'individual', 'Away', 2)
    returning id
  `;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
    values (${stageId}, ${divisionId}, 1, 1, ${home}, ${away})
    returning id
  `;
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  return { orgId, fixtureId, home, away, auth };
}

async function fixtureStatus(fixtureId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`
    select status from fixtures where id = ${fixtureId}
  `;
  return row.status;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const CRICKET_CFG = cricket.configSchema.parse({ ballsPerInnings: 30 });
const BADMINTON_CFG = badminton.configSchema.parse({});

describe.skipIf(!HAS_DB)("undo keeps fixtures.status coherent with the fold (v3/09 §2)", () => {
  it("undoing core.start returns the fixture to scheduled (was: stuck in_play)", async () => {
    const s = await seed("cricket", CRICKET_CFG);
    const toss = await appendEvent(s.orgId, s.fixtureId, 0, {
      type: "cricket.toss",
      payload: { wonBy: s.home, elected: "bat" },
    });
    const start = await appendEvent(s.orgId, s.fixtureId, toss.seq, {
      type: "core.start",
      payload: {},
    });
    expect(start.status).toBe("in_play");

    const undone = await appendEvent(s.orgId, s.fixtureId, start.seq, {
      type: "core.void",
      payload: {},
      voids: start.event.id,
    });
    // The fold is back in the pre phase — the status must follow, or the
    // console shows neither a Start button nor a scoring pad (blank panel).
    expect(undone.status).toBe("scheduled");
    expect(await fixtureStatus(s.fixtureId)).toBe("scheduled");

    // …and scoring can CONTINUE: re-start and record an over.
    const restart = await appendEvent(s.orgId, s.fixtureId, undone.seq, {
      type: "core.start",
      payload: {},
    });
    expect(restart.status).toBe("in_play");
    const over = await appendEvent(s.orgId, s.fixtureId, restart.seq, {
      type: "cricket.innings.summary",
      payload: { runs: 8, wickets: 0, legalBalls: 6, partial: true },
    });
    expect(over.summary).toBeTruthy();
    expect(over.status).toBe("in_play");
  });

  it("undoing mid-innings keeps the panel state renderable and scoring continues", async () => {
    const s = await seed("cricket", CRICKET_CFG);
    let seq = 0;
    const send = async (type: string, payload: unknown, voids?: string) => {
      const r = await appendEvent(s.orgId, s.fixtureId, seq, {
        type,
        payload,
        ...(voids ? { voids } : {}),
      });
      seq = r.seq;
      return r;
    };
    await send("cricket.toss", { wonBy: s.away, elected: "bowl" });
    await send("core.start", {});
    await send("cricket.innings.summary", { runs: 10, wickets: 1, legalBalls: 6, partial: true });
    const over2 = await send("cricket.innings.summary", {
      runs: 22,
      wickets: 1,
      legalBalls: 12,
      partial: true,
    });

    // Undo the last over (the intake #29 repro action).
    const undone = await send("core.void", {}, over2.event.id);
    expect(undone.status).toBe("in_play");
    expect(undone.summary).toBeTruthy();
    const state = await getFixtureState(s.auth, s.fixtureId);
    expect(state.summary).toBeTruthy();
    expect(state.status).toBe("in_play");

    // Continue scoring: the corrected over goes straight back in.
    const corrected = await send("cricket.innings.summary", {
      runs: 18,
      wickets: 2,
      legalBalls: 12,
      partial: true,
    });
    expect(corrected.status).toBe("in_play");
  });

  it("undoing a forfeit reopens the fixture (was: stuck forfeited)", async () => {
    const s = await seed("badminton", BADMINTON_CFG);
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    const forfeit = await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "core.forfeit",
      payload: { by: s.away, reason: "walkover" },
    });
    expect(forfeit.status).toBe("forfeited");

    const undone = await appendEvent(s.orgId, s.fixtureId, forfeit.seq, {
      type: "core.void",
      payload: {},
      voids: forfeit.event.id,
    });
    expect(undone.status).toBe("in_play");
    expect(undone.outcome).toBeNull();
  });

  it("undoing the deciding game drops a decided fixture back to in_play", async () => {
    const s = await seed("badminton", BADMINTON_CFG);
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "badminton.game.summary",
      payload: { home: 21, away: 15 },
    });
    const decider = await appendEvent(s.orgId, s.fixtureId, 2, {
      type: "badminton.game.summary",
      payload: { home: 21, away: 18 },
    });
    expect(decider.status).toBe("decided");

    const undone = await appendEvent(s.orgId, s.fixtureId, decider.seq, {
      type: "core.void",
      payload: {},
      voids: decider.event.id,
    });
    expect(undone.status).toBe("in_play");
    expect(undone.outcome).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("nothing to undo is a 409, never a crash (v3/09 §2)", () => {
  const expect409 = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      expect.unreachable("expected a 409 HttpError");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(409);
    }
  };

  it("void with no event_id, an unknown id, and a double-undo all answer 409", async () => {
    const s = await seed("badminton", BADMINTON_CFG);
    // Empty ledger, no target at all.
    await expect409(() =>
      scoreEvent(s.auth, s.fixtureId, { expected_seq: 0, type: "core.void", payload: {} }),
    );
    // Unknown target id.
    await expect409(() =>
      scoreEvent(s.auth, s.fixtureId, {
        expected_seq: 0,
        type: "core.void",
        payload: { event_id: randomUUID() },
      }),
    );

    const start = await scoreEvent(s.auth, s.fixtureId, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    });
    const game = await scoreEvent(s.auth, s.fixtureId, {
      expected_seq: start.seq,
      type: "badminton.game.summary",
      payload: { home: 21, away: 12 },
    });
    const [gameEvent] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${s.fixtureId} and seq = ${game.seq}
    `;
    const undo = await scoreEvent(s.auth, s.fixtureId, {
      expected_seq: game.seq,
      type: "core.void",
      payload: { event_id: gameEvent.id },
    });
    expect(undo.status).toBe("in_play");

    // Undoing the same entry twice: the second attempt is a calm 409.
    await expect409(() =>
      scoreEvent(s.auth, s.fixtureId, {
        expected_seq: undo.seq,
        type: "core.void",
        payload: { event_id: gameEvent.id },
      }),
    );
  });
});

describe.skipIf(!HAS_DB)("badminton entered game score reaches the header state (intake #28a)", () => {
  it("game.summary 21-15 shows in the summary the header renders from", async () => {
    const s = await seed("badminton", BADMINTON_CFG);
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "badminton.game.summary",
      payload: { home: 21, away: 15 },
    });
    const state = await getFixtureState(s.auth, s.fixtureId);
    const headline = (state.summary as { headline?: string } | null)?.headline ?? "";
    expect(headline).toContain("1 — 0");
    expect(headline).toContain("21–15");
  });
});
