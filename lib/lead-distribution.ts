// Lead Distribution engine (Phase 2).
//
// Flow per incoming LSQ lead (from the webhook):
//   1. Classify by phone country code → national / hindi_intl / english_intl
//      (mirrors the n8n country-code lists).
//   2. Build the candidate agent set:
//        • if an enabled stage-group matches the lead's stage → only that
//          group's agents;
//        • else the whole active pool.
//   3. Filter candidates by region:
//        • hindi_intl   → international_lead = "Hindi International"
//        • english_intl → international_lead = "English International"
//        • national     → everyone (any tag).
//      …plus active, not on week-off today, and under daily cap.
//   4. Pick by priority ↑, then leads_today ↑, then last_assigned_at ↑
//      (round-robin) and assign the lead's OwnerId in LSQ via Lead.Update.
//
// Off working hours → the lead stays `pending` and a later run (drain)
// assigns it once the window opens.

import { createServiceRoleClient } from "@/lib/supabase/server";
import { lsqUpdateLead, lsqGetLeadById } from "@/lib/lsq";

export type LeadCategory = "national" | "hindi_intl" | "english_intl";

// Country codes (without +) → which international PT bucket. From the n8n
// "check international english or hindi" Function node.
const HINDI_PT_CODES = ["977", "880", "971", "966", "968", "94", "95", "98", "93", "62", "60", "7"];
const ENGLISH_PT_CODES = ["61", "64", "34", "39", "41", "44", "90", "46", "45", "47", "63", "65", "81", "66", "27", "55", "1"];

/** Classify a phone (digits only) into a routing category. India / no-code /
 *  ≤10-digit (bare Indian mobile) → national; otherwise match the code lists.
 *  Unknown international codes fall back to national (assign to everyone). */
export function classifyCategory(rawDigits: string): LeadCategory {
  const d = (rawDigits || "").replace(/\D/g, "");
  if (!d || d.length <= 10 || d.startsWith("91")) return "national";
  for (const c of HINDI_PT_CODES) if (d.startsWith(c)) return "hindi_intl";
  for (const c of ENGLISH_PT_CODES) if (d.startsWith(c)) return "english_intl";
  return "national";
}

const INTL_TAG: Record<LeadCategory, string | null> = {
  national: null,
  hindi_intl: "Hindi International",
  english_intl: "English International",
};

function istWeekday(now: Date): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "Asia/Kolkata" }).format(now);
}
function istHHMM(now: Date): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).format(now);
}
export function isWithinWorkingHours(start: string, end: string, now = new Date()): boolean {
  const t = istHHMM(now);
  // Same-day window (start < end) — the only shape the UI allows.
  return t >= (start || "00:00") && t <= (end || "23:59");
}

interface AgentRow {
  lsq_id: string;
  agent_name: string | null;
  agent_email: string | null;
  priority: string | null;
  leads_today: number;
  daily_cap: number;
  week_off: string | null;
  is_active: boolean;
  last_assigned_at: string | null;
  international_lead: string | null;
}

interface GroupRow {
  stages: string[];
  agent_ids: string[];
  brands: string[];
  enabled: boolean;
  priority: number;
  working_start?: string;
  working_end?: string;
}

/** The enabled stage group whose stages include this stage (and brand, if the
 *  group is brand-scoped). Lowest priority wins. null = no group matches. */
export function matchStageGroup(groups: GroupRow[], stage: string | null, leadBrand: string | null): GroupRow | null {
  if (!stage) return null;
  const s = stage.trim().toLowerCase();
  const b = (leadBrand ?? "").trim().toLowerCase();
  return (
    groups
      .filter((g) => {
        if (!g.enabled) return false;
        if (!(g.stages ?? []).some((x) => x.trim().toLowerCase() === s)) return false;
        const brands = (g.brands ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean);
        if (brands.length > 0 && (!b || !brands.includes(b))) return false;
        return true;
      })
      .sort((a, b2) => (a.priority ?? 100) - (b2.priority ?? 100))[0] ?? null
  );
}

/** Pick the next eligible agent for a lead, honouring stage-group routing
 *  (stage + optional brand), region tag, week-off, daily cap, priority and
 *  round-robin. Returns null when nobody is eligible. */
