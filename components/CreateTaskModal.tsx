"use client";

// Slim "assign task" modal. Used from:
//   - Tasks panel header                  (no contact pre-fill)
//   - Chat header → "Assign task" button  (contact + number pre-filled)
//
// Three primary fields the operator actually fills (description,
// priority, assignee). Everything else — contact, business number,
// creator — is auto-fetched from context. Title is auto-derived from
// the first line of the description so the operator never has to think
// "what should I call this?".

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Calendar,
  ClipboardCheck,
  Flag,
  Loader2,
  MessageSquare,
  Phone,
  Send,
  Sparkles,
  User,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Priority = "low" | "normal" | "high" | "urgent";

const PRIORITY_META: Record<
  Priority,
  { label: string; chip: string; ring: string; dot: string }
> = {
  low: {
    label: "Low",
    chip: "bg-slate-50 text-slate-700",
    ring: "ring-slate-200",
    dot: "bg-slate-400",
  },
  normal: {
    label: "Normal",
    chip: "bg-sky-50 text-sky-700",
    ring: "ring-sky-200",
    dot: "bg-sky-500",
  },
  high: {
    label: "High",
    chip: "bg-amber-50 text-amber-700",
    ring: "ring-amber-200",
    dot: "bg-amber-500",
  },
  urgent: {
    label: "Urgent",
    chip: "bg-rose-50 text-rose-700",
    ring: "ring-rose-200",
    dot: "bg-rose-500",
  },
};
const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];

interface MemberLite {
  id: string;
  full_name: string | null;
  email: string;
}
interface BusinessNumber {
  phone_number_id: string;
  display_phone_number: string | null;
  nickname: string | null;
  verified_name: string | null;
}

