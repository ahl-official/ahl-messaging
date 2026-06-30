// POST /api/evolution/refresh-all-webhooks
//
// Re-registers the webhook (URL + full event list + enabled) on EVERY
// Evolution instance in one shot. This is the repair for "some unofficial
// numbers stopped live-syncing": Evolution persists the webhook URL it was
// given at instance-create time, so any number created before the public
// URL changed (domain move, staging→prod, http→https) — or whose webhook
// got disabled when Evolution restarted — keeps POSTing to a dead URL (or
// not at all) until it's re-applied. refresh-states only refreshes the
// connection badge, not the webhook, so a number can read "connected" yet
// never deliver inbound. This endpoint closes that gap for all numbers at
// once instead of one card at a time.
//
// Owner / admin+ only — workspace-wide write to Evolution.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";
import {
  isEvolutionConfigured,
  setInstanceWebhook,
  webhookUrlFor,
} from "@/lib/evolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface PerInstance {
  instance: string;
  bpid: string;
  url: string | null;
  ok: boolean;
  error?: string;
}

export async function POST() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admin or above" }, { status: 403 });
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ instances: [], skipped: true });
  }

  const admin = createServiceRoleClient();
  const { data: numbers } = await admin
    .from("business_numbers")
    .select("phone_number_id, evolution_instance_name, evolution_api_key")
    .eq("provider", "evolution")
    .not("evolution_instance_name", "is", null);

  const rows = (numbers ?? []) as Array<{
    phone_number_id: string;
    evolution_instance_name: string | null;
    evolution_api_key: string | null;
  }>;

  const out: PerInstance[] = await Promise.all(
    rows.map(async (r) => {
      const instance = r.evolution_instance_name!;
      if (!r.evolution_api_key) {
        return {
          instance,
          bpid: r.phone_number_id,
          url: null,
          ok: false,
          error: "Missing instance API key",
        };
      }
      try {
        const url = webhookUrlFor(instance);
        await setInstanceWebhook({
          instanceName: instance,
          apiKey: r.evolution_api_key,
          url,
        });
        return { instance, bpid: r.phone_number_id, url, ok: true };
      } catch (e) {
        return {
          instance,
          bpid: r.phone_number_id,
          url: null,
          ok: false,
          error: e instanceof Error ? e.message : "Webhook set failed",
        };
      }
    }),
  );

  return NextResponse.json({
    instances: out,
    total: out.length,
    repaired: out.filter((r) => r.ok).length,
    failed: out.filter((r) => !r.ok).length,
  });
}
