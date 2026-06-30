// POST /api/payments/[id]/send-receipt
//
// Manual "Send receipt" — operator hits this from the Payments section
// in Contact Details after a payment is marked paid. Uses the shared
// helper so the wording, send path, and audit trail match the auto-
// send path verbatim.
//
// Logged-in operators only. The helper itself uses the internal token
// to call /api/send-message.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { sendReceiptInternal } from "@/lib/payments";

export const runtime = "nodejs";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const result = await sendReceiptInternal(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
