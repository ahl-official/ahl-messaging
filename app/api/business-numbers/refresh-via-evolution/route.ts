// POST /api/business-numbers/refresh-via-evolution
//
// Bulk-borrow profile pictures from WhatsApp for every Meta business
// number by routing the lookup through a connected Evolution (Baileys)
// instance. Baileys' /chat/fetchProfilePictureUrl returns a public CDN
// URL for any WhatsApp user — works on Meta-side phone numbers too as
// long as the target's profile-picture privacy is set to "Everyone"
// (default for verified business accounts).
//
// Flow:
//   1. Find an open Evolution instance (provider='evolution' AND
//      connection_state='open'). If none available, return early.
//   2. For each Meta number that has a display_phone_number and no
//      profile_pic_url, call fetchProfilePictureUrl through that
//      instance using the Meta number's digits.
//   3. Update business_numbers.profile_pic_url with whatever URL
//      Evolution gives back (null = privacy locked, leave as-is).
//
// Admin+ only. Concurrency-capped so a 50-number workspace doesn't
// hammer Evolution.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { fetchProfilePictureUrl } from "@/lib/evolution";
import { fetchMetaBusinessProfilePic } from "@/lib/whatsapp";

export const runtime = "nodejs";

const CONCURRENCY = 3;

interface Row {
  phone_number_id: string;
  display_phone_number: string | null;
  provider: "meta" | "evolution" | null;
  profile_pic_url: string | null;
  evolution_instance_name: string | null;
  evolution_api_key: string | null;
  evolution_connection_state: string | null;
}

export async function POST() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("business_numbers")
    .select(
      "phone_number_id, display_phone_number, provider, profile_pic_url, evolution_instance_name, evolution_api_key, evolution_connection_state",
    );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as Row[];

  // Optional Evolution proxy for the fallback path. The primary
  // source is Meta's own /whatsapp_business_profile endpoint — Cloud
  // API verified numbers expose their picture there, no Baileys
  // required. Evolution is only used when Meta returns nothing AND a
  // connected instance is available.
  const proxy = rows.find(
    (r) =>
      r.provider === "evolution" &&
      r.evolution_connection_state === "open" &&
      !!r.evolution_instance_name &&
      !!r.evolution_api_key,
  );

  // Targets: every Meta number that has a phone but no cached pic.
  // (Evolution rows refresh their own pics via the existing
  // refresh-avatar route — we don't double-fetch here.)
  const targets = rows.filter(
    (r) =>
      r.provider !== "evolution" &&
      !!r.display_phone_number &&
      !r.profile_pic_url,
  );

  if (targets.length === 0) {
    return NextResponse.json({
      ok: true,
      proxy_instance: proxy?.evolution_instance_name ?? null,
      checked: 0,
      updated: 0,
      details: [],
    });
  }

  const queue = [...targets];
  const details: Array<{
    phone_number_id: string;
    display_phone_number: string;
    source: "meta" | "evolution" | "none";
    url: string | null;
  }> = [];
  let updated = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const row = queue.shift();
      if (!row) return;

      // 1) Try Meta's own business profile endpoint first — works for
      //    every verified Cloud-API number that has a logo uploaded.
      let url = await fetchMetaBusinessProfilePic(row.phone_number_id);
      let source: "meta" | "evolution" | "none" = url ? "meta" : "none";

      // 2) Fall back to an Evolution proxy lookup when Meta returned
      //    nothing AND a connected instance is available. Useful for
      //    legacy / personal numbers the operator wired in as Meta
      //    but that actually have a regular WhatsApp profile.
      if (!url && proxy) {
        url = await fetchProfilePictureUrl({
          instanceName: proxy.evolution_instance_name!,
          apiKey: proxy.evolution_api_key!,
          jidOrNumber: row.display_phone_number!,
        });
        if (url) source = "evolution";
      }

      if (url) {
        await admin
          .from("business_numbers")
          .update({ profile_pic_url: url })
          .eq("phone_number_id", row.phone_number_id);
        updated++;
      }
      details.push({
        phone_number_id: row.phone_number_id,
        display_phone_number: row.display_phone_number!,
        source,
        url,
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()),
  );

  return NextResponse.json({
    ok: true,
    proxy_instance: proxy?.evolution_instance_name ?? null,
    checked: targets.length,
    updated,
    details,
  });
}
