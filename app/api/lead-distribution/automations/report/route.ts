// GET /api/lead-distribution/automations/report?id=<automationId>
//   → run report for one Lead Automation, split into three sections:
//       sent   — templates already delivered (number · lead# · name · template · time)
//       failed — sends that errored
//       queue  — waiting continuations (which template is queued next, when)
//     Plus `steps` (total send-template nodes in the flow) for progress.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";

export const runtime = "nodejs";

interface FlowNode {
  id: string;
  data: { node_type?: string; template?: string };
}

export async function GET(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const admin = createServiceRoleClient();

  // Flow config — to resolve node ids → template names + count send steps.
  const { data: auto } = await admin
    .from("lead_distribution_automations")
    .select("config")
    .eq("id", id)
    .maybeSingle();
  const nodes = ((auto?.config as { flow?: { nodes?: FlowNode[] } } | null)?.flow?.nodes ?? []) as FlowNode[];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const sendNodes = nodes.filter((n) => n.data.node_type === "send_template");
  const templateOf = (nodeId: string) => nodeById.get(nodeId)?.data.template ?? nodeId;

  // Sent + failed.
  const { data: runs } = await admin
    .from("lead_automation_runs")
    .select("mobile, prospect_id, lead_number, name, template, node_id, status, sent_at")
    .eq("automation_id", id)
    .order("sent_at", { ascending: false })
    .limit(5000);
  const mapRun = (r: Record<string, unknown>) => ({
    mobile: (r.mobile as string | null) ?? (r.prospect_id as string | null) ?? "",
    lead_number: (r.lead_number as string | null) ?? "",
    name: (r.name as string | null) ?? "",
    template: (r.template as string | null) ?? templateOf(r.node_id as string),
    at: r.sent_at as string,
  });
  const all = (runs ?? []) as Record<string, unknown>[];
  const sent = all.filter((r) => (r.status ?? "sent") === "sent").map(mapRun);
  const failed = all.filter((r) => r.status === "failed").map(mapRun);

  // Pending rows are TWO kinds:
  //   • scheduled — a send waiting for its IST send-time (the lead carries
  //     __timedNode === resume_node_id; it resumes AT that send node).
  //   • queue     — a Wait-node continuation (resumes at the node after a wait).
  const { data: pending } = await admin
    .from("lead_automation_pending")
    .select("resume_node_id, lead, run_at")
    .eq("automation_id", id)
    .order("run_at", { ascending: true })
    .limit(5000);
  const queue: Array<{ mobile: string; lead_number: string; name: string; template: string; at: string }> = [];
  const scheduled: typeof queue = [];
  for (const p of pending ?? []) {
    const lead = (p.lead ?? {}) as { mobile?: string; lead_number?: string; first_name?: string; __timedNode?: string };
    const row = {
      mobile: lead.mobile ?? "",
      lead_number: lead.lead_number ?? "",
      name: lead.first_name ?? "",
      template: templateOf(p.resume_node_id as string),
      at: p.run_at as string,
    };
    if (lead.__timedNode && lead.__timedNode === p.resume_node_id) scheduled.push(row);
    else queue.push(row);
  }

  // Per-number progress: a number is "complete" once it has sends and nothing
  // queued; otherwise it's in progress.
  const queuedNumbers = new Set([...queue, ...scheduled].map((q) => q.mobile).filter(Boolean));
  const sentByNumber = new Map<string, number>();
  for (const s of sent) if (s.mobile) sentByNumber.set(s.mobile, (sentByNumber.get(s.mobile) ?? 0) + 1);
  const completed = [...sentByNumber.keys()].filter((n) => !queuedNumbers.has(n)).length;

  return NextResponse.json({
    steps: sendNodes.length, // total templates in the flow
    sent,
    failed,
    queue,
    scheduled, // sends waiting for their IST send-time (e.g. morning 08:40)
    recipients: sentByNumber.size,
    completed, // numbers that finished the whole flow
    in_progress: queuedNumbers.size,
  });
}
