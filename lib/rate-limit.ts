// In-memory sliding-window rate limiter. Used by middleware.ts to throttle
// per-IP request floods. State lives in the Node process — single-server
// (self-hosted VPS) deployments only. If we ever move to a multi-instance
// setup, swap the Map for Redis/Supabase-backed counters.
//
// Sliding window = ring of timestamps per key, oldest pruned on every check.
// More accurate than fixed-window counters at burst boundaries, cheap enough
// for the request volumes we see (a few req/sec per user).

type Bucket = {
  hits: number[]; // unix-ms timestamps of recent hits
};

const buckets = new Map<string, Bucket>();

// Periodic janitor — drops idle buckets so the Map doesn't grow unbounded
// from one-off IPs. Runs every 5 minutes. setInterval keeps the Node event
// loop alive, so guard with .unref() in case this ever ships to serverless.
if (typeof setInterval !== "undefined") {
  const timer = setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000; // anything older than 10 min
    for (const [key, b] of buckets) {
      const recent = b.hits.filter((t) => t > cutoff);
      if (recent.length === 0) buckets.delete(key);
      else b.hits = recent;
    }
  }, 5 * 60_000);
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetMs: number; // ms until the oldest hit falls out of the window
};

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const cutoff = now - windowMs;
  let b = buckets.get(key);
  if (!b) {
    b = { hits: [] };
    buckets.set(key, b);
  }
  // Drop expired hits in-place.
  while (b.hits.length > 0 && b.hits[0] <= cutoff) b.hits.shift();

  if (b.hits.length >= limit) {
    const resetMs = b.hits[0] + windowMs - now;
    return { allowed: false, remaining: 0, resetMs: Math.max(resetMs, 0) };
  }
  b.hits.push(now);
  return { allowed: true, remaining: limit - b.hits.length, resetMs: windowMs };
}
