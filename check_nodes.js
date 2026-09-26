const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
    const { data: flows } = await supabase.from('trigger_flows').select('id').eq('name', 'Americanhairline').limit(1);
    if (!flows || flows.length === 0) return console.log("Flow not found");

    const { data: nodes } = await supabase.from('trigger_nodes').select('id, node_type, config').eq('flow_id', flows[0].id).in('node_type', ['ask_list', 'ask_button', 'message_buttons']);

    console.log(JSON.stringify(nodes, null, 2));
}
check();
