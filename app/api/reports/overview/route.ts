// GET /api/reports/overview?since_hours=168&bpid=optional
//
// One-shot fetch for the Analytics dashboard on /reports. Returns
// everything the page needs in a single round-trip:
//
//   - kpis                  → top-of-page numbers
//   - daily                 → per-day inbound/outbound (line chart)
//   - per_number            → totals grouped by business number
//   - agent_leaderboard     → top operators by outbound volume
//   - top_tags              → most-used contact tags
//   - peak_hours            → 24-bucket histogram of inbound timestamps
//   - response_time         → median minutes to first outbound per bpid
//
// All queries respect the caller's allowed_number_ids — admins +
// teammates only see numbers they can already open in the inbox.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";
import { getEffectivePermissionsFor } from "@/lib/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface DailyBucket {
  date: string; // YYYY-MM-DD (UTC)
  inbound: number;
  outbound: number;
}

interface NumberRow {
  phone_number_id: string;
  label: string;
  inbound: number;
  outbound: number;
  contacts: number;
}

interface AgentRow {
  agent: string;
  email: string | null;
  outbound: number;
}

interface TagRow {
  tag: string;
  count: number;
}

interface ResponseTimeRow {
  bpid: string;
  label: string;
  median_minutes: number;
  samples: number;
}

interface OverviewResponse {
  range: {
    since_hours: number;
    since_iso: string;
    until_iso: string;
  };
  scope: { bpid_filter: string | null; allowed_bpids: string[] | "all" };
  kpis: {
    inbound: number;
    outbound: number;
    magic_messages: number;
    new_contacts: number;
    unread_now: number;
    open_chats: number;
    avg_response_minutes: number | null;
  };
  daily: DailyBucket[];
  per_number: NumberRow[];
  agent_leaderboard: AgentRow[];
  top_tags: TagRow[];
  peak_hours: Array<{ hour: number; count: number }>;
  response_time: ResponseTimeRow[];
}

