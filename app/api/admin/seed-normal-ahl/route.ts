import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
    const supabase = createServiceRoleClient();

    const url = new URL(req.url);
    // Default to a known live BPID if reachable, or allow override
    let bpid = url.searchParams.get("bpid") || "";

    if (!bpid) {
        const { data: contacts } = await supabase.from('contacts').select('business_phone_number_id').limit(1);
        bpid = contacts && contacts.length > 0 ? (contacts[0].business_phone_number_id || "waha:appointmentNum") : "waha:appointmentNum";
    }

    // Delete matching old ones to keep it clean
    await supabase.from('trigger_flows')
        .delete()
        .eq('name', 'Normal Americanhairline')
        .eq('business_phone_number_id', bpid);

    // 1. Create the flow
    const { data: flow, error: flowErr } = await supabase.from('trigger_flows').insert({
        business_phone_number_id: bpid,
        name: 'Normal Americanhairline',
        trigger_type: 'keyword',
        trigger_config: { match: 'exact', phrases: ['I want to know more about Hair Loss solutions'] },
        is_active: true,
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

    // Node Setup: Ask Name
    const n1 = addNode('ask_text', {
        text: "Hello, Welcome to American Hairline! We're delighted to have you here.\n\nMay we know your name?",
        var_name: 'user_name'
    }, 250, 100);

    // Node Setup: Ask Product
    // We use ask_button here specifically to show beautiful Quick Reply buttons!
    const n2 = addNode('ask_button', {
        text: "What treatment are you exclusively interested in learning about today?",
        var_name: 'product',
        buttons: [{ label: "Hair Patch" }, { label: "Hair Transplant" }, { label: "SMP" }]
    }, 250, 250);

    // Branches
    const t_patch = addNode('send_template', { template_name: "smp_price" }, 0, 450);
    const t_transplant = addNode('send_template', { template_name: "call_now" }, 250, 450);
    const t_smp = addNode('send_template', { template_name: "front_hairline_system_videos" }, 500, 450);

    // Final Action: Send to n8n Webhook
    const webhookUrl = "https://hook.eu2.make.com/d9v6bnsm9ndv8ubyem6c6sly6sqv92n2"; // Replace with your n8n POST webhook
    const wh = addNode('webhook', { url: webhookUrl }, 250, 600);

    // Connect the paths!
    makeEdge(n1, null, n2);
    makeEdge(n2, "Hair Patch", t_patch);
    makeEdge(n2, "Hair Transplant", t_transplant);
    makeEdge(n2, "SMP", t_smp);

    // All templates funnelling into the webhook at the very end!
    makeEdge(t_patch, null, wh);
    makeEdge(t_transplant, null, wh);
    makeEdge(t_smp, null, wh);

    // Push to DB
    await supabase.from("trigger_nodes").insert(nodes);
    if (edges.length > 0) await supabase.from("trigger_edges").insert(edges);

    // Set start node
    await supabase.from("trigger_flows").update({ start_node_id: n1 }).eq('id', flowId);

    return NextResponse.json({ success: true, message: `Normal Organic flow seeded to ${bpid} successfully!`, startNode: n1, flowId });
}
