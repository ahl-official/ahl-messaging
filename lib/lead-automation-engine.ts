// =====================================================================
// Lead Automation execution engine
// ---------------------------------------------------------------------
// Runs the visual flows built in Lead Distribution → Lead Automations when
// an LSQ webhook arrives. Each automation is a flow graph:
//
//   trigger → [if_else …] → action (send_template …)
//
// On every LSQ lead push we:
//   1. Load PUBLISHED automations.
//   2. Match the trigger — lead's current stage == config.change_to.
//   3. Walk the flow from the trigger node, evaluating If/Else branches
//      against the lead's fields, and firing action nodes.
//
// Currently supported action: send_template (WhatsApp template). Each fired
// action is deduped via lead_automation_runs so a re-sent webhook can't
// double-send. Wait nodes are not yet scheduled — traversal stops there.
// =====================================================================

import { createServiceRoleClient } from "@/lib/supabase/server";
import { sendTemplate, getApiVersion } from "@/lib/whatsapp";
import { requireCredsForPhoneNumberId } from "@/lib/portfolios";
import { getLsqConfig, lsqGetLeadById } from "@/lib/lsq";
import type { ParsedLsqLead } from "@/lib/lsq-webhook";

interface FlowNode {
  id: string;
  data: {
    node_type: string;
    bpid?: string;
    template?: string;
    templateLang?: string;
    sendTime?: string;
    waitAmount?: number;
    waitUnit?: string;
    criteria?: {
      match?: "any" | "all";
      conditions?: { field: string; operator: string; value: string }[];
    };
  };
}
interface FlowEdge {
  source: string;
  target: string;
  sourceHandle?: string | null;
}
interface AutomationRow {
  id: string;
  name: string;
  config: {
    change_to?: string;
    flow?: { nodes?: FlowNode[]; edges?: FlowEdge[] };
  } | null;
}

const last10 = (s: string) => s.replace(/\D/g, "").slice(-10);

// Map a UI condition-field name to the lead's value. LSQ webhook fields are
// flattened to lowercase keys (see parseLsqWebhookPayload).
function resolveField(field: string, lead: ParsedLsqLead): string {
  const f = field.trim().toLowerCase();
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const v = lead.fields[k];
      if (v != null && String(v).trim()) return String(v);
    }
    return "";
  };
  if (["phone number", "phone", "mobile", "mobile number"].includes(f)) return lead.mobile ?? "";
  if (["lead stage", "stage", "prospect stage"].includes(f)) return lead.stage ?? get("prospectstage");
  if (["lead source", "source"].includes(f)) return lead.source ?? get("mx_source", "source");
  if (["sub source", "subsource"].includes(f)) return lead.sub_source ?? get("mx_utm_source", "mx_sub_source");
  if (f === "brand") return get("mx_brand", "brand");
  if (["owner", "lead owner"].includes(f)) return lead.owner_name ?? get("owneridname");
  if (["owner email"].includes(f)) return lead.owner_email ?? get("owneridemailaddress");
  // Fallback — try the raw name + common mx_ variants.
  return get(f, "mx_" + f.replace(/\s+/g, "_"), f.replace(/\s+/g, "_"));
}

function evalCondition(cond: { field: string; operator: string; value: string }, lead: ParsedLsqLead): boolean {
  const isPhone = ["phone number", "phone", "mobile", "mobile number"].includes(cond.field.trim().toLowerCase());
  const rawActual = resolveField(cond.field, lead);
  const actual = isPhone ? last10(rawActual) : rawActual.trim().toLowerCase();
  const values = String(cond.value ?? "")
    .split(",")
    .map((v) => (isPhone ? last10(v) : v.trim().toLowerCase()))
    .filter(Boolean);
  if (values.length === 0) return false;
  const op = String(cond.operator ?? "Is").trim().toLowerCase();
  const actualSet = actual.split(",").map((x) => x.trim()).filter(Boolean);
  const eq = values.some((v) => actual === v || actualSet.includes(v));
  const has = values.some((v) => actual.includes(v));
  switch (op) {
    case "is":
    case "equals":
    case "=":
      return eq;
    case "is not":
    case "not equals":
    case "!=":
      return !eq;
    case "contains":
      return has;
    case "does not contain":
      return !has;
    case "starts with":
      return values.some((v) => actual.startsWith(v));
    default:
      return eq;
  }
}

