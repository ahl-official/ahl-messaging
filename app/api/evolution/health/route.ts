// GET /api/evolution/health?phone_number_id=<id>
//
// Returns disconnect-history derived health for an Evolution number:
//   • disconnects_24h     — count of close events in the last 24h
//   • last_reason_code    — most-recent statusReason (401 = logged out)
//   • last_occurred_at    — timestamp of the most-recent close
//
// Used by the EvolutionStateBadge on the Numbers page to render a
// "Connected / Connected · unstable / Logged out / Disconnected" pill
// without bloating the main numbers query with a JOIN.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const pnid = request.nextUrl.searchParams.get("phone_number_id");
  if (!pnid) {
    return NextResponse.json(
      { error: "phone_number_id query param required" },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [{ count }, { data: latest }] = await Promise.all([
    admin
      .from("evolution_disconnects")
      .select("id", { count: "exact", head: true })
      .eq("business_phone_number_id", pnid)
      .gte("occurred_at", cutoff),
    admin
      .from("evolution_disconnects")
      .select("reason_code, occurred_at")
      .eq("business_phone_number_id", pnid)
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return NextResponse.json({
    phone_number_id: pnid,
    disconnects_24h: count ?? 0,
    last_reason_code: latest?.reason_code ?? null,
    last_occurred_at: latest?.occurred_at ?? null,
  });
}
