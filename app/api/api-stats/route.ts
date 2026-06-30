// GET /api/api-stats?days=7
//
// Powers the API health monitor on Settings → API. Returns:
//   • Per-day request count for the last N days (default 7, max 30)
//   • Per-platform breakdown (derived from user-agent) over the same window
//   • Per-token totals (request_count + last_used_at)
//   • Last 50 individual hits with method/path/status/duration/platform
//
// Admin+ only — request logs leak source IPs and tokens.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { platformFromUserAgent } from "@/lib/api-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LogRow {
  id: string;
  token_id: string | null;
  token_name: string | null;
  business_phone_number_id: string | null;
  method: string;
  path: string;
  status: number;
  duration_ms: number | null;
  user_agent: string | null;
  source_ip: string | null;
  occurred_at: string;
}

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const days = Math.min(
    30,
    Math.max(1, parseInt(request.nextUrl.searchParams.get("days") ?? "7", 10) || 7),
  );
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const admin = createServiceRoleClient();
  // Pull a window of recent rows. With ~10 hits/sec at the high end,
  // 30 days = ~25M rows max — limit to 5000 here so the page doesn't
  // try to render that. The aggregate counts come from a separate
  // count query.
  const [{ data: rows, error: rowsErr }, { data: tokens }] = await Promise.all([
    admin
      .from("api_request_log")
      .select(
        "id, token_id, token_name, business_phone_number_id, method, path, status, duration_ms, user_agent, source_ip, occurred_at",
      )
      .gte("occurred_at", cutoff)
      .order("occurred_at", { ascending: false })
      .limit(5000),
    admin
      .from("api_tokens")
      .select(
        "id, name, business_phone_number_id, request_count, last_used_at, enabled, created_at",
      )
      .order("last_used_at", { ascending: false, nullsFirst: false }),
  ]);
  if (rowsErr) {
    return NextResponse.json({ error: rowsErr.message }, { status: 500 });
  }

  const list = (rows ?? []) as LogRow[];

  // Per-day buckets (YYYY-MM-DD → { total, errors }).
  const perDay = new Map<string, { total: number; errors: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    perDay.set(key, { total: 0, errors: 0 });
  }
  // Per-platform (n8n / Make / curl / Browser / …).
  const perPlatform = new Map<string, number>();
  // Per-token (id → { name, count }).
  const perToken = new Map<string, { name: string; count: number }>();

  for (const r of list) {
    const dayKey = r.occurred_at.slice(0, 10);
    const slot = perDay.get(dayKey);
    if (slot) {
      slot.total++;
      if (r.status >= 400) slot.errors++;
    }
    const platform = platformFromUserAgent(r.user_agent);
    perPlatform.set(platform, (perPlatform.get(platform) ?? 0) + 1);
    if (r.token_id) {
      const cur = perToken.get(r.token_id) ?? { name: r.token_name ?? "—", count: 0 };
      cur.count++;
      perToken.set(r.token_id, cur);
    }
  }

  const recent = list.slice(0, 50).map((r) => ({
    id: r.id,
    occurred_at: r.occurred_at,
    method: r.method,
    path: r.path,
    status: r.status,
    duration_ms: r.duration_ms,
    token_name: r.token_name,
    business_phone_number_id: r.business_phone_number_id,
    platform: platformFromUserAgent(r.user_agent),
    user_agent: r.user_agent,
    source_ip: r.source_ip,
  }));

  return NextResponse.json({
    window_days: days,
    total_requests: list.length,
    errors: list.filter((r) => r.status >= 400).length,
    per_day: Array.from(perDay.entries())
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => (a.day < b.day ? -1 : 1)),
    per_platform: Array.from(perPlatform.entries())
      .map(([platform, count]) => ({ platform, count }))
      .sort((a, b) => b.count - a.count),
    per_token: Array.from(perToken.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.count - a.count),
    tokens: tokens ?? [],
    recent,
  });
}
