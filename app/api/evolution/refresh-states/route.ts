// POST /api/evolution/refresh-states
//
// Walks every Evolution number the caller can see, asks Evolution for
// the current connection state, and writes any change back into
// business_numbers.evolution_connection_state.
//
// Why this exists: the column is normally kept fresh by the
// CONNECTION_UPDATE webhook event. But if the webhook subscription
// list was incomplete at QR-scan time (older instances) or the event
// got lost (proxy hiccup), the column gets stuck at "connecting" /
// "close" even when Evolution itself says the socket is "open". The
// Numbers settings page calls this on mount so the badge matches
// Evolution within a single page load.
//
// Owner / superadmin only — it's a workspace-wide background sweep.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";
import { getConnectionState, isEvolutionConfigured } from "@/lib/evolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface PerInstance {
  instance: string;
  bpid: string;
  previous: string | null;
  current: string | null;
  changed: boolean;
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
    .select(
      "phone_number_id, evolution_instance_name, evolution_connection_state",
    )
    .eq("provider", "evolution")
    .not("evolution_instance_name", "is", null);

  const rows = (numbers ?? []) as Array<{
    phone_number_id: string;
    evolution_instance_name: string | null;
    evolution_connection_state: string | null;
  }>;

  const out: PerInstance[] = await Promise.all(
    rows.map(async (r) => {
      const instance = r.evolution_instance_name!;
      const previous = r.evolution_connection_state;
      try {
        const stateRes = await getConnectionState(instance);
        const current = stateRes.instance?.state ?? null;
        const changed = current !== null && current !== previous;
        if (changed) {
          await admin
            .from("business_numbers")
            .update({
              evolution_connection_state: current,
              evolution_last_state_at: new Date().toISOString(),
            })
            .eq("phone_number_id", r.phone_number_id);
        }
        return {
          instance,
          bpid: r.phone_number_id,
          previous,
          current,
          changed,
        };
      } catch (e) {
        return {
          instance,
          bpid: r.phone_number_id,
          previous,
          current: null,
          changed: false,
          error: e instanceof Error ? e.message : "fetch failed",
        };
      }
    }),
  );

  return NextResponse.json({
    instances: out,
    changed: out.filter((r) => r.changed).length,
  });
}
