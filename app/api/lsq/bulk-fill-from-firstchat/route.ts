// POST /api/lsq/bulk-fill-from-firstchat
//
// Backfill Source / Sub-source / Brand (and any other lead_defaults) onto LSQ
// leads that came in blank. Unlike bulk-fill-source (one fixed value for every
// lead), this resolves the CORRECT value PER LEAD:
//
//   LSQ lead number → lead's phone → our contact(s) for that phone →
//   the business number the FIRST chat happened on → that number's
//   automation_configs.lead_defaults → push those fields to the lead.
//
// Only fills when the lead's Source is currently blank (never overwrites an
// existing attribution) unless `force` is set. `check: true` is read-only.
//
// Admin-only (driven from the Settings panel).
//
// Body: { lead_numbers: string[], check?: boolean, force?: boolean }

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { getCredential } from "@/lib/credentials";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getLsqConfig, lsqGetLeadByLeadNumber, lsqUpdateLead } from "@/lib/lsq";
import { recordPushFailure, markPushSucceeded } from "@/lib/lsq-push-failures";
import { buildFbAdLeadFields, type FbAdFieldMapping } from "@/lib/utm";

type Attr = { Attribute: string; Value: string };
// base wins on a duplicate Attribute (same as ensure-lead).
function mergeAttrs(base: Attr[], extra: Attr[]): Attr[] {
  const seen = new Set(base.map((f) => f.Attribute));
  return [...base, ...extra.filter((f) => !seen.has(f.Attribute))];
}
function toPairs(rows: Array<{ lsq_field?: string; value?: string }> | unknown): Attr[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((d) => ({ Attribute: String(d?.lsq_field ?? "").trim(), Value: String(d?.value ?? "").trim() }))
    .filter((f) => f.Attribute && f.Value);
}

export const runtime = "nodejs";
export const maxDuration = 800;

interface Body {
  lead_numbers?: string[];
  check?: boolean;
  force?: boolean;
  /** Shared internal token — lets a script drive this without a session. */
  token?: string;
}

interface FirstChat {
  matched_wa_id: string | null;
  bpid: string | null;
  number_label: string | null;
  fields: Array<{ Attribute: string; Value: string }>;
}

