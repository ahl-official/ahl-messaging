// GET /api/v1/me — health-check for an API token.
//
// Lets external integrators verify their `qht_...` Bearer is valid +
// see which WhatsApp business number it's bound to, without sending an
// actual WhatsApp message. Useful as the first call from a new
// automation: if this returns 200, the token works.

import { NextResponse, type NextRequest } from "next/server";
import { bearerFrom, resolveApiToken } from "@/lib/api-tokens";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const bearer = bearerFrom(request.headers);
  if (!bearer) {
    return NextResponse.json(
      { error: "Missing Authorization: Bearer <token>" },
      { status: 401 },
    );
  }
  const tok = await resolveApiToken(bearer);
  if (!tok) {
    return NextResponse.json(
      { error: "Invalid or disabled API token" },
      { status: 401 },
    );
  }

  // Best-effort: hydrate the number's display fields so the integrator
  // sees something more useful than just the phone-number id.
  const admin = createServiceRoleClient();
  const { data: number } = await admin
    .from("business_numbers")
    .select("phone_number_id, display_phone_number, verified_name, nickname")
    .eq("phone_number_id", tok.business_phone_number_id)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    token: { id: tok.id, name: tok.name },
    business_phone_number_id: tok.business_phone_number_id,
    number: number ?? null,
  });
}
