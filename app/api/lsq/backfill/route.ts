// Resumable LSQ stage backfill — bulk export engine.
//
//   GET  /api/lsq/backfill  → current progress
//   POST /api/lsq/backfill  → process the next chunk of LSQ pages
//
// Instead of one rate-limited lookup per contact (hours for 11k rows),
// this walks LSQ's bulk export — Leads.RecentlyModified, 1000 leads per
// call — and matches phones against the local contacts table. A whole
// account exports in ~300 calls regardless of contact count.
//
// One POST handles a chunk of pages (well under the 300s limit); the
// client loops POSTs until `done`. Progress lives in `app_settings` so
// a backfill survives a tab close — reopen the card and it resumes.
//
// Owner-only. Supersedes the old per-contact /api/lsq/sync-all.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getLsqConfig, lsqFetchLeadsPage } from "@/lib/lsq";
import { getAppSetting, setAppSetting } from "@/lib/app-settings";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const CURSOR_KEY = "lsq_backfill_cursor";
const STATS_KEY = "lsq_backfill_stats";
const PAGE_SIZE = 1000;
// LSQ pages fetched per POST. The 10-calls/5s rate limit means ~30
// pages take ~20s — frequent client updates, no timeout risk.
const PAGES_PER_REQUEST = 30;
// Parallelism for the local contact UPDATE writes (Supabase, not LSQ —
// no rate limit). Keeps each chunk's writes fast.
const WRITE_CONCURRENCY = 25;

interface BackfillStats {
  pages_done: number;
  total_pages: number;
  leads_scanned: number;
  total_leads: number;
  contacts_updated: number;
  updated_at: string;
}

const ZERO_STATS: BackfillStats = {
  pages_done: 0,
  total_pages: 0,
  leads_scanned: 0,
  total_leads: 0,
  contacts_updated: 0,
  updated_at: new Date(0).toISOString(),
};

async function readStats(): Promise<BackfillStats> {
  const raw = await getAppSetting(STATS_KEY);
  if (!raw) return { ...ZERO_STATS };
  try {
    return { ...ZERO_STATS, ...(JSON.parse(raw) as Partial<BackfillStats>) };
  } catch {
    return { ...ZERO_STATS };
  }
}

async function progress() {
  const [cursor, stats] = await Promise.all([
    getAppSetting(CURSOR_KEY),
    readStats(),
  ]);
  return {
    stats,
    done: cursor === "DONE",
    started: !!cursor && cursor !== "",
  };
}

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  return NextResponse.json(await progress(), {
    headers: { "Cache-Control": "no-store" },
  });
}

interface IndexedContact {
  id: string;
  name: string | null;
}

/** Build a phone-index of every contact: trailing-10-digits → contacts.
 *  wa_id carries the country code; LSQ phones may or may not — the
 *  national 10-digit tail is the reliable join key. `name` rides along
 *  so the backfill can fill a blank name without clobbering one. */
async function loadContactIndex(
  admin: ReturnType<typeof createServiceRoleClient>,
): Promise<Map<string, IndexedContact[]>> {
  const index = new Map<string, IndexedContact[]>();
  for (let from = 0; from < 500_000; from += 1000) {
    const { data } = await admin
      .from("contacts")
      .select("id, wa_id, name")
      .order("id", { ascending: true })
      .range(from, from + 999);
    const rows = (data ?? []) as Array<{
      id: string;
      wa_id: string;
      name: string | null;
    }>;
    for (const r of rows) {
      const digits = (r.wa_id ?? "").replace(/\D/g, "");
      if (digits.length < 10) continue;
      const key = digits.slice(-10);
      const entry: IndexedContact = { id: r.id, name: r.name };
      const list = index.get(key);
      if (list) list.push(entry);
      else index.set(key, [entry]);
    }
    if (rows.length < 1000) break;
  }
  return index;
}

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  if (!getLsqConfig().configured) {
    return NextResponse.json({ error: "LSQ not configured" }, { status: 400 });
  }

  let restart = false;
  try {
    const body = (await request.json()) as { restart?: boolean };
    restart = body?.restart === true;
  } catch {
    /* empty body is fine */
  }

  let cursor = (await getAppSetting(CURSOR_KEY)) ?? "";
  let stats = await readStats();

  if (restart) {
    stats = { ...ZERO_STATS };
    cursor = "";
  }
  if (cursor === "DONE") {
    return NextResponse.json({ stats, done: true, started: true });
  }

  const startPage = cursor === "" ? 1 : Number.parseInt(cursor, 10) || 1;
  const admin = createServiceRoleClient();
  const contactIndex = await loadContactIndex(admin);

  // Collect this chunk's updates keyed by contact id (last lead wins).
  const updates = new Map<
    string,
    {
      lsq_stage: string;
      lsq_lead_number: string | null;
      lsq_owner_name: string | null;
      lsq_owner_email: string | null;
      lsq_prospect_id: string | null;
      name?: string;
    }
  >();

  let done = false;
  let page = startPage;
  for (let i = 0; i < PAGES_PER_REQUEST; i++, page++) {
    const res = await lsqFetchLeadsPage(page, PAGE_SIZE);
    if (!res.ok) {
      return NextResponse.json(
        { error: `LSQ export failed on page ${page}: ${res.error}` },
        { status: 502 },
      );
    }
    if (stats.total_leads === 0 && res.record_count > 0) {
      stats.total_leads = res.record_count;
      stats.total_pages = Math.ceil(res.record_count / PAGE_SIZE);
    }
    for (const lead of res.leads) {
      if (!lead.phone || !lead.stage) continue;
      const digits = lead.phone.replace(/\D/g, "");
      if (digits.length < 10) continue;
      const matches = contactIndex.get(digits.slice(-10));
      if (!matches) continue;
      const lsqName = (lead.first_name ?? "").trim();
      for (const c of matches) {
        updates.set(c.id, {
          lsq_stage: lead.stage,
          lsq_lead_number: lead.lead_number,
          lsq_owner_name: lead.owner_name,
          lsq_owner_email: lead.owner_email?.trim().toLowerCase() ?? null,
          lsq_prospect_id: lead.prospect_id,
          // Fill a blank contact name from the LSQ lead — so number-only
          // cards in the inbox get a real name. Never overwrite a name
          // the contact already has.
          ...(lsqName && !(c.name ?? "").trim() ? { name: lsqName } : {}),
        });
      }
    }
    stats.leads_scanned += res.leads.length;
    stats.pages_done++;
    if (res.leads.length < PAGE_SIZE) {
      done = true;
      break;
    }
  }

  // Apply the chunk's contact updates (parallel — Supabase, not LSQ).
  const now = new Date().toISOString();
  const entries = Array.from(updates.entries());
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(WRITE_CONCURRENCY, entries.length) }, async () => {
      while (idx < entries.length) {
        const [id, patch] = entries[idx++];
        await admin
          .from("contacts")
          .update({ ...patch, lsq_synced_at: now })
          .eq("id", id);
      }
    }),
  );

  stats.contacts_updated += entries.length;
  stats.updated_at = now;
  const nextCursor = done ? "DONE" : String(page);

  await Promise.all([
    setAppSetting(CURSOR_KEY, nextCursor),
    setAppSetting(STATS_KEY, JSON.stringify(stats)),
  ]);

  return NextResponse.json({ stats, done, started: true });
}
