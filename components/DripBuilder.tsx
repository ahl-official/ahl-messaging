"use client";

// Drip-campaign builder — UI shell only. Lets an operator design a
// stage-triggered message sequence (trigger lead stage → ordered steps,
// each step a template / AI magic message / plain text fired after a
// gap from the previous step). The send engine is NOT wired yet, so the
// footer carries a clear "preview" banner and Save is inert.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  GitBranch,
  Info,
  Phone,
  Plus,
  Search,
  Send,
  Sparkles,
  Trash2,
  Type,
  Power,
  Users,
  Pencil,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FALLBACK_LEAD_STAGES } from "@/components/LeadStageStrip";

interface BusinessNumber {
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  nickname?: string | null;
  provider?: "meta" | "evolution" | null;
  portfolio?: { key: string; name: string } | null;
}

interface LsqField {
  schema: string;
  display_name: string;
  values: string[];
  priority?: boolean;
}

interface TemplateOpt {
  name: string;
  language: string;
  status: string;
}

type StepType = "template" | "magic" | "text";

interface DripStep {
  id: number;
  type: StepType;
  delayDays: number;
  delayHours: number;
  templateName: string;
  templateLanguage: string;
  magicPrompt: string;
  magicTone: string;
  text: string;
}

const STEP_META: Record<
  StepType,
  { label: string; sub: string; icon: React.ComponentType<{ className?: string }>; tone: string }
