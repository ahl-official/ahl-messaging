// Recurring (dynamic) campaign engine. Once a day per campaign:
//   pull rolling-window LSQ leads → upsert into contacts → send the template
//   to leads NOT already sent (dedup ledger) → log + record.
//
// The template-reply workflow fires on tap via the normal trigger engine
// (logging the send into `messages` is what arms it).

import { createServiceRoleClient } from "@/lib/supabase/server";
import { sendTemplate } from "@/lib/whatsapp";
import { pullLeadsFromLsq, type PullLeadsFilter, type PulledLead } from "@/lib/lsq-pull";

interface RecurringRow {
  id: string;
  name: string;
  business_phone_number_id: string;
  template_name: string;
  template_language: string | null;
  template_body_preview: string | null;
  template_components: unknown;
  filter: PullLeadsFilter | null;
  window_days: number;
  enabled: boolean;
  last_run_at: string | null;
}

// Per-run send ceiling — keeps the daily tick bounded. Anything over this
// drains on the next day's run (dedup ensures no double-send).
const PER_RUN_CAP = 300;

const istDate = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);

export interface RecurringTickResult {
  ran: number;
  sent: number;
  skipped: number;
}

export async function runRecurringDaily(): Promise<RecurringTickResult> {
  const admin = createServiceRoleClient();
  const result: RecurringTickResult = { ran: 0, sent: 0, skipped: 0 };

  const { data: campaigns } = await admin
    .from("recurring_campaigns")
    .select(
      "id, name, business_phone_number_id, template_name, template_language, template_body_preview, template_components, filter, window_days, enabled, last_run_at",
    )
    .eq("enabled", true);

  const today = istDate(new Date());
  for (const c of (campaigns ?? []) as RecurringRow[]) {
    // Once per IST day.
    if (c.last_run_at && istDate(new Date(c.last_run_at)) === today) {
      result.skipped++;
      continue;
    }
    result.ran++;
    try {
      const sent = await runOne(admin, c);
      result.sent += sent;
    } catch (e) {
      await admin
        .from("recurring_campaigns")
        .update({ last_run_at: new Date().toISOString(), last_run_error: (e instanceof Error ? e.message : "run failed").slice(0, 300) })
        .eq("id", c.id);
    }
  }
  return result;
}

async function runOne(
  admin: ReturnType<typeof createServiceRoleClient>,
  c: RecurringRow,
): Promise<number> {
  // Rolling window → created_after.
  const since = new Date(Date.now() - Math.max(1, c.window_days) * 86_400_000).toISOString();
  const filter: PullLeadsFilter = { ...(c.filter ?? {}), created_after: since, max: 5000 };
  const pull = await pullLeadsFromLsq(filter);
  if (!pull.ok) throw new Error(pull.error ?? "LSQ pull failed");

  // Upsert every matched lead into contacts (modified leads get refreshed).
  for (const lead of pull.leads) {
    await upsertContact(admin, c.business_phone_number_id, lead);
  }

  // Already-sent wa_ids for this campaign.
  const { data: prior } = await admin
    .from("recurring_campaign_sends")
    .select("wa_id")
    .eq("recurring_id", c.id);
  const alreadySent = new Set((prior ?? []).map((r) => r.wa_id as string));

  let sent = 0;
  for (const lead of pull.leads) {
    if (alreadySent.has(lead.wa_id)) continue;
    if (sent >= PER_RUN_CAP) break;
    try {
      const waMsgId = await sendOne(c, lead);
      await recordSend(admin, c, lead, waMsgId);
      sent++;
    } catch {
      // Skip a single failed send; it retries next run (not yet recorded).
    }
  }

  await admin
    .from("recurring_campaigns")
    .update({
      last_run_at: new Date().toISOString(),
      last_run_matched: pull.fetched,
      last_run_sent: sent,
      last_run_error: null,
      total_sent: (await currentTotal(admin, c.id)) + sent,
    })
    .eq("id", c.id);
  return sent;
}

async function currentTotal(admin: ReturnType<typeof createServiceRoleClient>, id: string): Promise<number> {
  const { count } = await admin
    .from("recurring_campaign_sends")
    .select("id", { count: "exact", head: true })
    .eq("recurring_id", id);
  return Math.max(0, (count ?? 0));
}

async function upsertContact(
  admin: ReturnType<typeof createServiceRoleClient>,
  bpid: string,
  lead: PulledLead,
): Promise<void> {
  const payload: Record<string, unknown> = {
    wa_id: lead.wa_id,
    business_phone_number_id: bpid,
    status: "open",
    lsq_synced_at: new Date().toISOString(),
  };
  if (lead.display_name) payload.profile_name = lead.display_name;
  if (lead.stage) payload.lsq_stage = lead.stage;
  if (lead.source) payload.lsq_source = lead.source;
  if (lead.owner) payload.lsq_owner_name = lead.owner;
  if (lead.prospect_id) payload.lsq_prospect_id = lead.prospect_id;
  await admin.from("contacts").upsert(payload, { onConflict: "wa_id,business_phone_number_id" });
}

function renderName(body: string | null, name: string | null): string {
  return (body ?? "").replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, k) =>
    k === "name" || k === "1" ? name ?? "" : "",
  );
}

async function sendOne(c: RecurringRow, lead: PulledLead): Promise<string | null> {
  const lang = c.template_language || "en";
  const name = lead.display_name || "";
  const bodyComp = name ? [{ type: "body", parameters: [{ type: "text", text: name }] }] : undefined;
  try {
    const resp = await sendTemplate(lead.wa_id, c.template_name, lang, bodyComp, c.business_phone_number_id);
    return resp.messages?.[0]?.id ?? null;
  } catch (e) {
    // Template with no {{1}} body var → retry with no components.
    if (bodyComp) {
      const resp = await sendTemplate(lead.wa_id, c.template_name, lang, undefined, c.business_phone_number_id);
      return resp.messages?.[0]?.id ?? null;
    }
    throw e;
  }
}

async function recordSend(
  admin: ReturnType<typeof createServiceRoleClient>,
  c: RecurringRow,
  lead: PulledLead,
  waMsgId: string | null,
): Promise<void> {
  // Resolve contact id + mirror into messages (arms the template-reply flow).
  let contactId: string | null = null;
  try {
    const { data: ct } = await admin
      .from("contacts")
      .select("id")
      .eq("wa_id", lead.wa_id)
      .eq("business_phone_number_id", c.business_phone_number_id)
      .maybeSingle();
    contactId = (ct?.id as string | undefined) ?? null;
    if (contactId) {
      const nowIso = new Date().toISOString();
      const content = renderName(c.template_body_preview, lead.display_name);
      await admin.from("messages").insert({
        contact_id: contactId,
        wa_message_id: waMsgId,
        direction: "outbound",
        type: "template",
        template_name: c.template_name,
        content,
        status: "sent",
        timestamp: nowIso,
        business_phone_number_id: c.business_phone_number_id,
      });
      await admin
        .from("contacts")
        .update({
          last_message_at: nowIso,
          last_message_preview: content.slice(0, 120),
          last_message_direction: "outbound",
          last_message_status: "sent",
        })
        .eq("id", contactId);
    }
  } catch {
    /* logging best-effort */
  }
  // The dedup ledger row — the source of truth for "already sent".
  await admin
    .from("recurring_campaign_sends")
    .upsert(
      { recurring_id: c.id, wa_id: lead.wa_id, contact_id: contactId, wa_message_id: waMsgId },
      { onConflict: "recurring_id,wa_id", ignoreDuplicates: true },
    );
}
