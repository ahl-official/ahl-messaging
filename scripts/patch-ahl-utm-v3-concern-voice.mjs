/**
 * Patch "AHL UTM Flow - V3 (YouTube to Thank You)" only:
 * After city → sheet webhook, insert concern mode:
 *   Type your request | Send a voice note → ask_text → product
 *
 * Does not touch classic "AHL UTM Flow".
 *
 * Usage: node scripts/patch-ahl-utm-v3-concern-voice.mjs
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
const { data: nodes, error: nErr } = await sb
  .from("trigger_nodes")
  .select("*")
  .eq("flow_id", flowId);
const { data: edges, error: eErr } = await sb
  .from("trigger_edges")
  .select("*")
  .eq("flow_id", flowId);
if (nErr || eErr) {
  console.error(nErr?.message || eErr?.message);
  process.exit(1);
}

// Remove prior concern patch if re-run
const prior = (nodes || []).filter((n) => {
  const vn = String(n.config?.var_name || "");
  return vn === "concern_mode" || vn === "concern";
});
if (prior.length) {
  const ids = prior.map((n) => n.id);
  await sb.from("trigger_edges").delete().eq("flow_id", flowId).in("from_node_id", ids);
  await sb.from("trigger_edges").delete().eq("flow_id", flowId).in("to_node_id", ids);
  await sb.from("trigger_nodes").delete().in("id", ids);
  console.log("Removed prior concern nodes:", ids.length);
}

const { data: nodes2 } = await sb.from("trigger_nodes").select("*").eq("flow_id", flowId);
const { data: edges2 } = await sb.from("trigger_edges").select("*").eq("flow_id", flowId);

const product = (nodes2 || []).find(
  (n) =>
    n.node_type === "ask_button" &&
    String(n.config?.text || "").toLowerCase().includes("which hair solution"),
);
if (!product) {
  console.error("Product ask_button not found on V3");
  process.exit(1);
}

// City→sheet webhook: the webhook that currently edges into product
const intoProduct = (edges2 || []).filter(
  (e) => e.to_node_id === product.id && (e.branch_label == null || e.branch_label === ""),
);
if (intoProduct.length !== 1) {
  console.error("Expected exactly 1 default edge into product, got", intoProduct.length);
  process.exit(1);
}
const webhookLeadId = intoProduct[0].from_node_id;
const webhookLead = (nodes2 || []).find((n) => n.id === webhookLeadId);
if (!webhookLead || webhookLead.node_type !== "webhook") {
  console.error("Upstream of product is not a webhook:", webhookLead?.node_type);
  process.exit(1);
}

const wx = Number(webhookLead.position?.x ?? 315);
const wy = Number(webhookLead.position?.y ?? 50);
const px = Number(product.position?.x ?? 633);
const midX = Math.round((wx + px) / 2);

const askConcernMode = randomUUID();
const askConcernText = randomUUID();
const askConcernVoice = randomUUID();
const maxSort = Math.max(0, ...(nodes2 || []).map((n) => Number(n.sort_order) || 0));

const newNodes = [
  {
    id: askConcernMode,
    flow_id: flowId,
    node_type: "ask_button",
    config: {
      text: "Please share your hair concern. You can type it, or send a voice note.",
      var_name: "concern_mode",
      buttons: [{ label: "Type your request" }, { label: "Send a voice note" }],
    },
    position: { x: midX, y: wy },
    sort_order: maxSort + 1,
  },
  {
    id: askConcernText,
    flow_id: flowId,
    node_type: "ask_text",
    config: {
      text: "Please type your hair concern — for example hairfall, receding front, thinning on top, or patch.",
      var_name: "concern",
      remind_on_invalid: true,
      invalid_reply_message:
        "Please type a short description of your hair concern to continue.",
    },
    position: { x: midX + 40, y: wy - 80 },
    sort_order: maxSort + 2,
  },
  {
    id: askConcernVoice,
    flow_id: flowId,
    node_type: "ask_text",
    config: {
      text: "Please send a voice note describing your hair concern. You can also type it if you prefer.",
      var_name: "concern",
      remind_on_invalid: true,
      invalid_reply_message:
        "Please send a voice note or type your hair concern to continue.",
    },
    position: { x: midX + 40, y: wy + 100 },
    sort_order: maxSort + 3,
  },
];

const { error: insN } = await sb.from("trigger_nodes").insert(newNodes);
if (insN) {
  console.error("insert nodes failed:", insN.message);
  process.exit(1);
}

// Drop webhook → product; wire concern chain
const { error: delE } = await sb
  .from("trigger_edges")
  .delete()
  .eq("id", intoProduct[0].id);
if (delE) {
  // some schemas may not expose id; fallback delete by endpoints
  await sb
    .from("trigger_edges")
    .delete()
    .eq("flow_id", flowId)
    .eq("from_node_id", webhookLeadId)
    .eq("to_node_id", product.id)
    .is("branch_label", null);
}

const newEdges = [
  {
    flow_id: flowId,
    from_node_id: webhookLeadId,
    to_node_id: askConcernMode,
    branch_label: null,
  },
  {
    flow_id: flowId,
    from_node_id: askConcernMode,
    to_node_id: askConcernText,
    branch_label: "Type your request",
  },
  {
    flow_id: flowId,
    from_node_id: askConcernMode,
    to_node_id: askConcernVoice,
    branch_label: "Send a voice note",
  },
  {
    flow_id: flowId,
    from_node_id: askConcernText,
    to_node_id: product.id,
    branch_label: null,
  },
  {
    flow_id: flowId,
    from_node_id: askConcernVoice,
    to_node_id: product.id,
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
      inserted: ["askConcernMode", "askConcernText", "askConcernVoice"],
      after: "city sheet webhook → Type/Voice → product",
    },
    null,
    2,
  ),
);
