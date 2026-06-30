"use client";

// Visual automation builder for Lead Distribution — mirrors LSQ's flowchart
// editor. A trigger at the top, condition nodes (If/Else, Multi If/Else) that
// split into Yes/No (or labelled) branches, and action nodes (Distribute
// Lead, Create Task, Wait, Notify). The graph (nodes + edges) is stored on
// the automation's `config.flow`. Pure visual model — the live distribution
// still runs through the webhook engine; this documents/designs the logic.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  addEdge,
  getSmoothStepPath,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "reactflow";
import "reactflow/dist/style.css";
import { Plus, Trash2, Copy, Save, X, GitBranch, Split, ClipboardList, Clock, Bell, Workflow, MessageSquare } from "lucide-react";
import { LSQ_DEFAULT_SOURCES } from "@/lib/lsq-defaults";
import { SearchableMultiSelect } from "@/components/SearchableMultiSelect";
import { GroupedSelect } from "@/components/automation/GroupedSelect";

export type LeadNodeType =
  | "trigger"
  | "if_else"
  | "multi_if_else"
  | "distribute_lead"
  | "create_task"
  | "wait"
  | "notify"
  | "send_template";

interface Criterion {
  field: string;
  operator: string;
  value: string;
}
interface NodeCriteria {
  match: "any" | "all"; // Any Criteria (OR) | All Criteria (AND)
  conditions: Criterion[];
}
interface LeadNodeData {
  node_type: LeadNodeType;
  title: string;
  subtitle: string;
  nodeId: string; // LSQ-style id e.g. IfElse90
  branches?: string[]; // condition outputs
  criteria?: NodeCriteria; // the check this condition node evaluates
  agents?: string[]; // distribute_lead: agent emails this branch assigns to
  bpid?: string; // send_template: business number to send from
  template?: string; // send_template: approved template name
  templateLang?: string; // send_template: template language code
  sendTime?: string; // send_template: HH:MM in IST to send at (empty = immediately)
  waitAmount?: number; // wait: amount
  waitUnit?: string; // wait: Seconds | Minutes | Hours | Days
}

const WAIT_UNITS = ["Seconds", "Minutes", "Hours", "Days"];

// LSQ lead fields for the condition builder. Shown in a real dropdown so the
// full list is always visible (like LSQ's Select Criteria).
const CONDITION_FIELDS = [
  // Most used
  "Brand", "Lead Source", "Sub Source", "Lead Stage",
  // Standard LSQ lead fields
  "Lead Activity", "Lead Number", "Lead Origin", "Lead Quality", "Lead Score",
  "Lead Status", "Owner", "Sales Group", "Task", "Created On", "Modified On",
  // Contact
  "First Name", "Last Name", "Email", "Mobile Number", "Phone Number",
  "Company", "City", "State", "Country", "Pincode", "Address",
  // Clinic / custom
  "Patient Age", "Treatment Goal", "Appointment Date", "Appointment Time",
  "Actual Grafts", "Adhaar No", "Agent Code", "Prospect Id",
  "Any ongoing hair loss medication", "AIDS or HIV", "Follow Up Reminder",
];
const CONDITION_OPERATORS = [
  "Is", "Is Not", "Contains", "Does Not Contain", "Starts With", "Ends With",
  "Greater Than", "Less Than", "Is Empty", "Is Not Empty",
];
// Pick-list values per field. When a field has these, the condition value
// becomes a real dropdown (select) instead of a free-text box.
const BRAND_VALUES = ["American Hairline", "Alchemane"];
const SUB_SOURCE_VALUES = ["FB Form", "Website", "WhatsApp", "Instagram", "Google", "YouTube", "Referral"];
function valueOptionsFor(field: string, stages: string[]): string[] | null {
  if (field === "Brand") return BRAND_VALUES;
  if (field === "Lead Source") return LSQ_DEFAULT_SOURCES;
  if (field === "Sub Source") return SUB_SOURCE_VALUES;
  if (field === "Lead Stage") return stages;
  return null;
}

function summariseCriteria(c?: NodeCriteria): string {
  if (!c || !c.conditions.length) return "";
  const join = c.match === "all" ? " and " : " or ";
  return c.conditions
    .map((x) => `${x.field} ${x.operator.toLowerCase()}${x.value ? ` "${x.value}"` : ""}`)
    .join(join);
}

interface AutomationLite {
  id: string;
  name: string;
  trigger_type: string;
  config: Record<string, unknown> | null;
}

const TRIGGER_PREFIX = "Event";

// Palette — the nodes the operator can drop onto the canvas.
const PALETTE: { type: LeadNodeType; label: string; prefix: string; icon: typeof GitBranch; branches?: string[] }[] = [
  { type: "if_else", label: "If / Else", prefix: "IfElse", icon: GitBranch, branches: ["yes", "no"] },
  { type: "multi_if_else", label: "Multi If / Else", prefix: "MultiIfElse", icon: Split, branches: ["if", "elseif", "else"] },
  { type: "distribute_lead", label: "Distribute Lead", prefix: "DistributeLead", icon: Workflow },
  { type: "create_task", label: "Create Task", prefix: "CreateTask", icon: ClipboardList },
  { type: "wait", label: "Wait", prefix: "Wait", icon: Clock },
  { type: "send_template", label: "Send Message", prefix: "SendMessage", icon: MessageSquare },
  { type: "notify", label: "Notify", prefix: "Notify", icon: Bell },
];

const PREFIX: Record<LeadNodeType, string> = {
  trigger: TRIGGER_PREFIX,
  if_else: "IfElse",
  multi_if_else: "MultiIfElse",
  distribute_lead: "DistributeLead",
  create_task: "CreateTask",
  wait: "Wait",
  notify: "Notify",
  send_template: "SendMessage",
};