export function pickAgent(
  agents: AgentRow[],
  groups: GroupRow[],
  category: LeadCategory,
  stage: string | null,
  leadBrand: string | null,
  now = new Date(),
): AgentRow | null {
  const today = istWeekday(now);

  // Stage-group narrowing — lowest priority group whose stages include the
  // lead's stage (and brand, if the group is brand-scoped) wins; restrict
  // candidates to its agents.
  let allowedIds: Set<string> | null = null;
  if (stage) {
    const s = stage.trim().toLowerCase();
    const b = (leadBrand ?? "").trim().toLowerCase();
    const match = groups
      .filter((g) => {
        if (!g.enabled) return false;
        if (!(g.stages ?? []).some((x) => x.trim().toLowerCase() === s)) return false;
        const brands = (g.brands ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean);
        if (brands.length > 0 && (!b || !brands.includes(b))) return false;
        return true;
      })
      .sort((a, b2) => (a.priority ?? 100) - (b2.priority ?? 100))[0];
    if (match) allowedIds = new Set(match.agent_ids ?? []);
  }

  const wantTag = INTL_TAG[category];
  const eligible = agents.filter((a) => {
    if (!a.is_active) return false;
    if (allowedIds && !allowedIds.has(a.lsq_id)) return false;
    // Region: international categories require the exact tag; national takes
    // anyone.
    if (wantTag && (a.international_lead ?? "").trim() !== wantTag) return false;
    if (a.week_off && a.week_off.trim().toLowerCase() === today.toLowerCase()) return false;
    if ((a.leads_today ?? 0) >= (a.daily_cap ?? 0)) return false;
    return true;
  });
  if (eligible.length === 0) return null;

  // Round-robin: whoever has the FEWEST leads today gets the next one, so 20
  // leads spread 1-1-1 across agents instead of dumping 20 on the top agent.
  // Priority is the tie-breaker — at an equal count, the lower priority number
  // goes first. (For international leads the eligible set is already restricted
  // to the matching language tag, so it round-robins within that group.)
  eligible.sort((a, b) => {
    if ((a.leads_today ?? 0) !== (b.leads_today ?? 0)) return (a.leads_today ?? 0) - (b.leads_today ?? 0);
    const pa = parseInt(String(a.priority ?? "999"), 10) || 999;
    const pb = parseInt(String(b.priority ?? "999"), 10) || 999;
    if (pa !== pb) return pa - pb;
    const la = a.last_assigned_at ? new Date(a.last_assigned_at).getTime() : 0;
    const lb = b.last_assigned_at ? new Date(b.last_assigned_at).getTime() : 0;
    return la - lb;
  });
  return eligible[0];
}

export interface AssignOutcome {
  ok: boolean;
  status: "assigned" | "pending" | "skipped";
  agent_email: string | null;
  agent_name: string | null;
  category: LeadCategory;
  reason: string | null;
}

/** Assign one pending row. Loads config/agents/groups, picks an agent,
 *  writes OwnerId in LSQ, and updates the pending row + agent counters.
 *  Best-effort — never throws; returns the outcome for logging. */