function evalCriteria(criteria: FlowNode["data"]["criteria"], lead: ParsedLsqLead): boolean {
  const conds = criteria?.conditions ?? [];
  if (conds.length === 0) return true; // no conditions → pass
  const results = conds.map((c) => evalCondition(c, lead));
  return (criteria?.match ?? "any") === "all" ? results.every(Boolean) : results.some(Boolean);
}

// Fire-and-forget entry point — called from the LSQ webhook handler.
export async function runLeadAutomations(lead: ParsedLsqLead): Promise<number> {
  const stage = (lead.stage ?? "").trim().toLowerCase();
  if (!stage || !lead.mobile) return 0;
  const admin = createServiceRoleClient();
  const { data: autos } = await admin
    .from("lead_distribution_automations")
    .select("id, name, config")
    .eq("status", "Published");

  // Trigger filter — automations whose change_to matches this lead's stage.
  // "Any Stage" (or empty) is a wildcard: fire on ANY stage change.
  const matched = ((autos ?? []) as AutomationRow[]).filter((a) => {
    const target = (a.config?.change_to ?? "").trim().toLowerCase();
    const wildcard = !target || target === "any stage" || target === "any";
    return (wildcard || stage === target) && (a.config?.flow?.nodes?.length ?? 0) > 0;
  });
  if (matched.length === 0) return 0;

  // The LSQ stage-change webhook payload only carries STANDARD fields (stage,
  // phone, source, owner) — NOT custom fields like mx_Brand. Fetch the full
  // lead from LSQ ONLY when a condition references a non-standard field, so a
  // wildcard "any stage" trigger doesn't hammer LSQ on every change.
  const PAYLOAD_NATIVE = new Set([
    "phone number", "phone", "mobile", "mobile number", "lead stage", "stage",
    "prospect stage", "lead source", "source", "sub source", "subsource",
    "owner", "lead owner", "owner email", "first name", "name",
  ]);
  const needsLsq = matched.some((a) =>
    (a.config!.flow!.nodes ?? []).some((n) =>
      (n.data.criteria?.conditions ?? []).some((c) => !PAYLOAD_NATIVE.has(c.field.trim().toLowerCase())),
    ),
  );
  if (needsLsq && lead.prospect_id) {
    try {
      const full = await lsqGetLeadById(lead.prospect_id, getLsqConfig());
      if (full.ok) {
        for (const [k, v] of Object.entries(full.fields)) {
          if (v != null && String(v).trim()) lead.fields[k.toLowerCase()] = String(v);
        }
      }
    } catch (e) {
      console.warn(`[lead-automation] LSQ lead fetch failed:`, e instanceof Error ? e.message : e);
    }
  }

  let fired = 0;
  for (const auto of matched) {
    try {
      fired += await executeFlow(auto, auto.config!.flow!, lead, admin);
    } catch (e) {
      console.warn(`[lead-automation] ${auto.name} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return fired;
}

const WAIT_UNIT_MS: Record<string, number> = {
  second: 1000, seconds: 1000, sec: 1000,
  minute: 60_000, minutes: 60_000, min: 60_000,
  hour: 3_600_000, hours: 3_600_000,
  day: 86_400_000, days: 86_400_000,
};
function waitNodeMs(node: FlowNode): number {
  const amt = Math.max(0, Number(node.data.waitAmount ?? 0));
  const unit = String(node.data.waitUnit ?? "seconds").trim().toLowerCase();
  return amt * (WAIT_UNIT_MS[unit] ?? 1000);
}

// Next UTC instant for a "HH:MM" wall-clock time in IST (Asia/Kolkata, fixed
// UTC+5:30, no DST). If that time has already passed today, returns tomorrow's.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
function nextIstRunAt(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  const now = Date.now();
  const istNow = new Date(now + IST_OFFSET_MS); // UTC fields = IST wall clock
  const targetAsUtc = Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate(),
    Number.isFinite(h) ? h : 0,
    Number.isFinite(m) ? m : 0,
    0,
    0,
  );
  let runMs = targetAsUtc - IST_OFFSET_MS; // IST wall clock → actual UTC instant
  if (runMs <= now) runMs += 24 * 60 * 60 * 1000; // already passed → tomorrow
  return new Date(runMs).toISOString();
}

async function executeFlow(
  auto: AutomationRow,
  flow: { nodes?: FlowNode[]; edges?: FlowEdge[] },
  lead: ParsedLsqLead,
  admin: ReturnType<typeof createServiceRoleClient>,
): Promise<number> {
  const start = (flow.nodes ?? []).find((n) => n.data.node_type === "trigger");
  if (!start) return 0;
  return walkFlow(auto, flow, lead, admin, start.id);
}

// Walk the flow from startNodeId. Send nodes fire (deduped); If/Else branches
// on the lead's fields; a Wait node ENQUEUES a continuation (resume at the
// node after it, at now + wait duration) and stops this walk — the cron picks
// it up later. Resumes call walkFlow directly with the resume node id.
async function walkFlow(
  auto: AutomationRow,
  flow: { nodes?: FlowNode[]; edges?: FlowEdge[] },
  lead: ParsedLsqLead,
  admin: ReturnType<typeof createServiceRoleClient>,
  startNodeId: string,
): Promise<number> {
  const nodes = new Map((flow.nodes ?? []).map((n) => [n.id, n]));
  const childrenOf = (id: string) => (flow.edges ?? []).filter((e) => e.source === id);
  const prospect = lead.prospect_id ?? lead.mobile ?? "";

  let fired = 0;
  const seen = new Set<string>();
  const walk = async (nodeId: string): Promise<void> => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    const node = nodes.get(nodeId);
    if (!node) return;
    const t = node.data.node_type;

    if (t === "if_else" || t === "multi_if_else") {
      const branch = evalCriteria(node.data.criteria, lead) ? "yes" : "no";
      for (const e of childrenOf(nodeId)) {
        if ((e.sourceHandle ?? "yes") === branch) await walk(e.target);
      }
      return;
    }

    if (t === "send_template") {
      const sendTime = node.data.sendTime?.trim();
      const timedFor = (lead as unknown as Record<string, unknown>).__timedNode;
      // If a send time (IST) is set and we haven't waited for it yet, schedule
      // the send for the next occurrence of that time and stop here.
      if (sendTime && timedFor !== nodeId) {
        await admin.from("lead_automation_pending").insert({
          automation_id: auto.id,
          prospect_id: prospect,
          resume_node_id: nodeId,
          lead: { ...lead, __timedNode: nodeId },
          run_at: nextIstRunAt(sendTime),
        });
        return;
      }
      if (await fireSendTemplate(auto.id, node, lead, admin)) fired++;
      for (const e of childrenOf(nodeId)) await walk(e.target);
      return;
    }

    if (t === "wait") {
      // Enqueue continuation(s) at now + delay; stop this walk. Unique
      // (automation, prospect, resume_node) dedups duplicate webhooks.
      const runAt = new Date(Date.now() + waitNodeMs(node)).toISOString();
      for (const e of childrenOf(nodeId)) {
        await admin
          .from("lead_automation_pending")
          .insert({ automation_id: auto.id, prospect_id: prospect, resume_node_id: e.target, lead, run_at: runAt });
      }
      return;
    }

    // trigger + unsupported action nodes: pass straight through.
    for (const e of childrenOf(nodeId)) await walk(e.target);
  };

  await walk(startNodeId);
  return fired;
}

// Cron entry point — resume Wait continuations whose run_at has elapsed.
export async function processPendingLeadAutomations(): Promise<number> {
  const admin = createServiceRoleClient();
  const nowIso = new Date().toISOString();
  const { data: due } = await admin
    .from("lead_automation_pending")
    .select("id, automation_id, prospect_id, resume_node_id, lead")
    .lte("run_at", nowIso)
    .order("run_at", { ascending: true })
    .limit(50);
  let processed = 0;
  for (const row of due ?? []) {
    // Atomic claim — delete; if another worker already took it, skip.
    const { data: claimed } = await admin
      .from("lead_automation_pending")
      .delete()
      .eq("id", row.id)
      .select("id");
    if (!claimed || claimed.length === 0) continue;
    const { data: auto } = await admin
      .from("lead_distribution_automations")
      .select("id, name, config")
      .eq("id", row.automation_id)
      .maybeSingle();
    const a = auto as AutomationRow | null;
    if (!a?.config?.flow?.nodes?.length) continue;
    try {
      await walkFlow(a, a.config.flow, row.lead as ParsedLsqLead, admin, row.resume_node_id as string);
      processed++;
    } catch (e) {
      console.warn(`[lead-automation] resume failed:`, e instanceof Error ? e.message : e);
    }
  }
  return processed;
}

async function fireSendTemplate(
  automationId: string,
  node: FlowNode,
  lead: ParsedLsqLead,
  admin: ReturnType<typeof createServiceRoleClient>,
): Promise<boolean> {
  const bpid = node.data.bpid;
  const template = node.data.template;
  const lang = node.data.templateLang || "en_US";
  if (!bpid || !template || !lead.mobile) return false;
  if (bpid.startsWith("evo:")) {
    console.warn(`[lead-automation] send_template not supported on Evolution numbers; got ${bpid}`);
    return false;
  }

  // Dedup — one send per (automation, lead, node). A unique-constraint insert
  // is the atomic claim: if it conflicts, another run already sent it. We stamp
  // the report metadata up front (status defaults 'sent'; flipped to 'failed'
  // on a send error).
  const prospect = lead.prospect_id ?? lead.mobile;
  const name = (lead.first_name || lead.fields["firstname"] || "there").trim() || "there";
  const { error: claimErr } = await admin.from("lead_automation_runs").insert({
    automation_id: automationId,
    prospect_id: prospect,
    node_id: node.id,
    mobile: lead.mobile,
    lead_number: lead.lead_number ?? null,
    name: lead.first_name ?? null,
    template,
    status: "sent",
  });
  if (claimErr) return false; // 23505 duplicate (already sent) or insert failure

  try {
    let waMessageId: string | null = null;
    let preview = `Template: ${template}`;
    if (bpid.startsWith("interakt:")) {
      // Interakt template send — fetch the template to count body {{n}} vars,
      // fill them with the patient name, send via Interakt's API.
      const { getInteraktApiKeyForNumber, fetchInteraktTemplates, sendInteraktTemplate } = await import("@/lib/interakt");
      const apiKey = await getInteraktApiKeyForNumber(bpid);
      if (!apiKey) throw new Error("no Interakt API key for " + bpid);
      const tpls = await fetchInteraktTemplates(apiKey);
      const short = lang.split(/[_-]/)[0];
      const tpl = tpls.find((t) => t.name === template && (t.language === lang || t.language === short)) ?? tpls.find((t) => t.name === template);
      const body = tpl?.body ?? "";
      const varCount = (body.match(/\{\{\s*\d+\s*\}\}/g) ?? []).length;
      if (body) preview = body.replace(/\{\{\s*\d+\s*\}\}/g, name);
      const bodyValues = Array.from({ length: varCount }, () => name);
      const r = await sendInteraktTemplate(apiKey, lead.mobile, {
        name: template,
        languageCode: tpl?.language || lang,
        bodyValues,
      });
      waMessageId = r.messageId;
    } else {
      // Meta Cloud API template send.
      const built = await buildTemplateComponents(bpid, template, lang, lead, admin);
      preview = built.preview;
      const resp = await sendTemplate(lead.mobile, template, lang, built.components, bpid);
      waMessageId = resp.messages?.[0]?.id ?? null;
    }
    // Log the outbound so it shows in the inbox + tracks delivery status.
    await logOutbound(admin, bpid, lead.mobile, template, preview, waMessageId, lead.first_name);
    return true;
  } catch (e) {
    // Keep the row but mark it failed — surfaces in the report's Failed
    // section (instead of silently disappearing).
    await admin
      .from("lead_automation_runs")
      .update({ status: "failed" })
      .eq("automation_id", automationId)
      .eq("prospect_id", prospect)
      .eq("node_id", node.id);
    console.warn(`[lead-automation] sendTemplate failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

// Record the sent template as an outbound message (find/create the contact for
// this number on the sending business number) so it appears in the inbox.
async function logOutbound(
  admin: ReturnType<typeof createServiceRoleClient>,
  bpid: string,
  mobile: string,
  templateName: string,
  preview: string,
  waMessageId: string | null,
  firstName: string | null,
): Promise<void> {
  try {
    let { data: contact } = await admin
      .from("contacts")
      .select("id")
      .eq("wa_id", mobile)
      .eq("business_phone_number_id", bpid)
      .maybeSingle();
    if (!contact) {
      const { data: created } = await admin
        .from("contacts")
        .insert({ wa_id: mobile, business_phone_number_id: bpid, profile_name: firstName ?? null, status: "open" })
        .select("id")
        .single();
      contact = created;
    }
    if (!contact) return;
    const nowIso = new Date().toISOString();
    await admin.from("messages").insert({
      contact_id: contact.id,
      wa_message_id: waMessageId,
      direction: "outbound",
      type: "template",
      template_name: templateName,
      content: preview,
      status: "sent",
      timestamp: nowIso,
      business_phone_number_id: bpid,
      sent_by_email: "lead-automation",
    });
    await admin
      .from("contacts")
      .update({
        last_message_at: nowIso,
        last_message_preview: preview.slice(0, 120),
        last_message_direction: "outbound",
        last_message_status: "sent",
      })
      .eq("id", contact.id);
  } catch (e) {
    // Logging must never fail the send.
    console.warn(`[lead-automation] outbound log failed:`, e instanceof Error ? e.message : e);
  }
}

// Build the body parameters a template needs + a rendered preview for the
// inbox. Fetches the template from Meta to learn how many {{n}} variables its
// BODY has, then fills them with the patient's first name (the common case,
// e.g. "Good morning {{1}}"). `components` is undefined when the template has
// no body variables; `preview` is the body text with vars substituted (falls
// back to "Template: <name>").
async function buildTemplateComponents(
  bpid: string,
  templateName: string,
  lang: string,
  lead: ParsedLsqLead,
  admin: ReturnType<typeof createServiceRoleClient>,
): Promise<{ components?: unknown[]; preview: string }> {
  const name = (lead.first_name || lead.fields["firstname"] || "there").trim() || "there";
  try {
    const { data: bn } = await admin
      .from("business_numbers")
      .select("waba_id")
      .eq("phone_number_id", bpid)
      .maybeSingle();
    const waba = bn?.waba_id as string | undefined;
    if (!waba) return { preview: `Template: ${templateName}` };
    const creds = await requireCredsForPhoneNumberId(bpid);
    const ver = await getApiVersion();
    const res = await fetch(
      `https://graph.facebook.com/${ver}/${waba}/message_templates?name=${encodeURIComponent(templateName)}&limit=10`,
      { headers: { Authorization: `Bearer ${creds.access_token}` }, cache: "no-store" },
    );
    const json = (await res.json()) as { data?: Array<{ language: string; components?: Array<{ type: string; text?: string }> }> };
    const list = json.data ?? [];
    const tpl = list.find((t) => t.language === lang) ?? list[0];
    const body = (tpl?.components ?? []).find((c) => c.type === "BODY");
    const bodyText = body?.text ?? "";
    const preview = bodyText ? bodyText.replace(/\{\{\s*\d+\s*\}\}/g, name) : `Template: ${templateName}`;
    const varCount = (bodyText.match(/\{\{\s*\d+\s*\}\}/g) ?? []).length;
    if (varCount === 0) return { preview };
    const parameters = Array.from({ length: varCount }, () => ({ type: "text", text: name }));
    return { components: [{ type: "body", parameters }], preview };
  } catch (e) {
    console.warn(`[lead-automation] template var resolve failed:`, e instanceof Error ? e.message : e);
    return { preview: `Template: ${templateName}` };
  }
}
