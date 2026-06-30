// GET /api/business-numbers/stats
//
// Per-number contact + message counts for the Numbers settings page so
// the operator can see "this number has X chats, Y messages" at a glance
// without going into the inbox.
//
// Implementation: parallel head:true counts per bpid. Cheap (uses the
// existing index on business_phone_number_id) and avoids needing a
// materialized view or a stored function. 9 numbers ≈ 18 queries in
// parallel → ~150ms typical.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { getEffectivePermissionsFor } from "@/lib/permissions";
import { fetchEvolutionInstanceTotals } from "@/lib/evolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceRoleClient();
  const { data: numbers } = await admin
    .from("business_numbers")
    .select(
      "phone_number_id, provider, evolution_instance_name, evolution_api_key",
    );
  const rows = (numbers ?? []) as Array<{
    phone_number_id: string;
    provider: string | null;
    evolution_instance_name: string | null;
    evolution_api_key: string | null;
  }>;

  // Scope to numbers this user is allowed to see (mirrors the inbox
  // gate — admins/teammates shouldn't see stats for numbers they can't
  // open).
  const perms = await getEffectivePermissionsFor(me);
  const visible =
    perms.allowed_number_ids === null
      ? rows
      : rows.filter((r) => perms.allowed_number_ids!.includes(r.phone_number_id));

  const stats = await Promise.all(
    visible.map(async (n) => {
      const bpid = n.phone_number_id;
      // Local DB counts always. Evolution counts only when applicable;
      // wrap in catch so a single sick instance doesn't poison the
      // whole stats response.
      const evolutionPromise =
        n.provider === "evolution" && n.evolution_instance_name && n.evolution_api_key
          ? fetchEvolutionInstanceTotals({
              instanceName: n.evolution_instance_name,
              apiKey: n.evolution_api_key,
            }).catch(() => null)
          : Promise.resolve(null);

      const [c, m, evo] = await Promise.all([
        admin
          .from("contacts")
          .select("id", { count: "exact", head: true })
          .eq("business_phone_number_id", bpid),
        admin
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("business_phone_number_id", bpid),
        evolutionPromise,
      ]);
      return {
        bpid,
        contacts: c.count ?? 0,
        messages: m.count ?? 0,
        evolution: evo,
      };
    }),
  );

  return NextResponse.json({ stats });
}
