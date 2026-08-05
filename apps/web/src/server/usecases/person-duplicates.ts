import "server-only";
// #404 §6 — the duplicate queue. Ranked candidate PAIRS with the evidence that
// put them there; `person-merge.ts` performs the merge the organiser confirms.
//
// Ranking is a suggestion, merging is destructive, so the two live apart: this
// file may be re-tuned freely, and nothing here may ever write.
//
// Computed live on every read, deliberately NOT materialised. An org holds
// hundreds of people, so the self-join is cheap; a stale queue's failure mode
// is proposing a merge against facts that have since changed, and a wrong merge
// is the expensive thing (#404 exists because one already happened).
import { withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { PersonRow } from "./persons";

/** Why a pair was suggested. `detail` is org DATA — a name, a date, an entrant
 *  name — never a sentence, so the panel can phrase it in the viewer's locale. */
export type Evidence =
  | { kind: "name"; detail: string }
  | { kind: "dob"; detail: string }
  | { kind: "shared_entrant"; detail: string };

export interface Candidate {
  /** The older row — the default survivor the panel shows on the left. */
  a: PersonRow;
  b: PersonRow;
  score: number;
  evidence: Evidence[];
}

/** A shared normalised name is the entry ticket; the rest raises the rank. */
const SCORE_NAME = 1;
const SCORE_DOB = 2;
const SCORE_SHARED_ENTRANT = 1;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface CandidateRow {
  a: PersonRow;
  b: PersonRow;
  name_key: string;
  dob_match: boolean;
  dob_key: string | null;
  shared_entrant: string | null;
  score: number;
}

/**
 * Ranked duplicate candidates for the org, most likely first.
 *
 * Four rules SUPPRESS a pair outright rather than down-ranking it, because each
 * one describes a merge that must not happen:
 *
 *  - **differing non-null `dob`** — the strongest evidence in the data that
 *    these are two humans who share a name (§6). An organiser who knows better
 *    can still merge by hand with `allowDobMismatch`; the queue never suggests it.
 *  - **different lanes** (V348) — an official row and a player row for one human
 *    are legitimately separate identities; merging them destroys officiating
 *    history.
 *  - **tombstones on either side** — already absorbed, and `merged_into` is
 *    checked in the CTE so it holds for `a` and `b` alike.
 *  - **two different non-null `user_id`s** — the merge refuses this with a 422,
 *    so suggesting it is a dead end the organiser cannot clear.
 */
export async function listDuplicateCandidates(
  auth: AuthCtx,
  opts: { limit?: number },
): Promise<{ items: Candidate[] }> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const rows = await withTenant(auth.orgId, async (tx) => {
    // The name key must fold exactly as `personKeyResolver` does
    // (schedule-ai.ts:152 — trim().toLowerCase().replace(/\s+/g," ")), or the
    // queue and the scheduling identity guard disagree on what "same name"
    // means. `[[:space:]]` rather than `\s` so no backslash has to survive a JS
    // template literal on its way into SQL. Blank names fold to '' and are
    // dropped: they all match each other, and bucketing them would offer to
    // fuse every unnamed person in the org into one human.
    return tx<CandidateRow[]>`
      with live as (
        select id, full_name, dob, gender, consent, external_ref, photo_path,
               user_id, created_at, lane,
               lower(btrim(regexp_replace(full_name, '[[:space:]]+', ' ', 'g'))) as name_key
          from persons
         where merged_into is null
      )
      select to_jsonb(a) - 'name_key' - 'lane' as a,
             to_jsonb(b) - 'name_key' - 'lane' as b,
             a.name_key,
             (a.dob is not null and a.dob = b.dob) as dob_match,
             to_char(a.dob, 'YYYY-MM-DD') as dob_key,
             shared.display_name as shared_entrant,
             (${SCORE_NAME}
              + case when a.dob is not null and a.dob = b.dob then ${SCORE_DOB} else 0 end
              + case when shared.display_name is not null then ${SCORE_SHARED_ENTRANT} else 0 end
             ) as score
        from live a
        join live b
          on b.name_key = a.name_key
         and b.lane = a.lane
         -- Orders the pair (the older row is always a) AND emits it once, not twice.
         and (a.created_at, a.id) < (b.created_at, b.id)
        left join lateral (
          select en.display_name
            from entrant_members ma
            join entrant_members mb on mb.entrant_id = ma.entrant_id and mb.person_id = b.id
            join entrants en on en.id = ma.entrant_id
           where ma.person_id = a.id
           order by en.display_name, en.id
           limit 1
        ) shared on true
       where a.name_key <> ''
         and not (a.dob is not null and b.dob is not null and a.dob <> b.dob)
         and not (a.user_id is not null and b.user_id is not null and a.user_id <> b.user_id)
       -- Fully ordered: the panel shows a and b side by side, and an orientation
       -- or rank that moved between reads would move the survivor under the
       -- organiser's cursor between seeing the pair and confirming it.
       order by score desc, a.created_at, a.id, b.id
       limit ${limit}`;
  });

  return {
    items: rows.map((row) => {
      const evidence: Evidence[] = [{ kind: "name", detail: row.name_key }];
      if (row.dob_match && row.dob_key) evidence.push({ kind: "dob", detail: row.dob_key });
      if (row.shared_entrant) {
        evidence.push({ kind: "shared_entrant", detail: row.shared_entrant });
      }
      return { a: row.a, b: row.b, score: row.score, evidence };
    }),
  };
}
