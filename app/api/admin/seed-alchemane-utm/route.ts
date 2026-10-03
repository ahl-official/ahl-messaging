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
      // Any new session (UTM dump / Hi / etc.) — silent leads still hit the sheet.
      trigger_type: "first_message",
      trigger_config: {},
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
        "Hey there! Welcome to Alchemane Hair Extensions ✅ We specialize in 100% natural human hair extensions and would love to help. May we know your name?",
      var_name: "user_name",
    },
    420,
    160,
  );

  const thanks = addNode(
    "message_text",
    { text: "Thanks, {{user_name}}! Let's get started." },
    760,
    160,
  );

  const askCity = addNode(
    "ask_button",
    {
      text: "We offer our services all across India 🇮🇳 Can you tell us which city you're from?",
      var_name: "city",
      buttons: [{ label: "Mumbai" }, { label: "Bangalore" }, { label: "Other" }],
    },
    1100,
    160,
  );

  const askCustomCity = addNode(
    "ask_text",
    { text: "Please mention your city here.", var_name: "city" },
    1100,
    420,
  );

  const webhookAfterCity = addNode("webhook", { url: WEBHOOK_URL }, 1440, 160);

  const askInterest = addNode(
    "ask_list",
    {
      text: "What are you looking for today?",
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
      prompt: "Which permanent extension style are you interested in?",
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
      prompt: "Which clip-in option are you looking for?",
      choices: ["Full Head", "Fringes", "Silk Hair Toppers", "U-Shape Clip-in"],
    },
    {
      label: "Fringes & Toppers",
      y: 280,
      prompt: "Which fringes or toppers option do you prefer?",
      choices: ["Silk Toppers", "Front Fringes", "U-Shape Toppers"],
    },
    {
      label: "Extensions Servicing",
      y: 420,
      prompt: "Which servicing do you need?",
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
        "Thanks, {{user_name}}! Our expert will call you shortly 📞 We'll help you choose the perfect hair extensions.",
    },
    2800,
    280,
  );

  for (const opt of interestOptions) {
    const wh = addNode("webhook", { url: WEBHOOK_URL }, 2120, opt.y);
    makeEdge(askInterest, opt.label, wh);

    if (opt.choices.length === 0) {
      const help = addNode(
        "message_text",
        {
          text:
            "No worries — our expert will understand your needs and guide you on the best option.",
        },
        2460,
        opt.y,
      );
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
      2460,
      opt.y,
    );
    const whChoice = addNode("webhook", { url: WEBHOOK_URL }, 2640, opt.y);
    makeEdge(wh, null, askSubtype);
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
    message: `Alchemane UTM Flow seeded on ${bpid} — first-message webhook (phone+UTM) then lists. Other flows unchanged.`,
    flowId,
    bpid,
    nodes: nodes.length,
    edges: edges.length,
    branches: interestOptions.map((o) => o.label),
  });
}
