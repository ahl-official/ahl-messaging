// POST /api/evolution/instances/[name]/refresh-avatar
//
// Pulls the current WhatsApp profile picture for an Evolution number
// from Baileys and caches it on business_numbers.profile_pic_url.
// Called silently from the Numbers page when a number has no avatar
// yet OR the cached one is stale (Evolution returns short-TTL CDN
// URLs).
//
// Auth: any signed-in member can trigger — read-only against
// Evolution, write is to the single matching business_numbers row.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { fetchProfilePictureUrl } from "@/lib/evolution";

export const runtime = "nodejs";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const member = await getCurrentMember();
  if (!member) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { name } = await params;

  const admin = createServiceRoleClient();
  const { data: bn } = await admin
    .from("business_numbers")
    .select(
      "phone_number_id, evolution_instance_name, evolution_api_key, evolution_jid, provider",
    )
    .eq("evolution_instance_name", name)
    .maybeSingle();
  if (
    !bn ||
    bn.provider !== "evolution" ||
    !bn.evolution_api_key ||
    !bn.evolution_jid
  ) {
    return NextResponse.json(
      { error: "Instance not found or not yet connected" },
      { status: 404 },
    );
  }

  const url = await fetchProfilePictureUrl({
    instanceName: bn.evolution_instance_name as string,
    apiKey: bn.evolution_api_key,
    jidOrNumber: bn.evolution_jid,
  });

  // Persist whatever we got (null wipes a stale URL too — privacy
  // setting may have changed since the last fetch).
  await admin
    .from("business_numbers")
    .update({ profile_pic_url: url })
    .eq("phone_number_id", bn.phone_number_id);

  return NextResponse.json({ ok: true, profile_pic_url: url });
}
