// POST /api/settings/payment-accounts/[id]/activate
//
// Mark this account as the workspace's active payment account. The DB
// has a partial unique index on `is_active = true` so the helper does
// a 2-step swap.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { setActiveAccount } from "@/lib/payment-accounts";

export const runtime = "nodejs";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  const { id } = await params;
  await setActiveAccount(id);
  return NextResponse.json({ ok: true });
}
