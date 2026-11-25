import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

/**
 * Seeds ONLY the "Alchemane UTM Flow" trigger graph.
 * Does not create, rename, or delete any other flow (incl. AHL UTM Flow).
 *
 * Default BPID = Alchemane Hair Extensions Cloud API number.
 * Webhooks → n8n Sheet append.
 *
 * GET /api/admin/seed-alchemane-utm?bpid=<phone_number_id>
 */
export async function GET(req: Request) {
  const supabase = createServiceRoleClient();
  const url = new URL(req.url);
  const bpid =
    url.searchParams.get("bpid")?.trim() || "1313214928544905";

  // Remove any prior Alchemane UTM Flow (including old AHL-number copies).
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

  if (flowErr || !flow) {
    return NextResponse.json({ success: false, error: flowErr?.message || "insert failed" }, { status: 500 });
  }

  const flowId = flow.id;
  const nodes: Array<{
    id: string;
    flow_id: string;
    node_type: string;
    config: Record<string, unknown>;
    position: { x: number; y: number };
    sort_order: number;
  }> = [];
  const edges: Array<{
    flow_id: string;
    from_node_id: string;
    to_node_id: string;
    branch_label: string | null;
  }> = [];
  let sortCounter = 0;

  function addNode(type: string, config: Record<string, unknown>, x: number, y: number) {
    const id = randomUUID();
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

  function makeEdge(source: string, label: string | null, target: string) {
    edges.push({
      flow_id: flowId,
      from_node_id: source,
      to_node_id: target,
      branch_label: label,
    });
  }

  const WEBHOOK_URL =
    "https://n8n.hairscalptradingco.com/webhook/alchemane-whatsapp-sheet";

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

  const askConcernMode = addNode(
    "ask_button",
    {
      text: "Please share your hair goal or concern. You can type it, or send a voice note 🎤",
      var_name: "concern_mode",
      buttons: [{ label: "Type your request" }, { label: "Send a voice note" }],
      remind_on_invalid: true,
      invalid_reply_message:
        "Please tap *Type your request* or *Send a voice note* — or just type / send a voice note now 😊",
    },
    1680,
    160,
  );
  const askConcernText = addNode(
    "ask_text",
    {
      text: "Please type what you're looking for — for example more volume, added length, fringes, toppers, or servicing ✨",
      var_name: "concern",
      remind_on_invalid: true,
      invalid_reply_message:
        "Please type a short note about what you need so we can guide you better.",
    },
    1860,
    40,
  );
  const askConcernVoice = addNode(
    "ask_text",
    {
      text: "Please send a voice note describing what you need 🎤 You can also type it if you prefer.",
      var_name: "concern",
      remind_on_invalid: true,
      invalid_reply_message:
        "Please send a voice note or type what you need so we can continue.",
    },
    1860,
    280,
  );

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
    2100,
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
      prompt: null as string | null,
      choices: [] as string[],
    },
  ] as const;

  const thanksCall = addNode(
    "message_text",
    {
      text:
        "Thank you, {{user_name}}! 🙏 We have received your request.\n\nOne of our Alchemane experts will call you shortly to help you choose the perfect hair extensions.",
    },
    3100,
    280,
  );

  for (const opt of interestOptions) {
    // One sheet row after final product pick — not after interest + subtype
    // (that was doubling/tripling rows for the same wa_tracking).
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
        text: opt.prompt as string,
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
  makeEdge(webhookAfterCity, null, askConcernMode);
  makeEdge(askConcernMode, "Type your request", askConcernText);
  makeEdge(askConcernMode, "Send a voice note", askConcernVoice);
  makeEdge(askConcernText, null, askInterest);
  makeEdge(askConcernVoice, null, askInterest);

  const { error: nErr } = await supabase.from("trigger_nodes").insert(nodes);
  if (nErr) {
    return NextResponse.json({ success: false, error: nErr.message }, { status: 500 });
  }
  const { error: eErr } = await supabase.from("trigger_edges").insert(edges);
  if (eErr) {
    return NextResponse.json({ success: false, error: eErr.message }, { status: 500 });
  }

  await supabase.from("trigger_flows").update({ start_node_id: webhookFirst }).eq("id", flowId);

  return NextResponse.json({
    success: true,
    message: `Alchemane UTM Flow seeded on ${bpid} — name→city→sheet→concern(type|voice)→interest. Other flows unchanged.`,
    flowId,
    bpid,
    nodes: nodes.length,
    edges: edges.length,
    branches: interestOptions.map((o) => o.label),
  });
}
