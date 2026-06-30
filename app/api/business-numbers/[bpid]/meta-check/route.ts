// POST /api/business-numbers/[bpid]/meta-check
//
// Probes Meta's Graph API for this phone_number_id using the owning
// portfolio's access token. Updates business_numbers.meta_status:
//   • 200 + matching id          → "connected"
//   • 404 / "does not exist"     → "removed"   (operator deleted it on Meta)
//   • other errors (token, rate) → leaves status unchanged, returns the
//                                  error so the UI can show "couldn't check"
//
// Admin+ — read-only probe, doesn't mutate anything on Meta's side.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { listPortfolios } from "@/lib/portfolios";
import { getApiVersion } from "@/lib/whatsapp";

export const runtime = "nodejs";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ bpid: string }> },
) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const { bpid } = await params;
  if (!bpid) return NextResponse.json({ error: "bpid required" }, { status: 400 });

  const admin = createServiceRoleClient();
  const { data: number } = await admin
    .from("business_numbers")
    .select("phone_number_id")
    .eq("phone_number_id", bpid)
    .maybeSingle();
  if (!number) {
    return NextResponse.json({ error: "Number not found" }, { status: 404 });
  }

  const apiVersion = await getApiVersion();
  // Resolve the owning portfolio's token; fall back to trying every
  // active portfolio (same approach as the lookup endpoint) so a
  // mis-assigned portfolio doesn't produce a false "removed".
  const portfolios = listPortfolios().filter((p) => p.is_active && p.access_token);
  if (portfolios.length === 0) {
    return NextResponse.json(
      { error: "No active portfolio with an access token configured." },
      { status: 500 },
    );
  }

  let status: "connected" | "removed" | null = null;
  let lastError: string | null = null;

  for (const p of portfolios) {
    try {
      const url = `https://graph.facebook.com/${apiVersion}/${bpid}?fields=id,display_phone_number,verified_name`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${p.access_token}` },
        cache: "no-store",
      });
      if (res.ok) {
        status = "connected";
        break;
      }
      const json = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; code?: number; type?: string };
      };
      const msg = json.error?.message ?? `HTTP ${res.status}`;
      const code = json.error?.code;
      // Meta error 100 + "does not exist" / 803 / a 404 = the object is
      // gone. A token/permission error (190, 200, 10) means THIS
      // portfolio can't see it — keep trying other portfolios.
      const looksRemoved =
        res.status === 404 ||
        code === 803 ||
        /does not exist|cannot be loaded|unsupported get request/i.test(msg);
      if (looksRemoved) {
        status = "removed";
        // Don't break — another portfolio might actually own + see it.
        // Only settle on "removed" if no portfolio reports "connected".
      }
      lastError = msg;
    } catch (e) {
      lastError = e instanceof Error ? e.message : "Network error";
    }
  }

  // If we never got a definitive answer, leave status untouched.
  if (status === null) {
    return NextResponse.json(
      {
        ok: false,
        error: `Couldn't determine status — ${lastError ?? "unknown error"}`,
      },
      { status: 502 },
    );
  }

  const nowIso = new Date().toISOString();
  const { data: updated, error: uErr } = await admin
    .from("business_numbers")
    .update({ meta_status: status, meta_checked_at: nowIso })
    .eq("phone_number_id", bpid)
    .select("phone_number_id, meta_status, meta_checked_at")
    .single();
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, ...updated });
}
