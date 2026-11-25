/**
 * Inserts ONLY "Alchemane UTM Flow". Does not modify any other trigger_flows row.
 *
 * Default BPID = Alchemane Hair Extensions (1313214928544905).
 * Webhooks → n8n alchemane-whatsapp-sheet.
 * Flow: name→city→sheet→interest→thanks→photos→Type|Voice|I'm all set.
 *
 * Usage: node scripts/seed-alchemane-utm-flow.js [optional_bpid]
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

const WEBHOOK_URL =
  "https://n8n.hairscalptradingco.com/webhook/alchemane-whatsapp-sheet";
const DEFAULT_BPID = "1313214928544905";

function uuid() {
  return crypto.randomUUID();
}

async function seedOne(bpid) {
  // Remove any prior Alchemane UTM Flow (including old-number copies).
  await supabase.from("trigger_flows").delete().eq("name", "Alchemane UTM Flow");

  const { data: flow, error: flowErr } = await supabase
    .from("trigger_flows")
    .insert({
      business_phone_number_id: bpid,
      name: "Alchemane UTM Flow",
      // Same opener keywords as AHL UTM Flow.
      trigger_type: "keyword",
      trigger_config: {
        match: "starts",
        phrases: [
          "Hi! Tell me more",
          "Hi! Tell me more:",
          "Tell me more",
          "I want to know more about Hair Extensions",
        ],
      },
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

  // Fire sheet FIRST (phone + UTM) before any question — silent leads still land.
  const webhookFirst = addNode("webhook", { url: WEBHOOK_URL }, 80, 160);

  const askName = addNode(
    "ask_text",
    {
      text:
        "Hello! 👋 Welcome to Alchemane Hair Extensions.\nWe're delighted to connect with you! We specialise in 100% natural human hair extensions. To help you better, may we know your *Name*?",
      var_name: "user_name",
      remind_on_invalid: true,
      invalid_reply_message: "Please tell us your name so we can continue 😊",
    },
    420,
    160,
  );

  const thanks = addNode(
    "message_text",
    {
      text: "Nice to meet you, {{user_name}}! 😊 Let's get you the perfect hair look.",
    },
    760,
    160,
  );

  const askCity = addNode(
    "ask_button",
    {
      text: "Nice to connect with you! 😊 Which city are you currently located in? (Tap below to select):",
      var_name: "city",
      buttons: [{ label: "Mumbai" }, { label: "Bangalore" }, { label: "Other" }],
    },
    1100,
    160,
  );

  const askCustomCity = addNode(
    "ask_text",
    {
      text: "No problem! Could you please type and send the city or region you are from?",
      var_name: "city",
    },
    1100,
    420,
  );

  const webhookAfterCity = addNode("webhook", { url: WEBHOOK_URL }, 1440, 160);

  // City → product directly (no mid-funnel voice — that blocked the flow).
  const askInterest = addNode(
    "ask_list",
    {
      text: "To guide you to the right Alchemane specialist, which option would you like to explore today? 👇",
      var_name: "interested_in",
      buttons: [
        { label: "Permanent Extensions" },
        { label: "Clip-in Hair Extensions" },
        { label: "Fringes & Toppers" },
        { label: "Extensions Servicing" },
        { label: "Not Sure, Need Help!" },
      ],
    },
    1780,
    160,
  );

  // Session list/buttons (free inside 24h window) — no paid Meta templates.
  const interestOptions = [
    {
      label: "Permanent Extensions",
      y: 0,
      prompt: "Great choice! Which permanent extension style are you interested in? (Tap below):",
      choices: [
        "Keratin Bond Extensions",
        "Micro Ring Extensions",
        "Tape-in Extensions",
        "U-Shape Extensions",
        "Halo Hair Extensions",
      ],
    },
    {
      label: "Clip-in Hair Extensions",
      y: 140,
      prompt: "Great choice! Which clip-in option are you looking for? (Tap below):",
      choices: ["Full Head", "Fringes", "Silk Hair Toppers", "U-Shape Clip-in"],
    },
    {
      label: "Fringes & Toppers",
      y: 280,
      prompt: "Great choice! Which fringes or toppers option do you prefer? (Tap below):",
      choices: ["Silk Toppers", "Front Fringes", "U-Shape Toppers"],
    },
    {
      label: "Extensions Servicing",
      y: 420,
      prompt: "Got it! Which servicing do you need? (Tap below):",
      choices: ["Re-taping", "Re-bonding", "Washing Deep Conditioning"],
    },
    {
      label: "Not Sure, Need Help!",
      y: 560,
      prompt: null,
      choices: [],
    },
  ];

  const thanksCall = addNode(
    "message_text",
    {
      text:
        "Thank you, {{user_name}}! 🙏 We have received your request.\n\nOne of our Alchemane experts will call you shortly to help you choose the perfect hair extensions.",
    },
    3100,
    280,
  );

  // After thank-you: photos first, then optional query (type | voice | done).
  const askExtraPhotos = addNode(
    "ask_file",
    {
      text:
        "To help our expert prepare for the call, please send clear photos of your hair (front / top / back if possible). We keep them confidential 📸",
      var_name: "hair_photos",
    },
    3440,
    280,
  );
  const askExtraHelp = addNode(
    "ask_button",
    {
      text:
        "Any question you'd like to share before we call? You can type it, send a voice note, or tap I'm all set.",
      var_name: "extra_help_mode",
      buttons: [
        { label: "Type" },
        { label: "Send a voice note" },
        { label: "I'm all set" },
      ],
      remind_on_invalid: true,
      invalid_reply_message:
        "Please tap *Type*, *Send a voice note*, or *I'm all set* — or just type / send a voice note now.",
    },
    3780,
    280,
  );
  const askExtraQuery = addNode(
    "ask_text",
    {
      text: "Please type your question — our advisor will reply with guidance ✨",
      var_name: "extra_query",
      remind_on_invalid: true,
      invalid_reply_message: "Please type a short note, or send a voice note if you prefer.",
    },
    4120,
    80,
  );
  const askExtraVoice = addNode(
    "ask_text",
    {
      text: "Please send a voice note with your question — our advisor will reply with guidance 🎤 You can also type it.",
      var_name: "extra_query",
      remind_on_invalid: true,
      invalid_reply_message: "Please send a voice note or type your question.",
    },
    4120,
    280,
  );
  // Type / voice answers are released to AI (no static "got it" — AI guides
  // or hands off for prices / confidential / off-topic).
  const allSetDone = addNode(
    "message_text",
    {
      text: "Perfect! We're all set. Our expert will call you shortly 😊",
    },
    4120,
    480,
  );

  for (const opt of interestOptions) {
    // One sheet append after final product — skip the interest-stage webhook
    // that was creating duplicate rows for the same lead.
    if (opt.choices.length === 0) {
      const wh = addNode("webhook", { url: WEBHOOK_URL }, 2440, opt.y);
      const help = addNode(
        "message_text",
        {
          text:
            "No worries at all! 😊 Our expert will understand your needs and guide you to the best option.",
        },
        2780,
        opt.y,
      );
      makeEdge(askInterest, opt.label, wh);
      makeEdge(wh, null, help);
      makeEdge(help, null, thanksCall);
      continue;
    }

    const askSubtype = addNode(
      "ask_list",
      {
        text: opt.prompt,
        var_name: "product_choice",
        buttons: opt.choices.map((label) => ({ label })),
      },
      2440,
      opt.y,
    );
    const whChoice = addNode("webhook", { url: WEBHOOK_URL }, 2780, opt.y);
    makeEdge(askInterest, opt.label, askSubtype);
    for (const choice of opt.choices) {
      makeEdge(askSubtype, choice, whChoice);
    }
    makeEdge(whChoice, null, thanksCall);
  }

  makeEdge(webhookFirst, null, askName);
  makeEdge(askName, null, thanks);
  makeEdge(thanks, null, askCity);
  makeEdge(askCity, "Mumbai", webhookAfterCity);
  makeEdge(askCity, "Bangalore", webhookAfterCity);
  makeEdge(askCity, "Other", askCustomCity);
  makeEdge(askCustomCity, null, webhookAfterCity);
  makeEdge(webhookAfterCity, null, askInterest);
  makeEdge(thanksCall, null, askExtraPhotos);
  makeEdge(askExtraPhotos, null, askExtraHelp);
  makeEdge(askExtraHelp, "Type", askExtraQuery);
  makeEdge(askExtraHelp, "Send a voice note", askExtraVoice);
  makeEdge(askExtraHelp, "I'm all set", allSetDone);
  // askExtraQuery / askExtraVoice have no out-edge — engine completes + AI.

  const { error: nErr } = await supabase.from("trigger_nodes").insert(nodes);
  if (nErr) throw nErr;
  const { error: eErr } = await supabase.from("trigger_edges").insert(edges);
  if (eErr) throw eErr;
  await supabase.from("trigger_flows").update({ start_node_id: webhookFirst }).eq("id", flowId);

  return {
    flowId,
    bpid,
    nodes: nodes.length,
    edges: edges.length,
    branches: interestOptions.map((o) => o.label),
  };
}

async function run() {
  const arg = (process.argv[2] || "").trim();
  const bpid = arg || DEFAULT_BPID;

  const { data: before } = await supabase
    .from("trigger_flows")
    .select("name")
    .eq("business_phone_number_id", bpid);
  console.log(
    "Before:",
    bpid,
    (before || []).map((f) => f.name),
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

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
