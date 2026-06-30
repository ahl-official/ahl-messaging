// Trigger-flow execution engine (Phase 2 — visual graph flows).
//
// On an inbound message we look up the number's enabled keyword flows,
// match the text, and run the first matching flow node-by-node by
// following EDGES (trigger_edges) out of each node. Nodes send messages
// (text / image / video / buttons), assign the chat, update tags/fields,
// branch on a condition, ask-a-question and wait for the patient's reply
// (interactive buttons), fire a webhook, or delay. Sends reuse
// /api/send-message so provider routing (Meta / Evolution / Interakt) is
// automatic.
//
// Edges carry an optional branch_label:
//   condition node      → 'true' | 'false'
//   buttons/ask node    → the button label the patient picked
//   everything else     → no label (the single default out-edge)

import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential } from "@/lib/credentials";

type Admin = ReturnType<typeof createServiceRoleClient>;

interface FlowRow {
  id: string;
  business_phone_number_id: string;
  trigger_type: string;
  trigger_config: { phrases?: string[]; match?: "exact" | "contains" | "starts"; template_name?: string };
  start_node_id: string | null;
  priority: number;
}

interface NodeRow {
  id: string;
  node_type: string;
  config: Record<string, unknown>;
  next_node_id: string | null;
}

interface EdgeRow {
  from_node_id: string;
  to_node_id: string;
  branch_label: string | null;
}

interface RunContext {
  contactId: string;
  waId: string;
  bpid: string;
  contact: Record<string, unknown>;
  vars: Record<string, string>;
}

const MAX_NODES_PER_RUN = 50;
const AWAIT_REPLY = "__AWAIT_REPLY__";
const WAIT_DELAY = "__WAIT__";

