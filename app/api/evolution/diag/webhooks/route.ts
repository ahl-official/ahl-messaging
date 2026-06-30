// GET /api/evolution/diag/webhooks
//
// Read-only diagnostic: for every Evolution instance, fetch the webhook
// Evolution ACTUALLY has on file and compare it to what we expect. Surfaces
// exactly which numbers are misconfigured (stale URL, disabled, or missing
// events) so the operator can see why some unofficial numbers don't live-
// sync — then fix them all with POST /api/evolution/refresh-all-webhooks.
//
// Owner / admin+ only.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";
import {
  WEBHOOK_EVENTS,
  getInstanceWebhook,
  isEvolutionConfigured,
  webhookUrlFor,
} from "@/lib/evolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface WebhookDiag {
  instance: string;
  bpid: string;
  connectionState: string | null;
  liveUrl: string | null;
  expectedUrl: string | null;
  urlMatch: boolean;
  enabled: boolean;
  byEvents: boolean;
  missingEvents: string[];
  /** True when everything looks correct — the number should live-sync. */
  healthy: boolean;
  note?: string;
}

export async function GET() {
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
    .select(
      "phone_number_id, evolution_instance_name, evolution_api_key, evolution_connection_state",
    )
    .eq("provider", "evolution")
    .not("evolution_instance_name", "is", null);

  const rows = (numbers ?? []) as Array<{
    phone_number_id: string;
    evolution_instance_name: string | null;
    evolution_api_key: string | null;
    evolution_connection_state: string | null;
  }>;

  const out: WebhookDiag[] = await Promise.all(
    rows.map(async (r) => {
      const instance = r.evolution_instance_name!;
      let expectedUrl: string | null = null;
      try {
        expectedUrl = webhookUrlFor(instance);
      } catch {
        expectedUrl = null; // base URL misconfigured server-side
      }
      const base: WebhookDiag = {
        instance,
        bpid: r.phone_number_id,
        connectionState: r.evolution_connection_state,
        liveUrl: null,
        expectedUrl,
        urlMatch: false,
        enabled: false,
        byEvents: false,
        missingEvents: [],
        healthy: false,
      };
      if (!r.evolution_api_key) {
        return { ...base, note: "Missing instance API key" };
      }
      const live = await getInstanceWebhook(instance, r.evolution_api_key);
      if (!live) {
        return { ...base, note: "No webhook on file (or unreadable)" };
      }
      const missingEvents = WEBHOOK_EVENTS.filter(
        (e) => !live.events.includes(e),
      );
      const urlMatch = !!expectedUrl && live.url === expectedUrl;
      return {
        ...base,
        liveUrl: live.url,
        urlMatch,
        enabled: live.enabled,
        byEvents: live.byEvents,
        missingEvents,
        healthy:
          urlMatch && live.enabled && !live.byEvents && missingEvents.length === 0,
      };
    }),
  );

  return NextResponse.json({
    instances: out,
    total: out.length,
    healthy: out.filter((r) => r.healthy).length,
    unhealthy: out.filter((r) => !r.healthy).length,
  });
}
