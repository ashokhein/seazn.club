// Analytics identity lifecycle (task-8 review fix, Critical finding).
// Client-safe module — no server imports, no posthog dependency — so it can be
// unit-tested with a mocked fetch + in-memory storage and imported from any
// client component (analytics-bootstrap resolves, logout-button clears).
//
// Semantics (the review-approved design):
//  - sessionStorage caches ONLY an identified payload — never an anonymous
//    sentinel. A cache hit returns without fetching.
//  - A miss fetches GET /api/users/me. 200-with-org → cache + return.
//    401 / no-org / network error → null WITHOUT caching, so the next
//    navigation retries. That retry is what restores identify-after-login:
//    the post-login redirect (magic-link.tsx router.push) is itself a
//    navigation, and the effect in analytics-bootstrap is keyed on pathname.
//  - clearAnalyticsIdentity (called by logout-button BEFORE its router.push)
//    drops the cache, resets the identified-this-tab flag, and invalidates any
//    resolution still in flight so a request that raced the logout can't
//    re-cache the stale identity.

export interface AnalyticsIdentity {
  userId: string;
  orgId: string;
  orgName: string;
  plan: string;
}

/** sessionStorage key holding the identified payload for this tab. */
export const IDENTITY_CACHE_KEY = "seazn_analytics_identity";

type IdentityStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface ResolveIdentityDeps {
  fetchFn?: typeof fetch;
  storage?: IdentityStorage;
}

interface MeResponse {
  data: {
    id: string;
    org: { id: string; name: string; plan: string } | null;
  };
}

// Bumped by clearAnalyticsIdentity: a resolution that started under an older
// generation discards its result instead of caching it (logout race guard).
let generation = 0;

// "Identified already this tab" — set by analytics-bootstrap after a
// successful identify so the pathname-keyed effect stops doing work; reset by
// clearAnalyticsIdentity so a post-logout login in the SAME tab re-identifies.
let identifiedThisTab = false;

export function hasIdentifiedThisTab(): boolean {
  return identifiedThisTab;
}

export function markIdentifiedThisTab(): void {
  identifiedThisTab = true;
}

function defaultStorage(): IdentityStorage | null {
  try {
    // Guarded: absent during SSR/tests; access can throw in some privacy modes.
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Resolve the identify payload for the current session, or null for an
 * anonymous visitor. Total: never throws (analytics must never break the app).
 */
export async function resolveIdentity(
  deps: ResolveIdentityDeps = {},
): Promise<AnalyticsIdentity | null> {
  const storage = deps.storage ?? defaultStorage();

  if (storage) {
    try {
      const cached = storage.getItem(IDENTITY_CACHE_KEY);
      if (cached) return JSON.parse(cached) as AnalyticsIdentity;
    } catch {
      // Malformed entry — drop it and fall through to a fresh fetch.
      try {
        storage.removeItem(IDENTITY_CACHE_KEY);
      } catch {
        /* storage gone mid-flight — nothing to clean */
      }
    }
  }

  const startedGeneration = generation;
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const res = await fetchFn("/api/users/me");
    if (!res.ok) return null; // 401 anonymous — never cached
    const body = (await res.json()) as MeResponse;
    if (!body?.data?.org) return null; // logged in but org-less — never cached
    const identity: AnalyticsIdentity = {
      userId: body.data.id,
      orgId: body.data.org.id,
      orgName: body.data.org.name,
      plan: body.data.org.plan,
    };
    // A logout landed while this request was in flight — discard, don't cache.
    if (startedGeneration !== generation) return null;
    try {
      storage?.setItem(IDENTITY_CACHE_KEY, JSON.stringify(identity));
    } catch {
      /* quota/privacy-mode write failure — identify still proceeds uncached */
    }
    return identity;
  } catch {
    return null; // network error — never cached; next navigation retries
  }
}

/**
 * Kill the cached identity NOW (logout). Callers pair this with
 * posthog.reset() so the device's distinct id rotates too.
 */
export function clearAnalyticsIdentity(deps: { storage?: IdentityStorage } = {}): void {
  generation += 1;
  identifiedThisTab = false;
  const storage = deps.storage ?? defaultStorage();
  try {
    storage?.removeItem(IDENTITY_CACHE_KEY);
  } catch {
    /* storage unavailable — nothing cached to clear */
  }
}
