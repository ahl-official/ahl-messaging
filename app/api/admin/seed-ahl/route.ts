import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
    const supabase = createServiceRoleClient();

    const url = new URL(req.url);
    // Default to a known live BPID if reachable, or allow override via URL parameter ?bpid=YOUR_ID
    let bpid = url.searchParams.get("bpid") || "";

    if (!bpid) {
        const { data: contacts } = await supabase.from('contacts').select('business_phone_number_id').limit(1);
        bpid = contacts && contacts.length > 0 ? (contacts[0].business_phone_number_id || "waha:appointmentNum") : "waha:appointmentNum";
    }

    // Delete matching old ones to keep it clean
    await supabase.from('trigger_flows')
        .delete()
        .eq('name', 'Americanhairline')
        .eq('business_phone_number_id', bpid);

    // 1. Create the flow
    const { data: flow, error: flowErr } = await supabase.from('trigger_flows').insert({
        business_phone_number_id: bpid,
        name: 'Americanhairline',
        trigger_type: 'keyword',
        // Support all the trigger keywords present in the video/UI
        trigger_config: { match: 'starts', phrases: ['Hi! Tell me more', 'AHL', 'TESTAHL'] },
        // IMPORTANT: The column 'is_active' does not exist in the DB schema, only 'enabled'. Do NOT add 'is_active'.
        enabled: true
    }).select('id').single();

    if (flowErr || !flow) return NextResponse.json({ error: flowErr });

    const flowId = flow.id;
    const nodes: Record<string, any>[] = [];
    const edges: Record<string, any>[] = [];
    let sortCounter = 0;

    function addNode(type: string, config: any, x: number, y: number) {
        const id = "n_" + Math.random().toString(36).slice(2, 9);
        nodes.push({ id, flow_id: flowId, node_type: type, config, position: { x, y }, sort_order: sortCounter++ });
        return id;
    }

    function makeEdge(source: string, sourceHandle: string | null, target: string) {
        edges.push({ flow_id: flowId, from_node_id: source, to_node_id: target, branch_label: sourceHandle });
    }

    // Node 1: Ask Name
    const n1 = addNode('ask_text', {
        text: "Hello, Welcome to American Hairline! We're delighted to have you here. May we know your name?",
        var_name: 'user_name'
    }, 250, 50);

    // Node 2: Ask City (MUST be ask_list because there are 11 options. Meta limits Ask Buttons to 3 max. If we use Buttons here, Meta will crash the message).
    const n2 = addNode('ask_list', {
        text: "May I know, which city are you from?",
        var_name: 'city',
        buttons: [
            { label: "Mumbai" }, { label: "Bangalore" }, { label: "Delhi" },
            { label: "Hyderabad" }, { label: "Pune" }, { label: "Ahmedabad" },
            { label: "Chennai" }, { label: "Jaipur" }, { label: "Kolkata" },
            { label: "Surat" }, { label: "Rest of India" }
        ]
    }, 250, 150);

    // Node 3: Ask Product (Turned back to Ask List ONLY because the video has EXACTLY 4 products. If you want Ask Button, you MUST delete one product so it fits the 3-button limit.)
    const n3 = addNode('ask_list', {
        text: "What product are you interested in?",
        var_name: 'product',
        buttons: [
            { label: "Hair Patch" }, { label: "Scalp Micro Pigmentation" },
            { label: "Hair Transplant" }, { label: "Front Hairline" }
        ]
    }, 250, 250);

    // Templates: Mapping directly from the 4 Product outputs perfectly. This permanently fixes the 'Hair Patch -> SMP template' hallucination.
    const t_patch = addNode('send_template', { template_name: "front_hairline_system_videos" }, 0, 400);
    const t_smp = addNode('send_template', { template_name: "smp_price_details" }, 250, 400);
    const t_ht = addNode('send_template', { template_name: "ht_cost_transplant" }, 500, 400);
    const t_front = addNode('send_template', { template_name: "front_hairline_system_videos" }, 750, 400);

    // Node 4: Platform (3 Options fits perfectly into an ask_button! Just exactly what you wanted.)
    const n4 = addNode('ask_button', {
        text: "What platform is comfortable for you?",
        var_name: 'platform',
        buttons: [
            { label: "Zoom Online Consult" },
            { label: "In Person Consult" },
            { label: "Call Now" }
        ]
    }, 250, 550);

    // Platform Responses based strictly on the video UI choices.
    const plat_zoom = addNode('ask_text', {
        text: "Sure please share your information (Email ID, Preferred Date & Time). We will share the Zoom Link.",
        var_name: 'zoom_details'
    }, 0, 700);

    const plat_visit = addNode('ask_text', {
        text: "Sure please share your basic information (Email ID, Date & Time). Team will share appointment confirmation.",
        var_name: 'visit_details'
    }, 250, 700);

    const plat_call = addNode('message_text', {
        text: "Our Team will call you shortly"
    }, 500, 700);

    // Webhook action at the very end to capture all the data
    const webhookUrl = "https://hook.eu2.make.com/d9v6bnsm9ndv8ubyem6c6sly6sqv92n2"; // Replace with your n8n POST webhook
    const wh = addNode('webhook', { url: webhookUrl }, 250, 850);

    // Connections from Node 1 downwards:
    makeEdge(n1, null, n2);
    makeEdge(n2, null, n3);

    // Routing products tightly to their respective templates
    makeEdge(n3, "Hair Patch", t_patch);
    makeEdge(n3, "Scalp Micro Pigmentation", t_smp);
    makeEdge(n3, "Hair Transplant", t_ht);
    makeEdge(n3, "Front Hairline", t_front);

    // All templates funnel perfectly into the 'Ask Platform' node
    makeEdge(t_patch, null, n4);
    makeEdge(t_smp, null, n4);
    makeEdge(t_ht, null, n4);
    makeEdge(t_front, null, n4);

    // Routing platform responses cleanly
    makeEdge(n4, "Zoom Online Consult", plat_zoom);
    makeEdge(n4, "In Person Consult", plat_visit);
    makeEdge(n4, "Call Now", plat_call);

    // All three final branches push their captured data to webhook
    makeEdge(plat_zoom, null, wh);
    makeEdge(plat_visit, null, wh);
    makeEdge(plat_call, null, wh);

    // Push to DB
    await supabase.from("trigger_nodes").insert(nodes);
    if (edges.length > 0) await supabase.from("trigger_edges").insert(edges);

    // Set start node
    await supabase.from("trigger_flows").update({ start_node_id: n1 }).eq('id', flowId);

    return NextResponse.json({ success: true, message: `Flow seeded to ${bpid} with webhook at the end!`, startNode: n1, flowId });
}
