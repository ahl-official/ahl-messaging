import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Seeds ONLY the "AHL UTM Flow" trigger graph (Ask Button nodes).
 * Does not create, rename, or delete any other flow.
 *
 * GET /api/admin/seed-ahl-utm?bpid=<phone_number_id>
 */
export async function GET(req: Request) {
  const supabase = createServiceRoleClient();
  const url = new URL(req.url);
  let bpid = url.searchParams.get("bpid")?.trim() || "";

  if (!bpid) {
    const { data: sibling } = await supabase
      .from("trigger_flows")
      .select("business_phone_number_id")
      .eq("name", "Americanhairline")
      .limit(1);
    bpid = sibling?.[0]?.business_phone_number_id || "1198859879988526";
  }

  // Replace this named flow only — never touch Americanhairline / others.
  await supabase
    .from("trigger_flows")
    .delete()
    .eq("name", "AHL UTM Flow")
    .eq("business_phone_number_id", bpid);

  const { data: flow, error: flowErr } = await supabase
    .from("trigger_flows")
    .insert({
      business_phone_number_id: bpid,
      name: "AHL UTM Flow",
      trigger_type: "keyword",
      trigger_config: {
        match: "starts",
        phrases: ["Hi! Tell me more", "Tell me more"],
      },
      enabled: true,
    })
    .select("id")
    .single();

  if (flowErr || !flow) return NextResponse.json({ error: flowErr }, { status: 500 });

  const flowId = flow.id;
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  let sortCounter = 0;

  function addNode(type: string, config: unknown, x: number, y: number) {
    const id = crypto.randomUUID();
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

  const webhookUrl = "https://n8n.hairscalptradingco.com/webhook/ahl-flow-webhook";

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
    {
      text: "Which city are you from then?",
      var_name: "city",
    },
    420,
    420,
  );

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
    780,
    80,
  );

  const tplSmp = addNode("send_template", { template_name: "smp_price_details" }, 1140, 20);
  const tplFront = addNode(
    "send_template",
    { template_name: "front_hairline_system_videos_update" },
    1140,
    180,
  );
  const webhookHT = addNode("webhook", { url: webhookUrl }, 1140, 360);

  const waitReply = addNode(
    "wait_reply",
    { timeout_value: 24, timeout_unit: "hours" },
    1500,
    20,
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
    1860,
    160,
  );

  const platformButtons = [
    { label: "Book Online Consult" },
    { label: "In-Person Consult" },
    { label: "Call Now" },
  ];

  const askPlatformTop = addNode(
    "ask_button",
    {
      text: "Which platform is comfortable for you?",
      var_name: "platform",
      buttons: platformButtons,
    },
    2220,
    40,
  );

  const askPlatformBot = addNode(
    "ask_button",
    {
      text: "Which platform is comfortable for you?",
      var_name: "platform",
      buttons: platformButtons,
    },
    2220,
    280,
  );

  const webhookPlatTop = addNode("webhook", { url: webhookUrl }, 2580, 20);
  const tplCallNow = addNode("send_template", { template_name: "call_now_utility" }, 2580, 180);
  const webhookPlatBot = addNode("webhook", { url: webhookUrl }, 2580, 340);

  const confirmText =
    "Got it. Let me take your information and one of our Executive will get back to you with the available slot time.";
  const photoText =
    "Send us your hair pics from the top, back and front. Let us understand the hair loss pattern, volume, texture and color. We keep the pics confidential.";
  const thankText = "Thank you! We shall study the hair loss pattern and get back to you.";

  const confirmTop = addNode("message_text", { text: confirmText }, 2940, 20);
  const webhookCallNow = addNode("webhook", { url: webhookUrl }, 2940, 180);
  const confirmBot = addNode("message_text", { text: confirmText }, 2940, 340);

  const photoTop = addNode("message_text", { text: photoText }, 3300, 20);
  const photoCall = addNode("message_text", { text: photoText }, 3300, 180);
  const photoBot = addNode("message_text", { text: photoText }, 3300, 340);

  const thankTop = addNode("message_text", { text: thankText }, 3660, 20);
  const thankCall = addNode("message_text", { text: thankText }, 3660, 180);
  const thankBot = addNode("message_text", { text: thankText }, 3660, 340);

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
    makeEdge(askCity, city, askProduct);
  }
  makeEdge(askCity, "None of the above", askCustomCity);
  makeEdge(askCustomCity, null, askProduct);

  makeEdge(askProduct, "Hair Patch", askPatchType);
  makeEdge(askProduct, "Scalp Micro Pigmentation", tplSmp);
  makeEdge(askProduct, "Hair Transplant", webhookHT);
  makeEdge(askProduct, "Front Hairline", tplFront);

  makeEdge(webhookHT, null, askPatchType);
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

  const { error: nodeErr } = await supabase.from("trigger_nodes").insert(nodes);
  if (nodeErr) return NextResponse.json({ error: nodeErr }, { status: 500 });

  const { error: edgeErr } = await supabase.from("trigger_edges").insert(edges);
  if (edgeErr) return NextResponse.json({ error: edgeErr }, { status: 500 });

  await supabase.from("trigger_flows").update({ start_node_id: askName }).eq("id", flowId);

  return NextResponse.json({
    success: true,
    message: `AHL UTM Flow seeded on ${bpid} — ${nodes.length} nodes, ${edges.length} edges. Other flows unchanged.`,
    flowId,
    bpid,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    startNode: askName,
  });
}
