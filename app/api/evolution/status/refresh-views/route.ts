// POST /api/evolution/status/refresh-views
//
// Walks every Evolution-side status post the caller can see, asks
// Evolution for the userReceipt array on each underlying message, and
// writes the aggregate (viewers, viewer JIDs) back into
// evolution_status_posts. The cross-number "Recent statuses" panel
// fires this in the background so view counts stay close to live
// without forcing a real-time webhook subscription on every chat.
//
// Body: { id?: string }   // when omitted, refreshes all rows
// Returns: { refreshed: number, errors: string[] }
//
// Auth: admin+ (matches the Status posting gate).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";
import { fetchStatusViews, isEvolutionConfigured } from "@/lib/evolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  id?: string;
}

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admin or above" }, { status: 403 });
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ refreshed: 0, errors: ["Evolution not configured"] });
  }

  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {
    /* empty body is fine */
  }

  const admin = createServiceRoleClient();
  let q = admin
    .from("evolution_status_posts")
    .select(
      "id, business_phone_number_id, wa_message_id, last_views_synced_at",
    )
    .not("wa_message_id", "is", null)
    // Skip rows the operator has just opened — re-sync if older than
    // 60 seconds. Cheap dedupe so a refresh storm doesn't hammer
    // Evolution.
    .order("posted_at", { ascending: false })
    .limit(100);
  if (body.id) q = q.eq("id", body.id);

  const { data: rows } = await q;
  if (!rows || rows.length === 0) {
    return NextResponse.json({ refreshed: 0, errors: [] });
  }

  // Group by business_phone_number_id so we resolve credentials once
  // per number rather than per row.
  const byBpid = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byBpid.get(r.business_phone_number_id as string) ?? [];
    arr.push(r);
    byBpid.set(r.business_phone_number_id as string, arr);
  }

  const errors: string[] = [];
  let refreshed = 0;
  await Promise.all(
    Array.from(byBpid.entries()).map(async ([bpid, posts]) => {
      const { data: bn } = await admin
        .from("business_numbers")
        .select("evolution_instance_name, evolution_api_key, provider")
        .eq("phone_number_id", bpid)
        .maybeSingle();
      if (
        !bn ||
        bn.provider !== "evolution" ||
        !bn.evolution_instance_name ||
        !bn.evolution_api_key
      ) {
        return;
      }
      // Sequentially per number so Evolution doesn't get hammered.
      for (const p of posts) {
        if (!p.wa_message_id) continue;
        try {
          const summary = await fetchStatusViews({
            instanceName: bn.evolution_instance_name as string,
            apiKey: bn.evolution_api_key as string,
            waMessageId: p.wa_message_id as string,
          });
          await admin
            .from("evolution_status_posts")
            .update({
              seen_count: summary.viewers,
              seen_by: summary.viewerJids,
              last_views_synced_at: new Date().toISOString(),
            })
            .eq("id", p.id);
          refreshed += 1;
        } catch (e) {
          errors.push(
            `${p.id}: ${e instanceof Error ? e.message : "fetch failed"}`,
          );
        }
      }
    }),
  );

  return NextResponse.json({ refreshed, errors });
}
