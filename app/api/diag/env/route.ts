// GET /api/_debug/env — owner-only diagnostic that returns whether
// the running process has the env vars we care about for invites /
// redirect URLs. Delete this route after you're done debugging.

import { NextResponse } from "next/server";
import { getCurrentMember } from "@/lib/team";

export const runtime = "nodejs";

export async function GET() {
  const me = await getCurrentMember();
  if (!me || me.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  return NextResponse.json({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? null,
    NODE_ENV: process.env.NODE_ENV ?? null,
  });
}