function branchColor(b: string): string {
  const k = b.toLowerCase();
  if (k === "yes" || k === "if" || k === "true") return "#10b981"; // emerald
  if (k === "no" || k === "else" || k === "false") return "#f43f5e"; // rose
  if (k === "elseif") return "#f59e0b"; // amber
  return "#64748b"; // slate
}
function branchLabel(b: string): string {
  const k = b.toLowerCase();
  if (k === "yes") return "Yes";
  if (k === "no") return "No";
  if (k === "if") return "If";
  if (k === "elseif") return "Else If";
  if (k === "else") return "Else";
  return b;
}
function barColor(t: LeadNodeType): string {
  if (t === "trigger") return "#10b981";
  if (t === "wait") return "#f59e0b";
  if (t === "send_template") return "#8b5cf6"; // violet — message
  return "#38bdf8"; // sky — actions
}
function defaults(t: LeadNodeType): { title: string; subtitle: string } {
  switch (t) {
    case "trigger": return { title: "Lead Update", subtitle: "When Lead field(s) changes" };
    case "if_else": return { title: "If/Else", subtitle: "Set your condition…" };
    case "multi_if_else": return { title: "Multi If/Else", subtitle: "Evaluating on latest data" };
    case "distribute_lead": return { title: "Distribute Lead", subtitle: "Distribute Leads" };
    case "create_task": return { title: "Create Task", subtitle: "Follow up call" };
    case "wait": return { title: "Wait", subtitle: "Wait for 2 Minute(s)" };
    case "send_template": return { title: "Send Message", subtitle: "Select number + template" };
    case "notify": return { title: "Notify", subtitle: "About @{Lead:FirstName}" };
  }
}