// ---------------------------------------------------------------------
// Matching — does the inbound text satisfy a keyword flow's trigger?
// ---------------------------------------------------------------------
function textMatches(text: string, cfg: FlowRow["trigger_config"]): boolean {
  const phrases = (cfg.phrases ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (phrases.length === 0) return false;
  const t = text.trim().toLowerCase();
  const mode = cfg.match ?? "contains";
  return phrases.some((p) =>
    mode === "exact" ? t === p : mode === "starts" ? t.startsWith(p) : t.includes(p),
  );
}

/** Match the inbound against the number's keyword flows and run the first
 *  hit — OR resume a flow that's waiting for this patient's reply. Returns
 *  true if a flow handled the message (so the caller can skip the AI reply). */
export async function matchAndRunTriggers(params: {
  contactId: string;
  waId: string;
  bpid: string;
  inboundText: string;
  /** WhatsApp message type of the inbound ("text" | "image" | "video" |
   *  "audio" | "document" | "sticker" …). Lets a parked flow branch on
   *  whether the patient actually sent the media we asked for. */
  inboundType?: string;
  inboundMediaUrl?: string | null;
}): Promise<{ matched: boolean }> {
  const { contactId, waId, bpid, inboundText, inboundType, inboundMediaUrl } = params;
  const reply = buildReplyVars(inboundText, inboundType, inboundMediaUrl);
  // Bail only when there's truly nothing to act on — an image-only reply
  // (empty text) must still resume a flow that's waiting for media.
  if (!inboundText.trim() && reply.media_received !== "yes") return { matched: false };

  const admin = createServiceRoleClient();

  // 1) A flow waiting on this patient's reply takes precedence over new triggers.
  const resumed = await resumeWaitingRun(admin, { contactId, waId, bpid, inboundText, reply });
  if (resumed) return { matched: true };

  // 1.5) Don't STACK a second flow on a contact who is already mid-flow. If a
  //      recent run is still running/waiting (e.g. parked on a buttons node and
  //      the patient typed something off-script), leave it be instead of
  //      starting a fresh flow from a keyword / new-contact / template trigger.
  if (await hasActiveRun(admin, contactId)) return { matched: false };

  // 2) Template-reply flows — fire when this inbound is the first reply right
  //    after a template was sent to the patient (optionally a named template).
  if (await runTemplateReplyFlow(admin, { contactId, waId, bpid, inboundText })) return { matched: true };

  // 2.5) New-contact flows — fire once when a brand-new number messages us for
  //      the first time. "New" = we've never sent this contact anything (no
  //      outbound) AND the contact row was created recently. The flow's own
  //      first reply / parked wait then keeps it from re-firing.
  {
    const { data: ncFlows } = await admin
      .from("trigger_flows")
      .select("id, business_phone_number_id, trigger_type, trigger_config, start_node_id, priority")
      .eq("business_phone_number_id", bpid)
      .eq("enabled", true)
      .eq("trigger_type", "new_contact")
      .order("priority", { ascending: true });
    const ncFlow = (ncFlows ?? []).find((f) => (f as FlowRow).start_node_id) as FlowRow | undefined;
    if (ncFlow) {
      const [{ count: outboundCount }, { data: c }] = await Promise.all([
        admin.from("messages").select("id", { count: "exact", head: true }).eq("contact_id", contactId).eq("direction", "outbound"),
        admin.from("contacts").select("created_at").eq("id", contactId).maybeSingle(),
      ]);
      const createdMs = c?.created_at ? Date.parse(c.created_at as string) : 0;
      const recentlyCreated = createdMs > 0 && Date.now() - createdMs < 60 * 60_000; // 1h
      if (!outboundCount && recentlyCreated && ncFlow.start_node_id) {
        await runFlow(admin, ncFlow, { contactId, waId, bpid }, ncFlow.start_node_id);
        return { matched: true };
      }
    }
  }

  // 2.7) First-message flows — fire when ANY contact (new or returning) opens a
  //      NEW conversation: the message right before this inbound was more than a
  //      session-window ago (or there is none). The recency check naturally
  //      makes it fire once per session (the next message's previous is now
  //      recent), so it re-fires only when the patient comes back after a gap.
  {
    const { data: ncFlows } = await admin
      .from("trigger_flows")
      .select("id, business_phone_number_id, trigger_type, trigger_config, start_node_id, priority")
      .eq("business_phone_number_id", bpid)
      .eq("enabled", true)
      .eq("trigger_type", "first_message")
      .order("priority", { ascending: true });
    const fmFlow = (ncFlows ?? []).find((f) => (f as FlowRow).start_node_id) as FlowRow | undefined;
    if (fmFlow?.start_node_id) {
      // Last 2 messages: [0] = this inbound (already stored), [1] = the previous.
      const { data: recent } = await admin
        .from("messages")
        .select("timestamp")
        .eq("contact_id", contactId)
        .order("timestamp", { ascending: false })
        .limit(2);
      const prev = (recent ?? [])[1];
      const SESSION_GAP_MS = 24 * 60 * 60_000;
      const prevMs = prev?.timestamp ? Date.parse(prev.timestamp as string) : 0;
      const newSession = !prevMs || Date.now() - prevMs > SESSION_GAP_MS;
      if (newSession) {
        await runFlow(admin, fmFlow, { contactId, waId, bpid }, fmFlow.start_node_id);
        return { matched: true };
      }
    }
  }

  // 3) Otherwise try to start a keyword flow.
  const { data: flows } = await admin
    .from("trigger_flows")
    .select("id, business_phone_number_id, trigger_type, trigger_config, start_node_id, priority")
    .eq("business_phone_number_id", bpid)
    .eq("enabled", true)
    .eq("trigger_type", "keyword")
    .order("priority", { ascending: true });

  for (const flow of (flows ?? []) as FlowRow[]) {
    if (!flow.start_node_id) continue;
    if (!textMatches(inboundText, flow.trigger_config)) continue;
    await runFlow(admin, flow, { contactId, waId, bpid }, flow.start_node_id);
    return { matched: true };
  }
  return { matched: false };
}

/** Run a 'template_reply' flow if the message just before this inbound was an
 *  outbound template (i.e. the patient is replying to a template we sent). */
async function runTemplateReplyFlow(
  admin: Admin,
  base: { contactId: string; waId: string; bpid: string; inboundText: string },
): Promise<boolean> {
  const { data: flows } = await admin
    .from("trigger_flows")
    .select("id, business_phone_number_id, trigger_type, trigger_config, start_node_id, priority")
    .eq("business_phone_number_id", base.bpid)
    .eq("enabled", true)
    .eq("trigger_type", "template_reply")
    .order("priority", { ascending: true });
  if (!flows || flows.length === 0) return false;

  // [0] = the inbound we just stored, [1] = the message before it.
  const { data: recent } = await admin
    .from("messages")
    .select("direction, type, template_name")
    .eq("contact_id", base.contactId)
    .order("timestamp", { ascending: false })
    .limit(2);
  const prev = (recent ?? [])[1];
  if (!prev || prev.direction !== "outbound" || prev.type !== "template") return false;
  const prevName = String(prev.template_name ?? "").trim().toLowerCase();

  for (const flow of flows as FlowRow[]) {
    if (!flow.start_node_id) continue;
    const want = String(flow.trigger_config?.template_name ?? "").trim().toLowerCase();
    if (want && want !== prevName) continue;

    // If the entry node mirrors the template's buttons, route directly on the
    // button the patient tapped (Hindi → Hindi branch) instead of re-asking.
    const { nodes, edges } = await loadGraph(admin, flow.id);
    const start = nodes.get(flow.start_node_id);
    if (start && start.node_type === "message_buttons") {
      const label = pickButton(start, base.inboundText);
      if (label) {
        const nextId = resolveNext(start.id, label, edges, start);
        if (nextId) {
          await runFlow(admin, flow, base, nextId);
          return true;
        }
        // Button matched but no route out — fall through and run the
        // flow from the start node rather than silently doing nothing.
      }
    }
    // No button match (or plain entry) — run the flow from the start node.
    await runFlow(admin, flow, base, flow.start_node_id);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------
async function loadGraph(
  admin: Admin,
  flowId: string,
): Promise<{ nodes: Map<string, NodeRow>; edges: EdgeRow[] }> {
  const { data: nodeRows } = await admin
    .from("trigger_nodes")
    .select("id, node_type, config, next_node_id")
    .eq("flow_id", flowId);
  const { data: edgeRows } = await admin
    .from("trigger_edges")
    .select("from_node_id, to_node_id, branch_label")
    .eq("flow_id", flowId);
  const nodes = new Map<string, NodeRow>(((nodeRows ?? []) as NodeRow[]).map((n) => [n.id, n]));
  return { nodes, edges: (edgeRows ?? []) as EdgeRow[] };
}

/** Match an inbound reply to one of a buttons-node's labels. Accepts the
 *  exact label (case-insensitive) or a 1-based number ("1" → first button).
 *  Returns the chosen label, or null if nothing matched. */
function pickButton(node: NodeRow, text: string): string | null {
  const buttons = Array.isArray(node.config?.buttons)
    ? (node.config.buttons as Array<{ label?: string }>)
    : [];
  if (buttons.length === 0) return null;
  const reply = text.trim().toLowerCase();
  const asNum = Number(reply);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= buttons.length) {
    return String(buttons[asNum - 1].label ?? "");
  }
  const hit = buttons.find((b) => (b.label ?? "").trim().toLowerCase() === reply);
  return hit ? String(hit.label ?? "") : null;
}

/** Resolve the next node from `fromId`. `label` selects a branch edge; when
 *  null we take the unlabelled default out-edge, falling back to next_node_id. */
function resolveNext(
  fromId: string,
  label: string | null,
  edges: EdgeRow[],
  node: NodeRow | undefined,
): string | null {
  const outgoing = edges.filter((e) => e.from_node_id === fromId);
  if (label != null) {
    const want = label.trim().toLowerCase();
    const hit = outgoing.find(
      (e) => (e.branch_label ?? "").trim().toLowerCase() === want,
    );
    if (hit) return hit.to_node_id;
    // The tapped button's label didn't match any edge's branch label.
    // This happens whenever the operator renames a button but the edge
    // keeps its old label — extremely common, and it used to dead-end the
    // whole flow. Fall through to a sensible default instead of giving up.
  }
  // Prefer an explicit unlabeled (default) edge; else, if the node has
  // exactly one way out, just take it; else the node's linear next.
  const def = outgoing.find((e) => !e.branch_label);
  if (def) return def.to_node_id;
  if (outgoing.length === 1) return outgoing[0].to_node_id;
  return node?.next_node_id ?? null;
}

// ---------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------
async function runFlow(
  admin: Admin,
  flow: { id: string },
  base: { contactId: string; waId: string; bpid: string },
  startNodeId: string,
  existingRunId?: string,
  /** Vars to seed before execution — used on resume to inject the reply
   *  descriptors (images_received, last_reply_type, …) a condition reads. */
  seedVars?: Record<string, string>,
): Promise<void> {
  const { data: contact } = await admin
    .from("contacts")
    .select("*")
    .eq("id", base.contactId)
    .maybeSingle();

  let runId: string;
  if (existingRunId) {
    runId = existingRunId;
    await admin.from("trigger_runs").update({ status: "running" }).eq("id", runId);
  } else {
    const { data: run } = await admin
      .from("trigger_runs")
      .insert({ flow_id: flow.id, contact_id: base.contactId, status: "running", current_node_id: startNodeId })
      .select("id")
      .single();
    if (!run) return;
    runId = run.id as string;
  }

  const { nodes, edges } = await loadGraph(admin, flow.id);

  const ctx: RunContext = {
    contactId: base.contactId,
    waId: base.waId,
    bpid: base.bpid,
    contact: (contact ?? {}) as Record<string, unknown>,
    vars: {},
  };
  // Hydrate any saved run vars, then layer on the just-received reply vars.
  const { data: savedVars } = await admin.from("trigger_run_vars").select("key, value").eq("run_id", runId);
  for (const v of savedVars ?? []) ctx.vars[v.key as string] = (v.value as string) ?? "";
  if (seedVars) for (const [k, val] of Object.entries(seedVars)) ctx.vars[k] = val;

  let currentId: string | null = startNodeId;
  let steps = 0;
  try {
    while (currentId && steps < MAX_NODES_PER_RUN) {
      steps++;
      const node = nodes.get(currentId);
      if (!node) break;
      const result = await executeNode(admin, node, ctx);

      if (result === AWAIT_REPLY) {
        // Park the run; the patient's next message resumes it. If the node
        // has a timeout configured, also stamp resume_at so the tick worker
        // can fire the "timeout" branch when no reply arrives in time.
        const ms = durationMs((node.config ?? {}).timeout_value, (node.config ?? {}).timeout_unit);
        const resumeAt = ms > 0 ? new Date(Date.now() + ms).toISOString() : null;
        await admin
          .from("trigger_runs")
          .update({ status: "waiting", current_node_id: currentId, resume_at: resumeAt })
          .eq("id", runId);
        await persistVars(admin, runId, ctx.vars);
        return;
      }
      if (result === WAIT_DELAY) {
        const ms = durationMs((node.config ?? {}).minutes, "minutes");
        const resumeAt = ms > 0 ? new Date(Date.now() + ms).toISOString() : null;
        await admin
          .from("trigger_runs")
          .update({ status: "waiting", current_node_id: currentId, resume_at: resumeAt })
          .eq("id", runId);
        await persistVars(admin, runId, ctx.vars);
        return;
      }
      currentId = resolveNext(currentId, result, edges, node);
    }
    await admin
      .from("trigger_runs")
      .update({ status: "completed", finished_at: new Date().toISOString(), current_node_id: null })
      .eq("id", runId);
  } catch (e) {
    await admin
      .from("trigger_runs")
      .update({ status: "failed", error_message: e instanceof Error ? e.message : "run failed", finished_at: new Date().toISOString() })
      .eq("id", runId);
  }
}

/** Convert a {value, unit} duration (minutes/hours/days) to milliseconds.
 *  0 / invalid → 0 (no timeout). */
function durationMs(value: unknown, unit: unknown): number {
  const v = Number(value ?? 0);
  if (!Number.isFinite(v) || v <= 0) return 0;
  const u = String(unit ?? "minutes").toLowerCase();
  const mult =
    u === "days" ? 86_400_000
    : u === "hours" ? 3_600_000
    : u === "seconds" ? 1_000
    : 60_000;
  return v * mult;
}

/** Tick worker — resume any waiting run whose timeout (resume_at) has passed.
 *  Wait-for-reply nodes follow their "timeout" branch (or end the run if none);
 *  delay nodes follow their default out-edge. Called periodically by
 *  /api/triggers/tick. Returns how many runs were advanced. */
export async function resumeDueWaits(admin: Admin): Promise<{ resumed: number }> {
  const nowIso = new Date().toISOString();
  const { data: due } = await admin
    .from("trigger_runs")
    .select("id, flow_id, current_node_id, contact_id")
    .eq("status", "waiting")
    .not("resume_at", "is", null)
    .lte("resume_at", nowIso)
    .order("resume_at", { ascending: true })
    .limit(50);
  if (!due || due.length === 0) return { resumed: 0 };

  let resumed = 0;
  for (const run of due) {
    if (!run.current_node_id) continue;
    const { data: contact } = await admin
      .from("contacts")
      .select("wa_id, business_phone_number_id")
      .eq("id", run.contact_id as string)
      .maybeSingle();
    const { nodes, edges } = await loadGraph(admin, run.flow_id as string);
    const node = nodes.get(run.current_node_id as string);
    if (!node) {
      await admin.from("trigger_runs").update({ status: "completed", resume_at: null, finished_at: nowIso, current_node_id: null }).eq("id", run.id);
      continue;
    }
    // wait_reply → "timeout" branch (end if not wired); delay → default edge.
    const label = node.node_type === "wait_reply" ? "timeout" : null;
    const nextId = resolveNext(run.current_node_id as string, label, edges, node);
    if (!nextId) {
      await admin.from("trigger_runs").update({ status: "completed", resume_at: null, finished_at: nowIso, current_node_id: null }).eq("id", run.id);
      resumed++;
      continue;
    }
    await runFlow(
      admin,
      { id: run.flow_id as string },
      {
        contactId: run.contact_id as string,
        waId: (contact?.wa_id as string) ?? "",
        bpid: (contact?.business_phone_number_id as string) ?? "",
      },
      nextId,
      run.id as string,
    );
    resumed++;
  }
  return { resumed };
}

/** Derive the branch/condition variables describing a patient's reply, so a
 *  "Wait for reply" → "Set a Condition" pair can check whether they actually
 *  sent what we asked for (e.g. images). Exposed as run vars:
 *    images_received  "yes" | "no"
 *    media_received   "yes" | "no"   (any image/video/audio/document)
 *    last_reply_type  "image" | "video" | "audio" | "document" | "text"
 *    last_reply_text  the raw text (empty for media-only replies) */
// Variables that describe the patient's reply (set by buildReplyVars). A
// condition reading any of these auto-waits for a reply if none captured yet.
const REPLY_VAR_NAMES = [
  "images_received",
  "video_received",
  "audio_received",
  "document_received",
  "text_received",
  "media_received",
  "last_reply_type",
  "last_reply_text",
];

/** Drop the reply descriptors so a downstream condition waits for a new reply. */
function clearReplyVars(ctx: RunContext): void {
  for (const k of REPLY_VAR_NAMES) delete ctx.vars[k];
}

const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "heic", "heif", "avif", "svg", "tif", "tiff"];
const VIDEO_EXTS = ["mp4", "mov", "webm", "m4v", "3gp", "3gpp", "mkv", "avi"];
const AUDIO_EXTS = ["mp3", "ogg", "oga", "m4a", "wav", "aac", "opus", "amr"];
const DOC_EXTS = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "zip", "rar"];

