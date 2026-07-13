// Unit tests for the analytics identity lifecycle (task-8 review fix,
// Critical finding): identify must start working after an IN-TAB login
// (magic-link.tsx soft-navigates — router.push + refresh, no reload) and must
// stop immediately after an IN-TAB logout (logout-button.tsx soft-navigates
// too). The old analytics-bootstrap effect ran once per hard load with a
// never-invalidated sessionStorage cache, so it missed both transitions.
// Mocked fetch + in-memory storage stub — no jsdom, no network, no DB.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY_CACHE_KEY,
  clearAnalyticsIdentity,
  hasIdentifiedThisTab,
  markIdentifiedThisTab,
  resolveIdentity,
  type AnalyticsIdentity,
} from "@/lib/analytics-identity";

type StorageStub = Pick<Storage, "getItem" | "setItem" | "removeItem"> & {
  dump(): Record<string, string>;
};

function memoryStorage(): StorageStub {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

const IDENTITY: AnalyticsIdentity = {
  userId: "u1",
  orgId: "o1",
  orgName: "Riverside",
  plan: "pro",
};

const ok200 = () =>
  new Response(
    JSON.stringify({
      ok: true,
      data: { id: "u1", org: { id: "o1", name: "Riverside", plan: "pro" } },
    }),
    { status: 200 },
  );
const noOrg200 = () =>
  new Response(JSON.stringify({ ok: true, data: { id: "u1", org: null } }), { status: 200 });
const anon401 = () =>
  new Response(JSON.stringify({ ok: false, error: "Not authenticated" }), { status: 401 });

beforeEach(() => {
  // Reset the module-level identified-this-tab flag between tests.
  clearAnalyticsIdentity({ storage: memoryStorage() });
});

describe("resolveIdentity", () => {
  it("login transition: anonymous 401 resolves null WITHOUT caching, then the same tab identifies on the next resolve once the session exists", async () => {
    const storage = memoryStorage();
    // First navigation: no session yet — the magic link hasn't been consumed.
    const fetchFn = vi.fn(async () => anon401());
    expect(await resolveIdentity({ fetchFn, storage })).toBeNull();
    expect(storage.dump()).toEqual({}); // anonymous result must never be cached
    // The user logs in (session cookie now set); the post-login redirect is a
    // navigation, which triggers the next resolve — it must retry the fetch.
    fetchFn.mockImplementation(async () => ok200());
    expect(await resolveIdentity({ fetchFn, storage })).toEqual(IDENTITY);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(storage.dump()[IDENTITY_CACHE_KEY]!)).toEqual(IDENTITY);
  });

  it("logout transition: clearAnalyticsIdentity drops the cache so the next resolve refetches and comes back anonymous", async () => {
    const storage = memoryStorage();
    const fetchFn = vi.fn(async () => ok200());
    expect(await resolveIdentity({ fetchFn, storage })).toEqual(IDENTITY);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    clearAnalyticsIdentity({ storage });
    expect(storage.dump()).toEqual({});

    // Session cookie destroyed by POST /api/auth/logout — the endpoint 401s.
    fetchFn.mockImplementation(async () => anon401());
    expect(await resolveIdentity({ fetchFn, storage })).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2); // refetch happened (no stale cache hit)
    expect(storage.dump()).toEqual({});
  });

  it("cache hit returns the identified payload without fetching", async () => {
    const storage = memoryStorage();
    storage.setItem(IDENTITY_CACHE_KEY, JSON.stringify(IDENTITY));
    const fetchFn = vi.fn(async () => ok200());
    expect(await resolveIdentity({ fetchFn, storage })).toEqual(IDENTITY);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("200 with no active org resolves null and is not cached (retries next navigation)", async () => {
    const storage = memoryStorage();
    const fetchFn = vi.fn(async () => noOrg200());
    expect(await resolveIdentity({ fetchFn, storage })).toBeNull();
    expect(storage.dump()).toEqual({});
    expect(await resolveIdentity({ fetchFn, storage })).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2); // no anonymous sentinel blocked the retry
  });

  it("network error resolves null, caches nothing, and the next resolve retries", async () => {
    const storage = memoryStorage();
    const fetchFn = vi
      .fn(async () => ok200())
      .mockRejectedValueOnce(new Error("offline"));
    expect(await resolveIdentity({ fetchFn, storage })).toBeNull();
    expect(storage.dump()).toEqual({});
    expect(await resolveIdentity({ fetchFn, storage })).toEqual(IDENTITY);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("malformed cached JSON is dropped and resolution falls through to a fetch", async () => {
    const storage = memoryStorage();
    storage.setItem(IDENTITY_CACHE_KEY, "{not json");
    const fetchFn = vi.fn(async () => ok200());
    expect(await resolveIdentity({ fetchFn, storage })).toEqual(IDENTITY);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.dump()[IDENTITY_CACHE_KEY]!)).toEqual(IDENTITY);
  });

  it("a resolution in flight when clearAnalyticsIdentity runs is discarded, not cached (logout race)", async () => {
    const storage = memoryStorage();
    let release!: (res: Response) => void;
    const gate = new Promise<Response>((r) => (release = r));
    const fetchFn = vi.fn(() => gate);
    const inFlight = resolveIdentity({ fetchFn, storage });
    // User clicks logout while the identity fetch is still in flight.
    clearAnalyticsIdentity({ storage });
    release(ok200()); // the request raced the logout and still 200'd
    expect(await inFlight).toBeNull();
    expect(storage.dump()).toEqual({}); // stale identity must NOT be re-cached
  });
});

describe("identified-this-tab flag", () => {
  it("clearAnalyticsIdentity resets the flag so a post-logout login re-identifies in the same tab", () => {
    expect(hasIdentifiedThisTab()).toBe(false);
    markIdentifiedThisTab();
    expect(hasIdentifiedThisTab()).toBe(true);
    clearAnalyticsIdentity({ storage: memoryStorage() });
    expect(hasIdentifiedThisTab()).toBe(false);
  });
});