export async function GET(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admin or above" }, { status: 403 });
  }

  const url = new URL(request.url);
  const hours = Math.min(
    24 * 365,
    Math.max(1, Number(url.searchParams.get("since_hours") ?? 24 * 7)),
  );
  const bpidFilter = url.searchParams.get("bpid")?.trim() || null;

  const perms = await getEffectivePermissionsFor(me);
  const allowedBpids = perms.allowed_number_ids;
  // If the caller filtered to a single number, intersect that with
  // their permission set so a teammate can't pull stats for a number
  // they shouldn't see by hand-typing the bpid into the URL.
  if (bpidFilter && allowedBpids !== null && !allowedBpids.includes(bpidFilter)) {
    return NextResponse.json({ error: "Not allowed for this number" }, {
      status: 403,
    });
  }
  const scopeBpids: string[] | null = bpidFilter
    ? [bpidFilter]
    : allowedBpids;

  const since = new Date(Date.now() - hours * 3_600_000);
  const sinceIso = since.toISOString();
  const untilIso = new Date().toISOString();

  const admin = createServiceRoleClient();

  // ---- helpers ----
  function applyScope<T extends { in: (col: string, v: string[]) => T }>(q: T): T {
    if (scopeBpids !== null) return q.in("business_phone_number_id", scopeBpids);
    return q;
  }

  // ---- 1. KPIs ----
  // Inbound + outbound counts (head + count exact, no row download).
  let inQ = admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("direction", "inbound")
    .gte("timestamp", sinceIso);
  let outQ = admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("direction", "outbound")
    .gte("timestamp", sinceIso);
  let newContactsQ = admin
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .gte("created_at", sinceIso);
  let unreadQ = admin
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .gt("unread_count", 0);
  let openQ = admin
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");
  // Magic messages = the outbound utility template that punches through the
  // 24h window (type='template', template_name='magic_message').
  let magicQ = admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("direction", "outbound")
    .eq("type", "template")
    .eq("template_name", "magic_message")
    .gte("timestamp", sinceIso);

  if (scopeBpids !== null) {
    inQ = inQ.in("business_phone_number_id", scopeBpids);
    outQ = outQ.in("business_phone_number_id", scopeBpids);
    newContactsQ = newContactsQ.in("business_phone_number_id", scopeBpids);
    unreadQ = unreadQ.in("business_phone_number_id", scopeBpids);
    openQ = openQ.in("business_phone_number_id", scopeBpids);
    magicQ = magicQ.in("business_phone_number_id", scopeBpids);
  }

  // ---- 2. Daily volume + 5. Peak hours come from one big pull.
  //      We pull (timestamp, direction) for every message in window.
  //      50k cap is enough for ~2 weeks of busy traffic; the user can
  //      narrow the range if they hit it.
  let dailyQ = admin
    .from("messages")
    .select("timestamp, direction")
    .gte("timestamp", sinceIso)
    .order("timestamp", { ascending: true })
    .limit(50_000);
  if (scopeBpids !== null) {
    dailyQ = dailyQ.in("business_phone_number_id", scopeBpids);
  }

  // ---- 3. Per-number breakdown ----
  let numbersQ = admin
    .from("business_numbers")
    .select(
      "phone_number_id, display_phone_number, verified_name, nickname",
    );

  // ---- 4. Agent leaderboard (top 10 outbound senders) ----
  let leaderboardQ = admin
    .from("messages")
    .select("sent_by_user_id")
    .eq("direction", "outbound")
    .gte("timestamp", sinceIso)
    .limit(20_000);
  if (scopeBpids !== null) {
    leaderboardQ = leaderboardQ.in("business_phone_number_id", scopeBpids);
  }

  // ---- 6. Top tags (operator-applied free-text tags on contacts) ----
  let tagsQ = admin
    .from("contacts")
    .select("tags")
    .order("last_message_at", { ascending: false })
    .limit(2000);
  if (scopeBpids !== null) tagsQ = tagsQ.in("business_phone_number_id", scopeBpids);

  // ---- 7. Response time samples — one outbound after each inbound,
  //         per contact. Walk in chronological order. We pull (bpid,
  //         contact_id, direction, timestamp); the daily pull already
  //         has direction + timestamp but is missing the two we need.
  let rtQ = admin
    .from("messages")
    .select("contact_id, direction, timestamp, business_phone_number_id")
    .gte("timestamp", sinceIso)
    .order("timestamp", { ascending: true })
    .limit(40_000);
  if (scopeBpids !== null) rtQ = rtQ.in("business_phone_number_id", scopeBpids);

  // Fire everything in parallel — minimal critical path.
  const [
    inRes,
    outRes,
    newContactsRes,
    unreadRes,
    openRes,
    magicRes,
    dailyRes,
    numbersRes,
    leaderboardRes,
    tagsRes,
    rtRes,
  ] = await Promise.all([
    inQ,
    outQ,
    newContactsQ,
    unreadQ,
    openQ,
    magicQ,
    dailyQ,
    numbersQ,
    leaderboardQ,
    tagsQ,
    rtQ,
  ]);

  // ---- Process daily + peak hours ----
  const dailyByDate = new Map<string, DailyBucket>();
  const hourly = new Array<number>(24).fill(0);
  for (const m of (dailyRes.data ?? []) as Array<{
    timestamp: string;
    direction: string;
  }>) {
    const d = new Date(m.timestamp);
    if (!Number.isFinite(d.getTime())) continue;
    const date = d.toISOString().slice(0, 10);
    let bucket = dailyByDate.get(date);
    if (!bucket) {
      bucket = { date, inbound: 0, outbound: 0 };
      dailyByDate.set(date, bucket);
    }
    if (m.direction === "inbound") {
      bucket.inbound += 1;
      hourly[d.getUTCHours()] += 1;
    } else if (m.direction === "outbound") {
      bucket.outbound += 1;
    }
  }
  // Fill missing days with zeros so the line chart doesn't skip dates.
  const daily: DailyBucket[] = [];
  {
    const start = new Date(sinceIso);
    const end = new Date(untilIso);
    const cursor = new Date(
      Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        start.getUTCDate(),
      ),
    );
    while (cursor <= end) {
      const date = cursor.toISOString().slice(0, 10);
      daily.push(dailyByDate.get(date) ?? { date, inbound: 0, outbound: 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  // ---- Process per-number (need fresh count for contacts + msgs) ----
  const numberRows = (numbersRes.data ?? []) as Array<{
    phone_number_id: string;
    display_phone_number: string | null;
    verified_name: string | null;
    nickname: string | null;
  }>;
  const visibleNumbers = numberRows.filter(
    (n) => scopeBpids === null || scopeBpids.includes(n.phone_number_id),
  );
  const perNumber: NumberRow[] = await Promise.all(
    visibleNumbers.map(async (n) => {
      const [inN, outN, contactsN] = await Promise.all([
        admin
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("business_phone_number_id", n.phone_number_id)
          .eq("direction", "inbound")
          .gte("timestamp", sinceIso),
        admin
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("business_phone_number_id", n.phone_number_id)
          .eq("direction", "outbound")
          .gte("timestamp", sinceIso),
        admin
          .from("contacts")
          .select("id", { count: "exact", head: true })
          .eq("business_phone_number_id", n.phone_number_id),
      ]);
      return {
        phone_number_id: n.phone_number_id,
        label:
          n.nickname?.trim() ||
          n.verified_name?.trim() ||
          n.display_phone_number ||
          n.phone_number_id,
        inbound: inN.count ?? 0,
        outbound: outN.count ?? 0,
        contacts: contactsN.count ?? 0,
      };
    }),
  );

  // ---- Process agent leaderboard ----
  const byUser = new Map<string, number>();
  for (const m of (leaderboardRes.data ?? []) as Array<{
    sent_by_user_id: string | null;
  }>) {
    const k = m.sent_by_user_id ?? "unattributed";
    byUser.set(k, (byUser.get(k) ?? 0) + 1);
  }
  const userIds = Array.from(byUser.keys()).filter(
    (k) => k !== "unattributed",
  );
  const nameById = new Map<string, { email: string; full_name: string | null }>();
  if (userIds.length > 0) {
    const { data: members } = await admin
      .from("team_members")
      .select("user_id, email, full_name")
      .in("user_id", userIds);
    for (const r of (members ?? []) as Array<{
      user_id: string;
      email: string;
      full_name: string | null;
    }>) {
      nameById.set(r.user_id, { email: r.email, full_name: r.full_name });
    }
  }
  const agentLeaderboard: AgentRow[] = Array.from(byUser.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([uid, n]) => {
      if (uid === "unattributed") {
        return { agent: "Unattributed", email: null, outbound: n };
      }
      const info = nameById.get(uid);
      return {
        agent: info?.full_name?.trim() || info?.email || uid,
        email: info?.email ?? null,
        outbound: n,
      };
    });

  // ---- Process top tags ----
  const tagCounts = new Map<string, number>();
  for (const r of (tagsRes.data ?? []) as Array<{ tags: string[] | null }>) {
    for (const t of r.tags ?? []) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }
  const topTags: TagRow[] = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([tag, count]) => ({ tag, count }));

  // ---- Process response time ----
  const pendingByChat = new Map<string, number>();
  const samplesByBpid = new Map<string, number[]>();
  for (const m of (rtRes.data ?? []) as Array<{
    contact_id: string;
    direction: string;
    timestamp: string;
    business_phone_number_id: string;
  }>) {
    const k = `${m.business_phone_number_id}:${m.contact_id}`;
    const ts = new Date(m.timestamp).getTime();
    if (!Number.isFinite(ts)) continue;
    if (m.direction === "inbound") {
      if (!pendingByChat.has(k)) pendingByChat.set(k, ts);
    } else if (m.direction === "outbound") {
      const inboundAt = pendingByChat.get(k);
      if (inboundAt !== undefined) {
        const minutes = (ts - inboundAt) / 60_000;
        const arr = samplesByBpid.get(m.business_phone_number_id) ?? [];
        arr.push(minutes);
        samplesByBpid.set(m.business_phone_number_id, arr);
        pendingByChat.delete(k);
      }
    }
  }
  function median(arr: number[]): number {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  const labelByBpid = new Map<string, string>();
  for (const n of numberRows) {
    labelByBpid.set(
      n.phone_number_id,
      n.nickname?.trim() ||
        n.verified_name?.trim() ||
        n.display_phone_number ||
        n.phone_number_id,
    );
  }
  const responseTime: ResponseTimeRow[] = Array.from(samplesByBpid.entries())
    .map(([bpid, arr]) => ({
      bpid,
      label: labelByBpid.get(bpid) ?? bpid,
      median_minutes: Number(median(arr).toFixed(1)),
      samples: arr.length,
    }))
    .sort((a, b) => a.median_minutes - b.median_minutes);
  // Workspace-wide average of medians (rough but useful for the KPI card).
  const avgResponseMinutes =
    responseTime.length === 0
      ? null
      : Number(
          (
            responseTime.reduce((acc, r) => acc + r.median_minutes, 0) /
            responseTime.length
          ).toFixed(1),
        );

  const out: OverviewResponse = {
    range: { since_hours: hours, since_iso: sinceIso, until_iso: untilIso },
    scope: {
      bpid_filter: bpidFilter,
      allowed_bpids: allowedBpids ?? "all",
    },
    kpis: {
      inbound: inRes.count ?? 0,
      outbound: outRes.count ?? 0,
      magic_messages: magicRes.count ?? 0,
      new_contacts: newContactsRes.count ?? 0,
      unread_now: unreadRes.count ?? 0,
      open_chats: openRes.count ?? 0,
      avg_response_minutes: avgResponseMinutes,
    },
    daily,
    per_number: perNumber.sort(
      (a, b) => b.inbound + b.outbound - (a.inbound + a.outbound),
    ),
    agent_leaderboard: agentLeaderboard,
    top_tags: topTags,
    peak_hours: hourly.map((count, hour) => ({ hour, count })),
    response_time: responseTime,
  };

  return NextResponse.json(out);
}
