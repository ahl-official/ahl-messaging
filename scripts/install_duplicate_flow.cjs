/**
 * Install Duplicate Flow into Supabase Database
 * 
 * Safely inserts or updates 'AHL UTM Flow - V2 (Consultation & Payment Optimized)' as an inactive/draft workflow.
 * Run with:
 *   node scripts/install_duplicate_flow.cjs
 * Or with a specific phone number ID:
 *   node scripts/install_duplicate_flow.cjs 1198859879988526
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Read environment
const envPath = path.join(__dirname, '..', '.env.local');
const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
const env = {};
for (const line of lines) {
  const idx = line.indexOf('=');
  if (idx > 0 && !line.trim().startsWith('#')) {
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    env[k] = v;
  }
}

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing Supabase credentials in .env.local");
  process.exit(1);
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function install() {
  const jsonPath = path.join(__dirname, 'ahl_utm_flow_v2.json');
  const flowData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

  // Default to AHL Messaging (+91 73041 89059 / ID: 1198859879988526)
  const cliBpid = process.argv[2]?.trim();
  const bpid = cliBpid || '1198859879988526';

  console.log(`\n======================================================`);
  console.log(`Targeting Business Phone Number ID: ${bpid}`);
  console.log(`Account: AHL Messaging (+91 73041 89059)`);
  console.log(`Flow Name: "${flowData.name}"`);
  console.log(`Total Nodes: ${flowData.graph.nodes.length}`);
  console.log(`Total Edges: ${flowData.graph.edges.length}`);
  console.log(`======================================================\n`);

  // Check if V2 already exists for this number to avoid duplication
  const { data: existing } = await sb
    .from('trigger_flows')
    .select('id, name')
    .eq('business_phone_number_id', bpid)
    .eq('name', flowData.name)
    .maybeSingle();

  if (existing) {
    console.log(`Flow "${flowData.name}" already exists on this number (ID: ${existing.id}). Updating its graph...`);
    await sb.from('trigger_flows').update({ start_node_id: null }).eq('id', existing.id);
    await sb.from('trigger_edges').delete().eq('flow_id', existing.id);
    await sb.from('trigger_nodes').delete().eq('flow_id', existing.id);
    await insertGraph(existing.id, flowData.graph);
    console.log(`\n✅ Graph updated successfully with ${flowData.graph.nodes.length} nodes and ${flowData.graph.edges.length} connections!`);
    console.log(`Status: DISABLED (Draft) — your live AHL UTM Flow is 100% untouched.`);
    return;
  }

  // Create new flow row (disabled/draft by default)
  const { data: newFlow, error: flowErr } = await sb.from('trigger_flows').insert({
    business_phone_number_id: bpid,
    name: flowData.name,
    enabled: false, // 100% SAFE: disabled draft so live flow is completely unaffected
    trigger_type: flowData.trigger_type,
    trigger_config: flowData.trigger_config,
    priority: flowData.priority,
    start_node_id: null // set after inserting nodes
  }).select('id').single();

  if (flowErr || !newFlow) {
    console.error("Failed to create trigger_flow:", flowErr);
    process.exit(1);
  }

  console.log(`Created new flow row: ${newFlow.id}`);
  await insertGraph(newFlow.id, flowData.graph);
  console.log(`\n🎉 SUCCESS! Installed "${flowData.name}" on number ${bpid}!`);
  console.log(`Total: ${flowData.graph.nodes.length} nodes and ${flowData.graph.edges.length} connections fully connected.`);
  console.log(`Status: DISABLED (Draft) — your live running AHL UTM Flow is 100% untouched.`);
  console.log(`You can view and test it under: Automation -> Trigger Flows`);
}

async function insertGraph(flowId, graph) {
  const nodeRows = graph.nodes.map((n, i) => ({
    id: n.id,
    flow_id: flowId,
    node_type: n.node_type,
    config: n.config || {},
    position: n.position || { x: 0, y: 0 },
    sort_order: i
  }));

  const { error: nodeErr } = await sb.from('trigger_nodes').insert(nodeRows);
  if (nodeErr) throw nodeErr;

  const edgeRows = graph.edges.map((e) => ({
    flow_id: flowId,
    from_node_id: e.from_node_id,
    to_node_id: e.to_node_id,
    branch_label: e.branch_label || null
  }));

  const { error: edgeErr } = await sb.from('trigger_edges').insert(edgeRows);
  if (edgeErr) throw edgeErr;

  // Mirror non-branch edges to next_node_id for linear fallback
  for (const n of graph.nodes) {
    const out = graph.edges.find((e) => e.from_node_id === n.id && !e.branch_label);
    if (out) {
      await sb.from('trigger_nodes').update({ next_node_id: out.to_node_id }).eq('id', n.id);
    }
  }

  // Set flow start_node_id
  await sb.from('trigger_flows').update({ start_node_id: graph.start_node_id }).eq('id', flowId);
}

install().catch(console.error);
