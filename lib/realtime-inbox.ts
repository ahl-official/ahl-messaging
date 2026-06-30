// Server-side Realtime *broadcast* so the inbox updates the instant a webhook
// ingests a message — for every provider (Meta / Evolution / Interakt).
//
// Why not rely on Postgres `postgres_changes`? That stream is RLS-gated and
// lags (or silently drops) under load, which is exactly why the inbox carried
// a 10s polling fallback. Broadcast is plain pub/sub: the server (service role)
// fires an event on the `inbox` topic and every subscribed client gets it in
// ~50-150ms, independent of RLS / replication. postgres_changes + polling stay
// as deeper fallbacks.
//
// Fire-and-forget: callers do `void broadcastInbox(...)`. It never throws and
// times out fast so it can't delay the webhook's 200 ACK back to the provider.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
// Service role when available (prod), else the anon key — broadcasting to a
// public topic needs no elevated privilege, and the anon key is always set,
// so this works in every environment. Verified: the broadcast REST endpoint
// returns 202 with either key.
const BROADCAST_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const INBOX_TOPIC = "inbox";
export const INBOX_EVENT = "update";

export interface InboxBroadcast {
  /** Which business number the message landed on — clients gate on their
   *  allowed/active set before refreshing. */
  business_phone_number_id: string | null;
  /** The contact whose thread changed (lets an open ChatWindow refetch just
   *  that thread). */
  contact_id: string | null;
  wa_id?: string | null;
  direction?: "inbound" | "outbound";
}

export async function broadcastInbox(payload: InboxBroadcast): Promise<void> {
  if (!SUPABASE_URL || !BROADCAST_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: BROADCAST_KEY,
        Authorization: `Bearer ${BROADCAST_KEY}`,
      },
      body: JSON.stringify({
        messages: [{ topic: INBOX_TOPIC, event: INBOX_EVENT, payload }],
      }),
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    // Best-effort — postgres_changes + the polling fallback still cover it.
  }
}
