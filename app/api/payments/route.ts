// GET /api/payments?contact_id=...
//
// Returns the payments rows for one contact, newest first. Drives the
// Payments section in the Contact Details panel.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const contactId = request.nextUrl.searchParams.get("contact_id")?.trim();
  if (!contactId) {
    return NextResponse.json({ error: "contact_id required" }, { status: 400 });
  }
  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("payments")
    .select(
      "id, amount_minor, currency, description, short_url, status, paid_at, receipt_url, receipt_sent_at, created_by, created_at",
    )
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(
    { payments: data ?? [] },
    { headers: { "Cache-Control": "no-store" } },
  );
}
