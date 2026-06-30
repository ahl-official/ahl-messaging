// POST /api/evolution/sync-groups
//
// Pulls the full WhatsApp group list from every connected Evolution
// number and upserts each group as an `is_group` contact, so the inbox
// "Groups" filter is populated up-front — without waiting for a message
// to arrive in each group. Safe to re-run (idempotent upsert).
//
// Admin+ only.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";
import { fetchEvolutionGroups, jidToWaId } from "@/lib/evolution";

export const runtime = "nodejs";

export async function POST() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admin or above" }, { status: 403 });
  }

  const admin = createServiceRoleClient();
  const { data: numbers } = await admin
    .from("business_numbers")
    .select("phone_number_id, evolution_instance_name, evolution_api_key")
    .eq("provider", "evolution")
    .not("evolution_instance_name", "is", null);

  let synced = 0;
  const errors: string[] = [];

  for (const n of (numbers ?? []) as Array<{
    phone_number_id: string;
    evolution_instance_name: string | null;
    evolution_api_key: string | null;
  }>) {
    const instance = n.evolution_instance_name;
    const key = n.evolution_api_key;
    if (!instance || !key) continue;
    try {
      const groups = await fetchEvolutionGroups(instance, key);
      for (const g of groups) {
        const waId = jidToWaId(g.id);
        if (!waId) continue;
        const { error } = await admin.from("contacts").upsert(
          {
            wa_id: waId,
            business_phone_number_id: n.phone_number_id,
            is_group: true,
            name: g.subject || null,
            profile_name: g.subject || null,
            status: "open",
          },
          {
            onConflict: "wa_id,business_phone_number_id",
            ignoreDuplicates: false,
          },
        );
        if (!error) synced += 1;
      }
    } catch (e) {
      errors.push(
        `${instance}: ${e instanceof Error ? e.message : "fetch failed"}`,
      );
    }
  }

  return NextResponse.json({ ok: true, synced, errors });
}