// Resolve the first-chat business number for an LSQ lead's phone, and the
// field set that number would push onto an EXISTING lead — same composition as
// ensure-lead's re-attribution path: the number's "update existing" fields
// (falling back to lead_defaults) PLUS the FB-ad fields resolved from the
// chosen contact's utm_params.
async function resolveFirstChat(
  admin: ReturnType<typeof createServiceRoleClient>,
  leadPhone: string | null,
): Promise<FirstChat> {
  const empty: FirstChat = { matched_wa_id: null, bpid: null, number_label: null, fields: [] };
  const last10 = (leadPhone ?? "").replace(/\D/g, "").slice(-10);
  if (last10.length < 10) return empty;

  // Every contact row this patient has (one per business number messaged).
  const { data: contacts } = await admin
    .from("contacts")
    .select("id, wa_id, business_phone_number_id, created_at, utm_params")
    .like("wa_id", `%${last10}`);
  if (!contacts?.length) return empty;

  // The business number the FIRST inbound landed on = earliest message across
  // those contacts. Fall back to the earliest-created contact row.
  const ids = contacts.map((c) => c.id as string);
  const { data: firstMsg } = await admin
    .from("messages")
    .select("contact_id, timestamp")
    .in("contact_id", ids)
    .order("timestamp", { ascending: true })
    .limit(1)
    .maybeSingle();

  let chosen = firstMsg
    ? contacts.find((c) => c.id === firstMsg.contact_id) ?? null
    : null;
  if (!chosen) {
    chosen = [...contacts].sort((a, b) =>
      String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
    )[0];
  }
  const bpid = (chosen?.business_phone_number_id as string | null) ?? null;
  if (!bpid) return { ...empty, matched_wa_id: (chosen?.wa_id as string) ?? null };

  const { data: cfg } = await admin
    .from("automation_configs")
    .select("lead_defaults, update_lead_fields, lsq_fb_ads_fields")
    .eq("business_phone_number_id", bpid)
    .maybeSingle();

  // Existing-lead field set — everything this number would stamp, combined
  // (the operator asked to ADD these, not swap): create defaults + the
  // dedicated "update existing" fields + the FB-ad fields resolved from THIS
  // contact's utm_params (Source ID / Campaign / …). Earlier entries win on a
  // duplicate LSQ attribute.
  const defaults = toPairs(cfg?.lead_defaults);
  const updateFields = toPairs(cfg?.update_lead_fields);
  const fbAdFields = buildFbAdLeadFields(
    (chosen?.utm_params as Record<string, unknown> | null) ?? null,
    (cfg?.lsq_fb_ads_fields as FbAdFieldMapping[] | null) ?? null,
  );
  const fields = mergeAttrs(mergeAttrs(defaults, updateFields), fbAdFields);

  const { data: bn } = await admin
    .from("business_numbers")
    .select("display_phone_number, verified_name, nickname")
    .eq("phone_number_id", bpid)
    .maybeSingle();
  const number_label =
    (bn?.nickname as string) || (bn?.verified_name as string) || (bn?.display_phone_number as string) || bpid;

  return { matched_wa_id: (chosen?.wa_id as string) ?? null, bpid, number_label, fields };
}

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  // Auth: an admin session OR the shared internal token (for scripts).
  const expected = await getCredential("webhook_internal_token");
  const auth = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const tokenOk = !!expected && (auth === expected || body.token === expected);
  if (!tokenOk) {
    const me = await getCurrentMember();
    if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isAtLeast(me.role, "admin")) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const cfg = getLsqConfig();
  if (!cfg.configured) return NextResponse.json({ error: "LSQ not configured" }, { status: 400 });

  const leadNumbers = [
    ...new Set((body.lead_numbers ?? []).map((n) => String(n).trim()).filter(Boolean)),
  ];
  if (leadNumbers.length === 0) {
    return NextResponse.json({ error: "lead_numbers required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const rows: Array<{
    lead_number: string;
    status:
      | "filled"
      | "would_fill"
      | "skipped_has_source"
      | "no_chat_found"
      | "no_defaults"
      | "lead_not_found"
      | "error";
    phone?: string | null;
    first_chat_number?: string | null;
    current_source?: string | null;
    fields?: Array<{ Attribute: string; Value: string }>;
  }> = [];

  // Throttled — LSQ rate-limits (~10 calls / 5s).
  const POOL = 3;
  let idx = 0;
  async function worker() {
    while (idx < leadNumbers.length) {
      const leadNumber = leadNumbers[idx++];
      try {
        const found = await lsqGetLeadByLeadNumber(leadNumber, cfg);
        if (!found.ok || !found.found || !found.lead?.prospect_id) {
          rows.push({ lead_number: leadNumber, status: "lead_not_found" });
          continue;
        }
        const currentSource = (found.lead.source ?? "").trim();
        const fc = await resolveFirstChat(admin, found.lead.phone);

        const base = {
          lead_number: leadNumber,
          phone: found.lead.phone,
          first_chat_number: fc.number_label,
          current_source: currentSource || null,
          fields: fc.fields,
        };

        if (!fc.bpid) {
          rows.push({ ...base, status: "no_chat_found" });
          continue;
        }
        if (fc.fields.length === 0) {
          rows.push({ ...base, status: "no_defaults" });
          continue;
        }
        if (currentSource && !body.force) {
          rows.push({ ...base, status: "skipped_has_source" });
          continue;
        }
        if (body.check) {
          rows.push({ ...base, status: "would_fill" });
          continue;
        }
        const upd = await lsqUpdateLead(found.lead.prospect_id, fc.fields);
        if (upd.ok) {
          await markPushSucceeded(leadNumber);
          rows.push({ ...base, status: "filled" });
        } else {
          // Park it — the 2-min retry heartbeat will keep trying.
          await recordPushFailure({
            lead_number: leadNumber,
            prospect_id: found.lead.prospect_id,
            phone: found.lead.phone,
            first_chat_number: fc.number_label,
            fields: fc.fields,
            error: upd.error ?? `LSQ ${upd.status}`,
            source: "bulk_firstchat",
          });
          rows.push({ ...base, status: "error" });
        }
      } catch (e) {
        rows.push({ lead_number: leadNumber, status: "error" });
        await recordPushFailure({
          lead_number: leadNumber,
          fields: [],
          error: e instanceof Error ? e.message : "exception",
          source: "bulk_firstchat",
        }).catch(() => {});
      }
    }
  }
  await Promise.all(Array.from({ length: POOL }, () => worker()));

  const summary = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({ ok: true, total: leadNumbers.length, summary, rows });
}