export function CreateTaskModal({
  onClose,
  onCreated,
  defaultContactId,
  defaultBusinessPhoneNumberId,
  contactLabel,
}: {
  onClose: () => void;
  onCreated: () => void;
  defaultContactId?: string | null;
  defaultBusinessPhoneNumberId?: string | null;
  contactLabel?: string | null;
}) {
  const [description, setDescription] = useState("");
  const [assignedTo, setAssignedTo] = useState<string>("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [dueAt, setDueAt] = useState<string>("");
  const [showDue, setShowDue] = useState(false);
  const [members, setMembers] = useState<MemberLite[]>([]);
  const [numberLabelText, setNumberLabelText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const contactLocked = Boolean(defaultContactId);

  useEffect(() => {
    void (async () => {
      try {
        const tasks: Array<Promise<unknown>> = [
          fetch("/api/team", { cache: "no-store" }).then((r) => r.json()),
        ];
        if (defaultBusinessPhoneNumberId) {
          tasks.push(
            fetch("/api/business-numbers", { cache: "no-store" }).then((r) =>
              r.json(),
            ),
          );
        }
        const [mJson, nJson] = (await Promise.all(tasks)) as [
          { members?: Array<MemberLite & { is_active: boolean | null }> },
          { numbers?: BusinessNumber[] } | undefined,
        ];
        setMembers(
          (mJson.members ?? [])
            .filter((m) => m.is_active !== false)
            .map((m) => ({ id: m.id, full_name: m.full_name, email: m.email })),
        );
        if (nJson?.numbers && defaultBusinessPhoneNumberId) {
          const match = nJson.numbers.find(
            (n) => n.phone_number_id === defaultBusinessPhoneNumberId,
          );
          if (match) setNumberLabelText(numberLabel(match));
        }
      } catch {
        /* user can still submit with manual fields */
      }
    })();
  }, [defaultBusinessPhoneNumberId]);

  async function submit() {
    if (busy) return;
    const desc = description.trim();
    if (!desc) return setErr("Likh do kya karna hai");
    if (!assignedTo) return setErr("Kisko assign karna hai?");

    // Auto-derive a short title from the description's first line so the
    // operator never has to think of one. Keeps the assigned-member's
    // task list scannable — title in row card, full text in detail view.
    const firstLine = desc.split(/\r?\n/)[0]!.trim();
    const title = firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine;
    const fullText = desc;

    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: fullText !== title ? fullText : null,
          assigned_to: assignedTo,
          priority,
          due_at: dueAt ? new Date(dueAt).toISOString() : null,
          contact_id: defaultContactId || null,
          business_phone_number_id: defaultBusinessPhoneNumberId || null,
        }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl bg-card shadow-2xl ring-1 ring-border animate-in fade-in-0 zoom-in-95">
        {/* Premium gradient header */}
        <div className="relative overflow-hidden bg-gradient-to-br from-primary via-[#6098FF] to-[#1e56c7] px-5 py-4 text-white">
          <span
            aria-hidden
            className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-white/15 blur-2xl"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute -left-8 -bottom-12 h-32 w-32 rounded-full bg-sky-300/20 blur-2xl"
          />
          <div className="relative flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15 ring-1 ring-inset ring-white/25 backdrop-blur">
                <ClipboardCheck className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h3 className="text-base font-bold tracking-tight">
                  Assign a task
                </h3>
                <p className="mt-0.5 text-[11px] text-white/80">
                  {contactLocked
                    ? "Linked to this chat — agent will see a deep link in their queue."
                    : "Free-form work item — picked up by the chosen agent."}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/10 text-white transition hover:bg-white/20"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Auto-fetched context chips */}
          {contactLocked ? (
            <div className="relative mt-3 flex flex-wrap items-center gap-1.5">
              {contactLabel ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold backdrop-blur ring-1 ring-inset ring-white/20">
                  <MessageSquare className="h-3 w-3" />
                  {contactLabel}
                </span>
              ) : null}
              {numberLabelText ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold backdrop-blur ring-1 ring-inset ring-white/20">
                  <Phone className="h-3 w-3" />
                  {numberLabelText}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Body */}
        <div className="space-y-3.5 px-5 py-4">
          <div>
            <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              <Sparkles className="h-3 w-3 text-primary" />
              What to do
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              autoFocus
              rows={3}
              placeholder={
                contactLocked
                  ? "e.g. Call back tomorrow morning, share package details on WhatsApp"
                  : "Describe the task — what, why, when"
              }
              className="mt-1.5 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed outline-none transition placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>

          {/* Priority chip row */}
          <div>
            <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              <Flag className="h-3 w-3 text-primary" />
              Priority
            </label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {PRIORITIES.map((p) => {
                const meta = PRIORITY_META[p];
                const active = priority === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset transition",
                      active
                        ? "bg-gradient-to-br from-primary to-[#1e56c7] text-white shadow-sm shadow-primary/20 ring-primary"
                        : cn(meta.chip, meta.ring, "hover:scale-[1.02]"),
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        active ? "bg-white" : meta.dot,
                      )}
                    />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Assignee */}
          <div>
            <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              <Users className="h-3 w-3 text-primary" />
              Assign to
            </label>
            <div className="relative mt-1.5">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
                {assignedTo ? (
                  <Avatar
                    name={
                      members.find((m) => m.id === assignedTo)?.full_name ??
                      members.find((m) => m.id === assignedTo)?.email ??
                      ""
                    }
                  />
                ) : (
                  <User className="h-4 w-4 text-muted-foreground" />
                )}
              </span>
              <select
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
                className="h-10 w-full appearance-none rounded-lg border border-input bg-background pl-10 pr-3 text-sm font-medium outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
              >
                <option value="">Pick a team member…</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {memberLabel(m)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Due — collapsed by default */}
          {showDue || dueAt ? (
            <div>
              <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                <Calendar className="h-3 w-3 text-primary" />
                Due
              </label>
              <input
                type="datetime-local"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowDue(true)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <Calendar className="h-3 w-3" />
              Add due date
            </button>
          )}

          {err ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-700">
              {err}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t bg-gradient-to-b from-secondary/30 to-secondary/50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-input bg-background px-3.5 py-1.5 text-xs font-semibold text-foreground transition hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !description.trim() || !assignedTo}
            className={cn(
              "group inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-bold text-white shadow-md transition-all disabled:opacity-40",
              "bg-gradient-to-br from-[#6098FF] via-primary to-[#1e56c7]",
              "hover:shadow-lg hover:shadow-primary/30 hover:brightness-105",
              "disabled:cursor-not-allowed disabled:shadow-none",
            )}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
            )}
            Assign
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------- helpers ---------- //

function memberLabel(m: MemberLite) {
  const n = m.full_name?.trim();
  if (n) return n;
  return m.email.split("@")[0] ?? m.email;
}

function numberLabel(n: BusinessNumber) {
  return (
    n.nickname?.trim() ||
    n.verified_name?.trim() ||
    n.display_phone_number ||
    n.phone_number_id
  );
}

function Avatar({ name }: { name: string }) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "?";
  return (
    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-[#6098FF] to-[#6098FF] text-[9px] font-bold text-white ring-2 ring-card">
      {initials}
    </span>
  );
}
