/**
 * Clone live "AHL UTM Flow - V2 (Consultation & Payment Optimized)" into
 * "AHL UTM Flow - V3 (YouTube to Thank You)":
 *   … → product → (patch) → YouTube → Thank You (END)
 * Drops urgency / consult format / slots / payment / retarget / call tail.
 *
 * Usage (from Project WhatsApp/):
 *   node scripts/seed-ahl-utm-v3-youtube-thankyou.mjs
 *
 * Requires env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * (or pass via .env.local loaded below).
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
const SRC_NAME = "AHL UTM Flow - V2 (Consultation & Payment Optimized)";
const DST_NAME = "AHL UTM Flow - V3 (YouTube to Thank You)";

const { data: src, error: srcErr } = await sb
  .from("trigger_flows")
  .select("*")
  .eq("name", SRC_NAME)
  .eq("business_phone_number_id", BPID)
  .maybeSingle();
if (srcErr || !src) {
  console.error("Source V2 flow not found:", srcErr?.message);
  process.exit(1);
}

const { data: nodes, error: nErr } = await sb
  .from("trigger_nodes")
  .select("*")
  .eq("flow_id", src.id);
const { data: edges, error: eErr } = await sb
  .from("trigger_edges")
  .select("*")
  .eq("flow_id", src.id);
if (nErr || eErr) {
  console.error(nErr?.message || eErr?.message);
  process.exit(1);
}

const youtube = nodes.find(
  (n) =>
    n.node_type === "message_text" &&
    String(n.config?.text || "").includes("2-minute technical video"),
);
const thankYou = nodes.find(
  (n) =>
    n.node_type === "message_text" &&
    String(n.config?.text || "").startsWith("Thank you!"),
);
const urgency = nodes.find(
  (n) =>
    n.node_type === "ask_button" &&
    String(n.config?.text || "").includes("how soon are you looking"),
);
if (!youtube || !thankYou || !urgency) {
  console.error("Could not locate youtube / thankYou / urgency nodes", {
    youtube: !!youtube,
    thankYou: !!thankYou,
    urgency: !!urgency,
  });
  process.exit(1);
}

const drop = new Set();
const q = [urgency.id];
while (q.length) {
  const cur = q.shift();
  if (drop.has(cur)) continue;
  drop.add(cur);
  for (const e of edges) {
    if (e.from_node_id !== cur) continue;
    if (e.to_node_id === thankYou.id) continue;
    q.push(e.to_node_id);
  }
}

const keep = nodes.filter((n) => !drop.has(n.id));
console.log(`Keep ${keep.length} nodes, drop ${drop.size}:`, [...drop].map((id) => {
  const n = nodes.find((x) => x.id === id);
  return `${n?.node_type}`;
}));

await sb.from("trigger_flows").delete().eq("name", DST_NAME).eq("business_phone_number_id", BPID);

const { data: flow, error: fErr } = await sb
  .from("trigger_flows")
  .insert({
    business_phone_number_id: BPID,
    name: DST_NAME,
    trigger_type: src.trigger_type || "keyword",
    trigger_config: src.trigger_config || {
      match: "contains",
      phrases: ["Hi! Tell me more", "Tell me more", "Hello!!!", "Hello", "Hi"],
    },
    enabled: false,
    priority: (src.priority || 200) + 10,
  })
  .select("id")
  .single();
if (fErr || !flow) {
  console.error("Create flow failed:", fErr?.message);
  process.exit(1);
}

const idMap = Object.fromEntries(keep.map((n) => [n.id, randomUUID()]));

const newNodes = keep.map((n) => ({
  id: idMap[n.id],
  flow_id: flow.id,
  node_type: n.node_type,
  config: n.config,
  position: n.position,
  sort_order: n.sort_order ?? 0,
}));

const { error: insN } = await sb.from("trigger_nodes").insert(newNodes);
if (insN) {
  console.error("Insert nodes failed:", insN.message);
  await sb.from("trigger_flows").delete().eq("id", flow.id);
  process.exit(1);
}

const newEdges = edges
  .filter((e) => !drop.has(e.from_node_id) && !drop.has(e.to_node_id))
  .filter((e) => idMap[e.from_node_id] && idMap[e.to_node_id])
  .map((e) => ({
    flow_id: flow.id,
    from_node_id: idMap[e.from_node_id],
    to_node_id: idMap[e.to_node_id],
    branch_label: e.branch_label ?? null,
  }));

// YouTube → Thank You (end)
newEdges.push({
  flow_id: flow.id,
  from_node_id: idMap[youtube.id],
  to_node_id: idMap[thankYou.id],
  branch_label: null,
});

const { error: insE } = await sb.from("trigger_edges").insert(newEdges);
if (insE) {
  console.error("Insert edges failed:", insE.message);
  await sb.from("trigger_flows").delete().eq("id", flow.id);
  process.exit(1);
}

const startId = idMap[src.start_node_id];
await sb.from("trigger_flows").update({ start_node_id: startId }).eq("id", flow.id);

console.log(JSON.stringify({
  ok: true,
  flow_id: flow.id,
  name: DST_NAME,
  enabled: false,
  nodes: newNodes.length,
  edges: newEdges.length,
  path: "… → YouTube → Thank You (END)",
  note: "Enable in One Inbox Automation when ready. V2 left untouched.",
}, null, 2));
