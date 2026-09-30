import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
    const supabase = createServiceRoleClient();

    const url = new URL(req.url);
    // Default to AHL Messaging BPID, or allow override via ?bpid=
    let bpid = url.searchParams.get("bpid") || "";

    if (!bpid) {
        // Try to find the AHL Messaging number automatically
        const { data: contacts } = await supabase.from('contacts').select('business_phone_number_id').limit(1);
        bpid = contacts && contacts.length > 0 ? (contacts[0].business_phone_number_id || "waha:appointmentNum") : "waha:appointmentNum";
    }

    // Delete matching old flow to keep it clean
    await supabase.from('trigger_flows')
        .delete()
        .eq('name', 'Americanhairline')
        .eq('business_phone_number_id', bpid);

    // 1. Create the flow — NO is_active column (doesn't exist in DB), only 'enabled'
    const { data: flow, error: flowErr } = await supabase.from('trigger_flows').insert({
        business_phone_number_id: bpid,
        name: 'Americanhairline',
        trigger_type: 'keyword',
        trigger_config: { match: 'starts', phrases: ['Hi! Tell me more', 'AHL', 'TESTAHL'] },
        enabled: true
    }).select('id').single();

    if (flowErr || !flow) return NextResponse.json({ error: flowErr });

    const flowId = flow.id;
    const nodes: Record<string, any>[] = [];
    const edges: Record<string, any>[] = [];
    let sortCounter = 0;

    function addNode(type: string, config: any, x: number, y: number) {
        const id = crypto.randomUUID();
        nodes.push({ id, flow_id: flowId, node_type: type, config, position: { x, y }, sort_order: sortCounter++ });
        return id;
    }

    function makeEdge(source: string, label: string | null, target: string) {
        edges.push({ flow_id: flowId, from_node_id: source, to_node_id: target, branch_label: label });
    }

    // =====================================================================
    // NODE 1: Ask Name (ask_text)
    // =====================================================================
    const askName = addNode('ask_text', {
        text: "Hello, Welcome to American Hairline! We're delighted to have you here. May we know your name?",
        var_name: 'user_name'
    }, 250, 50);

    // =====================================================================
    // NODE 2: Ask City (ask_button — dashboard calls it "Ask Button" even
    // with >3 options; the engine renders as interactive list automatically)
    // =====================================================================
    const askCity = addNode('ask_button', {
        text: "May I know, which city are you from?",
        var_name: 'city',
        buttons: [
            { label: "Mumbai" }, { label: "Bangalore" }, { label: "Delhi" },
            { label: "Hyderabad" }, { label: "Pune" }, { label: "Kolkata" },
            { label: "Chennai" }, { label: "Jaipur" }, { label: "Lucknow" },
            { label: "None of the above" }
        ]
    }, 250, 150);

    // =====================================================================
    // NODE 3: Custom City Input — only reached from "None of the above"
    // =====================================================================
    const askCustomCity = addNode('ask_text', {
        text: "Which city are you from then?",
        var_name: 'city'
    }, 600, 250);

    // =====================================================================
    // NODE 4: Ask Product (ask_button — 4 options, rendered as list)
    // =====================================================================
    const askProduct = addNode('ask_button', {
        text: "What product are you interested in?",
        var_name: 'product',
        buttons: [
            { label: "Hair Patch" },
            { label: "Scalp Micro Pigmentation" },
            { label: "Hair Transplant" },
            { label: "Front Hairline" }
        ]
    }, 250, 350);

    // =====================================================================
    // NODE 5: Template — SMP Price Details (for "Scalp Micro Pigmentation")
    // =====================================================================
    const tplSmp = addNode('send_template', {
        template_name: "smp_price_details"
    }, 100, 500);

    // =====================================================================
    // NODE 6: Template — Front Hairline Videos (for "Front Hairline")
    // =====================================================================
    const tplFront = addNode('send_template', {
        template_name: "front_hairline_system_videos_update"
    }, 500, 500);

    // =====================================================================
    // NODE 7: Webhook — Hair Transplant path fires webhook first
    // =====================================================================
    const webhookHT = addNode('webhook', {
        url: "https://n8n.hairscalptradingco.com/webhook/ahl-flow-webhook"
    }, 350, 500);

    // =====================================================================
    // NODE 8: Ask Hair Patch Type (ask_button — 3 options, renders as buttons!)
    // Reached from "Hair Patch" product AND from Hair Transplant webhook
    // =====================================================================
    const askPatchType = addNode('ask_button', {
        text: "Which Hair Patch you want?",
        var_name: 'patch_type',
        buttons: [
            { label: "Clip-On" },
            { label: "Stick-On" },
            { label: "Need Help" }
        ]
    }, 0, 500);

    // =====================================================================
    // NODE 9: Wait for Reply (after SMP & Front Hairline templates)
    // =====================================================================
    const waitReply = addNode('wait_reply', {
        timeout_value: 24,
        timeout_unit: "hours"
    }, 300, 650);

    // =====================================================================
    // NODE 10: Ask Urgency / Timeline (ask_button — 4 options)
    // =====================================================================
    const askUrgency = addNode('ask_button', {
        text: "How soon are you looking for a solution?",
        var_name: 'urgency',
        buttons: [
            { label: "Within 3 Days" },
            { label: "Within a Week" },
            { label: "Within a Month" },
            { label: "Not urgent" }
        ]
    }, 250, 800);

    // =====================================================================
    // NODE 11: Ask Platform — Top Branch (ask_button — 3 options, renders as buttons!)
    // =====================================================================
    const askPlatformTop = addNode('ask_button', {
        text: "Which platform is comfortable for you?",
        var_name: 'platform',
        buttons: [
            { label: "Book Online Consult" },
            { label: "In-Person Consult" },
            { label: "Call Now" }
        ]
    }, 100, 950);

    // =====================================================================
    // NODE 12: Ask Platform — Bottom Branch (ask_button — 3 options)
    // =====================================================================
    const askPlatformBot = addNode('ask_button', {
        text: "Which platform is comfortable for you?",
        var_name: 'platform',
        buttons: [
            { label: "Book Online Consult" },
            { label: "In-Person Consult" },
            { label: "Call Now" }
        ]
    }, 450, 950);

    // =====================================================================
    // NODE 13: Template — Call Now Utility
    // =====================================================================
    const tplCallNow = addNode('send_template', {
        template_name: "call_now_utility"
    }, 300, 1050);

    // =====================================================================
    // NODE 14: Webhook — Top Platform (Book Online / In-Person from top)
    // =====================================================================
    const webhookPlatTop = addNode('webhook', {
        url: "https://n8n.hairscalptradingco.com/webhook/ahl-flow-webhook"
    }, 0, 1100);

    // =====================================================================
    // NODE 15: Webhook — Bottom Platform (Book Online / In-Person from bot)
    // =====================================================================
    const webhookPlatBot = addNode('webhook', {
        url: "https://n8n.hairscalptradingco.com/webhook/ahl-flow-webhook"
    }, 500, 1100);

    // =====================================================================
    // NODE 16: Webhook — After Call Now template
    // =====================================================================
    const webhookCallNow = addNode('webhook', {
        url: "https://n8n.hairscalptradingco.com/webhook/ahl-flow-webhook"
    }, 300, 1150);

    // =====================================================================
    // NODE 17: Executive Confirmation — Top Branch (message_text)
    // =====================================================================
    const confirmTop = addNode('message_text', {
        text: "Got it. Let me take your information and one of our Executive will get back to you with the available slot time."
    }, 0, 1250);

    // =====================================================================
    // NODE 18: Executive Confirmation — Bottom Branch (message_text)
    // =====================================================================
    const confirmBot = addNode('message_text', {
        text: "Got it. Let me take your information and one of our Executive will get back to you with the available slot time."
    }, 500, 1250);

    // =====================================================================
    // NODE 19: Photo Request — Top Branch (message_text)
    // =====================================================================
    const photoTop = addNode('message_text', {
        text: "Send us your hair pics from the top, back and front. Let us understand the hair loss pattern, volume, texture and color. We keep the pics confidential."
    }, 100, 1400);

    // =====================================================================
    // NODE 20: Photo Request — Bottom Branch (message_text)
    // =====================================================================
    const photoBot = addNode('message_text', {
        text: "Send us your hair pics from the top, back and front. Let us understand the hair loss pattern, volume, texture and color. We keep the pics confidential."
    }, 450, 1400);

    // =====================================================================
    // NODE 21: Thank You — Top Branch (message_text) — TERMINAL
    // =====================================================================
    const thankTop = addNode('message_text', {
        text: "Thank you! We shall study the hair loss pattern and get back to you."
    }, 100, 1550);

    // =====================================================================
    // NODE 22: Thank You — Bottom Branch (message_text) — TERMINAL
    // =====================================================================
    const thankBot = addNode('message_text', {
        text: "Thank you! We shall study the hair loss pattern and get back to you."
    }, 450, 1550);

    // =====================================================================
    // EDGES — Exact connections from the video
    // =====================================================================

    // Ask Name → Ask City
    makeEdge(askName, null, askCity);

    // Ask City: all named cities → Ask Product; "None of the above" → Custom City
    makeEdge(askCity, "Mumbai", askProduct);
    makeEdge(askCity, "Bangalore", askProduct);
    makeEdge(askCity, "Delhi", askProduct);
    makeEdge(askCity, "Hyderabad", askProduct);
    makeEdge(askCity, "Pune", askProduct);
    makeEdge(askCity, "Kolkata", askProduct);
    makeEdge(askCity, "Chennai", askProduct);
    makeEdge(askCity, "Jaipur", askProduct);
    makeEdge(askCity, "Lucknow", askProduct);
    makeEdge(askCity, "None of the above", askCustomCity);

    // Custom City → Ask Product
    makeEdge(askCustomCity, null, askProduct);

    // Ask Product → branches
    makeEdge(askProduct, "Hair Patch", askPatchType);
    makeEdge(askProduct, "Scalp Micro Pigmentation", tplSmp);
    makeEdge(askProduct, "Hair Transplant", webhookHT);
    makeEdge(askProduct, "Front Hairline", tplFront);

    // Hair Transplant webhook → Ask Patch Type (as shown in video)
    makeEdge(webhookHT, null, askPatchType);

    // SMP template & Front Hairline template → Wait for Reply
    makeEdge(tplSmp, null, waitReply);
    makeEdge(tplFront, null, waitReply);

    // Ask Patch Type: all 3 options → Ask Urgency
    makeEdge(askPatchType, "Clip-On", askUrgency);
    makeEdge(askPatchType, "Stick-On", askUrgency);
    makeEdge(askPatchType, "Need Help", askUrgency);

    // Wait for Reply → Ask Urgency (reply branch) and Ask Platform Top (timeout branch)
    makeEdge(waitReply, null, askUrgency);        // reply
    makeEdge(waitReply, "timeout", askPlatformTop); // timeout

    // Ask Urgency → both Platform nodes
    makeEdge(askUrgency, "Within 3 Days", askPlatformTop);
    makeEdge(askUrgency, "Within a Week", askPlatformTop);
    makeEdge(askUrgency, "Within a Month", askPlatformBot);
    makeEdge(askUrgency, "Not urgent", askPlatformBot);

    // Ask Platform Top
    makeEdge(askPlatformTop, "Book Online Consult", webhookPlatTop);
    makeEdge(askPlatformTop, "In-Person Consult", webhookPlatTop);
    makeEdge(askPlatformTop, "Call Now", tplCallNow);

    // Ask Platform Bottom
    makeEdge(askPlatformBot, "Book Online Consult", webhookPlatBot);
    makeEdge(askPlatformBot, "In-Person Consult", webhookPlatBot);
    makeEdge(askPlatformBot, "Call Now", tplCallNow);

    // Call Now template → Webhook after call now
    makeEdge(tplCallNow, null, webhookCallNow);

    // Platform webhooks → Executive Confirmation messages
    makeEdge(webhookPlatTop, null, confirmTop);
    makeEdge(webhookPlatBot, null, confirmBot);

    // Executive Confirmations → Photo Request
    makeEdge(confirmTop, null, photoTop);
    makeEdge(confirmBot, null, photoBot);

    // Call Now webhook also → Photo (through the call_now path)
    makeEdge(webhookCallNow, null, photoTop);

    // Photo Request → Thank You (terminal)
    makeEdge(photoTop, null, thankTop);
    makeEdge(photoBot, null, thankBot);

    // =====================================================================
    // Push to DB
    // =====================================================================
    const { error: nodeErr } = await supabase.from("trigger_nodes").insert(nodes);
    if (nodeErr) return NextResponse.json({ error: nodeErr });

    if (edges.length > 0) {
        const { error: edgeErr } = await supabase.from("trigger_edges").insert(edges);
        if (edgeErr) return NextResponse.json({ error: edgeErr });
    }

    // Set start node
    await supabase.from("trigger_flows").update({ start_node_id: askName }).eq('id', flowId);

    return NextResponse.json({
        success: true,
        message: `AHL UTM Flow seeded to ${bpid} as 'Americanhairline' — ${nodes.length} nodes, ${edges.length} edges`,
        startNode: askName,
        flowId,
        nodeCount: nodes.length,
        edgeCount: edges.length
    });
}