export async function assignPendingLead(pendingId: string): Promise<AssignOutcome> {
  const admin = createServiceRoleClient();
  const base: AssignOutcome = { ok: false, status: "pending", agent_email: null, agent_name: null, category: "national", reason: null };

  const { data: row } = await admin
    .from("lead_distribution_pending")
    .select("*")
    .eq("id", pendingId)
    .maybeSingle();
  if (!row || row.status !== "pending") return { ...base, reason: "not pending" };

  const payload = (row.lead ?? {}) as Record<string, unknown>;
  const lead = (payload.After ?? payload.body ?? payload) as Record<string, unknown>;
  const prospectId = String(lead.ProspectID ?? lead.ProspectId ?? "").trim();
  const stage = (lead.ProspectStage ?? lead.Stage ?? null) as string | null;
  let leadBrand = String(lead.mx_Brand ?? lead.Brand ?? "").trim();
  const category = classifyCategory(String(row.mobile ?? lead.Phone ?? lead.Mobile ?? ""));
  base.category = category;

  const { data: config } = await admin.from("lead_distribution_config").select("*").eq("id", true).maybeSingle();
  if (!config?.enabled) return { ...base, status: "pending", reason: "distribution disabled" };

  if (!prospectId) {
    await admin.from("lead_distribution_pending").update({ status: "skipped" }).eq("id", pendingId);
    return { ...base, status: "skipped", reason: "no ProspectID in payload" };
  }

  // Dedup — the webhook fires on BOTH Lead Creation and Stage Change, so the
  // same lead can arrive twice. Assign it only once.
  const { data: already } = await admin
    .from("lead_distribution_pending")
    .select("id")
    .eq("prospect_id", prospectId)
    .eq("status", "assigned")
    .neq("id", pendingId)
    .limit(1);
  if (already && already.length > 0) {
    await admin.from("lead_distribution_pending").update({ status: "skipped" }).eq("id", pendingId);
    return { ...base, status: "skipped", reason: "lead already assigned" };
  }

  const [{ data: agents }, { data: groups }] = await Promise.all([
    admin.from("haridwar_sales_agents").select("*").limit(500),
    admin.from("lead_distribution_groups").select("stages, agent_ids, brands, enabled, priority, working_start, working_end").limit(200),
  ]);

  // A brand-scoped group needs the lead's brand — fetch it from LSQ if the
  // webhook payload didn't carry mx_Brand.
  const groupRows = (groups ?? []) as GroupRow[];
  if (!leadBrand && prospectId && groupRows.some((g) => (g.brands ?? []).length > 0)) {
    const fetched = await lsqGetLeadById(prospectId);
    leadBrand = String(fetched.fields?.mx_Brand ?? "").trim();
  }

  // Working hours come from the matched stage group (falling back to the
  // config window when no group matches). Outside the window → stay pending.
  const matched = matchStageGroup(groupRows, stage, leadBrand || null);
  const winStart = matched?.working_start || config.working_start || "10:00";
  const winEnd = matched?.working_end || config.working_end || "18:30";
  if (!isWithinWorkingHours(winStart, winEnd)) {
    return { ...base, status: "pending", reason: "outside working hours" };
  }

  const agent = pickAgent((agents ?? []) as AgentRow[], groupRows, category, stage, leadBrand || null);
  if (!agent) {
    return { ...base, status: "pending", reason: "no eligible agent (cap/week-off/tag)" };
  }

  // Write the owner in LSQ. LSQ rejects an inactive/invalid owner, so a
  // deactivated agent surfaces as an error and the lead stays pending.
  const res = await lsqUpdateLead(prospectId, [{ Attribute: "OwnerId", Value: agent.lsq_id }]);
  if (!res.ok) {
    return { ...base, status: "pending", agent_email: agent.agent_email, agent_name: agent.agent_name, reason: res.error ?? "LSQ assign failed" };
  }

  await admin
    .from("lead_distribution_pending")
    .update({ status: "assigned", assigned_agent: agent.agent_email ?? agent.agent_name ?? agent.lsq_id })
    .eq("id", pendingId);
  await admin
    .from("haridwar_sales_agents")
    .update({ leads_today: (agent.leads_today ?? 0) + 1, last_assigned_at: new Date().toISOString() })
    .eq("lsq_id", agent.lsq_id);

  return { ok: true, status: "assigned", agent_email: agent.agent_email, agent_name: agent.agent_name, category, reason: null };
}

/** Record an incoming LSQ lead into the distribution queue and try to assign
 *  it. Deduped by ProspectID so the SAME lead arriving via multiple webhooks
 *  / events (Lead Creation + Stage Change, or the inbox webhook too) becomes
 *  one row — refreshed in place, assigned once. Best-effort; never throws. */