/** Best-effort file extension from a media URL (strips query string). */
function extOf(url?: string | null): string {
  if (!url) return "";
  try {
    const path = new URL(url, "http://x").pathname.toLowerCase();
    const m = path.match(/\.([a-z0-9]+)$/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function buildReplyVars(
  text: string,
  type?: string,
  mediaUrl?: string | null,
): Record<string, string> {
  const t = (type ?? "").toLowerCase();
  // Verify by the WhatsApp message type AND the file extension — so a photo
  // sent as a "document" (jpg/png) still counts as images_received, etc.
  const ext = extOf(mediaUrl);
  const isImage = t === "image" || t === "sticker" || IMAGE_EXTS.includes(ext);
  const isVideo = t === "video" || VIDEO_EXTS.includes(ext);
  const isAudio = t === "audio" || t === "voice" || t === "ptt" || AUDIO_EXTS.includes(ext);
  // Document only when it isn't actually an image/video/audio by extension.
  const isDoc = (t === "document" || DOC_EXTS.includes(ext)) && !isImage && !isVideo && !isAudio;
  const hasMedia = isImage || isVideo || isAudio || isDoc || Boolean(mediaUrl);
  const kind = isImage
    ? "image"
    : isVideo
      ? "video"
      : isAudio
        ? "audio"
        : isDoc
          ? "document"
          : "text";
  return {
    last_reply_text: text ?? "",
    last_reply_type: kind,
    images_received: isImage ? "yes" : "no",
    video_received: isVideo ? "yes" : "no",
    audio_received: isAudio ? "yes" : "no",
    document_received: isDoc ? "yes" : "no",
    text_received: !hasMedia && (text ?? "").trim() ? "yes" : "no",
    media_received: hasMedia ? "yes" : "no",
  };
}

/** True if this contact already has a flow in progress (running or waiting),
 *  updated within the last 24h. Used to stop a second trigger from stacking a
 *  duplicate flow. The 24h window means a forgotten/stuck waiting run won't
 *  block this contact's triggers forever. */
async function hasActiveRun(admin: Admin, contactId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { count } = await admin
    .from("trigger_runs")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contactId)
    .in("status", ["running", "waiting"])
    .gte("updated_at", cutoff);
  return (count ?? 0) > 0;
}

/** If a run is parked waiting for THIS patient's reply, match the reply to a
 *  branch and resume from there. Returns true if a run was resumed. */
async function resumeWaitingRun(
  admin: Admin,
  base: {
    contactId: string;
    waId: string;
    bpid: string;
    inboundText: string;
    reply: Record<string, string>;
  },
): Promise<boolean> {
  // Most recent waiting run (incl. ones with a timeout stamped) — a reply
  // beats the timeout. Pure delay nodes are skipped below (they only resume
  // on the tick, not on a message).
  const { data: run } = await admin
    .from("trigger_runs")
    .select("id, flow_id, current_node_id")
    .eq("contact_id", base.contactId)
    .eq("status", "waiting")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!run?.current_node_id) return false;

  const { nodes, edges } = await loadGraph(admin, run.flow_id as string);
  const node = nodes.get(run.current_node_id as string);
  if (!node) return false;

  // A condition node that was parked waiting for a reply (because it reads a
  // reply-variable like images_received) re-runs ITSELF with the reply vars
  // now seeded — so it evaluates against what the patient just sent, then
  // follows its True/False branch.
  if (node.node_type === "condition") {
    await runFlow(
      admin,
      { id: run.flow_id as string },
      { contactId: base.contactId, waId: base.waId, bpid: base.bpid },
      run.current_node_id as string,
      run.id as string,
      base.reply,
    );
    return true;
  }

  // Only reply-waiting nodes resume on a message; a delay node waits for time.
  if (
    node.node_type !== "wait_reply" &&
    node.node_type !== "message_buttons" &&
    node.node_type !== "message_image_buttons"
  )
    return false;

  // A "Wait for reply" node resumes on ANY message — text or media — and
  // hands the reply vars to the downstream condition. A buttons node still
  // requires the patient to pick one of its options.
  let label: string | null;
  if (node.node_type === "wait_reply") {
    label = null; // follow the single default out-edge
  } else {
    const chosen = pickButton(node, base.inboundText);
    if (chosen == null) {
      // Patient typed something instead of tapping a button. If the node
      // has the "remind to use a button" toggle on, nudge them with the
      // configured message and stay parked on this node. Otherwise leave
      // it waiting silently (old behaviour).
      const cfg = node.config ?? {};
      const remindMsg = String(cfg.invalid_reply_message ?? "").trim();
      if (cfg.remind_on_invalid && remindMsg) {
        await sendText(
          { contactId: base.contactId, waId: base.waId, bpid: base.bpid, contact: {}, vars: {} },
          remindMsg,
        );
        return true; // handled — don't fall through to start a new flow
      }
      return false;
    }
    label = chosen;
  }

  const nextId = resolveNext(run.current_node_id as string, label, edges, node);
  if (!nextId) {
    await admin
      .from("trigger_runs")
      .update({ status: "completed", finished_at: new Date().toISOString(), current_node_id: null })
      .eq("id", run.id);
    return true;
  }
  await runFlow(
    admin,
    { id: run.flow_id as string },
    { contactId: base.contactId, waId: base.waId, bpid: base.bpid },
    nextId,
    run.id as string,
    base.reply,
  );
  return true;
}

/** Returns: null → follow default edge; a string → follow that branch label;
 *  AWAIT_REPLY → park for the patient's reply; WAIT_DELAY → park for the tick. */
async function executeNode(admin: Admin, node: NodeRow, ctx: RunContext): Promise<string | null> {
  const cfg = node.config ?? {};
  switch (node.node_type) {
    case "message_text": {
      await sendText(ctx, interpolate(String(cfg.text ?? ""), ctx));
      // We just asked the patient something — discard any earlier reply
      // descriptors so a following condition waits for a FRESH reply, not the
      // one captured before this message.
      clearReplyVars(ctx);
      return null;
    }
    case "message_image":
    case "message_video": {
      const caption = interpolate(String(cfg.caption ?? cfg.text ?? ""), ctx);
      const mediaKind = node.node_type === "message_image" ? "image" : "video";
      // Multiple images send as a sequence of image messages (album-style in
      // the chat); caption rides the FIRST one only. Old single-media nodes
      // fall back to media_url.
      const list = Array.isArray(cfg.media_urls)
        ? (cfg.media_urls as unknown[]).map((u) => String(u ?? "").trim()).filter(Boolean)
        : [];
      const single = String(cfg.media_url ?? cfg.url ?? "").trim();
      const urls = list.length > 0 ? list : single ? [single] : [];
      for (let i = 0; i < urls.length; i++) {
        await sendMedia(ctx, mediaKind, urls[i], i === 0 ? caption : "");
      }
      if (urls.length === 0 && caption) await sendText(ctx, caption);
      clearReplyVars(ctx);
      return null;
    }
    case "message_image_buttons": {
      // Image(s) + caption + buttons. Extra images go first as plain image
      // messages; the LAST image becomes the header of the interactive buttons
      // message (image + caption + reply/link buttons), sent via /api/send-
      // message kind:"rich".
      const caption = interpolate(String(cfg.caption ?? cfg.text ?? ""), ctx);
      const buttons = Array.isArray(cfg.buttons)
        ? (cfg.buttons as Array<{ label?: string; url?: string }>)
        : [];
      const list = Array.isArray(cfg.media_urls)
        ? (cfg.media_urls as unknown[]).map((u) => String(u ?? "").trim()).filter(Boolean)
        : [];
      const single = String(cfg.media_url ?? "").trim();
      const urls = list.length > 0 ? list : single ? [single] : [];
      for (let i = 0; i < urls.length - 1; i++) await sendMedia(ctx, "image", urls[i], "");
      const header = urls.length > 0 ? urls[urls.length - 1] : "";

      const richButtons = buttons
        .map((b) => {
          const text = String(b.label ?? "").trim();
          const url = (b.url ?? "").trim();
          if (!text) return null;
          return url ? { type: "url", text, url } : { type: "quick_reply", text };
        })
        .filter(Boolean);
      const hasBranch = buttons.some((b) => !(b.url ?? "").trim() && (b.label ?? "").trim());
      const bodyText = caption || (richButtons.length > 0 ? "Please choose" : "");

      await callSend(ctx, {
        kind: "rich",
        text: bodyText,
        ...(header ? { media_url: header, media_kind: "image" } : {}),
        rich_buttons: richButtons,
      });
      return hasBranch ? AWAIT_REPLY : null;
    }
    case "wait_reply": {
      // Park until the patient's next message (any type). On resume,
      // resumeWaitingRun follows the default out-edge with the reply vars
      // (images_received, last_reply_type, …) seeded for a condition.
      return AWAIT_REPLY;
    }
    case "message_buttons": {
      // Buttons can be branch buttons (no URL → patient taps, flow branches) or
      // LINK buttons (URL set → tap opens the link, no branch). WhatsApp can't
      // mix a real link button with reply buttons, so we degrade gracefully.
      const buttons = Array.isArray(cfg.buttons)
        ? (cfg.buttons as Array<{ label?: string; url?: string }>)
        : [];
      const body = interpolate(String(cfg.text ?? ""), ctx);
      const replyLabels = buttons
        .filter((b) => !(b.url ?? "").trim())
        .map((b) => String(b.label ?? "").trim())
        .filter(Boolean);
      const linkBtns = buttons
        .filter((b) => (b.url ?? "").trim())
        .map((b) => ({ text: String(b.label ?? "").trim() || "Open link", url: (b.url ?? "").trim() }));

      // Pure single link → one tappable CTA URL button (no branch reply).
      if (replyLabels.length === 0 && linkBtns.length === 1) {
        await sendCtaUrl(ctx, body || linkBtns[0].text, linkBtns[0]);
        return null;
      }
      // Reply (branch) buttons present → send them; fold any links into the
      // body as text links (Meta forbids link + reply buttons together).
      if (replyLabels.length > 0) {
        const linkLines = linkBtns.map((l) => `${l.text}: ${l.url}`);
        await sendButtons(ctx, [body || "Please choose", ...linkLines].filter(Boolean).join("\n"), replyLabels);
        return AWAIT_REPLY;
      }
      // Only multiple links (no branch) → can't send >1 URL button free-form;
      // fold them all into the body text.
      if (linkBtns.length > 0) {
        const linkLines = linkBtns.map((l) => `${l.text}: ${l.url}`);
        await sendText(ctx, [body, ...linkLines].filter(Boolean).join("\n"));
        return null;
      }
      await sendText(ctx, body);
      return null;
    }
    case "assign_agent": {
      const email = String(cfg.agent_email ?? "").trim();
      const userId = cfg.user_id ? String(cfg.user_id) : null;
      if (email || userId) {
        await admin
          .from("contacts")
          .update({
            assigned_to: userId,
            assigned_to_email: email || null,
            assigned_at: new Date().toISOString(),
          })
          .eq("id", ctx.contactId);
      }
      return null;
    }
    case "update_field_tag": {
      const patch: Record<string, unknown> = {};
      if (typeof cfg.lsq_stage === "string" && cfg.lsq_stage) patch.lsq_stage = cfg.lsq_stage;
      if (typeof cfg.status === "string" && cfg.status) patch.status = cfg.status;
      if (Array.isArray(cfg.add_label_ids) && cfg.add_label_ids.length > 0) {
        const existing = Array.isArray(ctx.contact.label_ids) ? (ctx.contact.label_ids as string[]) : [];
        patch.label_ids = Array.from(new Set([...existing, ...(cfg.add_label_ids as string[])]));
      }
      if (Object.keys(patch).length > 0) {
        await admin.from("contacts").update(patch).eq("id", ctx.contactId);
        Object.assign(ctx.contact, patch);
      }
      return null;
    }
    case "condition": {
      // config: { var?, op, value } → branch 'true' | 'false' via edges.
      const varName = String(cfg.var ?? "");
      // If the condition reads a reply-descriptor (images_received, …) but no
      // reply has been captured in this run yet, wait for the patient's next
      // message first — so the operator doesn't need a separate "Wait for
      // reply" node before the condition. resumeWaitingRun re-runs this node
      // once a reply arrives.
      if (REPLY_VAR_NAMES.includes(varName) && !(varName in ctx.vars)) {
        return AWAIT_REPLY;
      }
      const subject = cfg.var ? (ctx.vars[String(cfg.var)] ?? "") : String(ctx.contact.lsq_stage ?? "");
      const value = String(cfg.value ?? "").toLowerCase();
      const op = String(cfg.op ?? "contains");
      const s = subject.toLowerCase();
      const pass = op === "equals" ? s === value : op === "starts" ? s.startsWith(value) : s.includes(value);
      return pass ? "true" : "false";
    }
    case "webhook": {
      const url = String(cfg.url ?? "").trim();
      if (url) {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contact_id: ctx.contactId,
            wa_id: ctx.waId,
            business_phone_number_id: ctx.bpid,
            vars: ctx.vars,
          }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => {});
      }
      return null;
    }
    case "clear_variable": {
      if (typeof cfg.key === "string") delete ctx.vars[cfg.key];
      return null;
    }
    case "delay": {
      const minutes = Number(cfg.minutes ?? 0);
      return minutes > 0 ? WAIT_DELAY : null;
    }
    default:
      // Unknown / not-yet-implemented node types are skipped (default edge).
      return null;
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
async function persistVars(admin: Admin, runId: string, vars: Record<string, string>): Promise<void> {
  const keys = Object.keys(vars);
  if (keys.length === 0) return;
  await admin
    .from("trigger_run_vars")
    .upsert(keys.map((k) => ({ run_id: runId, key: k, value: vars[k] })), { onConflict: "run_id,key" });
}

function interpolate(text: string, ctx: RunContext): string {
  const name = String(ctx.contact.name ?? ctx.contact.profile_name ?? "").trim();
  const display = name || "there";
  const map: Record<string, string> = {
    name: display,
    first_name: name.split(" ")[0] || "there",
    phone: ctx.waId,
    // Numbered placeholders (copied from the magic_message template body where
    // {{1}} = customer name) — map {{1}} to the name so "Hi {{1}}," renders
    // "Hi Birjul," instead of the literal placeholder.
    "1": display,
    ...ctx.vars,
  };
  return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, k) => map[k] ?? `{{${k}}}`);
}

