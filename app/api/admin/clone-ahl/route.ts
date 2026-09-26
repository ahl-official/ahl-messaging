import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import crypto from "crypto";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
    const supabase = createServiceRoleClient();

    // 1. Get the LIVE Americanhairline flow!
    const { data: originalFlow, error: err1 } = await supabase.from('trigger_flows')
        .select('*')
        .eq('name', 'Americanhairline')
        .single();

    if (err1 || !originalFlow) return NextResponse.json({ error: "Could not find original flow" });

    // 2. Clear old ones to keep clean
    await supabase.from('trigger_flows')
        .delete()
        .eq('name', 'Normal Americanhairline')
        .eq('business_phone_number_id', originalFlow.business_phone_number_id);

    // 3. Create the cloned flow metadata
    const { data: newFlow, error: err2 } = await supabase.from('trigger_flows').insert({
        business_phone_number_id: originalFlow.business_phone_number_id,
        name: 'Normal Americanhairline',
        trigger_type: 'keyword',
        trigger_config: { match: 'exact', phrases: ['I want to know more about Hair Loss solutions'] },
        enabled: true,
        // we will set start_node_id after copying nodes!
    }).select('id').single();

    if (err2 || !newFlow) return NextResponse.json({ error: err2 });

    // 4. Fetch all live nodes and edges
    const { data: oldNodes } = await supabase.from('trigger_nodes').select('*').eq('flow_id', originalFlow.id);
    const { data: oldEdges } = await supabase.from('trigger_edges').select('*').eq('flow_id', originalFlow.id);

    // 5. Generate UUID mappings
    const idMap: Record<string, string> = {};
    for (const node of oldNodes || []) {
        idMap[node.id] = crypto.randomUUID();
    }

    // 6. Deep clone the nodes, modify ask_list to ask_button per user request
    const newNodes = (oldNodes || []).map(node => {
        const newNode = { ...node };
        newNode.id = idMap[node.id];
        newNode.flow_id = newFlow.id;
        delete newNode.created_at;
        delete newNode.updated_at;

        // Apply specific requested modifications: Convert lists to beautiful clickable Quick Reply buttons!
        if (newNode.node_type === 'ask_list') {
            const numOptions = newNode.config?.list_options?.length || 0;
            // Only convert if it has 3 or fewer options (Meta's strict limit for Quick Reply buttons)
            if (numOptions <= 3) {
                newNode.node_type = 'ask_button';
                if (newNode.config && newNode.config.list_options) {
                    newNode.config.buttons = newNode.config.list_options.map((opt: string) => ({ label: opt }));
                    delete newNode.config.list_options;
                }
            }
        }
        return newNode;
    });

    // 7. Deep clone edges
    const newEdges = (oldEdges || []).map(edge => {
        const newEdge = { ...edge };
        delete newEdge.id;
        delete newEdge.created_at;
        delete newEdge.updated_at;
        newEdge.flow_id = newFlow.id;
        newEdge.from_node_id = idMap[edge.from_node_id];
        newEdge.to_node_id = idMap[edge.to_node_id];
        return newEdge;
    });

    // 8. Inject!
    let nErr = null, eErr = null;
    if (newNodes.length > 0) {
        const { error } = await supabase.from('trigger_nodes').insert(newNodes);
        nErr = error;
    }
    if (newEdges.length > 0) {
        const { error } = await supabase.from('trigger_edges').insert(newEdges);
        eErr = error;
    }

    // 9. Assign new start node
    const newStartNodeId = idMap[originalFlow.start_node_id];
    if (newStartNodeId) {
        await supabase.from('trigger_flows').update({ start_node_id: newStartNodeId }).eq('id', newFlow.id);
    }

    return NextResponse.json({ success: true, steps_cloned: newNodes.length, nErr, eErr });
}
