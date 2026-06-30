// POST /api/business-numbers/profile-pic-cron
//
// Background "refill missing pics" runner — called every 5 minutes from
// instrumentation.ts. Picks the N oldest-checked (or never-checked)
// numbers with NULL profile_pic_url, asks Meta directly, falls back to
// Baileys via the first online Evolution instance, and stores whatever
// comes back. Bumps profile_pic_checked_at on every attempt so the
// next tick rotates to a different batch.
//
// Why this is rate-limit friendly:
//   • 5 numbers per tick × 12 ticks/hour = 60 lookups/hour
//   • 3-second gap between Evolution calls inside a tick
//   • Meta lookups don't count against Evolution's anti-spam — only
//     the fallback path uses Baileys
//
// Auth: internal — `Authorization: Bearer <WEBHOOK_INTERNAL_TOKEN>`.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential } from "@/lib/credentials";
import { fetchMetaBusinessProfilePic } from "@/lib/whatsapp";
import { fetchProfilePictureUrl } from "@/lib/evolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BATCH_SIZE = 5;
const EVOLUTION_GAP_MS = 3_000;

export async function POST(request: NextRequest) {
  // Internal-only — same shared-secret pattern the existing sweep
  // uses. Prevents random POSTs from triggering the background work.
  const auth = request.headers.get("authorization") ?? "";
  const expected = (await getCredential("webhook_internal_token")) ?? "";
  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createServiceRoleClient();

  // Pick the next batch — numbers with no cached pic, oldest-checked
  // first (NULL first thanks to the partial index in 0045). Filter to
  // rows that actually have a phone we can look up.
  const { data: batch, error } = await admin
    .from("business_numbers")
    .select(
      "phone_number_id, display_phone_number, provider, evolution_instance_name, evolution_api_key",
    )
    .is("profile_pic_url", null)
    .not("display_phone_number", "is", null)
    .order("profile_pic_checked_at", { ascending: true, nullsFirst: true })
    .limit(BATCH_SIZE);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const targets = batch ?? [];
  if (targets.length === 0) {
    return NextResponse.json({ ok: true, checked: 0, updated: 0 });
  }

  // Discover an online Evolution instance to use as the Baileys
  // fallback for Meta numbers Meta itself doesn't have a logo for.
  const { data: evoRows } = await admin
    .from("business_numbers")
    .select("evolution_instance_name, evolution_api_key")
    .eq("provider", "evolution")
    .eq("evolution_connection_state", "open")
    .not("evolution_instance_name", "is", null)
    .not("evolution_api_key", "is", null)
    .limit(1);
  const proxy = (evoRows ?? [])[0] ?? null;

  let updated = 0;
  const nowIso = new Date().toISOString();

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    let url: string | null = null;

    // Meta side first — instant, no anti-spam concerns. Only works
    // for own Meta-provider numbers (Evolution rows don't have a
    // Meta WABA mapping to query against).
    if (row.provider !== "evolution") {
      try {
        url = await fetchMetaBusinessProfilePic(row.phone_number_id);
      } catch {
        /* fall through to evolution */
      }
    }

    // Evolution fallback — only when Meta returned nothing AND a
    // proxy instance is connected. Gap to keep Baileys happy.
    if (!url && proxy?.evolution_instance_name && proxy?.evolution_api_key && row.display_phone_number) {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, EVOLUTION_GAP_MS));
      }
      try {
        url = await fetchProfilePictureUrl({
          instanceName: proxy.evolution_instance_name,
          apiKey: proxy.evolution_api_key,
          jidOrNumber: row.display_phone_number,
        });
      } catch {
        /* swallow — bump checked_at anyway so the cron rotates onward */
      }
    }

    const patch: Record<string, unknown> = {
      profile_pic_checked_at: nowIso,
    };
    if (url) {
      patch.profile_pic_url = url;
      updated++;
    }
    await admin
      .from("business_numbers")
      .update(patch)
      .eq("phone_number_id", row.phone_number_id);
  }

  return NextResponse.json({
    ok: true,
    checked: targets.length,
    updated,
    proxy_used: proxy?.evolution_instance_name ?? null,
  });
}
