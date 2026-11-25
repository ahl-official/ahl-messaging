/**
 * Patch "AHL UTM Flow - V3 (YouTube to Thank You)":
 * 1) Remove mid-funnel concern Type|Voice (reconnect city sheet → product)
 * 2) After Thank You, add optional: Type a query | Voice | Photos | I'm all set
 *
 * Does not touch classic "AHL UTM Flow".
 *
 * Usage: node scripts/patch-ahl-utm-v3-post-thanks-extra.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const envPath = resolve(root, ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const k = m[1].trim();
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });
const BPID = process.env.AHL_MESSAGING_BPID || "1198859879988526";
const FLOW_NAME = "AHL UTM Flow - V3 (YouTube to Thank You)";

const { data: flow, error: flowErr } = await sb
  .from("trigger_flows")
  .select("id,name")
  .eq("name", FLOW_NAME)
  .eq("business_phone_number_id", BPID)
  .maybeSingle();
if (flowErr || !flow) {
  console.error("V3 flow not found:", flowErr?.message);
  process.exit(1);
}

const flowId = flow.id;

async function loadGraph() {
  const { data: nodes, error: nErr } = await sb
    .from("trigger_nodes")
    .select("*")
    .eq("flow_id", flowId);
  const { data: edges, error: eErr } = await sb
    .from("trigger_edges")
    .select("*")
    .eq("flow_id", flowId);
  if (nErr || eErr) throw new Error(nErr?.message || eErr?.message);
  return { nodes: nodes || [], edges: edges || [] };
}

async function deleteNodesByVar(varNames) {
  const { nodes } = await loadGraph();
  const prior = nodes.filter((n) =>
    varNames.includes(String(n.config?.var_name || "")),
  );
  if (!prior.length) return 0;
  const ids = prior.map((n) => n.id);
  await sb.from("trigger_edges").delete().eq("flow_id", flowId).in("from_node_id", ids);
  await sb.from("trigger_edges").delete().eq("flow_id", flowId).in("to_node_id", ids);
  await sb.from("trigger_nodes").delete().in("id", ids);
  return ids.length;
}

// --- 1) Strip mid-funnel concern ---
{
  const removed = await deleteNodesByVar(["concern_mode", "concern"]);
  if (removed) console.log("Removed mid-funnel concern nodes:", removed);
}

let { nodes, edges } = await loadGraph();

const product = nodes.find(
  (n) =>
    n.node_type === "ask_button" &&
    String(n.config?.text || "").toLowerCase().includes("which hair solution"),
);
if (!product) {
  console.error("Product ask_button not found on V3");
  process.exit(1);
}

// Ensure city-sheet webhook → product (repair if concern left a gap)
const intoProduct = edges.filter(
  (e) =>
    e.to_node_id === product.id &&
    (e.branch_label == null || e.branch_label === ""),
);
if (intoProduct.length === 0) {
  // Find webhook that used to lead into concern / product — prefer last sheet webhook before product by x
  const webhooks = nodes
    .filter((n) => n.node_type === "webhook")
    .sort((a, b) => Number(a.position?.x ?? 0) - Number(b.position?.x ?? 0));
  const px = Number(product.position?.x ?? 9999);
  const leadWh =
    [...webhooks].reverse().find((w) => Number(w.position?.x ?? 0) < px) ||
    webhooks[webhooks.length - 1];
  if (!leadWh) {
    console.error("No webhook to reconnect to product");
    process.exit(1);
  }
  const { error: insBridge } = await sb.from("trigger_edges").insert({
    flow_id: flowId,
    from_node_id: leadWh.id,
    to_node_id: product.id,
    branch_label: null,
  });
  if (insBridge) {
    console.error("Reconnect webhook→product failed:", insBridge.message);
    process.exit(1);
  }
  console.log("Reconnected webhook → product:", leadWh.id);
} else {
  console.log("Product inbound default edges OK:", intoProduct.length);
}

// --- 2) Post thank-you optional block ---
({ nodes, edges } = await loadGraph());

// Clear prior post-thanks enrichment if re-run
{
  const removed = await deleteNodesByVar([
    "extra_help_mode",
    "extra_query",
    "hair_photos",
  ]);
  // Also drop prior closing messages we tagged via text
  const { nodes: n3 } = await loadGraph();
  const closerIds = n3
    .filter((n) => {
      const t = String(n.config?.text || "");
      return (
        t.includes("Before we call — anything else") ||
        t.includes("Got it — thank you! Our AHL expert") ||
        t.includes("Got it — thank you! Our Alchemane expert") ||
        t.includes("Perfect! We're all set. Our expert will call") ||
        t.includes("Please send a voice note with your question") ||
        t.includes("Please type your question or anything we should know") ||
        t.includes("Please send clear photos of your hair")
      );
    })
    .map((n) => n.id);
  if (closerIds.length) {
    await sb.from("trigger_edges").delete().eq("flow_id", flowId).in("from_node_id", closerIds);
    await sb.from("trigger_edges").delete().eq("flow_id", flowId).in("to_node_id", closerIds);
    await sb.from("trigger_nodes").delete().in("id", closerIds);
    console.log("Removed prior post-thanks nodes:", closerIds.length + removed);
  } else if (removed) {
    console.log("Removed prior extra_help vars:", removed);
  }
}

({ nodes, edges } = await loadGraph());

const thankYou = nodes.find(
  (n) =>
    n.node_type === "message_text" &&
    String(n.config?.text || "").startsWith("Thank you!"),
);
if (!thankYou) {
  console.error("Thank You node not found on V3");
  process.exit(1);
}

// Drop any existing out-edges from thank you (was END)
await sb
  .from("trigger_edges")
  .delete()
  .eq("flow_id", flowId)
  .eq("from_node_id", thankYou.id);

const tx = Number(thankYou.position?.x ?? 2800);
const ty = Number(thankYou.position?.y ?? 50);
const maxSort = Math.max(0, ...nodes.map((n) => Number(n.sort_order) || 0));

const askExtraHelp = randomUUID();
const askExtraQuery = randomUUID();
const askExtraVoice = randomUUID();
const askExtraPhotos = randomUUID();
const extraDone = randomUUID();
const allSetDone = randomUUID();

const newNodes = [
  {
    id: askExtraHelp,
    flow_id: flowId,
    node_type: "ask_list",
    config: {
      text:
        "Before we call — anything else that would help our expert?\nYou can type a query, send a voice note, or share photos. Or tap I'm all set.",
      var_name: "extra_help_mode",
      buttons: [
        { label: "Type a quick query" },
        { label: "Send a voice note" },
        { label: "Send photos" },
        { label: "I'm all set" },
      ],
      remind_on_invalid: true,
      invalid_reply_message:
        "Please tap an option — or type a query / send a voice note / send photos. Tap I'm all set if you're done.",
    },
    position: { x: tx + 280, y: ty },
    sort_order: maxSort + 1,
  },
  {
    id: askExtraQuery,
    flow_id: flowId,
    node_type: "ask_text",
    config: {
      text: "Please type your question or anything we should know.",
      var_name: "extra_query",
      remind_on_invalid: true,
      invalid_reply_message: "Please type a short note, or send a voice note if you prefer.",
    },
    position: { x: tx + 560, y: ty - 120 },
    sort_order: maxSort + 2,
  },
  {
    id: askExtraVoice,
    flow_id: flowId,
    node_type: "ask_text",
    config: {
      text: "Please send a voice note with your question. You can also type it.",
      var_name: "extra_query",
      remind_on_invalid: true,
      invalid_reply_message: "Please send a voice note or type your question.",
    },
    position: { x: tx + 560, y: ty },
    sort_order: maxSort + 3,
  },
  {
    id: askExtraPhotos,
    flow_id: flowId,
    node_type: "ask_file",
    config: {
      text:
        "Please send clear photos of your hair (front / top / back if possible). We keep them confidential.",
      var_name: "hair_photos",
    },
    position: { x: tx + 560, y: ty + 120 },
    sort_order: maxSort + 4,
  },
  {
    id: extraDone,
    flow_id: flowId,
    node_type: "message_text",
    config: {
      text:
        "Got it — thank you! Our AHL expert will use this when they call you. Talk soon.",
    },
    position: { x: tx + 840, y: ty },
    sort_order: maxSort + 5,
  },
  {
    id: allSetDone,
    flow_id: flowId,
    node_type: "message_text",
    config: {
      text: "Perfect! We're all set. Our expert will call you shortly.",
    },
    position: { x: tx + 560, y: ty + 240 },
    sort_order: maxSort + 6,
  },
];

const { error: insN } = await sb.from("trigger_nodes").insert(newNodes);
if (insN) {
  console.error("insert nodes failed:", insN.message);
  process.exit(1);
}

const newEdges = [
  {
    flow_id: flowId,
    from_node_id: thankYou.id,
    to_node_id: askExtraHelp,
    branch_label: null,
  },
  {
    flow_id: flowId,
    from_node_id: askExtraHelp,
    to_node_id: askExtraQuery,
    branch_label: "Type a quick query",
  },
  {
    flow_id: flowId,
    from_node_id: askExtraHelp,
    to_node_id: askExtraVoice,
    branch_label: "Send a voice note",
  },
  {
    flow_id: flowId,
    from_node_id: askExtraHelp,
    to_node_id: askExtraPhotos,
    branch_label: "Send photos",
  },
  {
    flow_id: flowId,
    from_node_id: askExtraHelp,
    to_node_id: allSetDone,
    branch_label: "I'm all set",
  },
  {
    flow_id: flowId,
    from_node_id: askExtraQuery,
    to_node_id: extraDone,
    branch_label: null,
  },
  {
    flow_id: flowId,
    from_node_id: askExtraVoice,
    to_node_id: extraDone,
    branch_label: null,
  },
  {
    flow_id: flowId,
    from_node_id: askExtraPhotos,
    to_node_id: extraDone,
    branch_label: null,
  },
];

const { error: insE } = await sb.from("trigger_edges").insert(newEdges);
if (insE) {
  console.error("insert edges failed:", insE.message);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      flow: FLOW_NAME,
      flowId,
      changes: [
        "removed mid-funnel concern Type|Voice",
        "city sheet → product",
        "thank you → optional query|voice|photos|all set",
      ],
    },
    null,
    2,
  ),
);
