import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import crypto from "crypto";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
    const supabase = createServiceRoleClient();

    const url = new URL(req.url);
    let bpid = url.searchParams.get("bpid") || "";

    if (!bpid) {
        // Automatically steal the exact Business Phone ID from the original AHL flow!
        const { data: oldFlow } = await supabase.from('trigger_flows').select('business_phone_number_id').eq('name', 'Americanhairline').limit(1);
        bpid = oldFlow && oldFlow.length > 0 ? (oldFlow[0].business_phone_number_id || "waha:appointmentNum") : "waha:appointmentNum";
    }

    // Delete matching old ones to keep it perfectly clean
    await supabase.from('trigger_flows')
        .delete()
        .eq('name', 'Normal Americanhairline')
        .eq('business_phone_number_id', bpid);

    // 1. Create the Flow Container
    const { data: flow, error: flowErr } = await supabase.from('trigger_flows').insert({
        business_phone_number_id: bpid,
        name: 'Normal Americanhairline',
        trigger_type: 'keyword',
        trigger_config: { match: 'exact', phrases: ['I want to know more about Hair Loss solutions'] },
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

    function makeEdge(source: string, sourceHandle: string | null, target: string) {
        edges.push({ flow_id: flowId, from_node_id: source, to_node_id: target, branch_label: sourceHandle });
    }

    // Node 1: Ask Name
    const n1 = addNode('ask_text', {
        text: "Hello, Welcome to American Hairline! We're delighted to have you here.\n\nMay we know your name?",
        var_name: 'Name'
    }, 250, 100);

    // Node 2: Ask Treatment (Interactive List for 4 options)
    const n2 = addNode('ask_list', {
        text: "What treatment are you exclusively interested in learning about today?",
        var_name: 'Interested In',
        list_options: ["Hair Patch", "Hair Transplant", "Front Hairline", "SMP"]
    }, 250, 250);

    // Node 3: Ask City (Interactive List for 10 options)
    const n3 = addNode('ask_list', {
        text: "May I know, which city are you from?",
        var_name: 'City',
        list_options: ["Mumbai", "Bangalore", "Delhi", "Hyderabad", "Pune", "Kolkata", "Chennai", "Jaipur", "Lucknow", "None of the above"]
    }, 250, 400);

    // Node 4: Send Final Thank You Message
    const n4 = addNode('message_text', {
        text: "Thank you so much! Our executives will reach out to you shortly."
    }, 250, 550);

    // Node 5: Webhook to n8n (Sends all the collected data silently in the background!)
    const webhookUrl = "https://hook.eu2.make.com/d9v6bnsm9ndv8ubyem6c6sly6sqv92n2"; // User's standard n8n/make hook
    const wh = addNode('webhook', { url: webhookUrl }, 500, 550);

    // Connect the paths smoothly descending!
    makeEdge(n1, null, n2);
    makeEdge(n2, null, n3);
    makeEdge(n3, null, n4);

    // Once the thank you message fires, instantly hit the webhook!
    makeEdge(n4, null, wh);

    // Push to DB
    const { error: nErr } = await supabase.from("trigger_nodes").insert(nodes);
    const { error: eErr } = edges.length > 0 ? await supabase.from("trigger_edges").insert(edges) : { error: null };

    // Set start node
    await supabase.from("trigger_flows").update({ start_node_id: n1 }).eq('id', flowId);

    return NextResponse.json({ success: true, message: `Normal Organic flow beautifully seeded successfully!`, startNode: n1, flowId, nErr, eErr });
}
