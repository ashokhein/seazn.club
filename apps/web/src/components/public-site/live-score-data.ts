// Fetch layer for the public live scoreboard, split out so the payload
// unwrapping is unit-testable (lib/client.ts's api() already returns the
// endpoint's `data` — unwrapping it twice was a live bug: every 15 s poll
// replaced the score with `undefined`).
import { api } from "@/lib/client";

export interface LiveFixtureData {
  status: string;
  summary: {
    headline?: string;
    perSide?: { entrantId: string; line: string }[];
    detail?: unknown;
  } | null;
  outcome: { kind?: string; winner?: string } | null;
}

export interface PublicRealtimeToken {
  token: string;
  channel: string;
}

export async function fetchLiveFixture(fixtureId: string): Promise<LiveFixtureData> {
  return api<LiveFixtureData>(`/api/v1/public/fixtures/${fixtureId}`);
}

export async function fetchPublicRealtimeToken(
  fixtureId: string,
): Promise<PublicRealtimeToken> {
  return api<PublicRealtimeToken>(`/api/v1/public/fixtures/${fixtureId}/realtime-token`);
}
