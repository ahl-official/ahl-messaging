// Sync only the un-synced (newly added) contacts with LSQ.
//
//   GET  /api/lsq/backfill-new  → how many contacts still un-synced
//   POST /api/lsq/backfill-new  → process the next batch  (body: {reset?})
//
// The full backfill walks LSQ's whole 300k-lead export. After a chat
// import you only need the handful of fresh contacts synced — this does
// a per-contact lookup of rows where `lsq_synced_at` is still null.
// Processing a contact stamps `lsq_synced_at`, so it drops out of the
// set — the run is naturally resumable with no cursor.
//
// Owner-only.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getLsqConfig, lsqGetLeadByMobile } from "@/lib/lsq";
import { getAppSetting, setAppSetting } from "@/lib/app-settings";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const STATS_KEY = "lsq_newsync_stats";
// Contacts per POST. Each is one rate-limited LSQ lookup (~8/5s), so a
// batch of 40 finishes in ~25s — well under the function limit.
const BATCH = 40;

interface NewSyncStats {
  processed: number;
  matched: number;
}

async function readStats(): Promise<NewSyncStats> {
  const raw = await getAppSetting(STATS_KEY);
  if (!raw) return { processed: 0, matched: 0 };
  try {
    const p = JSON.parse(raw) as Partial<NewSyncStats>;
    return { processed: p.processed ?? 0, matched: p.matched ?? 0 };
  } catch {
    return { processed: 0, matched: 0 };
  }
}

/** Count of contacts that have never been synced with LSQ. */
async function countRemaining(
  admin: ReturnType<typeof createServiceRoleClient>,
): Promise<number> {
  const { count } = await admin
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .is("lsq_synced_at", null);
  return count ?? 0;
}

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  const admin = createServiceRoleClient();
  const [remaining, stats] = await Promise.all([
    countRemaining(admin),
    readStats(),
  ]);
  return NextResponse.json(
    { remaining, stats },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return NextResponse.json({ error: "LSQ not configured" }, { status: 400 });
  }

  let reset = false;
  try {
    const body = (await request.json()) as { reset?: boolean };
    reset = body?.reset === true;
  } catch {
    /* empty body is fine */
  }

  const admin = createServiceRoleClient();
  let stats = reset ? { processed: 0, matched: 0 } : await readStats();

  // Next batch of never-synced contacts.
  const { data, error } = await admin
    .from("contacts")
    .select("id, wa_id, name")
    .is("lsq_synced_at", null)
    .order("id", { ascending: true })
    .limit(BATCH);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as Array<{
    id: string;
    wa_id: string;
    name: string | null;
  }>;
  const now = new Date().toISOString();

  for (const row of rows) {
    const result = await lsqGetLeadByMobile(row.wa_id, cfg);
    // Always stamp lsq_synced_at — match, miss or error — so the
    // contact leaves the un-synced set and the run can't loop forever.
    const update: Record<string, unknown> = { lsq_synced_at: now };
    if (result.ok && result.found && result.lead) {
      stats.matched++;
      update.lsq_stage = result.lead.status;
      update.lsq_lead_number = result.lead.lead_number;
      update.lsq_owner_name = result.lead.owner_name;
      update.lsq_prospect_id = result.lead.prospect_id;
      const lsqName = (result.lead.first_name ?? "").trim();
      if (lsqName && !(row.name ?? "").trim()) update.name = lsqName;
    }
    await admin.from("contacts").update(update).eq("id", row.id);
    stats.processed++;
  }

  await setAppSetting(STATS_KEY, JSON.stringify(stats));
  const remaining = await countRemaining(admin);

  return NextResponse.json({
    stats,
    remaining,
    done: rows.length < BATCH,
  });
}
