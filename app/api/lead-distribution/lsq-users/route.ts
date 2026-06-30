// GET /api/lead-distribution/lsq-users
//   → all LSQ users (sales agents) with active flag (StatusCode 0 = present).
// GET /api/lead-distribution/lsq-users?email=foo@bar.com
//   → just that user (presence check before assigning a lead).
//
// Backs the Lead Distribution setup (pick real LSQ agents) and the Phase-2
// engine (verify an agent is live in LSQ before assignment).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { lsqGetUsers } from "@/lib/lsq";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { ok, error, users } = await lsqGetUsers();
  if (!ok) return NextResponse.json({ error: error ?? "LSQ Users.Get failed" }, { status: 502 });

  const email = request.nextUrl.searchParams.get("email")?.trim().toLowerCase();
  if (email) {
    const user = users.find((u) => u.email === email) ?? null;
    return NextResponse.json({ user, present: !!user?.active });
  }
  const activeOnly = request.nextUrl.searchParams.get("active") === "1";
  const list = activeOnly ? users.filter((u) => u.active) : users;
  return NextResponse.json({ users: list, total: users.length, active: users.filter((u) => u.active).length });
}
