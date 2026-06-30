// Server-side aggregations powering the /home dashboard.
//
// One round-trip to Supabase per logical concern (contacts, business numbers,
// recent inbound messages) — fine for a single-clinic team inbox at thousands-
// of-rows scale. When traffic grows, swap each computation for a Postgres
// view / function with proper indexing.

import { createServerClient } from "@/lib/supabase/server";
import { WHATSAPP_WINDOW_HOURS } from "@/lib/whatsapp-window";

export interface PerNumberStat {
  business_phone_number_id: string;
  verified_name: string | null;
  display_phone_number: string | null;
  totalCount: number;
  openCount: number;
  unreadConversations: number;
  unreadMessages: number;
}

export interface TagStat {
  tag: string;
  totalCount: number;
  unreadCount: number;
}

export interface ActivityRow {
  contact_id: string;
  wa_id: string;
  display_name: string;
  preview: string | null;
  timestamp: string;
  business_phone_number_id: string | null;
}

export interface HomeStats {
  openCount: number;
  closedCount: number;
  totalConversations: number;
  unreadConversations: number;
  unreadMessages: number;
  windowsExpiringSoon: number;   // < 6h left in 24h window
  windowsClosed: number;         // > 24h since last inbound
  unassignedOpen: number;
  perNumber: PerNumberStat[];
  topTags: TagStat[];
  recentActivity: ActivityRow[];
}

interface ContactRow {
  id: string;
  wa_id: string;
  name: string | null;
  profile_name: string | null;
  status: "open" | "closed" | null;
  unread_count: number | null;
  tags: string[] | null;
  business_phone_number_id: string | null;
  assigned_to: string | null;
  last_message_at: string | null;
}

interface BusinessNumberRow {
  phone_number_id: string;
  verified_name: string | null;
  display_phone_number: string | null;
}

interface MessageRow {
  contact_id: string;
  content: string | null;
  timestamp: string;
  business_phone_number_id: string | null;
  direction: "inbound" | "outbound";
}

const WARN_HOURS = 6;

/** Workspace-wide stats by default, OR scoped to a specific set of
 *  business numbers when `allowedBpids` is non-null. The home page
 *  passes the caller's `allowed_number_ids` so a teammate limited to
 *  one number sees ONLY that number's open/unread/window/perNumber/
 *  recent-activity counts — never the workspace totals. */
// In-memory cache for the heavy /home aggregation. The page walks all
// 39k+ contacts + every inbound message in the last 48h, which on
// production took 6-10 s end to end. Stats are analytics, not
// transactional state — 60 s of staleness is fine. Keyed by the
// caller's allowed-bpid set so per-user scope is preserved.
const HOME_STATS_CACHE_TTL_MS = 60_000;
const homeStatsCache = new Map<string, { value: HomeStats; expiresAt: number }>();

function cacheKey(allowedBpids: string[] | null): string {
  if (allowedBpids === null) return "ALL";
  return [...allowedBpids].sort().join(",");
}

const EMPTY_STATS: HomeStats = {
  openCount: 0,
  closedCount: 0,
  totalConversations: 0,
  unreadConversations: 0,
  unreadMessages: 0,
  windowsExpiringSoon: 0,
  windowsClosed: 0,
  unassignedOpen: 0,
  perNumber: [],
  topTags: [],
  recentActivity: [],
};

