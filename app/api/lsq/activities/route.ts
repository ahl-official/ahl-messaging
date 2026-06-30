// GET /api/lsq/activities?prospect_id=<lsq-lead-uuid>
//
// Returns the LSQ activity timeline for a single lead. Used by the
// contact-details panel + inline chat thread to render activities.
//
// Scaling notes:
//   ─ In-memory cache with a 30s TTL keyed by prospect_id. The client
//     polls at the same cadence, so when 100+ agents are viewing the
//     same hot lead, LSQ sees one fetch per 30s — not one per agent.
//   ─ Concurrent-fetch dedup. If a fetch is already in flight for a
//     prospect_id, additional callers await the same promise instead
//     of starting their own. Important during cache-miss + thundering-
//     herd scenarios (e.g. fresh deploy + every open tab refetches).
//   ─ The cache lives in module scope on a single Node process. On
//     Vercel each function instance has its own cache, so the dedup
//     effect scales per-instance. For tighter coalescing across
//     instances move this to Redis / Upstash. Until then, in-memory
//     is fine for one or two long-running Node servers.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { getLsqConfig, lsqGetLeadActivities, type LsqActivityView } from "@/lib/lsq";

export const runtime = "nodejs";

interface CachedResult {
  ok: boolean;
  activities: LsqActivityView[];
  error: string | null;
}

interface CacheEntry {
  data: CachedResult;
  fetchedAt: number;
}

const CACHE_TTL_MS = 30_000;
// Hard cap so a long-running process doesn't accumulate stale entries
// for prospects nobody opens anymore. We sweep on every miss; cheap.
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CachedResult>>();

function sweepStale() {
  const cutoff = Date.now() - CACHE_MAX_AGE_MS;
  for (const [k, v] of cache) {
    if (v.fetchedAt < cutoff) cache.delete(k);
  }
}

async function fetchOnce(prospectId: string, limit: number): Promise<CachedResult> {
  // If a concurrent caller is already fetching this prospect, hop on
  // its promise — no duplicate LSQ hit.
  const existing = inFlight.get(prospectId);
  if (existing) return existing;

  const promise = (async () => {
    const result = await lsqGetLeadActivities(prospectId, limit);
    const data: CachedResult = {
      ok: result.ok,
      activities: result.activities,
      error: result.error,
    };
    cache.set(prospectId, { data, fetchedAt: Date.now() });
    inFlight.delete(prospectId);
    return data;
  })();
  inFlight.set(prospectId, promise);
  return promise;
}

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const prospectId = request.nextUrl.searchParams.get("prospect_id")?.trim();
  if (!prospectId) {
    return NextResponse.json({ error: "prospect_id is required" }, { status: 400 });
  }

  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return NextResponse.json({ configured: false, activities: [] });
  }

  const limit = Math.min(
    100,
    Math.max(10, Number(request.nextUrl.searchParams.get("limit") ?? "50") || 50),
  );
  // `force=1` lets the UI bypass the cache (refresh button).
  const force = request.nextUrl.searchParams.get("force") === "1";

  if (!force) {
    const cached = cache.get(prospectId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return NextResponse.json(
        {
          configured: true,
          ok: cached.data.ok,
          activities: cached.data.activities,
          error: cached.data.error,
          cached: true,
          cache_age_ms: Date.now() - cached.fetchedAt,
        },
        // Tell the browser it can hold onto the body for the rest of
        // the TTL — turns intra-tab navigation into a free hit.
        {
          headers: {
            "Cache-Control": `private, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`,
          },
        },
      );
    }
  }

  sweepStale();
  const data = await fetchOnce(prospectId, limit);
  return NextResponse.json({
    configured: true,
    ok: data.ok,
    activities: data.activities,
    error: data.error,
    cached: false,
  });
}