// ---- Node card (LSQ style) -------------------------------------------------
function LeadNode({ data }: NodeProps<LeadNodeData>) {
  const isTrigger = data.node_type === "trigger";
  const isCond = data.node_type === "if_else" || data.node_type === "multi_if_else";
  const branches = isCond ? (data.branches?.length ? data.branches : ["yes", "no"]) : [];
  return (
    <div className="w-56">
      {!isTrigger ? <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-slate-400" /> : null}
      <div className="rounded-md border border-slate-200 bg-white shadow-sm">
        <div className="px-3 py-2">
          <div className="text-[13px] font-bold leading-tight text-slate-800">{data.title}</div>
          {data.subtitle ? (
            <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-slate-500">{data.subtitle}</div>
          ) : null}
        </div>
        {isCond ? (
          <div className="flex h-1.5 w-full overflow-hidden rounded-b-md">
            {branches.map((b) => (
              <div key={b} className="flex-1" style={{ background: branchColor(b) }} />
            ))}
          </div>
        ) : (
          <div className="h-1.5 w-full rounded-b-md" style={{ background: barColor(data.node_type) }} />
        )}
      </div>
      <div className="mt-0.5 text-center text-[9px] text-slate-400">{data.nodeId}</div>
      {isCond ? (
        branches.map((b, i) => (
          <Handle
            key={b}
            id={b}
            type="source"
            position={Position.Bottom}
            style={{ left: `${((i + 0.5) / branches.length) * 100}%`, background: branchColor(b), bottom: 14 }}
            className="!h-2.5 !w-2.5 !border-2 !border-white"
          />
        ))
      ) : (
        <Handle type="source" position={Position.Bottom} style={{ bottom: 14 }} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-slate-400" />
      )}
    </div>
  );
}

const nodeTypes = { lead: LeadNode };

// Edge with a × (delete) and ⊕ (insert a node here) control at its midpoint —
// lets the operator drop a node BETWEEN two connected nodes (splits the edge).
interface EdgeOps {
  onDelete: (edgeId: string) => void;
  onInsert: (edgeId: string, nodeType: LeadNodeType) => void;
  onPaste: (edgeId: string) => void;
  canPaste: boolean;
}
const EdgeOpsContext = createContext<EdgeOps | null>(null);
const INSERTABLE = PALETTE; // condition + action nodes

function InsertEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style } = props;
  const [edgePath, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const ops = useContext(EdgeOpsContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as globalThis.Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);
  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`, pointerEvents: "all" }}
          className="nodrag nopan absolute flex items-center gap-1"
        >
          <button
            type="button"
            title="Delete connection"
            onClick={() => ops?.onDelete(id)}
            className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-rose-300 bg-white text-rose-600 shadow-sm hover:bg-rose-50"
          >
            <X className="h-3 w-3" />
          </button>
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              title="Insert a node here"
              onClick={() => setMenuOpen((v) => !v)}
              className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-emerald-300 bg-white text-emerald-700 shadow-sm hover:bg-emerald-50"
            >
              <Plus className="h-3 w-3" />
            </button>
            {menuOpen ? (
              <div className="absolute left-1/2 top-6 z-50 max-h-64 w-44 -translate-x-1/2 overflow-y-auto rounded-lg border bg-white py-1 shadow-xl">
                {ops?.canPaste ? (
                  <button
                    type="button"
                    onClick={() => { ops?.onPaste(id); setMenuOpen(false); }}
                    className="mb-1 flex w-full items-center gap-2 border-b px-3 py-1.5 text-left text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Paste copied node
                  </button>
                ) : null}
                {INSERTABLE.map((a) => {
                  const Icon = a.icon;
                  return (
                    <button
                      key={a.type}
                      type="button"
                      onClick={() => { ops?.onInsert(id, a.type); setMenuOpen(false); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-secondary"
                    >
                      <Icon className="h-3.5 w-3.5 text-emerald-700" />
                      {a.label}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
const edgeTypes = { insert: InsertEdge };

const TRIGGER_ID = "trigger";

function nextNumber(nodes: Node<LeadNodeData>[]): number {
  let max = 18; // LSQ-ish starting offset
  for (const n of nodes) {
    const m = /(\d+)$/.exec((n.data as LeadNodeData).nodeId || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

export function LeadAutomationFlow({
  automation,
  lsqStages,
  onClose,
  onSaved,
}: {
  automation: AutomationLite;
  lsqStages: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<LeadNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Copied node's config (clipboard) — paste it at the bottom or onto an edge.
  const [copiedData, setCopiedData] = useState<LeadNodeData | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rfRef = useRef<ReactFlowInstance | null>(null);
  // Configured distribution agents — for the Distribute Lead node's picker.
  const [agentPool, setAgentPool] = useState<{ lsq_id: string; agent_name: string; agent_email: string }[]>([]);
  useEffect(() => {
    fetch("/api/lead-distribution/agents", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { agents?: { lsq_id: string; agent_name: string; agent_email: string }[] }) => setAgentPool(j.agents ?? []))
      .catch(() => setAgentPool([]));
  }, []);
  // WhatsApp numbers + their templates — for the Send Message node. Evolution
  // (Baileys) numbers can't send approved templates, so they're excluded;
  // numbers are grouped by portfolio.
  const [numbers, setNumbers] = useState<{ phone_number_id: string; label: string; portfolio: string }[]>([]);
  useEffect(() => {
    fetch("/api/business-numbers", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { numbers?: { phone_number_id: string; display_phone_number?: string | null; verified_name?: string | null; nickname?: string | null; provider?: string | null; portfolio?: { name?: string } | null }[] }) =>
        setNumbers(
          (j.numbers ?? [])
            .filter((n) => (n.provider ?? "meta") !== "evolution")
            .map((n) => ({
              phone_number_id: n.phone_number_id,
              label: n.nickname || n.verified_name || n.display_phone_number || n.phone_number_id,
              portfolio: n.portfolio?.name || "Other",
            })),
        ))
      .catch(() => setNumbers([]));
  }, []);
  const numbersByPortfolio = useMemo(() => {
    const m = new Map<string, { phone_number_id: string; label: string }[]>();
    for (const n of numbers) {
      if (!m.has(n.portfolio)) m.set(n.portfolio, []);
      m.get(n.portfolio)!.push({ phone_number_id: n.phone_number_id, label: n.label });
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [numbers]);
  const [templatesByBpid, setTemplatesByBpid] = useState<Record<string, { name: string; language: string; body: string }[]>>({});
  const loadTemplates = useCallback(
    (bpid: string) => {
      if (!bpid) return;
      setTemplatesByBpid((m) => (m[bpid] ? m : { ...m, [bpid]: [] }));
      fetch(`/api/templates?phone_number_id=${encodeURIComponent(bpid)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j: { templates?: Array<{ name: string; language: string; status?: string; body?: string; components?: Array<{ type?: string; text?: string }> }> }) =>
          setTemplatesByBpid((m) => ({
            ...m,
            [bpid]: (j.templates ?? [])
              .filter((t) => t.name && (!t.status || t.status.toUpperCase() === "APPROVED"))
              .map((t) => ({
                name: t.name,
                language: t.language,
                body: t.body ?? t.components?.find((c) => (c.type ?? "").toUpperCase() === "BODY")?.text ?? "",
              })),
          })))
        .catch(() => setTemplatesByBpid((m) => ({ ...m, [bpid]: [] })));
    },
    [],
  );
  // "Select Condition" modal (for condition nodes)
  const [condOpen, setCondOpen] = useState(false);
  const [draftMatch, setDraftMatch] = useState<"any" | "all">("any");
  const [draftConds, setDraftConds] = useState<Criterion[]>([]);
  const [rowField, setRowField] = useState(CONDITION_FIELDS[0]);
  const [rowOp, setRowOp] = useState(CONDITION_OPERATORS[0]);
  const [rowValue, setRowValue] = useState(""); // free-text fields
  const [rowValues, setRowValues] = useState<string[]>([]); // multi-select fields
  // Editable trigger config (mirrors the Build-trigger modal; type stays fixed)
  const [tLeadField, setTLeadField] = useState("Lead Stage");
  const [tFrom, setTFrom] = useState("Any Stage");
  const [tTo, setTTo] = useState("");
  const [tRunOnce, setTRunOnce] = useState(false);
  const [tScope, setTScope] = useState("Global");
  const [tExitStage, setTExitStage] = useState("");
  const [tExitCond, setTExitCond] = useState("");

  // Seed editable trigger fields from the automation's saved config.
  useEffect(() => {
    const cfg = (automation.config ?? {}) as Record<string, unknown>;
    setTLeadField((cfg.lead_field as string) || "Lead Stage");
    setTFrom((cfg.change_from as string) || "Any Stage");
    setTTo((cfg.change_to as string) || "");
    setTRunOnce(cfg.run_once === true);
    setTScope((cfg.scope as string) || "Global");
    setTExitStage((cfg.exit_stage as string) || "");
    setTExitCond((cfg.exit_condition as string) || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automation.id]);

  const triggerSubtitle = useCallback(
    (criteria?: NodeCriteria): string => {
      const parts: string[] = [];
      if (tTo) parts.push(`${tLeadField}: ${tFrom || "Any Stage"} → ${tTo}`);
      const cs = summariseCriteria(criteria);
      if (cs) parts.push(cs);
      return parts.join("  ·  ") || "When Lead field(s) changes";
    },
    [tLeadField, tFrom, tTo],
  );

  // Keep the trigger card's subtitle in sync with the editable fields.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => (n.id === TRIGGER_ID ? { ...n, data: { ...n.data, subtitle: triggerSubtitle(n.data.criteria) } } : n)),
    );
  }, [triggerSubtitle, setNodes]);

  // Seed from saved flow, else a lone trigger node.
  useEffect(() => {
    const flow = (automation.config?.flow ?? null) as { nodes?: Node<LeadNodeData>[]; edges?: Edge[] } | null;
    if (flow?.nodes?.length) {
      setNodes(flow.nodes);
      setEdges((flow.edges ?? []).map((e) => ({ ...e, type: "insert" })));
    } else {
      // No saved flow yet — seed the trigger node FROM the Build-trigger
      // config (lead_field, change_from/to, conditions) so the flow editor
      // mirrors what the operator set, like LSQ's Trigger detail.
      const d = defaults("trigger");
      const cfg = (automation.config ?? {}) as Record<string, unknown>;
      const leadField = (cfg.lead_field as string) || "Lead Stage";
      const changeFrom = (cfg.change_from as string) || "";
      const changeTo = (cfg.change_to as string) || "";
      const rawConds = Array.isArray(cfg.conditions)
        ? (cfg.conditions as Array<{ connector?: string; field?: string; operator?: string; value?: string }>)
        : [];
      const mapped = rawConds
        .map((c) => ({ field: c.field || "", operator: c.operator || "is", value: c.value || "" }))
        .filter((c) => c.field);
      const criteria: NodeCriteria | undefined = mapped.length
        ? { match: rawConds.some((c) => (c.connector || "").toLowerCase() === "or") ? "any" : "all", conditions: mapped }
        : undefined;
      const parts: string[] = [];
      if (changeTo) parts.push(`${leadField}: ${changeFrom || "Any Stage"} → ${changeTo}`);
      const cs = summariseCriteria(criteria);
      if (cs) parts.push(cs);
      setNodes([
        {
          id: TRIGGER_ID,
          type: "lead",
          position: { x: 360, y: 40 },
          data: {
            node_type: "trigger",
            title: automation.trigger_type || d.title,
            subtitle: parts.join("  ·  ") || d.subtitle,
            nodeId: `${TRIGGER_PREFIX}19`,
            criteria,
          },
        },
      ]);
      setEdges([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automation.id]);

  const onConnect = useCallback(
    (c: Connection) => {
      const branch = c.sourceHandle ?? null;
      const color = branch ? branchColor(branch) : "#64748b";
      setEdges((eds) =>
        addEdge(
          {
            ...c,
            type: "insert",
            label: branch ? branchLabel(branch) : undefined,
            labelBgStyle: { fill: "#fff" },
            labelStyle: { fontSize: 10, fontWeight: 700, fill: color },
            style: { stroke: color, strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color },
          },
          eds,
        ),
      );
    },
    [setEdges],
  );

  function addNode(type: LeadNodeType) {
    const d = defaults(type);
    const num = nextNumber(nodes);
    const palette = PALETTE.find((p) => p.type === type);
    const id = `${type}-${num}`;
    setNodes((prev) => {
      // Drop the new node directly BELOW the current lowest node (aligned to
      // its column) so it lands where the operator is building, not floating
      // up at the top.
      const lowest = prev.reduce<Node<LeadNodeData> | null>((lo, n) => (!lo || n.position.y > lo.position.y ? n : lo), null);
      const position = lowest ? { x: lowest.position.x, y: lowest.position.y + 140 } : { x: 360, y: 160 };
      return [
        ...prev,
        {
          id,
          type: "lead",
          position,
          data: { node_type: type, title: d.title, subtitle: d.subtitle, nodeId: `${PREFIX[type]}${num}`, branches: palette?.branches },
        },
      ];
    });
    setSelectedId(id);
  }

  // Copy the selected node's full config to the clipboard.
  function copyNode() {
    if (!selected || selected.id === TRIGGER_ID) return;
    setCopiedData(selected.data);
  }

  // Paste the copied node as a new (unconnected) node at the bottom of the flow.
  function pasteNode() {
    if (!copiedData) return;
    const type = copiedData.node_type as LeadNodeType;
    const num = nextNumber(nodes);
    const id = `${type}-${num}`;
    setNodes((prev) => {
      const lowest = prev.reduce<Node<LeadNodeData> | null>((lo, n) => (!lo || n.position.y > lo.position.y ? n : lo), null);
      const position = lowest ? { x: lowest.position.x, y: lowest.position.y + 140 } : { x: 360, y: 160 };
      return [...prev, { id, type: "lead", position, data: { ...copiedData, nodeId: `${PREFIX[type]}${num}` } }];
    });
    setSelectedId(id);
  }

  function deleteEdge(edgeId: string) {
    setEdges((eds) => eds.filter((e) => e.id !== edgeId));
  }

  // Insert a node in the MIDDLE of an edge: src → [new] → tgt. The first
  // segment keeps the original branch (handle/label/colour); the second is a
  // plain connector.
  const insertOnEdge = useCallback(
    (edgeId: string, type: LeadNodeType, copyFrom?: LeadNodeData) => {
      const inst = rfRef.current;
      if (!inst) return;
      const edge = inst.getEdges().find((e) => e.id === edgeId);
      if (!edge) return;
      const nodesNow = inst.getNodes() as Node<LeadNodeData>[];
      const src = nodesNow.find((n) => n.id === edge.source);
      const tgt = nodesNow.find((n) => n.id === edge.target);
      const num = nextNumber(nodesNow);
      const d = defaults(type);
      const palette = PALETTE.find((p) => p.type === type);
      const id = `${type}-${num}`;
      const midX = src && tgt ? (src.position.x + tgt.position.x) / 2 : 300;
      const midY = src && tgt ? (src.position.y + tgt.position.y) / 2 : 240;
      // Paste = the copied node's config; plain insert = a fresh node from defaults.
      const data: LeadNodeData = copyFrom
        ? { ...copyFrom, nodeId: `${PREFIX[type]}${num}` }
        : { node_type: type, title: d.title, subtitle: d.subtitle, nodeId: `${PREFIX[type]}${num}`, branches: palette?.branches };
      setNodes((prev) => [
        ...prev,
        {
          id,
          type: "lead",
          position: { x: midX, y: midY },
          data,
        },
      ]);
      setEdges((prev) => {
        const rest = prev.filter((e) => e.id !== edgeId);
        const e1: Edge = {
          id: `e-${edge.source}-${id}`,
          source: edge.source,
          sourceHandle: edge.sourceHandle,
          target: id,
          type: "insert",
          label: edge.label,
          labelStyle: edge.labelStyle,
          labelBgStyle: edge.labelBgStyle,
          style: edge.style,
          markerEnd: edge.markerEnd,
        };
        const e2: Edge = {
          id: `e-${id}-${edge.target}`,
          source: id,
          target: edge.target,
          type: "insert",
          style: { stroke: "#64748b", strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#64748b" },
        };
        return [...rest, e1, e2];
      });
      setSelectedId(id);
    },
    [setNodes, setEdges],
  );
  const edgeOps = useMemo<EdgeOps>(
    () => ({
      onDelete: deleteEdge,
      onInsert: insertOnEdge,
      onPaste: (edgeId: string) => copiedData && insertOnEdge(edgeId, copiedData.node_type as LeadNodeType, copiedData),
      canPaste: !!copiedData,
    }),
    [insertOnEdge, copiedData],
  );

  const selected = useMemo(() => nodes.find((n) => n.id === selectedId) ?? null, [nodes, selectedId]);
  // Load a Send Message node's templates when it's opened from a saved flow.
  useEffect(() => {
    if (selected?.data.node_type === "send_template" && selected.data.bpid) loadTemplates(selected.data.bpid);
  }, [selectedId, selected?.data.node_type, selected?.data.bpid, loadTemplates]);

  function patchSelected(patch: Partial<LeadNodeData>) {
    if (!selectedId) return;
    setNodes((prev) => prev.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n)));
  }
  function removeSelected() {
    if (!selectedId || selectedId === TRIGGER_ID) return;
    setNodes((prev) => prev.filter((n) => n.id !== selectedId));
    setEdges((prev) => prev.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  }

  function openCondModal() {
    const cur = selected?.data.criteria;
    setDraftMatch(cur?.match ?? "any");
    setDraftConds(cur?.conditions ?? []);
    setRowField(CONDITION_FIELDS[0]);
    setRowOp(CONDITION_OPERATORS[0]);
    setRowValue("");
    setRowValues([]);
    setCondOpen(true);
  }
  function addDraftCondition() {
    if (!rowField) return;
    const opts = valueOptionsFor(rowField, lsqStages);
    const noValueOp = rowOp === "Is Empty" || rowOp === "Is Not Empty";
    const val = opts ? rowValues.join(", ") : rowValue.trim();
    if (!val && !noValueOp) return; // a value is required unless empty-check op
    setDraftConds((c) => [...c, { field: rowField, operator: rowOp, value: val }]);
    setRowValue("");
    setRowValues([]);
  }
  function setCondition() {
    const criteria: NodeCriteria = { match: draftMatch, conditions: draftConds };
    if (selectedId === TRIGGER_ID) {
      patchSelected({ criteria, subtitle: triggerSubtitle(criteria) });
    } else {
      patchSelected({ criteria, subtitle: summariseCriteria(criteria) || "Set your condition…" });
    }
    setCondOpen(false);
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const cleanNodes = nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data }));
      // Persist the editable trigger config back to the top-level fields too,
      // so the Build-trigger view and the flow stay in sync.
      const trigCrit = nodes.find((n) => n.id === TRIGGER_ID)?.data.criteria;
      const conditions = (trigCrit?.conditions ?? []).map((c, i) => ({
        connector: i === 0 ? "and" : trigCrit!.match === "any" ? "or" : "and",
        field: c.field,
        operator: c.operator,
        value: c.value,
      }));
      const config = {
        ...(automation.config ?? {}),
        lead_field: tLeadField,
        change_from: tFrom,
        change_to: tTo,
        run_once: tRunOnce,
        scope: tScope,
        exit_stage: tExitStage || undefined,
        exit_condition: tExitCond || undefined,
        conditions,
        flow: { nodes: cleanNodes, edges },
      };
      const res = await fetch(`/api/lead-distribution/automations?id=${automation.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-100">
      {/* Header */}
      <div className="flex items-center gap-3 border-b bg-white px-4 py-2.5 shadow-sm">
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary" title="Close">
          <X className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{automation.name}</div>
          <div className="text-[11px] text-muted-foreground">Trigger: {automation.trigger_type}</div>
        </div>
        {err ? <span className="text-xs text-destructive">{err}</span> : null}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          <Save className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Save flow"}
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Palette */}
        <aside className="w-44 shrink-0 space-y-1.5 overflow-y-auto border-r bg-white p-2">
          <div className="px-1 pb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Add node</div>
          {PALETTE.map((p) => {
            const PIcon = p.icon;
            return (
              <button
                key={p.type}
                type="button"
                onClick={() => addNode(p.type)}
                className="flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-left text-xs font-semibold hover:border-emerald-300 hover:bg-emerald-50/40"
              >
                <PIcon className="h-3.5 w-3.5 text-slate-500" /> {p.label}
                <Plus className="ml-auto h-3 w-3 text-muted-foreground" />
              </button>
            );
          })}
          {copiedData ? (
            <button
              type="button"
              onClick={pasteNode}
              className="mt-1 flex w-full items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1.5 text-left text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
              title="Paste the copied node at the bottom"
            >
              <Copy className="h-3.5 w-3.5" /> Paste {copiedData.nodeId}
              <Plus className="ml-auto h-3 w-3" />
            </button>
          ) : null}
          <p className="px-1 pt-2 text-[10px] leading-snug text-muted-foreground">
            Node se nikalti line ko agle node ke upar wale dot par chhodo (Yes=green, No=red). Card copy karne ke liye uske panel mein Copy icon dabao.
          </p>
        </aside>

        {/* Canvas */}
        <div className="relative min-w-0 flex-1">
          <EdgeOpsContext.Provider value={edgeOps}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={(inst) => {
              rfRef.current = inst;
              setTimeout(() => inst.fitView({ padding: 0.2 }), 80);
            }}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultEdgeOptions={{ type: "insert" }}
            fitView
            minZoom={0.2}
            maxZoom={1.75}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} color="#e2e8f0" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!bg-white" />
          </ReactFlow>
          </EdgeOpsContext.Provider>

          {/* Node config side panel */}
          {selected ? (
            <div className="absolute right-3 top-3 z-10 max-h-[calc(100vh-110px)] w-96 overflow-y-auto rounded-xl border bg-white p-4 shadow-lg">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-bold">{selected.data.nodeId}</span>
                {selected.id !== TRIGGER_ID ? (
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={copyNode} className={`rounded p-1 ${copiedData === selected.data ? "text-emerald-600" : "text-muted-foreground hover:text-emerald-600"}`} title="Copy node — then paste from an edge (+) or the Add-node panel">
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" onClick={removeSelected} className="rounded p-1 text-muted-foreground hover:text-destructive" title="Delete node">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
              </div>

              {selected.data.node_type === "trigger" ? (
                <div className="space-y-2">
                  <div className="rounded-md border bg-slate-50 px-2 py-1.5 text-[11px]">
                    Trigger: <b>{automation.trigger_type}</b> <span className="text-muted-foreground">(locked)</span>
                  </div>
                  <label className="block text-[11px] font-semibold">
                    Lead Field
                    <select
                      value={tLeadField}
                      onChange={(e) => setTLeadField(e.target.value)}
                      className="mt-1 w-full rounded-md border bg-white px-2 py-1.5 text-xs outline-none focus:border-emerald-400"
                    >
                      {["Lead Stage", "Lead Source", "Owner", "Mobile Number", "Phone Number"].map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-[11px] font-semibold">
                      Changes from
                      <input list="trig-stages" value={tFrom} onChange={(e) => setTFrom(e.target.value)} className="mt-1 w-full rounded-md border px-2 py-1.5 text-xs outline-none focus:border-emerald-400" />
                    </label>
                    <label className="block text-[11px] font-semibold">
                      to — Start stage
                      <input list="trig-stages" value={tTo} onChange={(e) => setTTo(e.target.value)} placeholder="Photos Received" className="mt-1 w-full rounded-md border px-2 py-1.5 text-xs outline-none focus:border-emerald-400" />
                    </label>
                  </div>
                  <datalist id="trig-stages">
                    {["Any Stage", ...lsqStages].map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-[11px] font-semibold">
                      Run once per Lead
                      <select value={tRunOnce ? "Yes" : "No"} onChange={(e) => setTRunOnce(e.target.value === "Yes")} className="mt-1 w-full rounded-md border bg-white px-2 py-1.5 text-xs outline-none focus:border-emerald-400">
                        <option>No</option>
                        <option>Yes</option>
                      </select>
                    </label>
                    <label className="block text-[11px] font-semibold">
                      Scope
                      <select value={tScope} onChange={(e) => setTScope(e.target.value)} className="mt-1 w-full rounded-md border bg-white px-2 py-1.5 text-xs outline-none focus:border-emerald-400">
                        <option>Global</option>
                        <option>Restricted</option>
                      </select>
                    </label>
                  </div>
                  <label className="block text-[11px] font-semibold">
                    Exit stage
                    <select value={tExitStage} onChange={(e) => setTExitStage(e.target.value)} className="mt-1 w-full rounded-md border bg-white px-2 py-1.5 text-xs outline-none focus:border-emerald-400">
                      <option value="">— none —</option>
                      {lsqStages.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-[11px] font-semibold">
                    Exit condition <span className="font-normal text-muted-foreground">(optional)</span>
                    <input value={tExitCond} onChange={(e) => setTExitCond(e.target.value)} placeholder="e.g. Lead Source is Junk" className="mt-1 w-full rounded-md border px-2 py-1.5 text-xs outline-none focus:border-emerald-400" />
                  </label>
                </div>
              ) : (
                <>
                  <label className="block text-[11px] font-semibold">
                    Title
                    <input
                      value={selected.data.title}
                      onChange={(e) => patchSelected({ title: e.target.value })}
                      className="mt-1 w-full rounded-md border px-2 py-1.5 text-xs outline-none focus:border-emerald-400"
                    />
                  </label>
                  {selected.data.node_type !== "wait" && selected.data.node_type !== "send_template" ? (
                    <label className="mt-2 block text-[11px] font-semibold">
                      Configuration / description
                      <textarea
                        value={selected.data.subtitle}
                        onChange={(e) => patchSelected({ subtitle: e.target.value })}
                        rows={3}
                        className="mt-1 w-full resize-none rounded-md border px-2 py-1.5 text-xs outline-none focus:border-emerald-400"
                        placeholder='e.g. Phone Number starts with "+91-"'
                      />
                    </label>
                  ) : null}

                  {/* Wait — amount + unit (n8n style) */}
                  {selected.data.node_type === "wait" ? (
                    (() => {
                      const amount = selected.data.waitAmount ?? 2;
                      const unit = selected.data.waitUnit ?? "Minutes";
                      const setWait = (a: number, u: string) =>
                        patchSelected({ waitAmount: a, waitUnit: u, subtitle: `Wait for ${a} ${a === 1 ? u.replace(/s$/, "") : u}` });
                      return (
                        <div className="mt-2">
                          <div className="text-[11px] font-semibold">Wait for</div>
                          <div className="mt-1 flex gap-2">
                            <input
                              type="number"
                              min={0}
                              value={amount}
                              onChange={(e) => setWait(Math.max(0, Number(e.target.value) || 0), unit)}
                              className="w-20 rounded-md border px-2 py-1.5 text-sm outline-none focus:border-emerald-400"
                            />
                            <select
                              value={unit}
                              onChange={(e) => setWait(amount, e.target.value)}
                              className="flex-1 rounded-md border bg-white px-2 py-1.5 text-sm outline-none focus:border-emerald-400"
                            >
                              {WAIT_UNITS.map((u) => (
                                <option key={u} value={u}>{u}</option>
                              ))}
                            </select>
                          </div>
                          <p className="mt-1 text-[10px] text-muted-foreground">e.g. surgery date ke hisaab se 48 Hours.</p>
                        </div>
                      );
                    })()
                  ) : null}
                </>
              )}
              {(selected.data.node_type === "trigger" ||
                selected.data.node_type === "if_else" ||
                selected.data.node_type === "multi_if_else") ? (
                <>
                  <button
                    type="button"
                    onClick={openCondModal}
                    className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-2 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                  >
                    <GitBranch className="h-3.5 w-3.5" /> Select condition
                  </button>
                  {selected.data.criteria?.conditions?.length ? (
                    <div className="mt-1.5 rounded-md border bg-slate-50 px-2 py-1.5">
                      <div className="text-[10px] font-bold uppercase text-muted-foreground">
                        match {selected.data.criteria.match === "all" ? "ALL" : "ANY"}
                      </div>
                      <ul className="mt-0.5 space-y-0.5 text-[11px]">
                        {selected.data.criteria.conditions.map((c, i) => (
                          <li key={i}>
                            <b>{c.field}</b> {c.operator.toLowerCase()} {c.value ? <b>&quot;{c.value}&quot;</b> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="mt-1 text-[10px] text-muted-foreground">No condition set.</p>
                  )}
                  {selected.data.node_type !== "trigger" ? (
                    <label className="mt-2 block text-[11px] font-semibold">
                      Branches (comma)
                      <input
                        value={(selected.data.branches ?? []).join(", ")}
                        onChange={(e) => patchSelected({ branches: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                        className="mt-1 w-full rounded-md border px-2 py-1.5 text-xs outline-none focus:border-emerald-400"
                        placeholder="yes, no"
                      />
                      <span className="mt-0.5 block text-[10px] text-muted-foreground">yes/if=green, no/else=red, elseif=amber</span>
                    </label>
                  ) : null}
                </>
              ) : null}

              {/* Distribute Lead — pick which agents this branch assigns to */}
              {selected.data.node_type === "distribute_lead" ? (
                <div className="mt-2">
                  <SearchableMultiSelect
                    label="Assign to agents"
                    hint="Inhi agents ko ye branch leads degi (round-robin)"
                    items={agentPool.map((a) => ({ key: a.agent_email || a.lsq_id, label: a.agent_name || a.agent_email || a.lsq_id }))}
                    selected={selected.data.agents ?? []}
                    onChange={(next) =>
                      patchSelected({ agents: next, subtitle: next.length ? `Assign to ${next.length} agent(s)` : "Distribute Leads" })
                    }
                    allowCustom={false}
                    accent="emerald"
                    showCounts={false}
                    emptyHint="Koi agent nahi — Agent priority tab me add karo."
                  />
                </div>
              ) : null}

              {/* Send Message — pick a WhatsApp number, then an approved template */}
              {selected.data.node_type === "send_template" ? (
                <div className="mt-2 space-y-2">
                  <div className="text-[11px] font-semibold">
                    WhatsApp number
                    <div className="mt-1">
                      <GroupedSelect
                        value={selected.data.bpid ?? ""}
                        placeholder="— select number —"
                        groups={numbersByPortfolio.map(([portfolio, list]) => ({
                          label: portfolio,
                          items: list.map((n) => ({ value: n.phone_number_id, label: n.label })),
                        }))}
                        onChange={(bpid) => {
                          loadTemplates(bpid);
                          patchSelected({ bpid, template: undefined, templateLang: undefined, subtitle: "Select template" });
                        }}
                      />
                    </div>
                  </div>
                  <div className="text-[11px] font-semibold">
                    Template
                    <div className="mt-1">
                      <GroupedSelect
                        value={selected.data.template ?? ""}
                        disabled={!selected.data.bpid}
                        placeholder={!selected.data.bpid ? "Pehle number choose karo" : (templatesByBpid[selected.data.bpid] ?? []).length ? "— select template —" : "Loading…"}
                        groups={[{
                          label: "Approved templates",
                          items: (templatesByBpid[selected.data.bpid ?? ""] ?? []).map((t) => ({ value: t.name, label: t.name, sub: t.language })),
                        }]}
                        onChange={(name) => {
                          const t = (templatesByBpid[selected.data.bpid ?? ""] ?? []).find((x) => x.name === name);
                          patchSelected({ template: name || undefined, templateLang: t?.language, subtitle: name ? `Template: ${name}` : "Select template" });
                        }}
                      />
                    </div>
                  </div>
                  {/* Template body preview — what this template actually says. */}
                  {selected.data.template
                    ? (() => {
                        const tpl = (templatesByBpid[selected.data.bpid ?? ""] ?? []).find((x) => x.name === selected.data.template);
                        return tpl?.body ? (
                          <div className="text-[11px] font-semibold">
                            Template preview
                            <div className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border bg-secondary/30 p-2.5 text-[11px] font-normal leading-relaxed text-foreground/80">
                              {tpl.body}
                            </div>
                          </div>
                        ) : null;
                      })()
                    : null}
                  {/* Send time — when set, the message goes at this time (IST). */}
                  <div className="text-[11px] font-semibold">
                    Send time (IST)
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type="time"
                        value={selected.data.sendTime ?? ""}
                        onChange={(e) => patchSelected({ sendTime: e.target.value || undefined })}
                        className="rounded-md border bg-white px-2 py-1.5 text-sm outline-none focus:border-emerald-400"
                      />
                      {selected.data.sendTime ? (
                        <button
                          type="button"
                          onClick={() => patchSelected({ sendTime: undefined })}
                          className="text-[11px] font-medium text-muted-foreground hover:text-rose-600"
                        >
                          Clear
                        </button>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">Khali = turant bhej do</span>
                      )}
                    </div>
                    <p className="mt-1 text-[10px] font-normal text-muted-foreground">
                      Set karne par message us din ke is <b>Asia/Kolkata</b> time pe jayega (time nikal gaya to agle din).
                    </p>
                  </div>
                  <p className="text-[10px] text-muted-foreground">Stage update hone par (e.g. Wait ke baad) ye approved template us number se bheja jayega.</p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* Select Condition modal (LSQ-style) */}
      {condOpen ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setCondOpen(false)}>
          <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="text-base font-bold">Select Condition</h3>
              <button type="button" onClick={() => setCondOpen(false)} className="rounded p-1 text-muted-foreground hover:bg-secondary">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[260px_1fr] divide-x">
              {/* Left — build a criterion. No overflow clip here so the value
                  multi-select dropdown can spill outside this column. */}
              <div className="space-y-2 bg-slate-50 p-3">
                <select
                  value={rowField}
                  onChange={(e) => { setRowField(e.target.value); setRowValue(""); setRowValues([]); }}
                  className="w-full rounded-md border bg-white px-2 py-1.5 text-xs outline-none focus:border-emerald-400"
                >
                  {CONDITION_FIELDS.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
                <select
                  value={rowOp}
                  onChange={(e) => setRowOp(e.target.value)}
                  className="w-full rounded-md border bg-white px-2 py-1.5 text-xs outline-none focus:border-emerald-400"
                >
                  {CONDITION_OPERATORS.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
                {(() => {
                  const noValueOp = rowOp === "Is Empty" || rowOp === "Is Not Empty";
                  if (noValueOp) return <p className="text-[10px] text-muted-foreground">No value needed for &quot;{rowOp}&quot;.</p>;
                  const opts = valueOptionsFor(rowField, lsqStages);
                  return opts ? (
                    <SearchableMultiSelect
                      label={`${rowField} value(s)`}
                      hint="Ek ya zyada select karo"
                      items={opts.map((o) => ({ key: o, label: o }))}
                      selected={rowValues}
                      onChange={setRowValues}
                      allowCustom={rowField === "Lead Source" || rowField === "Sub Source"}
                      accent="emerald"
                      showCounts={false}
                    />
                  ) : (
                    <input
                      value={rowValue}
                      onChange={(e) => setRowValue(e.target.value)}
                      placeholder="Value"
                      className="w-full rounded-md border bg-white px-2 py-1.5 text-xs outline-none focus:border-emerald-400"
                    />
                  );
                })()}
                <div className="flex gap-2">
                  <button type="button" onClick={addDraftCondition} className="flex-1 rounded-md bg-emerald-500 px-2 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600">
                    Add Condition
                  </button>
                  <button type="button" onClick={() => { setRowField(CONDITION_FIELDS[0]); setRowOp(CONDITION_OPERATORS[0]); setRowValue(""); }} className="rounded-md border bg-white px-2 py-1.5 text-xs font-semibold hover:bg-secondary">
                    Reset
                  </button>
                </div>
              </div>

              {/* Right — selected criteria + match mode */}
              <div className="min-w-0 overflow-y-auto p-4">
                <div className="flex items-center gap-4 text-sm">
                  <span className="font-semibold">Check for Lead that Match</span>
                  <label className="flex items-center gap-1 text-xs">
                    <input type="radio" checked={draftMatch === "any"} onChange={() => setDraftMatch("any")} /> Any Criteria
                  </label>
                  <label className="flex items-center gap-1 text-xs">
                    <input type="radio" checked={draftMatch === "all"} onChange={() => setDraftMatch("all")} /> All Criteria
                  </label>
                </div>
                <div className="mt-3 rounded-md border">
                  {draftConds.length === 0 ? (
                    <div className="bg-slate-50 px-3 py-6 text-center text-sm text-muted-foreground">No Search Criteria is Selected</div>
                  ) : (
                    <ul className="divide-y text-xs">
                      {draftConds.map((c, i) => (
                        <li key={i} className="flex items-center gap-2 px-3 py-2">
                          {i > 0 ? <span className="text-[10px] font-bold uppercase text-muted-foreground">{draftMatch === "all" ? "and" : "or"}</span> : <span className="text-[10px] font-bold uppercase text-muted-foreground">where</span>}
                          <span className="flex-1"><b>{c.field}</b> {c.operator.toLowerCase()} {c.value ? <b>&quot;{c.value}&quot;</b> : null}</span>
                          <button type="button" onClick={() => setDraftConds((cs) => cs.filter((_, j) => j !== i))} className="rounded p-1 text-muted-foreground hover:text-destructive">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t bg-slate-50 px-4 py-3">
              <button type="button" onClick={() => setCondOpen(false)} className="rounded-md px-3 py-1.5 text-sm font-semibold text-muted-foreground hover:text-foreground">
                Cancel
              </button>
              <button type="button" onClick={setCondition} className="rounded-md bg-sky-500 px-4 py-1.5 text-sm font-semibold text-white hover:bg-sky-600">
                Set Condition
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
