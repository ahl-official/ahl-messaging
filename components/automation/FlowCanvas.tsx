"use client";

// Visual flow builder (Phase 2) — Interakt-style canvas.
//
// Left: Actions palette (click to drop a node). Center: React Flow canvas
// with a fixed Trigger node + draggable action nodes connected by edges.
// Right: config drawer for the selected node. Save serialises the graph
// (nodes + positions + edges with branch labels) to /api/triggers.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactFlow, {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  addEdge,
  getBezierPath,
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
import {
  AlignLeft,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Loader2,
  MessageCircleReply,
  MessageSquare,
  MoreVertical,
  Pencil,
  Plus,
  Tag,
  Trash2,
  UserPlus,
  Video,
  Webhook,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------
// Node catalogue
// ---------------------------------------------------------------------
interface ActionDef {
  type: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  group: string;
}
const ACTIONS: ActionDef[] = [
  { type: "message_text", label: "Plain Message", icon: MessageSquare, group: "Messages" },
  { type: "message_buttons", label: "Message + Buttons", icon: AlignLeft, group: "Messages" },
  { type: "message_image", label: "Message + Image", icon: ImageIcon, group: "Messages" },
  { type: "message_image_buttons", label: "Message + Image + Buttons", icon: ImageIcon, group: "Messages" },
  { type: "message_video", label: "Message + Video", icon: Video, group: "Messages" },
  { type: "wait_reply", label: "Wait for reply", icon: MessageCircleReply, group: "Logic" },
  { type: "condition", label: "Set a Condition", icon: GitBranch, group: "Logic" },
  { type: "webhook", label: "Trigger Webhook", icon: Webhook, group: "Logic" },
  { type: "update_field_tag", label: "Update Field / Tag", icon: Tag, group: "Logic" },
  { type: "assign_agent", label: "Assign Chat to Agent", icon: UserPlus, group: "Logic" },
];
const ACTION_BY_TYPE = new Map(ACTIONS.map((a) => [a.type, a]));

const TRIGGER_DEFS: { type: string; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { type: "keyword", label: "On keyword", icon: Zap },
  { type: "template_reply", label: "Replied on a template", icon: FileText },
  { type: "new_contact", label: "On new contact", icon: UserPlus },
  { type: "first_message", label: "On first message", icon: MessageSquare },
];

// Variables a "Set a Condition" node can read. The reply-* ones are populated
// by a preceding "Wait for reply" node (engine: buildReplyVars). `value` is the
// suggested match value clicked-in from the chip.
const CONDITION_VARS: { name: string; desc: string; value?: string }[] = [
  { name: "images_received", desc: "client ne image bheji? (yes/no)", value: "yes" },
  { name: "video_received", desc: "video bheji? (yes/no)", value: "yes" },
  { name: "audio_received", desc: "audio/voice bheji? (yes/no)", value: "yes" },
  { name: "document_received", desc: "file/document bheji? (yes/no)", value: "yes" },
  { name: "text_received", desc: "sirf text reply kiya? (yes/no)", value: "yes" },
  { name: "media_received", desc: "koi image/video/audio/file bheji? (yes/no)", value: "yes" },
  { name: "last_reply_type", desc: "reply ka type: image/video/audio/document/text", value: "image" },
  { name: "last_reply_text", desc: "reply ka text (media-only par khaali)" },
];

function nodeTitle(type: string): string {
  return ACTION_BY_TYPE.get(type)?.label ?? type;
}
function summarise(type: string, config: Record<string, unknown>): string {
  switch (type) {
    case "message_text":
      return String(config.text ?? "") || "Empty message";
    case "message_buttons": {
      const b = Array.isArray(config.buttons) ? (config.buttons as Array<{ label?: string }>) : [];
      return (String(config.text ?? "") || "Question") + (b.length ? ` · ${b.length} button(s)` : "");
    }
    case "message_image":
    case "message_video":
      return String(config.media_url ?? "") || "No media URL";
    case "message_image_buttons": {
      const b = Array.isArray(config.buttons) ? (config.buttons as unknown[]) : [];
      const imgs = Array.isArray(config.media_urls) ? (config.media_urls as unknown[]).filter(Boolean).length : config.media_url ? 1 : 0;
      return `${imgs} image(s)${b.length ? ` · ${b.length} button(s)` : ""}`;
    }
    case "wait_reply":
      return "Client ke reply ka intezaar";
    case "condition":
      return `if ${config.var || "stage"} ${config.op || "contains"} "${config.value ?? ""}"`;
    case "webhook":
      return String(config.url ?? "") || "No URL";
    case "update_field_tag":
      return [config.lsq_stage && `stage→${config.lsq_stage}`, config.status && `status→${config.status}`]
        .filter(Boolean)
        .join(", ") || "No change";
    case "assign_agent":
      return String(config.agent_email ?? "") || "No agent";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------
// Custom node renderers
// ---------------------------------------------------------------------
type NodeData = {
  node_type: string;
  config: Record<string, unknown>;
  selected?: boolean;
};

type TriggerData = {
  triggerType: string;
  phrasesText: string;
  phraseList: string[];
  match: string;
  templateName: string;
  templates: string[] | null;
  onPhrases: (v: string) => void;
  onMatch: (v: string) => void;
  onTemplate: (v: string) => void;
};

function TriggerNode({ data }: NodeProps<TriggerData>) {
  const isTemplate = data.triggerType === "template_reply";
  const isNewContact = data.triggerType === "new_contact";
  const isFirstMessage = data.triggerType === "first_message";
  return (
    <div className="w-72 rounded-xl border border-emerald-300 bg-emerald-50/80 shadow-sm">
      <div className="flex items-center gap-2 border-b border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-800">
        <Zap className="h-3.5 w-3.5" /> When to trigger the workflow
      </div>
      <div className="space-y-2 px-3 py-2">
        <div className="rounded-md bg-white px-2 py-1.5 text-[11px] text-slate-600 ring-1 ring-inset ring-emerald-100">
          {isNewContact
            ? "A new number messages for the first time"
            : isFirstMessage
              ? "A contact starts a new conversation"
              : isTemplate
                ? "User replies to a template"
                : "User sends a WhatsApp message"}
        </div>

        {isNewContact ? (
          <div className="rounded-md bg-white px-2 py-1.5 text-[10px] text-muted-foreground ring-1 ring-inset ring-emerald-100">
            Fires once when a brand-new contact (number we&apos;ve never chatted with) sends their first message. No keywords needed.
          </div>
        ) : isFirstMessage ? (
          <div className="rounded-md bg-white px-2 py-1.5 text-[10px] text-muted-foreground ring-1 ring-inset ring-emerald-100">
            Fires on the first message of a new conversation — when ANY client (new or returning) messages after a quiet gap (24h+). No keywords needed.
          </div>
        ) : isTemplate ? (
          <select
            value={data.templateName}
            onChange={(e) => data.onTemplate(e.target.value)}
            className="nodrag w-full rounded-md border bg-white px-2 py-1.5 text-[11px] outline-none focus:border-emerald-400"
          >
            <option value="">Any template</option>
            {data.templateName && !(data.templates ?? []).includes(data.templateName) ? (
              <option value={data.templateName}>{data.templateName}</option>
            ) : null}
            {(data.templates ?? []).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <input
                value={data.phrasesText}
                onChange={(e) => data.onPhrases(e.target.value)}
                placeholder="keywords: price, hello, hi"
                disabled={data.match === "any"}
                className="nodrag flex-1 rounded-md border bg-white px-2 py-1.5 text-[11px] outline-none focus:border-emerald-400 disabled:bg-slate-50 disabled:text-muted-foreground"
              />
              <select
                value={data.match}
                onChange={(e) => data.onMatch(e.target.value)}
                className="nodrag rounded-md border bg-white px-1.5 py-1.5 text-[10px] outline-none focus:border-emerald-400"
                title="Match mode"
              >
                <option value="any">any message</option>
                <option value="contains">contains</option>
                <option value="exact">exact</option>
                <option value="starts">starts</option>
              </select>
            </div>
            {data.match === "any" ? (
              <div className="rounded-md bg-white px-2 py-1.5 text-[10px] text-muted-foreground ring-1 ring-inset ring-emerald-100">
                Fires on ANY message from the client — keywords ignored.
              </div>
            ) : null}
            <div className="flex flex-wrap gap-1">
              {data.phraseList.length === 0 ? (
                <span className="text-[10px] text-muted-foreground">No keywords yet</span>
              ) : (
                data.phraseList.slice(0, 10).map((p) => (
                  <span key={p} className="rounded bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-700 ring-1 ring-inset ring-slate-200">
                    {p}
                  </span>
                ))
              )}
            </div>
          </>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !bg-emerald-500" />
    </div>
  );
}

/** Render WhatsApp-ish text: preserve line breaks and bold *...* segments. */
function renderWaText(text: string): React.ReactNode {
  return (text || "").split("*").map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : <span key={i}>{part}</span>,
  );
}

function ActionNode({ data }: NodeProps<NodeData>) {
  const def = ACTION_BY_TYPE.get(data.node_type);
  const Icon = def?.icon ?? MessageSquare;
  const isMessage = ["message_text", "message_buttons", "message_image", "message_image_buttons", "message_video"].includes(data.node_type);
  const isCondition = data.node_type === "condition";
  const isWaitReply = data.node_type === "wait_reply";
  const buttons =
    (data.node_type === "message_buttons" || data.node_type === "message_image_buttons") && Array.isArray(data.config.buttons)
      ? (data.config.buttons as Array<{ label?: string }>)
      : [];
  const selRing = data.selected ? "border-emerald-400 ring-2 ring-emerald-300/40" : "border-slate-200";

  // Rich "Send a Message" card (text / image / video / buttons).
  if (isMessage) {
    const body = String(data.config.text ?? data.config.caption ?? "");
    const mediaUrl = String(data.config.media_url ?? "");
    return (
      <div className={cn("w-80 rounded-2xl border bg-white shadow-sm", selRing)}>
        <Handle type="target" position={Position.Left} className="!h-3 !w-3 !bg-slate-400" />
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <span className="text-sm font-semibold text-slate-700">Send a Message</span>
          <div className="flex items-center gap-2 text-slate-400">
            <Pencil className="h-3.5 w-3.5" />
            <MoreVertical className="h-4 w-4" />
          </div>
        </div>
        <div className="space-y-2 p-3">
          {(data.node_type === "message_image" || data.node_type === "message_image_buttons" || data.node_type === "message_video") && mediaUrl ? (
            data.node_type !== "message_video" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mediaUrl} alt="" className="max-h-32 w-full rounded-lg object-cover" />
            ) : (
              <div className="flex h-24 items-center justify-center rounded-lg bg-slate-100 text-[11px] text-slate-500">
                <Video className="mr-1 h-4 w-4" /> Video
              </div>
            )
          ) : null}
          <div className="whitespace-pre-wrap break-words rounded-xl bg-emerald-50/70 px-3 py-2.5 text-center text-xs leading-relaxed text-sky-800">
            {body ? renderWaText(body) : <span className="text-muted-foreground">Empty message</span>}
          </div>
          {buttons.map((b, i) => (
            <div
              key={i}
              className="relative flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700"
            >
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-slate-700 px-1 text-[10px] font-bold text-white">
                {i + 1}
              </span>
              <span className="truncate">{b.label || `Button ${i + 1}`}</span>
              <Handle
                id={b.label || `opt-${i}`}
                type="source"
                position={Position.Right}
                style={{ position: "absolute", right: -7, top: "50%", transform: "translateY(-50%)" }}
                className="!h-3 !w-3 !bg-emerald-500"
              />
            </div>
          ))}
        </div>
        {buttons.length === 0 ? (
          <Handle type="source" position={Position.Right} className="!h-3 !w-3 !bg-slate-400" />
        ) : null}
      </div>
    );
  }

  // Compact card for logic nodes (condition / webhook / update / assign).
  return (
    <div className={cn("w-64 rounded-xl border bg-white shadow-sm", selRing)}>
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !bg-slate-400" />
      <div className="flex items-center gap-2 rounded-t-xl bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
        <Icon className="h-3.5 w-3.5 text-emerald-700" /> {nodeTitle(data.node_type)}
      </div>
      <div className="px-3 py-2 text-[11px] text-slate-600">
        <div className="line-clamp-2 whitespace-pre-wrap break-words">{summarise(data.node_type, data.config)}</div>
      </div>
      {isCondition ? (
        <div className="flex items-center justify-between border-t px-3 py-1.5 text-[10px] font-semibold">
          <span className="text-emerald-600">True</span>
          <span className="text-rose-500">False</span>
          <Handle id="true" type="source" position={Position.Right} style={{ top: "auto", bottom: 22 }} className="!h-2.5 !w-2.5 !bg-emerald-500" />
          <Handle id="false" type="source" position={Position.Right} style={{ top: "auto", bottom: 6 }} className="!h-2.5 !w-2.5 !bg-rose-500" />
        </div>
      ) : isWaitReply ? (
        <div className="flex items-center justify-between border-t px-3 py-1.5 text-[10px] font-semibold">
          <span className="text-emerald-600">Reply</span>
          <span className="text-amber-500">Timeout</span>
          {/* default (unlabeled) handle = reply path; "timeout" handle fires
              when the wait time elapses with no reply. */}
          <Handle type="source" position={Position.Right} style={{ top: "auto", bottom: 22 }} className="!h-2.5 !w-2.5 !bg-emerald-500" />
          <Handle id="timeout" type="source" position={Position.Right} style={{ top: "auto", bottom: 6 }} className="!h-2.5 !w-2.5 !bg-amber-500" />
        </div>
      ) : (
        <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !bg-slate-400" />
      )}
    </div>
  );
}

const nodeTypes = { trigger: TriggerNode, action: ActionNode };

// Edge ops shared with the custom edge (delete a wire / insert a node mid-wire).
interface EdgeOps {
  onDelete: (edgeId: string) => void;
  onInsert: (edgeId: string, nodeType: string) => void;
}
const EdgeOpsContext = createContext<EdgeOps | null>(null);

// Custom edge with a × (delete) and ⊕ (insert a node here) control at its
// midpoint — so the operator can drop a node between two connected nodes.
function ButtonEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style } = props;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });
  const ops = useContext(EdgeOpsContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Close the insert menu on an outside click / Escape.
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
                {ACTIONS.map((a) => {
                  const Icon = a.icon;
                  return (
                    <button
                      key={a.type}
                      type="button"
                      onClick={() => {
                        ops?.onInsert(id, a.type);
                        setMenuOpen(false);
                      }}
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
const edgeTypes = { button: ButtonEdge };

// ---------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------
const TRIGGER_ID = "trigger";

export function FlowCanvas({
  bpid,
  flowId,
  onClose,
  onSaved,
}: {
  bpid: string;
  flowId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState("keyword");
  const [phrases, setPhrases] = useState("");
  const [match, setMatch] = useState("contains");
  const [templateName, setTemplateName] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<NodeData | TriggerData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mounted, setMounted] = useState(false);
  // ReactFlow instance — used to re-fit the view once the flow's nodes
  // finish loading (the `fitView` prop only fits on first mount, which
  // can run before async-loaded nodes have positions → nodes off-screen).
  const rfRef = useRef<ReactFlowInstance | null>(null);
  // Re-center on the flow's nodes once they've loaded.
  useEffect(() => {
    if (!loaded || !mounted) return;
    const t = setTimeout(() => rfRef.current?.fitView({ padding: 0.2, duration: 200 }), 60);
    return () => clearTimeout(t);
  }, [loaded, mounted]);
  useEffect(() => setMounted(true), []);
  const [templates, setTemplates] = useState<string[] | null>(null);
  const [tplDetails, setTplDetails] = useState<Record<string, { body: string; buttons: string[] }>>({});
  const appliedTplRef = useRef<string | null>(null);

  // Load the number's templates once the user picks the template trigger.
  useEffect(() => {
    if (triggerType !== "template_reply" || templates !== null) return;
    void (async () => {
      try {
        const res = await fetch(`/api/templates?phone_number_id=${encodeURIComponent(bpid)}`, { cache: "no-store" });
        const j = (await res.json()) as {
          templates?: Array<{ name: string; status?: string; body?: string; buttons?: Array<{ text?: string } | string> | null }>;
        };
        const approved = (j.templates ?? []).filter((t) => t.name && (!t.status || t.status.toUpperCase() === "APPROVED"));
        const names = Array.from(new Set(approved.map((t) => t.name))).sort();
        const details: Record<string, { body: string; buttons: string[] }> = {};
        for (const t of approved) {
          const labels = (t.buttons ?? [])
            .map((b) => (typeof b === "string" ? b : b?.text ?? ""))
            .filter(Boolean);
          details[t.name] = { body: t.body ?? "", buttons: labels };
        }
        setTemplates(names);
        setTplDetails(details);
      } catch {
        setTemplates([]);
      }
    })();
  }, [triggerType, templates, bpid]);

  // Picking a template loads its full body + buttons into the connected node,
  // so the operator can branch from each template button. Guarded by a ref so
  // it applies once per chosen template (no clobber loop).
  useEffect(() => {
    if (triggerType !== "template_reply" || !templateName) return;
    const d = tplDetails[templateName];
    if (!d || appliedTplRef.current === templateName) return;
    appliedTplRef.current = templateName;
    const cfg = { text: d.body, buttons: d.buttons.map((label) => ({ label })) };
    const startEdge = edges.find((e) => e.source === TRIGGER_ID);
    if (startEdge) {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === startEdge.target
            ? { ...n, type: "action", data: { node_type: "message_buttons", config: cfg } }
            : n,
        ),
      );
    } else {
      const id = crypto.randomUUID();
      setNodes((prev) => [
        ...prev,
        { id, type: "action", position: { x: 440, y: 120 }, data: { node_type: "message_buttons", config: cfg } },
      ]);
      setEdges((prev) => addEdge({ source: TRIGGER_ID, target: id, sourceHandle: null, targetHandle: null, type: "button" }, prev));
    }
  }, [triggerType, templateName, tplDetails, edges, setNodes, setEdges]);

  const phraseList = useMemo(() => phrases.split(",").map((p) => p.trim()).filter(Boolean), [phrases]);

  // Keep the trigger node in sync with the trigger fields (editable in-node).
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) =>
        n.id === TRIGGER_ID
          ? {
              ...n,
              data: {
                triggerType,
                phrasesText: phrases,
                phraseList,
                match,
                templateName,
                templates,
                onPhrases: setPhrases,
                onMatch: setMatch,
                onTemplate: setTemplateName,
              },
            }
          : n,
      ),
    );
  }, [phrases, phraseList, match, triggerType, templateName, templates, setNodes]);

  // Load existing flow (or seed an empty one).
  useEffect(() => {
    void (async () => {
      const mkTrigger = (d: { triggerType: string; phrasesText: string; match: string; templateName: string; pos?: { x: number; y: number } }): Node => ({
        id: TRIGGER_ID,
        type: "trigger",
        position: d.pos ?? { x: 40, y: 160 },
        data: {
          triggerType: d.triggerType,
          phrasesText: d.phrasesText,
          phraseList: d.phrasesText.split(",").map((p) => p.trim()).filter(Boolean),
          match: d.match,
          templateName: d.templateName,
          templates: null,
          onPhrases: setPhrases,
          onMatch: setMatch,
          onTemplate: setTemplateName,
        },
        deletable: false,
      });
      if (!flowId) {
        setNodes([mkTrigger({ triggerType: "keyword", phrasesText: "", match: "contains", templateName: "" })]);
        setLoaded(true);
        return;
      }
      const res = await fetch(`/api/triggers/${flowId}`, { cache: "no-store" });
      const j = (await res.json()) as {
        flow?: { name: string; enabled: boolean; trigger_type: string; start_node_id: string | null; trigger_config: { phrases?: string[]; match?: string; template_name?: string; _pos?: { x: number; y: number } } };
        nodes?: Array<{ id: string; node_type: string; config: Record<string, unknown>; position: { x: number; y: number } | null }>;
        edges?: Array<{ from_node_id: string; to_node_id: string; branch_label: string | null }>;
      };
      const tType = j.flow?.trigger_type ?? "keyword";
      const tPhrases = (j.flow?.trigger_config?.phrases ?? []).join(", ");
      const tMatch = j.flow?.trigger_config?.match ?? "contains";
      const tTemplate = j.flow?.trigger_config?.template_name ?? "";
      const tPos = j.flow?.trigger_config?._pos;
      if (j.flow) {
        setName(j.flow.name);
        setTriggerType(tType);
        setPhrases(tPhrases);
        setMatch(tMatch);
        setTemplateName(tTemplate);
        setEnabled(j.flow.enabled);
      }
      // Mark the saved template as already-applied so reopening doesn't
      // re-run the prefill and clobber the saved graph / positions.
      appliedTplRef.current = tTemplate || null;
      const rfNodes: Node[] = [mkTrigger({ triggerType: tType, phrasesText: tPhrases, match: tMatch, templateName: tTemplate, pos: tPos })];
      (j.nodes ?? []).forEach((n, i) => {
        rfNodes.push({
          id: n.id,
          type: "action",
          position: n.position ?? { x: 360 + (i % 3) * 300, y: 60 + Math.floor(i / 3) * 180 },
          data: { node_type: n.node_type, config: n.config ?? {} },
        });
      });
      const rfEdges: Edge[] = [];
      if (j.flow?.start_node_id) {
        rfEdges.push({ id: `e-trigger-${j.flow.start_node_id}`, source: TRIGGER_ID, target: j.flow.start_node_id, type: "button" });
      }
      (j.edges ?? []).forEach((e, i) => {
        rfEdges.push({
          id: `e-${e.from_node_id}-${e.to_node_id}-${i}`,
          source: e.from_node_id,
          target: e.to_node_id,
          sourceHandle: e.branch_label || undefined,
          label: e.branch_label || undefined,
          type: "button",
        });
      });
      setNodes(rfNodes);
      setEdges(rfEdges);
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId]);

  const onConnect = useCallback(
    (c: Connection) => setEdges((eds) => addEdge({ ...c, label: c.sourceHandle || undefined, type: "button" }, eds)),
    [setEdges],
  );

  // Wire controls: × deletes a connection; ⊕ inserts a node mid-wire (splits
  // A→B into A→new→B, preserving the source handle / branch label).
  const edgeOps = useMemo<EdgeOps>(
    () => ({
      onDelete: (edgeId) => setEdges((eds) => eds.filter((e) => e.id !== edgeId)),
      onInsert: (edgeId, nodeType) => {
        const edge = edges.find((e) => e.id === edgeId);
        if (!edge) return;
        const src = nodes.find((n) => n.id === edge.source);
        const tgt = nodes.find((n) => n.id === edge.target);
        const newId = crypto.randomUUID();
        const mid = {
          x: ((src?.position.x ?? 0) + (tgt?.position.x ?? 0)) / 2,
          y: ((src?.position.y ?? 0) + (tgt?.position.y ?? 0)) / 2,
        };
        setNodes((prev) => [
          ...prev,
          { id: newId, type: "action", position: mid, data: { node_type: nodeType, config: defaultConfig(nodeType) } },
        ]);
        setEdges((prev) => [
          ...prev.filter((e) => e.id !== edgeId),
          { id: `e-${edge.source}-${newId}`, source: edge.source, target: newId, sourceHandle: edge.sourceHandle, label: edge.label, type: "button" },
          { id: `e-${newId}-${edge.target}`, source: newId, target: edge.target, type: "button" },
        ]);
        setSelectedId(newId);
      },
    }),
    [edges, nodes, setEdges, setNodes],
  );

  function addAction(type: string) {
    const id = crypto.randomUUID();
    const count = nodes.filter((n) => n.type === "action").length;
    setNodes((prev) => [
      ...prev,
      {
        id,
        type: "action",
        position: { x: 380 + (count % 3) * 60, y: 80 + count * 40 },
        data: { node_type: type, config: defaultConfig(type) },
      },
    ]);
    setSelectedId(id);
  }

  function updateConfig(id: string, patch: Record<string, unknown>) {
    setNodes((prev) =>
      prev.map((n) =>
        n.id === id ? { ...n, data: { ...(n.data as NodeData), config: { ...(n.data as NodeData).config, ...patch } } } : n,
      ),
    );
  }

  function deleteNode(id: string) {
    setNodes((prev) => prev.filter((n) => n.id !== id));
    setEdges((prev) => prev.filter((e) => e.source !== id && e.target !== id));
    setSelectedId(null);
  }

  // Reflect selection styling.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) =>
        n.type === "action"
          ? { ...n, data: { ...(n.data as NodeData), selected: n.id === selectedId } }
          : n,
      ),
    );
  }, [selectedId, setNodes]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const startEdge = edges.find((e) => e.source === TRIGGER_ID);
      const graph = {
        start_node_id: startEdge?.target ?? null,
        nodes: nodes
          .filter((n) => n.type === "action")
          .map((n) => ({
            id: n.id,
            node_type: (n.data as NodeData).node_type,
            config: (n.data as NodeData).config,
            position: n.position,
          })),
        edges: edges
          .filter((e) => e.source !== TRIGGER_ID)
          .map((e) => ({
            from_node_id: e.source,
            to_node_id: e.target,
            branch_label: e.sourceHandle ?? null,
          })),
      };
      const trigPos = nodes.find((n) => n.id === TRIGGER_ID)?.position;
      const payload = {
        business_phone_number_id: bpid,
        name: name.trim() || "Untitled flow",
        enabled,
        trigger_type: triggerType,
        trigger_config: {
          ...(triggerType === "template_reply"
            ? { template_name: templateName.trim() }
            : { phrases: phraseList, match }),
          ...(trigPos ? { _pos: trigPos } : {}),
        },
        graph,
      };
      const res = flowId
        ? await fetch(`/api/triggers/${flowId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/triggers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const selectedNode = nodes.find((n) => n.id === selectedId && n.type === "action");
  const grouped = useMemo(() => {
    const m = new Map<string, ActionDef[]>();
    for (const a of ACTIONS) {
      if (!m.has(a.group)) m.set(a.group, []);
      m.get(a.group)!.push(a);
    }
    return Array.from(m.entries());
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-background">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2.5">
        <button type="button" onClick={onClose} className="text-xs font-semibold text-muted-foreground hover:underline">
          ← Back
        </button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Flow name"
          className="w-56 rounded-md border bg-background px-2.5 py-1.5 text-sm font-semibold outline-none focus:border-primary"
        />
        <span className="text-[11px] text-muted-foreground">Trigger keywords/template node me set karo →</span>
        <label className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4" />
          Enabled
        </label>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Save flow
        </button>
      </div>

      {error ? <div className="border-b bg-destructive/10 px-4 py-1.5 text-xs text-destructive">{error}</div> : null}

      <div className="flex min-h-0 flex-1">
        {/* Actions palette */}
        <aside className="w-52 shrink-0 overflow-y-auto border-r bg-background p-3">
          <div className="mb-3">
            <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Triggers</div>
            <div className="space-y-1">
              {TRIGGER_DEFS.map((t) => {
                const active = triggerType === t.type;
                return (
                  <button
                    key={t.type}
                    type="button"
                    onClick={() => setTriggerType(t.type)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs font-medium",
                      active
                        ? "border-emerald-400 bg-emerald-50 text-emerald-800"
                        : "bg-card hover:border-primary hover:bg-secondary",
                    )}
                  >
                    <t.icon className={cn("h-4 w-4 shrink-0", active ? "text-emerald-600" : "text-emerald-700")} /> {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Actions</div>
          {grouped.map(([group, items]) => (
            <div key={group} className="mb-3">
              <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">{group}</div>
              <div className="space-y-1">
                {items.map((a) => (
                  <button
                    key={a.type}
                    type="button"
                    onClick={() => addAction(a.type)}
                    className="flex w-full items-center gap-2 rounded-lg border bg-card px-2.5 py-2 text-left text-xs font-medium hover:border-primary hover:bg-secondary"
                  >
                    <a.icon className="h-4 w-4 shrink-0 text-emerald-700" /> {a.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </aside>

        {/* Canvas */}
        <div className="relative min-w-0 flex-1">
          {!loaded ? (
            <div className="grid h-full place-items-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <EdgeOpsContext.Provider value={edgeOps}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={(_, n) => setSelectedId(n.type === "action" ? n.id : null)}
                onPaneClick={() => setSelectedId(null)}
                onInit={(inst) => {
                  rfRef.current = inst;
                  inst.fitView({ padding: 0.2 });
                }}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                defaultEdgeOptions={{ type: "button" }}
                fitView
                minZoom={0.1}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={16} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </EdgeOpsContext.Provider>
          )}
        </div>

        {/* Config drawer */}
        {selectedNode ? (
          <aside className="w-80 shrink-0 overflow-y-auto border-l bg-background p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold">{nodeTitle((selectedNode.data as NodeData).node_type)}</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => deleteNode(selectedNode.id)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded text-rose-600 hover:bg-rose-50"
                  aria-label="Delete node"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-secondary"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <NodeConfig
              node_type={(selectedNode.data as NodeData).node_type}
              config={(selectedNode.data as NodeData).config}
              onSet={(patch) => updateConfig(selectedNode.id, patch)}
            />
            <NodePreview
              node_type={(selectedNode.data as NodeData).node_type}
              config={(selectedNode.data as NodeData).config}
            />
          </aside>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function defaultConfig(type: string): Record<string, unknown> {
  // Every new message pre-fills with the client's name greeting — the engine
  // replaces {{name}} with the contact's name at send time.
  const greeting = "Hi {{name}},\n\n";
  if (type === "message_text") return { text: greeting };
  if (type === "message_buttons") return { text: greeting, buttons: [{ label: "Yes" }, { label: "No" }] };
  if (type === "message_image_buttons") return { caption: greeting, media_urls: [""], buttons: [{ label: "Yes" }, { label: "No" }] };
  if (type === "message_image" || type === "message_video") return { caption: greeting };
  if (type === "condition") return { var: "", op: "contains", value: "" };
  return {};
}

// ---------------------------------------------------------------------
// Per-node config editors
// ---------------------------------------------------------------------
function NodeConfig({
  node_type,
  config,
  onSet,
}: {
  node_type: string;
  config: Record<string, unknown>;
  onSet: (patch: Record<string, unknown>) => void;
}) {
  const c = config;
  switch (node_type) {
    case "message_text":
      return (
        <Field label="Message" hint="Variables: {{name}}, {{first_name}}, {{phone}}">
          <textarea value={String(c.text ?? "")} onChange={(e) => onSet({ text: e.target.value })} rows={5} className={cn(inputCls, "resize-y")} placeholder="Hi {{name}}, …" />
        </Field>
      );
    case "message_buttons": {
      const buttons = Array.isArray(c.buttons) ? (c.buttons as Array<{ label?: string; url?: string }>) : [];
      const setBtns = (next: Array<{ label?: string; url?: string }>) => onSet({ buttons: next });
      return (
        <div className="space-y-3">
          <Field label="Question" hint="Client ko bheja jayega; options ke neeche se branch nikalo">
            <textarea value={String(c.text ?? "")} onChange={(e) => onSet({ text: e.target.value })} rows={3} className={cn(inputCls, "resize-y")} placeholder="Please select language" />
          </Field>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Buttons</span>
              <button
                type="button"
                onClick={() => setBtns([...buttons, { label: `Button ${buttons.length + 1}` }])}
                className="inline-flex items-center gap-1 rounded border bg-card px-1.5 py-0.5 text-[10px] font-semibold hover:bg-secondary"
              >
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
            <div className="space-y-2">
              {buttons.map((b, i) => {
                const isLink = Boolean((b.url ?? "").trim());
                return (
                  <div key={i} className="rounded-md border bg-secondary/20 p-1.5">
                    <div className="flex items-center gap-1.5">
                      <input
                        value={b.label ?? ""}
                        onChange={(e) => setBtns(buttons.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                        className={inputCls}
                        placeholder={`Button ${i + 1}`}
                      />
                      <button
                        type="button"
                        onClick={() => setBtns(buttons.filter((_, j) => j !== i))}
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <input
                      value={b.url ?? ""}
                      onChange={(e) => setBtns(buttons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                      className={cn(inputCls, "mt-1 text-[10px]", isLink && "border-emerald-300")}
                      placeholder="Link URL (optional) — https://…"
                    />
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              Khali URL = branch button (apna handle). URL daala = <b>link button</b> (tap pe link khulta hai, branch nahi). WhatsApp: 1 link button alone, ya 3 tak branch buttons.
            </p>
          </div>

          {/* If the client types instead of tapping a button, optionally
              nudge them to use a button (run stays parked on this node). */}
          <div className="rounded-md border bg-secondary/30 p-2">
            <label className="flex cursor-pointer items-center justify-between gap-2">
              <span className="text-[11px] font-semibold">Remind if no button is tapped</span>
              <input
                type="checkbox"
                checked={Boolean(c.remind_on_invalid)}
                onChange={(e) => onSet({ remind_on_invalid: e.target.checked })}
                className="h-4 w-4 accent-emerald-600"
              />
            </label>
            {c.remind_on_invalid ? (
              <textarea
                value={String(c.invalid_reply_message ?? "")}
                onChange={(e) => onSet({ invalid_reply_message: e.target.value })}
                rows={2}
                className={cn(inputCls, "mt-2 resize-y")}
                placeholder="Please select an option from the buttons 🙏"
              />
            ) : null}
          </div>
        </div>
      );
    }
    case "message_image": {
      const urls =
        Array.isArray(c.media_urls) && c.media_urls.length
          ? (c.media_urls as string[])
          : c.media_url
            ? [String(c.media_url)]
            : [""];
      // Keep media_url mirrored to the first image so the node card preview +
      // older send paths still work.
      const setUrls = (next: string[]) => onSet({ media_urls: next, media_url: next[0] ?? "" });
      return (
        <div className="space-y-3">
          <Field label="Images" hint="Ek se zyada add karo — sequence me jaayengi (chat me album jaisa).">
            <div className="space-y-2">
              {urls.map((u, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <div className="min-w-0 flex-1">
                    <ImageUrlField value={u} onChange={(v) => setUrls(urls.map((x, j) => (j === i ? v : x)))} />
                  </div>
                  {urls.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setUrls(urls.filter((_, j) => j !== i))}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-rose-600 hover:bg-rose-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setUrls([...urls, ""])}
              className="mt-1.5 inline-flex items-center gap-1 rounded border bg-card px-2 py-1 text-[10px] font-semibold hover:bg-secondary"
            >
              <Plus className="h-3 w-3" /> Add image
            </button>
          </Field>
          <Field label="Caption" hint="Pehli image ke saath jaata hai">
            <textarea value={String(c.caption ?? "")} onChange={(e) => onSet({ caption: e.target.value })} rows={2} className={cn(inputCls, "resize-y")} />
          </Field>
        </div>
      );
    }
    case "message_image_buttons": {
      const imgs =
        Array.isArray(c.media_urls) && c.media_urls.length
          ? (c.media_urls as string[])
          : c.media_url
            ? [String(c.media_url)]
            : [""];
      const setImgs = (next: string[]) => onSet({ media_urls: next, media_url: next[0] ?? "" });
      const btns = Array.isArray(c.buttons) ? (c.buttons as Array<{ label?: string; url?: string }>) : [];
      const setBtns = (next: Array<{ label?: string; url?: string }>) => onSet({ buttons: next });
      return (
        <div className="space-y-3">
          <Field label="Images" hint="Ek se zyada — sequence me jaayengi; aakhri image ke saath caption + buttons.">
            <div className="space-y-2">
              {imgs.map((u, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <div className="min-w-0 flex-1">
                    <ImageUrlField value={u} onChange={(v) => setImgs(imgs.map((x, j) => (j === i ? v : x)))} />
                  </div>
                  {imgs.length > 1 ? (
                    <button type="button" onClick={() => setImgs(imgs.filter((_, j) => j !== i))} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-rose-600 hover:bg-rose-50">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setImgs([...imgs, ""])} className="mt-1.5 inline-flex items-center gap-1 rounded border bg-card px-2 py-1 text-[10px] font-semibold hover:bg-secondary">
              <Plus className="h-3 w-3" /> Add image
            </button>
          </Field>
          <Field label="Caption">
            <textarea value={String(c.caption ?? "")} onChange={(e) => onSet({ caption: e.target.value })} rows={2} className={cn(inputCls, "resize-y")} />
          </Field>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Buttons</span>
              <button type="button" onClick={() => setBtns([...btns, { label: `Button ${btns.length + 1}` }])} className="inline-flex items-center gap-1 rounded border bg-card px-1.5 py-0.5 text-[10px] font-semibold hover:bg-secondary">
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
            <div className="space-y-2">
              {btns.map((b, i) => (
                <div key={i} className="rounded-md border bg-secondary/20 p-1.5">
                  <div className="flex items-center gap-1.5">
                    <input value={b.label ?? ""} onChange={(e) => setBtns(btns.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className={inputCls} placeholder={`Button ${i + 1}`} />
                    <button type="button" onClick={() => setBtns(btns.filter((_, j) => j !== i))} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-rose-600 hover:bg-rose-50">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <input value={b.url ?? ""} onChange={(e) => setBtns(btns.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} className={cn(inputCls, "mt-1 text-[10px]", (b.url ?? "").trim() && "border-emerald-300")} placeholder="Link URL (optional) — https://…" />
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] text-muted-foreground">Khali URL = branch button. URL daala = link button. (Image header ke saath: 3 tak branch buttons ya 1 link button.)</p>
          </div>
        </div>
      );
    }
    case "message_video":
      return (
        <div className="space-y-3">
          <Field label="Video URL">
            <input value={String(c.media_url ?? "")} onChange={(e) => onSet({ media_url: e.target.value })} className={inputCls} placeholder="https://…" />
          </Field>
          <Field label="Caption">
            <textarea value={String(c.caption ?? "")} onChange={(e) => onSet({ caption: e.target.value })} rows={2} className={cn(inputCls, "resize-y")} />
          </Field>
        </div>
      );
    case "condition":
      return (
        <div className="space-y-3">
          <p className="text-[11px] text-muted-foreground">Match hone par <strong>True</strong> handle, warna <strong>False</strong> handle se aage jata hai.</p>
          <Field label="Variable" hint="khaali = CRM stage. Reply ke variables ke liye pehle ek 'Wait for reply' node lagao.">
            <input
              value={String(c.var ?? "")}
              onChange={(e) => onSet({ var: e.target.value })}
              className={inputCls}
              placeholder="stage / var name"
              list="condition-vars"
            />
            <datalist id="condition-vars">
              {CONDITION_VARS.map((v) => (
                <option key={v.name} value={v.name}>{v.desc}</option>
              ))}
            </datalist>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {CONDITION_VARS.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  onClick={() => onSet({ var: v.name, ...(v.value ? { op: "equals", value: v.value } : {}) })}
                  title={v.desc}
                  className="rounded-full border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-secondary"
                >
                  {v.name}
                </button>
              ))}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Operator">
              <select value={String(c.op ?? "contains")} onChange={(e) => onSet({ op: e.target.value })} className={inputCls}>
                <option value="contains">contains</option>
                <option value="equals">equals</option>
                <option value="starts">starts</option>
              </select>
            </Field>
            <Field label="Value">
              <input value={String(c.value ?? "")} onChange={(e) => onSet({ value: e.target.value })} className={inputCls} placeholder="yes / no / image …" />
            </Field>
          </div>
        </div>
      );
    case "wait_reply":
      return (
        <div className="space-y-3">
          <p className="text-[11px] text-muted-foreground">
            Client ke <strong>agle message</strong> ka intezaar karta hai (text ho ya image/file). Iske baad ek <strong>Set a Condition</strong> node lagao jo ye variables padh sake.
          </p>
          <Field label="Wait time (timeout)" hint="Itni der me reply na aaye to 'Timeout' handle se aage jata hai. 0 = hamesha intezaar.">
            <div className="flex gap-2">
              <input
                type="number"
                min={0}
                value={String(c.timeout_value ?? "")}
                onChange={(e) => onSet({ timeout_value: e.target.value === "" ? 0 : Number(e.target.value) })}
                className={cn(inputCls, "w-24")}
                placeholder="0"
              />
              <select
                value={String(c.timeout_unit ?? "minutes")}
                onChange={(e) => onSet({ timeout_unit: e.target.value })}
                className={inputCls}
              >
                <option value="seconds">seconds</option>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </div>
          </Field>
          <div className="flex flex-wrap gap-1">
            {[
              { label: "30 sec", v: 30, u: "seconds" },
              { label: "5 min", v: 5, u: "minutes" },
              { label: "1 hour", v: 1, u: "hours" },
              { label: "1 day", v: 1, u: "days" },
              { label: "48 hours", v: 48, u: "hours" },
            ].map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => onSet({ timeout_value: p.v, timeout_unit: p.u })}
                className="rounded-full border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-secondary"
              >
                {p.label}
              </button>
            ))}
          </div>
          <ul className="space-y-1 border-t pt-2 text-[10px] text-muted-foreground">
            {CONDITION_VARS.map((v) => (
              <li key={v.name}>
                <span className="font-mono text-foreground">{v.name}</span> — {v.desc}
              </li>
            ))}
          </ul>
        </div>
      );
    case "webhook":
      return (
        <Field label="Webhook URL" hint="POST: contact_id, wa_id, vars">
          <input value={String(c.url ?? "")} onChange={(e) => onSet({ url: e.target.value })} className={inputCls} placeholder="https://your-server.com/hook" />
        </Field>
      );
    case "update_field_tag":
      return (
        <div className="space-y-3">
          <Field label="CRM stage">
            <input value={String(c.lsq_stage ?? "")} onChange={(e) => onSet({ lsq_stage: e.target.value })} className={inputCls} placeholder="(optional)" />
          </Field>
          <Field label="Status">
            <select value={String(c.status ?? "")} onChange={(e) => onSet({ status: e.target.value })} className={inputCls}>
              <option value="">No change</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </Field>
        </div>
      );
    case "assign_agent":
      return (
        <Field label="Agent email">
          <input value={String(c.agent_email ?? "")} onChange={(e) => onSet({ agent_email: e.target.value })} className={inputCls} placeholder="agent@americanhairline.com" />
        </Field>
      );
    default:
      return <p className="text-xs text-muted-foreground">No settings.</p>;
  }
}

const inputCls = "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary";

// WhatsApp-style preview of how a message node will look in the client's chat.
function NodePreview({ node_type, config }: { node_type: string; config: Record<string, unknown> }) {
  const MSG = ["message_text", "message_image", "message_image_buttons", "message_video", "message_buttons"];
  if (!MSG.includes(node_type)) return null;

  const caption = String(config.caption ?? config.text ?? "");
  const imgs =
    Array.isArray(config.media_urls) && (config.media_urls as unknown[]).length
      ? (config.media_urls as string[]).filter((u) => (u ?? "").trim())
      : config.media_url
        ? [String(config.media_url)]
        : [];
  const hasImages = (node_type === "message_image" || node_type === "message_image_buttons") && imgs.length > 0;
  const isVideo = node_type === "message_video" && !!String(config.media_url ?? "").trim();
  const buttons =
    (node_type === "message_buttons" || node_type === "message_image_buttons") && Array.isArray(config.buttons)
      ? (config.buttons as Array<{ label?: string; url?: string }>).filter((b) => (b.label ?? "").trim() || (b.url ?? "").trim())
      : [];

  return (
    <div className="mt-5">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Preview — chat me aise dikhega
      </div>
      <div className="rounded-xl bg-[#e6ddd4] p-3">
        <div className="max-w-[230px] overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-black/5">
          {hasImages ? (
            <div className="space-y-px">
              {imgs.slice(0, 4).map((u, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={u} alt="" className="block max-h-40 w-full object-cover" />
              ))}
            </div>
          ) : null}
          {isVideo ? (
            <div className="flex h-24 items-center justify-center bg-slate-200 text-[11px] font-medium text-slate-500">▶ Video</div>
          ) : null}
          {caption ? (
            <div className="whitespace-pre-wrap break-words px-2.5 py-1.5 text-[12px] leading-snug text-slate-800">
              {renderWaText(caption)}
            </div>
          ) : !hasImages && !isVideo ? (
            <div className="px-2.5 py-1.5 text-[11px] italic text-slate-400">Empty message</div>
          ) : null}
          {buttons.length > 0 ? (
            <div className="border-t border-slate-100">
              {buttons.map((b, i) => {
                const isLink = Boolean((b.url ?? "").trim());
                return (
                  <div
                    key={i}
                    className="flex items-center justify-center gap-1 border-t border-slate-100 px-2 py-2 text-[12px] font-medium text-[#027eb5] first:border-t-0"
                  >
                    <span className="text-[11px]">{isLink ? "↗" : "↩"}</span>
                    <span className="truncate">{b.label || (isLink ? "Open link" : `Button ${i + 1}`)}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
        {hasImages && imgs.length > 1 ? (
          <p className="mt-1.5 text-[9px] text-slate-600">{imgs.length} images — sequence me alag messages, buttons aakhri ke saath.</p>
        ) : null}
      </div>
    </div>
  );
}

// URL input + file upload for the Message+Image node. Uploads land in the
// public automation-trigger-images bucket and the returned public URL is
// stored as media_url (the same endpoint the AI-Intent image triggers use).
function ImageUrlField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/automation/trigger-image", { method: "POST", body: fd });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
      if (!res.ok || !json.ok || !json.url) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      onChange(json.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="preview" className="h-14 w-14 shrink-0 rounded border object-cover" />
        ) : (
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded border border-dashed text-[10px] text-muted-foreground">
            no image
          </div>
        )}
        <input value={value} onChange={(e) => onChange(e.target.value)} className={inputCls} placeholder="https://… or upload" />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2.5 text-[11px] font-medium hover:bg-secondary disabled:opacity-50"
        >
          {busy ? "Uploading…" : value ? "Replace" : "Upload"}
        </button>
        {value ? (
          <button type="button" onClick={() => onChange("")} disabled={busy} className="text-[11px] text-muted-foreground hover:text-destructive">
            Clear
          </button>
        ) : null}
        {error ? <span className="text-[10px] text-destructive">{error}</span> : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
        onChange={onFile}
        className="hidden"
      />
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</label>
      {children}
      {hint ? <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
