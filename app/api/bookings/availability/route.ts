// GET /api/bookings/availability — agent-only. Available dates for the
// in-chat "Date Align" picker (so the agent can set a date directly).

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { getEffectivePermissionsFor } from "@/lib/permissions";
import { getAvailability } from "@/lib/bookings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const perms = await getEffectivePermissionsFor(member);
  if (!perms.can_align_dates) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const admin = createServiceRoleClient();
  const { available, load, details, capacity } = await getAvailability(admin);
  return NextResponse.json({ available_dates: available, load, details, capacity });
}