export async function ingestDistributionLead(
  payload: Record<string, unknown>,
): Promise<{ id: string | null; category: LeadCategory; outcome: AssignOutcome | null }> {
  const admin = createServiceRoleClient();
  const lead = (payload.After ?? payload.body ?? payload) as Record<string, unknown>;
  const digits = String(lead.Phone ?? lead.Mobile ?? lead.mobile ?? "").replace(/[^\d]/g, "");
  const category = classifyCategory(digits);
  const region = category === "national" ? "national" : "international";
  const prospectId = String(lead.ProspectID ?? lead.ProspectId ?? "").trim() || null;
  let brand = String(lead.mx_Brand ?? lead.Brand ?? "").trim() || null;

  // Denormalised summary — so the list views don't have to read the jsonb.
  const summary = {
    stage: String(lead.ProspectStage ?? lead.Stage ?? "").trim() || null,
    lead_name: String(lead.FirstName ?? lead.Name ?? "").trim() || null,
    owner_email: String(lead.OwnerIdEmailAddress ?? lead.OwnerEmailAddress ?? "").trim().toLowerCase() || null,
    lead_number: String(lead.ProspectAutoId ?? lead.leadnumber ?? "").trim() || null,
  };

  // Resolve the brand from LSQ once (the webhook payload rarely carries it) so
  // the Executions brand filter has something to match on.
  async function resolveBrand(): Promise<string | null> {
    if (brand || !prospectId) return brand;
    try {
      const fetched = await lsqGetLeadById(prospectId);
      brand = String(fetched.fields?.mx_Brand ?? "").trim() || null;
    } catch {
      /* leave null */
    }
    return brand;
  }

  let id: string | null = null;
  if (prospectId) {
    const { data: existing } = await admin
      .from("lead_distribution_pending")
      .select("id, status, brand")
      .eq("prospect_id", prospectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      id = existing.id as string;
      // Only look the brand up if we don't already have it stored.
      const storedBrand = (existing.brand as string | null)?.trim() || null;
      const b = storedBrand ?? (await resolveBrand());
      // Refresh the payload/stage; re-queue unless it's already assigned.
      const reset = existing.status === "assigned" ? {} : { status: "pending" };
      await admin
        .from("lead_distribution_pending")
        .update({ lead: payload, mobile: digits || null, region, brand: b, ...summary, ...reset })
        .eq("id", id);
    }
  }
  if (!id) {
    const b = await resolveBrand();
    const { data: ins } = await admin
      .from("lead_distribution_pending")
      .insert({ mobile: digits || null, region, lead: payload, status: "pending", prospect_id: prospectId, brand: b, ...summary })
      .select("id")
      .single();
    id = (ins?.id as string | undefined) ?? null;
  }

  let outcome: AssignOutcome | null = null;
  if (id) {
    try {
      outcome = await assignPendingLead(id);
    } catch {
      outcome = null;
    }
  }
  return { id, category, outcome };
}

/** Reset every agent's daily lead counter at IST midnight. Cheap: only
 *  writes when the stored reset date differs from today (IST). */
export async function resetDailyCountsIfNeeded(
  admin: ReturnType<typeof createServiceRoleClient>,
): Promise<void> {
  const todayIST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const { data: cfg } = await admin.from("lead_distribution_config").select("leads_reset_date").eq("id", true).maybeSingle();
  if (cfg?.leads_reset_date === todayIST) return;
  await admin.from("haridwar_sales_agents").update({ leads_today: 0 }).neq("lsq_id", "");
  await admin.from("lead_distribution_config").update({ leads_reset_date: todayIST }).eq("id", true);
}

/** Drain pending leads (off-hours queue) — called by the scheduler tick.
 *  Assigns up to `limit` oldest pending rows. */
export async function drainPendingAssignments(limit = 25): Promise<{ assigned: number; scanned: number }> {
  const admin = createServiceRoleClient();
  await resetDailyCountsIfNeeded(admin); // roll over the daily caps at IST midnight
  // Working-hours are now per-stage-group (checked inside assignPendingLead),
  // so the drain only gates on the master enable switch.
  const { data: config } = await admin.from("lead_distribution_config").select("enabled").eq("id", true).maybeSingle();
  if (!config?.enabled) {
    return { assigned: 0, scanned: 0 };
  }
  const { data: rows } = await admin
    .from("lead_distribution_pending")
    .select("id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  let assigned = 0;
  for (const r of rows ?? []) {
    const out = await assignPendingLead(r.id as string);
    if (out.status === "assigned") assigned++;
  }
  return { assigned, scanned: (rows ?? []).length };
}