async function sendText(ctx: RunContext, text: string): Promise<void> {
  if (!text.trim()) return;
  await callSend(ctx, { kind: "text", text });
}

async function sendMedia(
  ctx: RunContext,
  mediaKind: "image" | "video",
  url: string,
  caption: string,
): Promise<void> {
  await callSend(ctx, { kind: "media", media_kind: mediaKind, media_url: url, caption });
}

async function sendButtons(ctx: RunContext, bodyText: string, labels: string[]): Promise<void> {
  // Meta interactive reply buttons: max 3, title ≤ 20 chars. When the flow
  // exceeds that we fall back to a numbered text list so the patient can
  // still reply "1"/"2" and pickButton resolves the branch.
  const fits = labels.length <= 3 && labels.every((l) => l.length <= 20);
  if (fits) {
    await callSend(ctx, {
      kind: "interactive",
      body_text: bodyText,
      buttons: labels.map((title) => ({ title })),
    });
    return;
  }
  const lines = labels.map((l, i) => `${i + 1}. ${l}`);
  await sendText(ctx, [bodyText, ...lines].filter(Boolean).join("\n"));
}

// A single tappable CTA URL button — opens the link, no branch reply. Evolution/
// Interakt fall back to the URL inline inside /api/send-message.
async function sendCtaUrl(ctx: RunContext, bodyText: string, btn: { text: string; url: string }): Promise<void> {
  await callSend(ctx, {
    kind: "rich",
    text: bodyText || btn.text,
    rich_buttons: [{ type: "url", text: btn.text.slice(0, 20), url: btn.url }],
  });
}

async function callSend(ctx: RunContext, extra: Record<string, unknown>): Promise<void> {
  const token = await getCredential("webhook_internal_token");
  if (!token) return;
  const origin = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  await fetch(`${origin}/api/send-message`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ contact_id: ctx.contactId, wa_id: ctx.waId, ...extra }),
  }).catch(() => {});
}