export async function getHomeStats(
  allowedBpids: string[] | null = null,
): Promise<HomeStats> {
  // Cache hit — return instantly. Expired or missing entries fall
  // through and recompute below.
  const key = cacheKey(allowedBpids);
  const cached = homeStatsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const supabase = await createServerClient();

  // Fast path: a single Postgres aggregation via the get_home_stats
  // RPC (migration 0068). Runs in <500 ms on production volumes vs
  // the old paginated-walk approach which took 6-10 s. Falls through
  // to the legacy TS aggregation only if the RPC isn't installed yet
  // (operator hasn't run migration 0068).
  try {
    const { data, error } = await supabase.rpc("get_home_stats", {
      bpid_filter: allowedBpids,
    });
    if (!error && data) {
      const parsed: HomeStats = {
        ...EMPTY_STATS,
        ...(data as Partial<HomeStats>),
      };
      homeStatsCache.set(key, {
        value: parsed,
        expiresAt: Date.now() + HOME_STATS_CACHE_TTL_MS,
      });
      if (homeStatsCache.size > 50) {
        const oldest = homeStatsCache.keys().next().value;
        if (oldest) homeStatsCache.delete(oldest);
      }
      return parsed;
    }
    if (error) {
      console.warn(
        "[home-stats] get_home_stats RPC failed, falling back to TS aggregation:",
        error.message,
      );
    }
  } catch (e) {
    console.warn(
      "[home-stats] get_home_stats RPC threw, falling back:",
      e instanceof Error ? e.message : e,
    );
  }

  // Empty allow-list = explicit deny. Skip all queries and return zero
  // counters so the dashboard doesn't reveal anything.
  if (allowedBpids !== null && allowedBpids.length === 0) {
    return {
      openCount: 0,
      closedCount: 0,
      totalConversations: 0,
      unreadConversations: 0,
      unreadMessages: 0,
      windowsExpiringSoon: 0,
      windowsClosed: 0,
      unassignedOpen: 0,
      perNumber: [],
      topTags: [],
      recentActivity: [],
    };
  }

  // Window expiry calcs only care about inbound messages from the last
  // 48 hours — the 24h customer-care window can't possibly be open on
  // anything older, and "closed" counts come from contacts that simply
  // never have a row in the recent set. Capping the lookup here turns
  // an unbounded scan over the entire `messages` table into a small
  // indexed range read, which is what was making /home spin for 10+
  // seconds on dashboards with high message volume.
  const inboundCutoffIso = new Date(
    Date.now() - 48 * 60 * 60 * 1000,
  ).toISOString();

  // PostgREST caps a single response at ~1000 rows, so a plain
  // .limit(N) silently truncates the workspace and every counter pegs
  // at 1000. Walk pages until exhausted so the totals are real.
  async function fetchAllPages<T>(
    build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>,
    cap = 60_000,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; from < cap; from += 1000) {
      const { data } = await build(from, from + 999);
      const rows = data ?? [];
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  }

  const contactsP = fetchAllPages<ContactRow>((from, to) => {
    let q = supabase
      .from("contacts")
      .select(
        "id, wa_id, name, profile_name, status, unread_count, tags, business_phone_number_id, assigned_to, last_message_at",
      )
      .order("last_message_at", { ascending: false })
      .range(from, to);
    if (allowedBpids !== null) q = q.in("business_phone_number_id", allowedBpids);
    return q as unknown as PromiseLike<{ data: ContactRow[] | null }>;
  });

  const inboundP = fetchAllPages<Pick<MessageRow, "contact_id" | "timestamp">>(
    (from, to) => {
      let q = supabase
        .from("messages")
        .select("contact_id, timestamp")
        .eq("direction", "inbound")
        .gte("timestamp", inboundCutoffIso)
        .order("timestamp", { ascending: false })
        .range(from, to);
      if (allowedBpids !== null)
        q = q.in("business_phone_number_id", allowedBpids);
      return q as unknown as PromiseLike<{
        data: Pick<MessageRow, "contact_id" | "timestamp">[] | null;
      }>;
    },
  );

  let numbersQ = supabase
    .from("business_numbers")
    .select("phone_number_id, verified_name, display_phone_number");
  let recentMsgQ = supabase
    .from("messages")
    .select("contact_id, content, timestamp, business_phone_number_id, direction")
    .eq("direction", "inbound")
    .order("timestamp", { ascending: false })
    .limit(8);
  if (allowedBpids !== null) {
    numbersQ = numbersQ.in("phone_number_id", allowedBpids);
    recentMsgQ = recentMsgQ.in("business_phone_number_id", allowedBpids);
  }

  const [contacts, numbersRes, recentMsgRes, inboundForWindow] =
    await Promise.all([contactsP, numbersQ, recentMsgQ, inboundP]);

  const numbers = (numbersRes.data ?? []) as BusinessNumberRow[];
  const recentMessages = (recentMsgRes.data ?? []) as MessageRow[];

  const numberMap = new Map(numbers.map((n) => [n.phone_number_id, n]));

  // ---------- Top-line counters ----------
  let openCount = 0;
  let closedCount = 0;
  let unreadConversations = 0;
  let unreadMessages = 0;
  let unassignedOpen = 0;
  for (const c of contacts) {
    const isClosed = c.status === "closed";
    if (isClosed) closedCount++;
    else openCount++;
    const u = c.unread_count ?? 0;
    if (u > 0) unreadConversations++;
    unreadMessages += u;
    if (!isClosed && !c.assigned_to) unassignedOpen++;
  }

  // ---------- 24h window expiry counts ----------
  // Build latest-inbound per contact from the ordered inbound list.
  const latestInboundByContact = new Map<string, Date>();
  for (const m of inboundForWindow) {
    if (!latestInboundByContact.has(m.contact_id)) {
      latestInboundByContact.set(m.contact_id, new Date(m.timestamp));
    }
  }
  const now = Date.now();
  const windowMs = WHATSAPP_WINDOW_HOURS * 60 * 60 * 1000;
  const warnMs = WARN_HOURS * 60 * 60 * 1000;
  let windowsExpiringSoon = 0;
  let windowsClosed = 0;
  for (const c of contacts) {
    if (c.status === "closed") continue;
    const lastIn = latestInboundByContact.get(c.id);
    if (!lastIn) continue; // never opened — agent-initiated, not stale
    const elapsed = now - lastIn.getTime();
    if (elapsed > windowMs) windowsClosed++;
    else if (windowMs - elapsed < warnMs) windowsExpiringSoon++;
  }

  // ---------- Per-number breakdown ----------
  const perNumberMap = new Map<string, PerNumberStat>();
  for (const c of contacts) {
    const id = c.business_phone_number_id;
    if (!id) continue;
    if (!perNumberMap.has(id)) {
      const meta = numberMap.get(id);
      perNumberMap.set(id, {
        business_phone_number_id: id,
        verified_name: meta?.verified_name ?? null,
        display_phone_number: meta?.display_phone_number ?? null,
        totalCount: 0,
        openCount: 0,
        unreadConversations: 0,
        unreadMessages: 0,
      });
    }
    const stat = perNumberMap.get(id)!;
    stat.totalCount++;
    if (c.status !== "closed") stat.openCount++;
    const u = c.unread_count ?? 0;
    if (u > 0) stat.unreadConversations++;
    stat.unreadMessages += u;
  }
  const perNumber = Array.from(perNumberMap.values()).sort(
    (a, b) => b.unreadMessages - a.unreadMessages || b.openCount - a.openCount,
  );

  // ---------- Top tags ----------
  const tagMap = new Map<string, { totalCount: number; unreadCount: number }>();
  for (const c of contacts) {
    const tags = c.tags ?? [];
    const u = c.unread_count ?? 0;
    for (const tag of tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, { totalCount: 0, unreadCount: 0 });
      const stat = tagMap.get(tag)!;
      stat.totalCount++;
      if (u > 0) stat.unreadCount++;
    }
  }
  const topTags = Array.from(tagMap.entries())
    .map(([tag, s]) => ({ tag, ...s }))
    .sort((a, b) => b.unreadCount - a.unreadCount || b.totalCount - a.totalCount)
    .slice(0, 8);

  // ---------- Recent activity ----------
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const recentActivity: ActivityRow[] = recentMessages.map((m) => {
    const c = contactById.get(m.contact_id);
    const display =
      c?.name?.trim() ||
      c?.profile_name?.trim() ||
      (c?.wa_id ? `+${c.wa_id}` : "Unknown");
    return {
      contact_id: m.contact_id,
      wa_id: c?.wa_id ?? "",
      display_name: display,
      preview: m.content,
      timestamp: m.timestamp,
      business_phone_number_id: m.business_phone_number_id,
    };
  });

  const result: HomeStats = {
    openCount,
    closedCount,
    totalConversations: contacts.length,
    unreadConversations,
    unreadMessages,
    windowsExpiringSoon,
    windowsClosed,
    unassignedOpen,
    perNumber,
    topTags,
    recentActivity,
  };
  homeStatsCache.set(key, {
    value: result,
    expiresAt: Date.now() + HOME_STATS_CACHE_TTL_MS,
  });
  // Cap unbounded growth on multi-tenant installs — drop the oldest
  // entry when we cross 50 distinct allowed-bpid scopes.
  if (homeStatsCache.size > 50) {
    const oldest = homeStatsCache.keys().next().value;
    if (oldest) homeStatsCache.delete(oldest);
  }
  return result;
}
