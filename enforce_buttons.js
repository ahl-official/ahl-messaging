const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function enforceButtons() {
    const { data: flows } = await supabase.from('trigger_flows').select('id').eq('name', 'Normal Americanhairline').limit(1);
    if (!flows || flows.length === 0) return console.log("Flow not found");

    const flowId = flows[0].id;
    const { data: nodes } = await supabase.from('trigger_nodes').select('*').eq('flow_id', flowId).in('node_type', ['ask_list', 'ask_button', 'message_buttons']);

    let updatedCount = 0;

    for (const node of nodes) {
        let needsUpdate = false;
        const cfg = node.config || {};
        const buttons = cfg.buttons || [];

        // 1. Force the node to be an ask_button natively
        if (node.node_type !== 'ask_button') {
            node.node_type = 'ask_button';
            needsUpdate = true;
        }

        // 2. Strict Meta Limit: Maximum 3 interactive buttons
        if (buttons.length > 3) {
            cfg.buttons = buttons.slice(0, 3);
            needsUpdate = true;
        }

        // 3. Strict Meta Limit: Maximum 20 characters per button title
        if (cfg.buttons) {
            cfg.buttons = cfg.buttons.map(b => {
                // Special case rewrite for the long product name
                if (b.label === "Scalp Micro Pigmentation") b.label = "SMP";

                if (b.label && b.label.length > 20) {
                    b.label = b.label.substring(0, 20).trim();
                    needsUpdate = true;
                }
                return b;
            });
        }

        if (needsUpdate) {
            node.config = cfg;
            await supabase.from('trigger_nodes').update({ node_type: node.node_type, config: node.config }).eq('id', node.id);
            updatedCount++;
        }
    }

    console.log(`Successfully enforced Meta Quick Reply strict UI formatting on ${updatedCount} nodes!`);
}
enforceButtons();
