/**
 * Inserts ONLY "AHL UTM Flow". Does not modify any other trigger_flows row.
 * Usage: node scripts/seed-ahl-utm-flow.js [optional_bpid]
 *
 * Graph: Name → City → n8n webhook → Product (correct branches) → …
 */
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const envPath = path.join(__dirname, "..", ".env.local");
const env = Object.fromEntries(
  fs
    .readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const webhookUrl = "https://n8n.hairscalptradingco.com/webhook/ahl-flow-webhook";

function uuid() {
  return crypto.randomUUID();
}

async function seedOne(bpid) {
  await supabase.from("trigger_flows").delete().eq("name", "AHL UTM Flow").eq("business_phone_number_id", bpid);

  const { data: flow, error: flowErr } = await supabase
    .from("trigger_flows")
    .insert({
      business_phone_number_id: bpid,
      name: "AHL UTM Flow",
      trigger_type: "keyword",
      trigger_config: { match: "starts", phrases: ["Hi! Tell me more", "Tell me more"] },
      enabled: true,
    })
    .select("id")
    .single();

  if (flowErr || !flow) throw flowErr || new Error("no flow");

  const flowId = flow.id;
  const nodes = [];
  const edges = [];
  let sortCounter = 0;

  function addNode(type, config, x, y) {
    const id = uuid();
    nodes.push({
      id,
      flow_id: flowId,
      node_type: type,
      config,
      position: { x, y },
      sort_order: sortCounter++,
    });
    return id;
  }

  function makeEdge(source, label, target) {
    edges.push({
      flow_id: flowId,
      from_node_id: source,
      to_node_id: target,
      branch_label: label,
    });
  }

  const askName = addNode(
    "ask_text",
    {
      text: "Hello, Welcome to American Hairline! We're delighted to have you here. May we know your name?",
      var_name: "user_name",
    },
    80,
    80,
  );

  const askCity = addNode(
    "ask_button",
    {
      text: "May I know, which city are you from?",
      var_name: "city",
      buttons: [
        { label: "Mumbai" },
        { label: "Bangalore" },
        { label: "Delhi" },
        { label: "Hyderabad" },
        { label: "Pune" },
        { label: "Kolkata" },
        { label: "Chennai" },
        { label: "Jaipur" },
        { label: "Lucknow" },
        { label: "None of the above" },
      ],
    },
    420,
    40,
  );

  const askCustomCity = addNode(
    "ask_text",
    { text: "Which city are you from then?", var_name: "city" },
    420,
    420,
  );

  const webhookLead = addNode("webhook", { url: webhookUrl }, 780, 80);

  const askProduct = addNode(
    "ask_button",
    {
      text: "What product are you interested in?",
      var_name: "product",
      buttons: [
        { label: "Hair Patch" },
        { label: "Scalp Micro Pigmentation" },
        { label: "Hair Transplant" },
        { label: "Front Hairline" },
      ],
    },
    1140,
    80,
  );

  const askPatchType = addNode(
    "ask_button",
    {
      text: "Which Hair Patch you want?",
      var_name: "patch_type",
      buttons: [{ label: "Clip-On" }, { label: "Stick-On" }, { label: "Need Help" }],
    },
    1500,
    280,
  );

  const tplSmp = addNode("send_template", { template_name: "smp_price_details" }, 1500, 20);
  const tplFront = addNode(
    "send_template",
    { template_name: "front_hairline_system_videos_update" },
    1500,
    140,
  );

  const waitReply = addNode("wait_reply", { timeout_value: 24, timeout_unit: "hours" }, 1860, 80);

  const askUrgency = addNode(
    "ask_button",
    {
      text: "How soon are you looking for a solution?",
      var_name: "urgency",
      buttons: [
        { label: "Within 3 Days" },
        { label: "Within a Week" },
        { label: "Within a Month" },
        { label: "Not urgent" },
      ],
    },
    2220,
    160,
  );

  const platformButtons = [
    { label: "Book Online Consult" },
    { label: "In-Person Consult" },
    { label: "Call Now" },
  ];
  const askPlatformTop = addNode(
    "ask_button",
    { text: "Which platform is comfortable for you?", var_name: "platform", buttons: platformButtons },
    2580,
    40,
  );
  const askPlatformBot = addNode(
    "ask_button",
    { text: "Which platform is comfortable for you?", var_name: "platform", buttons: platformButtons },
    2580,
    280,
  );

  const webhookPlatTop = addNode("webhook", { url: webhookUrl }, 2940, 20);
  const tplCallNow = addNode("send_template", { template_name: "call_now_utility" }, 2940, 180);
  const webhookPlatBot = addNode("webhook", { url: webhookUrl }, 2940, 340);

  const confirmText =
    "Got it. Let me take your information and one of our Executive will get back to you with the available slot time.";
  const photoText =
    "Send us your hair pics from the top, back and front. Let us understand the hair loss pattern, volume, texture and color. We keep the pics confidential.";
  const thankText = "Thank you! We shall study the hair loss pattern and get back to you.";

  const confirmTop = addNode("message_text", { text: confirmText }, 3300, 20);
  const webhookCallNow = addNode("webhook", { url: webhookUrl }, 3300, 180);
  const confirmBot = addNode("message_text", { text: confirmText }, 3300, 340);

  const photoTop = addNode("message_text", { text: photoText }, 3660, 20);
  const photoCall = addNode("message_text", { text: photoText }, 3660, 180);
  const photoBot = addNode("message_text", { text: photoText }, 3660, 340);

  const thankTop = addNode("message_text", { text: thankText }, 4020, 20);
  const thankCall = addNode("message_text", { text: thankText }, 4020, 180);
  const thankBot = addNode("message_text", { text: thankText }, 4020, 340);

  makeEdge(askName, null, askCity);
  for (const city of [
    "Mumbai",
    "Bangalore",
    "Delhi",
    "Hyderabad",
    "Pune",
    "Kolkata",
    "Chennai",
    "Jaipur",
    "Lucknow",
  ]) {
    makeEdge(askCity, city, webhookLead);
  }
  makeEdge(askCity, "None of the above", askCustomCity);
  makeEdge(askCustomCity, null, webhookLead);
  makeEdge(webhookLead, null, askProduct);

  // CRITICAL — do not cross in the canvas
  makeEdge(askProduct, "Hair Patch", askPatchType);
  makeEdge(askProduct, "Scalp Micro Pigmentation", tplSmp);
  makeEdge(askProduct, "Hair Transplant", askUrgency);
  makeEdge(askProduct, "Front Hairline", tplFront);

  makeEdge(tplSmp, null, waitReply);
  makeEdge(tplFront, null, waitReply);

  makeEdge(askPatchType, "Clip-On", askUrgency);
  makeEdge(askPatchType, "Stick-On", askUrgency);
  makeEdge(askPatchType, "Need Help", askUrgency);

  makeEdge(waitReply, null, askUrgency);
  makeEdge(waitReply, "timeout", askPlatformTop);

  makeEdge(askUrgency, "Within 3 Days", askPlatformTop);
  makeEdge(askUrgency, "Within a Week", askPlatformTop);
  makeEdge(askUrgency, "Within a Month", askPlatformBot);
  makeEdge(askUrgency, "Not urgent", askPlatformBot);

  makeEdge(askPlatformTop, "Book Online Consult", webhookPlatTop);
  makeEdge(askPlatformTop, "In-Person Consult", webhookPlatTop);
  makeEdge(askPlatformTop, "Call Now", tplCallNow);
  makeEdge(askPlatformBot, "Book Online Consult", webhookPlatBot);
  makeEdge(askPlatformBot, "In-Person Consult", webhookPlatBot);
  makeEdge(askPlatformBot, "Call Now", tplCallNow);

  makeEdge(tplCallNow, null, webhookCallNow);
  makeEdge(webhookPlatTop, null, confirmTop);
  makeEdge(webhookPlatBot, null, confirmBot);
  makeEdge(webhookCallNow, null, photoCall);
  makeEdge(confirmTop, null, photoTop);
  makeEdge(confirmBot, null, photoBot);
  makeEdge(photoTop, null, thankTop);
  makeEdge(photoCall, null, thankCall);
  makeEdge(photoBot, null, thankBot);

  const { error: nErr } = await supabase.from("trigger_nodes").insert(nodes);
  if (nErr) throw nErr;
  const { error: eErr } = await supabase.from("trigger_edges").insert(edges);
  if (eErr) throw eErr;
  await supabase.from("trigger_flows").update({ start_node_id: askName }).eq("id", flowId);

  const productEdges = edges
    .filter((e) => e.from_node_id === askProduct)
    .map((e) => {
      const to = nodes.find((n) => n.id === e.to_node_id);
      return {
        branch: e.branch_label,
        to:
          to?.config?.template_name ||
          to?.config?.text?.slice?.(0, 40) ||
          to?.node_type,
      };
    });

  return { flowId, bpid, nodes: nodes.length, edges: edges.length, productEdges };
}

async function run() {
  const arg = (process.argv[2] || "").trim();
  const bpids = arg
    ? [arg]
    : ["1198859879988526", "waha:rahulCRM"];

  for (const bpid of bpids) {
    const { data: others } = await supabase
      .from("trigger_flows")
      .select("name")
      .eq("business_phone_number_id", bpid);
    console.log(
      "Before:",
      bpid,
      (others || []).map((f) => f.name),
    );
    const result = await seedOne(bpid);
    const { data: after } = await supabase
      .from("trigger_flows")
      .select("name")
      .eq("business_phone_number_id", bpid);
    console.log("OK", result);
    console.log(
      "After (others preserved):",
      (after || []).map((f) => f.name),
    );
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
