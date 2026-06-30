// Helpers for the application-level session ledger
// (`user_sessions` table). Used by the sign-in flow, the heartbeat
// route, and the admin sessions API.
//
// Geo is best-effort via the free ipapi.co endpoint — we don't block
// the login if it fails; the row just lacks city/country.

import { createServiceRoleClient } from "@/lib/supabase/server";

const SESSION_COOKIE = "qht_session_id";

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

export interface IpGeoLookup {
  city: string | null;
  region: string | null;
  country: string | null;
}

/** Look up a public IP → city/country. Free tier, no key. Returns
 *  all-nulls on any error or for private/loopback IPs. */
export async function lookupIpGeo(ip: string | null): Promise<IpGeoLookup> {
  if (!ip) return { city: null, region: null, country: null };
  // Skip private ranges — ipapi just returns errors and burns the
  // free quota.
  const trimmed = ip.trim();
  if (
    !trimmed ||
    trimmed === "unknown" ||
    trimmed === "127.0.0.1" ||
    trimmed === "::1" ||
    trimmed.startsWith("10.") ||
    trimmed.startsWith("192.168.") ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(trimmed)
  ) {
    return { city: null, region: null, country: null };
  }
  try {
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(trimmed)}/json/`, {
      signal: AbortSignal.timeout(3_000),
      headers: { "User-Agent": "qht-dashboard/1.0" },
    });
    if (!res.ok) return { city: null, region: null, country: null };
    const j = (await res.json()) as {
      city?: string;
      region?: string;
      country_code?: string;
      error?: boolean;
    };
    if (j.error) return { city: null, region: null, country: null };
    return {
      city: j.city ?? null,
      region: j.region ?? null,
      country: j.country_code ?? null,
    };
  } catch {
    return { city: null, region: null, country: null };
  }
}

interface CreateSessionInput {
  userId: string;
  memberId?: string | null;
  ip: string | null;
  userAgent: string | null;
}

/** Record a fresh session row + return its id (caller stores in a
 *  cookie so heartbeat updates can find it). Geo lookup is fire-and-
 *  forget — the row inserts immediately with nulls, then gets
 *  enriched after the geo call resolves. */
export async function createSession(input: CreateSessionInput): Promise<string | null> {
  try {
    const admin = createServiceRoleClient();
    const { data, error } = await admin
      .from("user_sessions")
      .insert({
        user_id: input.userId,
        member_id: input.memberId ?? null,
        ip: input.ip,
        user_agent: input.userAgent,
      })
      .select("id")
      .single();
    if (error || !data) return null;
    const id = data.id as string;
    // Enrich geo in the background — must NOT await; the login path
    // is user-facing.
    void (async () => {
      const geo = await lookupIpGeo(input.ip);
      if (geo.city || geo.country) {
        await admin
          .from("user_sessions")
          .update({
            city: geo.city,
            region: geo.region,
            country: geo.country,
          })
          .eq("id", id);
      }
    })();
    return id;
  } catch {
    return null;
  }
}

/** Refresh last_seen_at on an existing session. Called from the
 *  heartbeat route, so this runs every ~30s per active tab. */
export async function pingSession(sessionId: string): Promise<void> {
  try {
    const admin = createServiceRoleClient();
    await admin
      .from("user_sessions")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", sessionId)
      .is("revoked_at", null);
  } catch {
    /* silent */
  }
}

/** Mark a specific session revoked. */
export async function revokeSession(
  sessionId: string,
  reason: string,
): Promise<void> {
  try {
    const admin = createServiceRoleClient();
    await admin
      .from("user_sessions")
      .update({
        revoked_at: new Date().toISOString(),
        revoked_reason: reason,
      })
      .eq("id", sessionId);
  } catch {
    /* silent */
  }
}

/** Revoke EVERY active session for a user. Used by the "logout from
 *  all devices" button. Caller is also expected to call
 *  supabase.auth.admin.signOut(userId) so the Supabase refresh-tokens
 *  themselves are invalidated. */
export async function revokeAllSessionsForUser(
  userId: string,
  reason: string,
): Promise<number> {
  try {
    const admin = createServiceRoleClient();
    const { count } = await admin
      .from("user_sessions")
      .update(
        {
          revoked_at: new Date().toISOString(),
          revoked_reason: reason,
        },
        { count: "exact" },
      )
      .eq("user_id", userId)
      .is("revoked_at", null);
    return count ?? 0;
  } catch {
    return 0;
  }
}