> = {
  template: {
    label: "Template",
    sub: "Approved WhatsApp template — delivers outside the 24h window.",
    icon: Send,
    tone: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  magic: {
    label: "Magic Message",
    sub: "AI writes a personalized message per contact.",
    icon: Sparkles,
    tone: "bg-violet-50 text-violet-700 ring-violet-200",
  },
  text: {
    label: "Plain text",
    sub: "Fixed text — only delivers inside the 24h window.",
    icon: Type,
    tone: "bg-sky-50 text-sky-700 ring-sky-200",
  },
};

function newStep(id: number, first: boolean): DripStep {
  return {
    id,
    type: "template",
    delayDays: first ? 0 : 1,
    delayHours: 0,
    templateName: "",
    templateLanguage: "en",
    magicPrompt: "Hi {{name}},\n",
    magicTone: "warm, conversational, professional",
    text: "",
  };
}

export function DripBuilder({ onClose, editId }: { onClose: () => void; editId?: string }) {
  const [name, setName] = useState("");
  const [bpid, setBpid] = useState("");
  const [numbers, setNumbers] = useState<BusinessNumber[]>([]);
  const [triggerStage, setTriggerStage] = useState("");
  // schema -> selected value ("" = any non-empty). Presence of a key = that
  // field's filter is ON.
  const [conditions, setConditions] = useState<Record<string, string>>({});
  const [lsqFields, setLsqFields] = useState<LsqField[]>([]);
  const [templates, setTemplates] = useState<TemplateOpt[]>([]);
  const [stages, setStages] = useState<readonly string[]>(FALLBACK_LEAD_STAGES);
  const [rateLimit, setRateLimit] = useState(30);
  const [quietStart, setQuietStart] = useState("");
  const [quietEnd, setQuietEnd] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const stepId = useRef(2);
  const [steps, setSteps] = useState<DripStep[]>([newStep(1, true)]);

  const filterFields = lsqFields.filter((f) => f.priority);
  function toggleCond(schema: string) {
    setConditions((prev) => {
      const next = { ...prev };
      if (schema in next) delete next[schema];
      else next[schema] = "";
      return next;
    });
  }

  const canSave =
    name.trim().length > 0 &&
    bpid.length > 0 &&
    triggerStage.length > 0 &&
    steps.every((s) => (s.type !== "template" ? true : s.templateName.trim().length > 0));

  async function save() {
    if (!canSave || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = {
        name: name.trim(),
        business_phone_number_id: bpid,
        trigger_stage: triggerStage,
        trigger_conditions: Object.entries(conditions).map(([field, value]) => ({
          field,
          value: value.trim() || null,
        })),
        rate_limit_per_minute: rateLimit,
        quiet_hours_start: quietStart || null,
        quiet_hours_end: quietEnd || null,
        steps: steps.map((s) => ({
          step_type: s.type,
          delay_minutes: s.delayDays * 1440 + s.delayHours * 60,
          template_name: s.templateName.trim() || null,
          template_language: s.templateLanguage.trim() || null,
          magic_prompt: s.magicPrompt || null,
          magic_tone: s.magicTone || null,
          text_body: s.text || null,
        })),
      };
      const res = await fetch(editId ? `/api/drips/${editId}` : "/api/drips", {
        method: editId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // Group numbers by portfolio (same buckets as the sidebar). Unassigned
  // numbers fall into an "Unassigned" group that sorts last.
  const groupedNumbers = useMemo(() => {
    const groups = new Map<string, { name: string; rows: BusinessNumber[] }>();
    for (const n of numbers) {
      const key = n.portfolio?.key ?? "__unassigned__";
      const name = n.portfolio?.name ?? "Unassigned";
      if (!groups.has(key)) groups.set(key, { name, rows: [] });
      groups.get(key)!.rows.push(n);
    }
    return Array.from(groups.values()).sort((a, b) => {
      if (a.name === "Unassigned") return 1;
      if (b.name === "Unassigned") return -1;
      return a.name.localeCompare(b.name);
    });
  }, [numbers]);

  useEffect(() => {
    fetch("/api/business-numbers", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { numbers?: BusinessNumber[] }) => {
        // Drip only sends approved templates / re-engagement messages —
        // Evolution (Baileys) numbers can't do that, so exclude them.
        const list = (j.numbers ?? []).filter((n) => (n.provider ?? "meta") !== "evolution");
        setNumbers(list);
        if (list[0] && !editId) setBpid(list[0].phone_number_id);
      })
      .catch(() => setNumbers([]));

    fetch("/api/lsq/stages", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { stages?: string[] }) => {
        if (Array.isArray(j.stages) && j.stages.length > 0) {
          setStages(j.stages);
          setTriggerStage((s) => s || j.stages![0]);
        }
      })
      .catch(() => {
        /* stay on fallback list */
      });

    fetch("/api/lsq/field-values", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { fields?: LsqField[] }) => {
        if (Array.isArray(j.fields)) setLsqFields(j.fields);
      })
      .catch(() => {
        /* free-text fallback in the value box */
      });
  }, []);

  // Approved templates for the chosen send-from number — re-fetch on change.
  useEffect(() => {
    if (!bpid) {
      setTemplates([]);
      return;
    }
    let alive = true;
    fetch(`/api/templates?phone_number_id=${encodeURIComponent(bpid)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { templates?: TemplateOpt[] }) => {
        if (alive) setTemplates(Array.isArray(j.templates) ? j.templates : []);
      })
      .catch(() => {
        if (alive) setTemplates([]);
      });
    return () => {
      alive = false;
    };
  }, [bpid]);

  // Edit mode — load the existing drip + steps and prefill the form.
  useEffect(() => {
    if (!editId) return;
    let alive = true;
    fetch(`/api/drips/${editId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then(
        (j: {
          drip?: {
            name: string;
            business_phone_number_id: string;
            trigger_stage: string;
            trigger_conditions: Array<{ field?: string; value?: string | null }> | null;
            rate_limit_per_minute: number;
            quiet_hours_start: string | null;
            quiet_hours_end: string | null;
          };
          steps?: Array<{
            step_type: StepType;
            delay_minutes: number;
            template_name: string | null;
            template_language: string | null;
            magic_prompt: string | null;
            magic_tone: string | null;
            text_body: string | null;
          }>;
        }) => {
          if (!alive || !j.drip) return;
          const d = j.drip;
          setName(d.name);
          setBpid(d.business_phone_number_id);
          setTriggerStage(d.trigger_stage);
          setRateLimit(d.rate_limit_per_minute ?? 30);
          setQuietStart(d.quiet_hours_start ?? "");
          setQuietEnd(d.quiet_hours_end ?? "");
          const conds: Record<string, string> = {};
          for (const c of d.trigger_conditions ?? []) {
            if (c.field) conds[c.field] = (c.value ?? "").toString();
          }
          setConditions(conds);
          const loaded = (j.steps ?? []).map((s, i) => ({
            id: i + 1,
            type: s.step_type,
            delayDays: Math.floor((s.delay_minutes ?? 0) / 1440),
            delayHours: Math.floor(((s.delay_minutes ?? 0) % 1440) / 60),
            templateName: s.template_name ?? "",
            templateLanguage: s.template_language ?? "en",
            magicPrompt: s.magic_prompt ?? "",
            magicTone: s.magic_tone ?? "",
            text: s.text_body ?? "",
          }));
          if (loaded.length > 0) {
            stepId.current = loaded.length + 1;
            setSteps(loaded);
          }
        },
      )
      .catch(() => {
        /* keep empty form */
      });
    return () => {
      alive = false;
    };
  }, [editId]);

  function addStep() {
    setSteps((prev) => [...prev, newStep(stepId.current++, false)]);
  }
  function removeStep(id: number) {
    setSteps((prev) => (prev.length === 1 ? prev : prev.filter((s) => s.id !== id)));
  }
  function patchStep(id: number, patch: Partial<DripStep>) {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }
  function moveStep(id: number, dir: -1 | 1) {
    setSteps((prev) => {
      const i = prev.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      {/* Hero */}
      <header className="relative overflow-hidden border-b bg-gradient-to-br from-violet-700 via-violet-800 to-slate-900 text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 right-1/4 h-72 w-72 rounded-full bg-violet-300/15 blur-3xl"
        />
        <div className="relative mx-auto max-w-2xl px-6 py-6">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white ring-1 ring-white/20 transition hover:bg-white/20"
              aria-label="Close"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <GitBranch className="h-5 w-5" />
                <h1 className="text-xl font-semibold tracking-tight">{editId ? "Edit drip campaign" : "New drip campaign"}</h1>
              </div>
              <p className="mt-0.5 text-xs text-white/80">
                Lead stage ke hisaab se ek message sequence — har step pichle ke kuch
                din/ghante baad auto-send hota hai.
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {/* Basics */}
          <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold">Basics</h2>

            <Field label="Drip name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Photo Awaited nurture"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
            </Field>

            <Field label="Send from">
              {numbers.length === 0 ? (
                <div className="rounded-md border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
                  No business numbers connected.
                </div>
              ) : (
                <NumberSelect groups={groupedNumbers} value={bpid} onChange={setBpid} />
              )}
            </Field>

            <Field
              label="Trigger lead stage"
              hint="Is stage me aane wala har contact enroll hoga; stage badle to sequence ruk jayegi."
            >
              <select
                value={triggerStage}
                onChange={(e) => setTriggerStage(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                {stages.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Trigger filters (optional)"
              hint="Field ON karo to uski value choose karo. Jitne ON honge sab match hone par hi lead enroll hogi (AND). Sab OFF = is stage ki sabhi leads."
            >
              <div className="space-y-2">
                {filterFields.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">CRM fields load ho rahe…</p>
                ) : (
                  filterFields.map((f) => {
                    const on = f.schema in conditions;
                    return (
                      <div key={f.schema} className="rounded-md border bg-background px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">{f.display_name}</span>
                          <button
                            type="button"
                            onClick={() => toggleCond(f.schema)}
                            className={cn(
                              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition",
                              on ? "bg-primary" : "bg-muted",
                            )}
                            aria-pressed={on}
                          >
                            <span
                              className={cn(
                                "inline-block h-4 w-4 transform rounded-full bg-white shadow transition",
                                on ? "translate-x-4" : "translate-x-0.5",
                              )}
                            />
                          </button>
                        </div>
                        {on ? (
                          <div className="mt-2">
                            {f.values.length > 0 ? (
                              <select
                                value={conditions[f.schema]}
                                onChange={(e) =>
                                  setConditions((p) => ({ ...p, [f.schema]: e.target.value }))
                                }
                                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                              >
                                <option value="">Any non-empty value</option>
                                {f.values.map((v) => (
                                  <option key={v} value={v}>
                                    {v}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                value={conditions[f.schema]}
                                onChange={(e) =>
                                  setConditions((p) => ({ ...p, [f.schema]: e.target.value }))
                                }
                                placeholder="e.g. QHT  (khaali = koi bhi value)"
                                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                              />
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Rate / min" hint="Safety throttle">
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={rateLimit}
                  onChange={(e) => setRateLimit(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </Field>
              <Field label="Quiet from (IST)">
                <input
                  type="time"
                  value={quietStart}
                  onChange={(e) => setQuietStart(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </Field>
              <Field label="Quiet to (IST)">
                <input
                  type="time"
                  value={quietEnd}
                  onChange={(e) => setQuietEnd(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </Field>
            </div>
          </section>

          {/* Steps */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                Sequence steps
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  ({steps.length})
                </span>
              </h2>
              <button
                type="button"
                onClick={addStep}
                className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs font-semibold text-foreground shadow-sm transition hover:border-primary/40 hover:bg-secondary"
              >
                <Plus className="h-3.5 w-3.5" />
                Add step
              </button>
            </div>

            <ol className="space-y-3">
              {steps.map((step, i) => (
                <StepCard
                  key={step.id}
                  step={step}
                  index={i}
                  isFirst={i === 0}
                  isLast={i === steps.length - 1}
                  canRemove={steps.length > 1}
                  templates={templates}
                  onPatch={(p) => patchStep(step.id, p)}
                  onRemove={() => removeStep(step.id)}
                  onMove={(d) => moveStep(step.id, d)}
                />
              ))}
            </ol>
          </section>
        </div>
      </div>

      {/* Footer — save */}
      <footer className="space-y-2 border-t bg-card px-6 py-3">
        <div className="mx-auto flex max-w-2xl items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-900">
          <Info className="h-3.5 w-3.5 shrink-0" />
          LSQ lead is stage (+ source) pe aate hi matching contact enroll hoga aur steps auto-send
          honge. Stage badle to sequence ruk jayegi.
        </div>
        {saveError ? (
          <div className="mx-auto max-w-2xl rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
            {saveError}
          </div>
        ) : null}
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave || saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <GitBranch className="h-3 w-3" />
            {saving ? "Saving…" : editId ? "Update drip" : "Save drip campaign"}
          </button>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NumberSelect — searchable, portfolio-grouped popover replacing the plain
// native <select>. Scoped to the drip builder; ~70 numbers make a search
// box worthwhile, and grouped headers mirror the sidebar.
// ---------------------------------------------------------------------------
function numLabel(n: BusinessNumber): string {
  return n.nickname || n.verified_name || n.display_phone_number || n.phone_number_id;
}

function NumberSelect({
  groups,
  value,
  onChange,
}: {
  groups: { name: string; rows: BusinessNumber[] }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => {
    for (const g of groups) for (const n of g.rows) if (n.phone_number_id === value) return n;
    return null;
  }, [groups, value]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return groups;
    return groups
      .map((g) => ({
        name: g.name,
        rows: g.rows.filter((n) =>
          [n.nickname, n.verified_name, n.display_phone_number, g.name]
            .filter(Boolean)
            .some((t) => (t as string).toLowerCase().includes(s)),
        ),
      }))
      .filter((g) => g.rows.length > 0);
  }, [groups, q]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md border bg-background px-3 py-2 text-left text-sm outline-none transition",
          open ? "border-primary ring-2 ring-primary/10" : "hover:border-foreground/20",
        )}
      >
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200">
          <Phone className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          {selected ? (
            <>
              <span className="block truncate font-medium">{numLabel(selected)}</span>
              {selected.display_phone_number ? (
                <span className="block truncate text-[11px] text-muted-foreground">
                  {selected.display_phone_number}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground">Select a number…</span>
          )}
        </span>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 text-muted-foreground transition", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div className="absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-xl border bg-popover shadow-xl ring-1 ring-black/5">
          {/* Search */}
          <div className="flex items-center gap-2 border-b bg-card px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name or number…"
              className="h-6 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/* Grouped list */}
          <div className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No numbers match &ldquo;{q}&rdquo;.
              </div>
            ) : (
              filtered.map((g) => (
                <div key={g.name}>
                  <div className="sticky top-0 bg-popover/95 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-foreground backdrop-blur">
                    {g.name}
                  </div>
                  {g.rows.map((n) => {
                    const active = n.phone_number_id === value;
                    return (
                      <button
                        key={n.phone_number_id}
                        type="button"
                        onClick={() => {
                          onChange(n.phone_number_id);
                          setOpen(false);
                          setQ("");
                        }}
                        className={cn(
                          "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition",
                          active ? "bg-emerald-50 text-emerald-900" : "hover:bg-secondary",
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{numLabel(n)}</span>
                          {n.display_phone_number ? (
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {n.display_phone_number}
                            </span>
                          ) : null}
                        </span>
                        {active ? <Check className="h-4 w-4 shrink-0 text-emerald-600" /> : null}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StepCard({
  step,
  index,
  isFirst,
  isLast,
  canRemove,
  templates,
  onPatch,
  onRemove,
  onMove,
}: {
  step: DripStep;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  canRemove: boolean;
  templates: TemplateOpt[];
  onPatch: (p: Partial<DripStep>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const meta = STEP_META[step.type];
  const Icon = meta.icon;
  return (
    <li className="rounded-xl border bg-card p-4 shadow-sm">
      {/* Head */}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-bold tabular-nums text-foreground/70",
          )}
        >
          {index + 1}
        </span>
        <span className={cn("inline-flex h-7 w-7 items-center justify-center rounded-md ring-1 ring-inset", meta.tone)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{meta.label}</div>
          <div className="truncate text-[10px] text-muted-foreground">
            <Clock className="mr-1 inline h-2.5 w-2.5" />
            {isFirst ? "Enrollment pe turant" : delayLabel(step.delayDays, step.delayHours)}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={isFirst}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-secondary disabled:opacity-30"
            aria-label="Move up"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={isLast}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-secondary disabled:opacity-30"
            aria-label="Move down"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={!canRemove}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-rose-600 transition hover:bg-rose-50 disabled:opacity-30"
            aria-label="Remove step"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-3 space-y-3 border-t pt-3">
        {/* Type picker */}
        <div className="flex flex-wrap gap-2">
          {(Object.keys(STEP_META) as StepType[]).map((t) => {
            const m = STEP_META[t];
            const TIcon = m.icon;
            const active = step.type === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => onPatch({ type: t })}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition",
                  active
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border text-muted-foreground hover:bg-secondary",
                )}
              >
                <TIcon className="h-3 w-3" />
                {m.label}
              </button>
            );
          })}
        </div>

        {/* Delay — first step is always "immediate" */}
        {!isFirst ? (
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Pichle step ke kitne baad
            </label>
            <div className="flex items-center gap-2">
              <NumberBox
                value={step.delayDays}
                onChange={(v) => onPatch({ delayDays: v })}
                suffix="din"
              />
              <NumberBox
                value={step.delayHours}
                max={23}
                onChange={(v) => onPatch({ delayHours: v })}
                suffix="ghante"
              />
            </div>
          </div>
        ) : null}

        {/* Content by type */}
        {step.type === "template" ? (
          templates.length > 0 ? (
            <Field label="Template" hint="Send-from number ke approved templates">
              <select
                value={step.templateName ? `${step.templateName}|||${step.templateLanguage}` : ""}
                onChange={(e) => {
                  const [name, lang] = e.target.value.split("|||");
                  onPatch({ templateName: name ?? "", templateLanguage: lang || "en" });
                }}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="">Select a template…</option>
                {templates.map((t) => {
                  const approved = t.status === "APPROVED";
                  return (
                    <option key={`${t.name}|${t.language}`} value={`${t.name}|||${t.language}`} disabled={!approved}>
                      {t.name} ({t.language}){approved ? "" : ` · ${t.status}`}
                    </option>
                  );
                })}
              </select>
            </Field>
          ) : (
            <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
              <Field label="Template name" hint="Send-from number choose karo to list aayegi; ya naam type karo">
                <input
                  value={step.templateName}
                  onChange={(e) => onPatch({ templateName: e.target.value })}
                  placeholder="e.g. photo_followup"
                  className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
                />
              </Field>
              <Field label="Language">
                <input
                  value={step.templateLanguage}
                  onChange={(e) => onPatch({ templateLanguage: e.target.value })}
                  placeholder="en"
                  className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
                />
              </Field>
            </div>
          )
        ) : step.type === "magic" ? (
          <div className="space-y-3">
            <Field label="AI brief" hint="{{name}} jaise variables use kar sakte ho">
              <textarea
                value={step.magicPrompt}
                onChange={(e) => onPatch({ magicPrompt: e.target.value })}
                rows={3}
                className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </Field>
            <Field label="Tone">
              <input
                value={step.magicTone}
                onChange={(e) => onPatch({ magicTone: e.target.value })}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </Field>
          </div>
        ) : (
          <Field label="Message text" hint="24h window ke andar hi reliably deliver hoga">
            <textarea
              value={step.text}
              onChange={(e) => onPatch({ text: e.target.value })}
              rows={3}
              placeholder="Type the message…"
              className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </Field>
        )}
      </div>
    </li>
  );
}

function NumberBox({
  value,
  onChange,
  suffix,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  suffix: string;
  max?: number;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border bg-background px-2">
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(e) => {
          let v = Number(e.target.value) || 0;
          if (v < 0) v = 0;
          if (max !== undefined && v > max) v = max;
          onChange(v);
        }}
        className="h-9 w-12 bg-transparent text-center text-sm outline-none"
      />
      <span className="pr-1 text-[11px] text-muted-foreground">{suffix}</span>
    </div>
  );
}

function delayLabel(days: number, hours: number): string {
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} din`);
  if (hours > 0) parts.push(`${hours} ghante`);
  if (parts.length === 0) return "Pichle step ke turant baad";
  return `${parts.join(" ")} baad`;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DRIPS LIST — manage saved drip campaigns (enable / disable / delete) + see
// enrollment counts. This is where a saved drip "shows up".
// ---------------------------------------------------------------------------
interface DripSummary {
  id: string;
  name: string;
  business_phone_number_id: string;
  trigger_stage: string;
  trigger_conditions: Array<{ field?: string; value?: string | null }> | null;
  enabled: boolean;
  step_count: number;
  runs: { active: number; completed: number; total: number };
  created_at: string;
}

export function DripsList({
  onBack,
  onNew,
  onEdit,
}: {
  onBack: () => void;
  onNew: () => void;
  onEdit: (id: string) => void;
}) {
  const [drips, setDrips] = useState<DripSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch("/api/drips", { cache: "no-store" });
      const j = (await r.json()) as { drips?: DripSummary[]; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setDrips(j.drips ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  async function toggle(d: DripSummary) {
    setBusy(d.id);
    try {
      await fetch(`/api/drips/${d.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !d.enabled }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  }
  async function remove(d: DripSummary) {
    if (!confirm(`Delete drip "${d.name}"? Iske runs bhi delete honge.`)) return;
    setBusy(d.id);
    try {
      await fetch(`/api/drips/${d.id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <header className="relative overflow-hidden border-b bg-gradient-to-br from-violet-700 via-violet-800 to-slate-900 text-white">
        <div className="relative mx-auto flex max-w-3xl items-center gap-3 px-6 py-6">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/20 transition hover:bg-white/20"
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <GitBranch className="h-5 w-5" />
              <h1 className="text-xl font-semibold tracking-tight">Drip campaigns</h1>
            </div>
            <p className="mt-0.5 text-xs text-white/80">
              LSQ lead stage (+ field) pe auto message sequences.
            </p>
          </div>
          <button
            type="button"
            onClick={onNew}
            className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-semibold text-violet-800 shadow-lg ring-1 ring-white/40 transition hover:shadow-xl"
          >
            <Plus className="h-3.5 w-3.5" />
            New drip
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl space-y-3 px-6 py-6">
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          {drips === null ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
          ) : drips.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed bg-card/50 px-6 py-12 text-center">
              <GitBranch className="mx-auto h-8 w-8 text-muted-foreground/40" />
              <p className="mt-2 text-sm font-medium">Koi drip campaign nahi hai.</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                &quot;New drip&quot; se ek banao — LSQ lead aate hi auto chal
                jaayega.
              </p>
            </div>
          ) : (
            drips.map((d) => {
              const conds = (d.trigger_conditions ?? []).filter((c) => c.field);
              return (
                <div key={d.id} className="rounded-xl border bg-card p-4 shadow-sm">
                  <div className="flex items-start gap-3">
                    <span
                      className={cn(
                        "mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset",
                        d.enabled
                          ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                          : "bg-slate-100 text-slate-400 ring-slate-200",
                      )}
                    >
                      <GitBranch className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-semibold">{d.name}</span>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset",
                            d.enabled
                              ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                              : "bg-slate-100 text-slate-500 ring-slate-200",
                          )}
                        >
                          {d.enabled ? "On" : "Off"}
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="rounded-md bg-violet-50 px-1.5 py-0.5 font-medium text-violet-700 ring-1 ring-inset ring-violet-200">
                          Stage: {d.trigger_stage}
                        </span>
                        {conds.map((c, i) => (
                          <span
                            key={i}
                            className="rounded-md bg-sky-50 px-1.5 py-0.5 font-medium text-sky-700 ring-1 ring-inset ring-sky-200"
                          >
                            {c.field} = {c.value || "any"}
                          </span>
                        ))}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                        <span>{d.step_count} step{d.step_count === 1 ? "" : "s"}</span>
                        <span className="inline-flex items-center gap-1">
                          <Users className="h-3 w-3" /> {d.runs.active} active · {d.runs.completed} done · {d.runs.total} total
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onEdit(d.id)}
                        disabled={busy === d.id}
                        title="Edit"
                        className="inline-flex items-center gap-1 rounded-md bg-violet-50 px-2.5 py-1.5 text-xs font-semibold text-violet-700 ring-1 ring-inset ring-violet-200 transition hover:bg-violet-100 disabled:opacity-50"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => toggle(d)}
                        disabled={busy === d.id}
                        title={d.enabled ? "Disable" : "Enable"}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold ring-1 ring-inset transition disabled:opacity-50",
                          d.enabled
                            ? "bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100"
                            : "bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100",
                        )}
                      >
                        <Power className="h-3.5 w-3.5" />
                        {d.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(d)}
                        disabled={busy === d.id}
                        title="Delete"
                        className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2.5 py-1.5 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-200 transition hover:bg-rose-100 disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
