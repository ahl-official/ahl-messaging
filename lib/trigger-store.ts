// Persistence helpers for trigger flows — kept out of the route files so
// Next's route-export validator only sees HTTP handlers.

import type { createServiceRoleClient } from "@/lib/supabase/server";

type Admin = ReturnType<typeof createServiceRoleClient>;

export interface StepInput {
  node_type: string;
  config?: Record<string, unknown>;
}
export interface GraphNode {
  id: string;
  node_type: string;
  config?: Record<string, unknown>;
  position?: { x: number; y: number };
}
export interface GraphEdge {
  from_node_id: string;
  to_node_id: string;
  branch_label?: string | null;
}
export interface GraphInput {
  start_node_id: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Insert linear steps and chain them via next_node_id; set the flow's
 *  start_node_id to the first one. (Legacy linear builder.) */
export async function insertSteps(admin: Admin, flowId: string, steps: StepInput[]): Promise<void> {
  if (steps.length === 0) {
    await admin.from("trigger_flows").update({ start_node_id: null }).eq("id", flowId);
    return;
  }
  const rows = steps.map((s, i) => ({
    flow_id: flowId,
    node_type: s.node_type,
    config: s.config ?? {},
    sort_order: i,
  }));
  const { data: inserted } = await admin.from("trigger_nodes").insert(rows).select("id, sort_order");
  const ordered = (inserted ?? []).sort((a, b) => (a.sort_order as number) - (b.sort_order as number));
  for (let i = 0; i < ordered.length - 1; i++) {
    await admin.from("trigger_nodes").update({ next_node_id: ordered[i + 1].id }).eq("id", ordered[i].id);
  }
  await admin.from("trigger_flows").update({ start_node_id: ordered[0]?.id ?? null }).eq("id", flowId);
}

/** Replace a flow's whole node/edge graph (visual canvas). Client sends node
 *  ids (uuids it generated) so edges can reference them; we delete the old
 *  graph and re-insert with those ids. */
export async function saveGraph(admin: Admin, flowId: string, graph: GraphInput): Promise<void> {
  await admin.from("trigger_nodes").delete().eq("flow_id", flowId); // cascades edges
  if (graph.nodes.length === 0) {
    await admin.from("trigger_flows").update({ start_node_id: null }).eq("id", flowId);
    return;
  }
  const nodeRows = graph.nodes.map((n, i) => ({
    id: n.id,
    flow_id: flowId,
    node_type: n.node_type,
    config: n.config ?? {},
    position: n.position ?? { x: 0, y: 0 },
    sort_order: i,
  }));
  await admin.from("trigger_nodes").insert(nodeRows);
  if (graph.edges.length > 0) {
    await admin.from("trigger_edges").insert(
      graph.edges.map((e) => ({
        flow_id: flowId,
        from_node_id: e.from_node_id,
        to_node_id: e.to_node_id,
        branch_label: e.branch_label ?? null,
      })),
    );
  }
  // Mirror non-branch edges into next_node_id so linear reads still work.
  for (const n of graph.nodes) {
    const out = graph.edges.find((e) => e.from_node_id === n.id && !e.branch_label);
    if (out) await admin.from("trigger_nodes").update({ next_node_id: out.to_node_id }).eq("id", n.id);
  }
  await admin.from("trigger_flows").update({ start_node_id: graph.start_node_id }).eq("id", flowId);
}
