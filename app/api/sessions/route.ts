// GET    /api/sessions                  → caller's own sessions
// GET    /api/sessions?member_id=<id>   → that member's sessions (admin+)
// DELETE /api/sessions                  → revoke ALL caller's other devices
// DELETE /api/sessions?id=<sid>         → revoke a single session (caller's
//                                          own OR admin+ revoking another
//                                          member's)
//
// Active means revoked_at IS NULL AND last_seen_at within the last 5m.

import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";
import {
  revokeAllSessionsForUser,
  revokeSession,
  SESSION_COOKIE_NAME,
} from "@/lib/user-sessions";

export const runtime = "nodejs";

const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;

interface SessionRow {
  id: string;
  user_id: string;
  member_id: string | null;
  ip: string | null;
  user_agent: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  started_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

interface ApiSession {
  id: string;
  ip: string | null;
  user_agent: string | null;
  location: string | null;
  device: string | null;
  started_at: string;
  last_seen_at: string;
  active: boolean;
  is_current: boolean;
}

function locationStr(s: SessionRow): string | null {
  const bits = [s.city, s.region, s.country].filter(Boolean);
  return bits.length > 0 ? bits.join(", ") : null;
}

function deviceLabel(ua: string | null): string | null {
  if (!ua) return null;
  // Cheap UA parse — full ua-parser library is overkill for a label.
  const browser =
    /Edg\//.test(ua)
      ? "Edge"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os =
    /Windows/.test(ua)
      ? "Windows"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /iPhone|iPad|iOS/.test(ua)
            ? "iOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "Unknown";
  return `${browser} · ${os}`;
}

function toApi(row: SessionRow, currentSessionId: string | null): ApiSession {
  const now = Date.now();
  const lastSeen = new Date(row.last_seen_at).getTime();
  const active =
    row.revoked_at === null && now - lastSeen < ACTIVE_THRESHOLD_MS;
  return {
    id: row.id,
    ip: row.ip,
    user_agent: row.user_agent,
    location: locationStr(row),
    device: deviceLabel(row.user_agent),
    started_at: row.started_at,
    last_seen_at: row.last_seen_at,
    active,
    is_current: row.id === currentSessionId,
  };
}

export async function GET(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberId = request.nextUrl.searchParams.get("member_id");
  const all = request.nextUrl.searchParams.get("all") === "1";
  const admin = createServiceRoleClient();

  // Workspace-wide view — every member's sessions grouped per user.
  // Admin+ only; powers the Team → Sessions sub-tab.
  if (all) {
    if (!isAtLeast(me.role, "admin")) {
      return NextResponse.json({ error: "Admin or above" }, { status: 403 });
    }
    const cookieStore = await cookies();
    const currentSessionId =
      cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
    const [{ data: members }, { data: rows }] = await Promise.all([
      admin
        .from("team_members")
        .select("id, user_id, email, full_name, first_name, last_name, role")
        .eq("is_active", true),
      admin
        .from("user_sessions")
        .select("*")
        .order("last_seen_at", { ascending: false })
        .limit(500),
    ]);
    const sessionsByUser = new Map<string, ApiSession[]>();
    for (const r of (rows ?? []) as SessionRow[]) {
      const arr = sessionsByUser.get(r.user_id) ?? [];
      arr.push(toApi(r, currentSessionId));
      sessionsByUser.set(r.user_id, arr);
    }
    const users = ((members ?? []) as Array<{
      id: string;
      user_id: string | null;
      email: string;
      full_name: string | null;
      first_name: string | null;
      last_name: string | null;
      role: string;
    }>)
      .map((m) => {
        const sess = m.user_id ? sessionsByUser.get(m.user_id) ?? [] : [];
        const active = sess.filter((s) => s.active);
        return {
          member_id: m.id,
          email: m.email,
          name:
            (m.first_name && m.last_name
              ? `${m.first_name} ${m.last_name}`
              : m.full_name) || m.email.split("@")[0],
          role: m.role,
          active_count: active.length,
          total_count: sess.length,
          last_seen_at: sess[0]?.last_seen_at ?? null,
          last_location: active[0]?.location ?? sess[0]?.location ?? null,
          sessions: sess,
        };
      })
      .sort((a, b) => b.active_count - a.active_count);
    return NextResponse.json({ users });
  }

  let userId: string;
  if (memberId && memberId !== me.id) {
    if (!isAtLeast(me.role, "admin")) {
      return NextResponse.json({ error: "Admin or above" }, { status: 403 });
    }
    const { data: target } = await admin
      .from("team_members")
      .select("user_id")
      .eq("id", memberId)
      .maybeSingle();
    if (!target?.user_id) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }
    userId = target.user_id as string;
  } else {
    userId = me.user_id ?? "";
    if (!userId)
      return NextResponse.json({ error: "Account not linked" }, { status: 400 });
  }

  const { data } = await admin
    .from("user_sessions")
    .select("*")
    .eq("user_id", userId)
    .order("last_seen_at", { ascending: false })
    .limit(50);

  const cookieStore = await cookies();
  const currentSessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
  return NextResponse.json({
    sessions: (data ?? []).map((r) =>
      toApi(r as SessionRow, currentSessionId),
    ),
  });
}

export async function DELETE(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!me.user_id)
    return NextResponse.json({ error: "Account not linked" }, { status: 400 });

  const sessionId = request.nextUrl.searchParams.get("id");
  const memberId = request.nextUrl.searchParams.get("member_id");
  const admin = createServiceRoleClient();
  const cookieStore = await cookies();
  const currentSessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;

  // Admin revoking SOMEONE ELSE's all sessions.
  if (memberId && !sessionId) {
    if (!isAtLeast(me.role, "admin")) {
      return NextResponse.json({ error: "Admin or above" }, { status: 403 });
    }
    const { data: target } = await admin
      .from("team_members")
      .select("user_id")
      .eq("id", memberId)
      .maybeSingle();
    if (!target?.user_id) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }
    const n = await revokeAllSessionsForUser(
      target.user_id as string,
      `revoked_by_${me.email ?? "admin"}`,
    );
    // Best-effort: also invalidate Supabase refresh tokens so the
    // signed-out user can't keep using a cached access-token.
    try {
      await admin.auth.admin.signOut(target.user_id as string);
    } catch {
      /* signOut admin endpoint is best-effort */
    }
    return NextResponse.json({ ok: true, revoked: n });
  }

  // Caller revoking a specific session (own OR admin acting on others)
  if (sessionId) {
    const { data: row } = await admin
      .from("user_sessions")
      .select("user_id")
      .eq("id", sessionId)
      .maybeSingle();
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const ownsRow = row.user_id === me.user_id;
    if (!ownsRow && !isAtLeast(me.role, "admin")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    await revokeSession(sessionId, ownsRow ? "user_revoked" : `revoked_by_${me.email ?? "admin"}`);
    return NextResponse.json({ ok: true });
  }

  // No params → revoke ALL OTHER caller's sessions (keep current
  // session live so they don't kick themselves out).
  const admin2 = createServiceRoleClient();
  const { data: rows } = await admin2
    .from("user_sessions")
    .select("id")
    .eq("user_id", me.user_id)
    .is("revoked_at", null);
  let n = 0;
  for (const r of (rows ?? []) as Array<{ id: string }>) {
    if (r.id === currentSessionId) continue;
    await revokeSession(r.id, "logout_other_devices");
    n += 1;
  }
  return NextResponse.json({ ok: true, revoked: n });
}
