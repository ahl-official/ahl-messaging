// GET    /api/campaigns/[id]            — campaign + recipients + counters
// PATCH  /api/campaigns/[id]            — edit draft
// DELETE /api/campaigns/[id]            — cancel (works in any state except completed)

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const admin = createServiceRoleClient();

  const [{ data: campaign }, { data: recipients }] = await Promise.all([
    admin.from("campaigns").select("*").eq("id", id).maybeSingle(),
    admin
      .from("campaign_recipients")
      .select("*")
      .eq("campaign_id", id)
      .order("created_at", { ascending: true })
      .limit(2000),
  ]);

  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  // Engagement derived from the messages table (works without the
  // button_clicked column):
  //   • clicked_count        — recipients who tapped a button at all.
  //   • workflow_completion  — how FAR tappers got through the
  //     template-reply workflow (0–100%). Each reply-step the client
  //     answers counts; finishing the flow = 100%, halfway = ~50%. The
  //     campaign value is the average across everyone who tapped.
  let clickedCount = 0;
  let repliedCount = 0;
  let workflowCompletionPct = 0;
  const workflowProgress: Array<{ wa_id: string; display_name: string | null; replies: number; pct: number }> = [];
  const waIds = [...new Set((recipients ?? []).map((r) => r.wa_id as string).filter(Boolean))];
  const nameByWa = new Map<string, string | null>();
  for (const r of recipients ?? []) {
    if (!nameByWa.has(r.wa_id as string)) nameByWa.set(r.wa_id as string, (r.display_name as string | null) ?? null);
  }
  // LSQ Lead Number (#474893) per number — shown in the Button-clicks list / CSV.
  const leadNumberByWa = new Map<string, string | null>();
  // Latest button tap / inbound reply per number, rebuilt from the messages
  // table so old campaigns also populate the Button-clicks report.
  const tapByWa = new Map<string, { label: string; at: string }>();
  const replyByWa = new Map<string, { text: string; at: string }>();
  if (waIds.length > 0) {
    const { data: contacts } = await admin
      .from("contacts")
      .select("id, wa_id, lsq_lead_number")
      .in("wa_id", waIds)
      .eq("business_phone_number_id", campaign.business_phone_number_id);
    for (const c of contacts ?? []) leadNumberByWa.set(c.wa_id as string, (c.lsq_lead_number as string | null) ?? null);
    const contactIds = (contacts ?? []).map((c) => c.id as string);
    const waByContact = new Map<string, string>();
    for (const c of contacts ?? []) waByContact.set(c.id as string, c.wa_id as string);
    if (contactIds.length > 0) {
      const since =
        (campaign.started_at as string | null) ?? (campaign.created_at as string);
      const { data: inbound } = await admin
        .from("messages")
        .select("contact_id, type, content, timestamp")
        .in("contact_id", contactIds)
        .eq("direction", "inbound")
        .gte("timestamp", since);

      // Tappers = contacts with a button/interactive inbound. Repliers =
      // contacts with ANY inbound after the send (text or tap) — that's the
      // live "replied" count, independent of the recipient.status column /
      // counter recompute.
      const tappers = new Set<string>();
      const repliers = new Set<string>();
      const replyCount = new Map<string, number>();
      // Reconstruct button taps + replies from the messages table so OLD
      // campaigns (sent before recipient.button_clicked was recorded) still
      // populate the Button-clicks report. Interakt delivers button taps as a
      // plain "text" message (no interactive type), so for Interakt campaigns
      // any inbound reply counts as engagement. Keep the LATEST inbound per number.
      const isInteraktCampaign = String(campaign.business_phone_number_id ?? "").startsWith("interakt:");
      for (const m of inbound ?? []) {
        const cid = m.contact_id as string;
        replyCount.set(cid, (replyCount.get(cid) ?? 0) + 1);
        repliers.add(cid);
        const wa = waByContact.get(cid);
        const ts = (m.timestamp as string | null) ?? "";
        const text = (m.content as string | null)?.trim() || "";
        const isTap = m.type === "button" || m.type === "interactive" || (isInteraktCampaign && text.length > 0);
        if (isTap) tappers.add(cid);
        if (wa && text) {
          if (isTap) {
            const prev = tapByWa.get(wa);
            if (!prev || ts > prev.at) tapByWa.set(wa, { label: text, at: ts });
          }
          const prevR = replyByWa.get(wa);
          if (!prevR || ts > prevR.at) replyByWa.set(wa, { text, at: ts });
        }
      }
      clickedCount = tappers.size;
      repliedCount = repliers.size;

      // Flow depth = number of nodes that wait for a client reply
      // (wait_reply + message_buttons) in the template-reply flow this
      // campaign's template triggers. That's how many answers = 100%.
      let flowSteps = 0;
      const { data: flows } = await admin
        .from("trigger_flows")
        .select("id, trigger_config")
        .eq("business_phone_number_id", campaign.business_phone_number_id)
        .eq("trigger_type", "template_reply")
        .eq("enabled", true);
      const wantTpl = String(campaign.template_name ?? "").trim().toLowerCase();
      const flow =
        (flows ?? []).find((f) => {
          const t = String(
            (f.trigger_config as { template_name?: string } | null)?.template_name ?? "",
          )
            .trim()
            .toLowerCase();
          return !t || t === wantTpl;
        }) ?? (flows ?? [])[0];
      if (flow) {
        const { data: nodes } = await admin
          .from("trigger_nodes")
          .select("node_type")
          .eq("flow_id", flow.id as string);
        flowSteps = (nodes ?? []).filter(
          (n) => n.node_type === "wait_reply" || n.node_type === "message_buttons",
        ).length;
      }

      if (tappers.size > 0) {
        let sum = 0;
        for (const cid of tappers) {
          const replies = replyCount.get(cid) ?? 0;
          const frac = flowSteps > 0 ? Math.min(replies / flowSteps, 1) : replies > 0 ? 1 : 0;
          sum += frac;
          const wa = waByContact.get(cid) ?? "";
          workflowProgress.push({
            wa_id: wa,
            display_name: nameByWa.get(wa) ?? null,
            replies,
            pct: Math.round(frac * 100),
          });
        }
        // Average completion across everyone we SENT to — a recipient who
        // never tapped counts as 0%. So "1 of 4 fully completed" = 25%,
        // not 100%.
        const denom = Math.max(1, campaign.sent_count as number);
        workflowCompletionPct = Math.round((sum / denom) * 100);
        workflowProgress.sort((a, b) => b.pct - a.pct);
      }
    }
  }

  return NextResponse.json({
    campaign,
    recipients: (recipients ?? []).map((r) => {
      const wa = r.wa_id as string;
      const tap = tapByWa.get(wa);
      const rep = replyByWa.get(wa);
      return {
        ...r,
        lead_number: leadNumberByWa.get(wa) ?? null,
        // Fall back to the messages-derived tap/reply for campaigns sent before
        // these columns were recorded (so the report is never empty for taps
        // that actually happened).
        button_clicked: (r.button_clicked as string | null) ?? tap?.label ?? null,
        button_clicked_at: (r.button_clicked_at as string | null) ?? tap?.at ?? null,
        reply_text: (r.reply_text as string | null) ?? rep?.text ?? null,
      };
    }),
    clicked_count: clickedCount,
    replied_count: repliedCount,
    workflow_completion_pct: workflowCompletionPct,
    workflow_progress: workflowProgress,
  });
}

interface PatchBody {
  name?: string;
  template_name?: string;
  template_language?: string;
  template_components?: unknown;
  template_body_preview?: string;
  magic_prompt?: string;
  magic_persona_override?: string | null;
  magic_tone?: string | null;
  schedule_at?: string | null;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  rate_limit_per_minute?: number;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const { id } = await params;
  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data: existing } = await admin
    .from("campaigns")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (!["draft", "scheduled"].includes(existing.status)) {
    return NextResponse.json(
      { error: `Cannot edit a ${existing.status} campaign — duplicate to a new draft instead.` },
      { status: 400 },
    );
  }

  const update: Record<string, unknown> = {};
  if (body.name !== undefined) update.name = body.name.trim();
  if (body.template_name !== undefined) update.template_name = body.template_name.trim() || null;
  if (body.template_language !== undefined) update.template_language = body.template_language.trim() || null;
  if (body.template_components !== undefined) update.template_components = body.template_components;
  if (body.template_body_preview !== undefined) update.template_body_preview = body.template_body_preview.trim() || null;
  if (body.magic_prompt !== undefined) update.magic_prompt = body.magic_prompt.trim() || null;
  if (body.magic_persona_override !== undefined) update.magic_persona_override = body.magic_persona_override;
  if (body.magic_tone !== undefined) update.magic_tone = body.magic_tone;
  if (body.schedule_at !== undefined) update.schedule_at = body.schedule_at;
  if (body.quiet_hours_start !== undefined) update.quiet_hours_start = body.quiet_hours_start;
  if (body.quiet_hours_end !== undefined) update.quiet_hours_end = body.quiet_hours_end;
  if (body.rate_limit_per_minute !== undefined) {
    update.rate_limit_per_minute = Math.max(1, Math.min(120, body.rate_limit_per_minute));
  }

  const { data, error } = await admin
    .from("campaigns")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ campaign: data });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const { id } = await params;
  // ?purge=1 → hard-delete the campaign + its recipients (remove from list
  // entirely). Default → "stop": cancel an active campaign, delete a draft.
  const purge = request.nextUrl.searchParams.get("purge") === "1";
  const admin = createServiceRoleClient();
  const { data: existing } = await admin
    .from("campaigns")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (purge || existing.status === "draft" || existing.status === "scheduled") {
    // Hard-delete — recipients first (no FK cascade assumed), then the row.
    await admin.from("campaign_recipients").delete().eq("campaign_id", id);
    await admin.from("campaigns").delete().eq("id", id);
    return NextResponse.json({ ok: true, deleted: true });
  }

  // Stop a sending/completed campaign — keep the row for history.
  await admin.from("campaigns").update({ status: "canceled" }).eq("id", id);
  await admin
    .from("campaign_recipients")
    .update({ status: "skipped" })
    .eq("campaign_id", id)
    .in("status", ["pending", "sending"]);
  return NextResponse.json({ ok: true, stopped: true });
}
