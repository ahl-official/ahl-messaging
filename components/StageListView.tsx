"use client";

// Centred list-view modal for a single LSQ pipeline stage. Opened from
// the LeadStageStrip's per-segment menu ("List view"). Lists every chat
// in that stage with name + last-activity time + assigned agent.
// Clicking a row opens that chat and minimises the modal — the panel
// visibly shrinks and flies toward the bottom-right pill (left of the
// notifications bell); tapping the pill restores it.

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Loader2, Minus, X, ListChecks } from "lucide-react";
import {
  contactDisplayName,
  contactInitials,
  type Contact,
} from "@/lib/types";
import { useMembers } from "@/components/MembersContext";
import { memberDisplayName } from "@/lib/team-types";
import { toneForStage } from "@/lib/chip-tones";
import { cn } from "@/lib/utils";

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
  });
}

export function StageListView({
  stage,
  minimized,
  onMinimize,
  onRestore,
  onClose,
  onSelectContact,
}: {
  stage: string;
  minimized: boolean;
  onMinimize: () => void;
  onRestore: () => void;
  onClose: () => void;
  onSelectContact: (c: Contact) => void;
}) {
  const members = useMembers();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Vector from the screen centre to the minimised pill, so the modal's
  // exit animation actually flies toward where it parks.
  const [corner, setCorner] = useState({ dx: 560, dy: 320 });
  useEffect(() => {
    const calc = () =>
      setCorner({
        dx: window.innerWidth / 2 - 132,
        dy: window.innerHeight / 2 - 36,
      });
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setContacts(null);
    setError(null);
    fetch(`/api/contacts?stage=${encodeURIComponent(stage)}`, {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((j: { contacts?: Contact[] }) => {
        if (!cancelled) setContacts(j.contacts ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load this stage.");
      });
    return () => {
      cancelled = true;
    };
  }, [stage]);

  const tone = toneForStage(stage);

  return (
    <>
      {/* Modal — backdrop + panel. The panel's exit shrinks + flies to
          the bottom-right pill so the operator sees where it went. */}
      <AnimatePresence>
        {!minimized ? (
          <div
            key="modal"
            className="fixed inset-0 z-[68] flex items-center justify-center p-4"
          >
            <motion.div
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-[1px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={onMinimize}
            />
            <motion.div
              className="relative z-10 flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl"
              initial={{ opacity: 0, scale: 0.9, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.06, x: corner.dx, y: corner.dy }}
              transition={{ type: "spring", stiffness: 360, damping: 32 }}
            >
              {/* Header */}
              <div className="flex items-center gap-2.5 border-b px-4 py-3">
                <span className={cn("h-2.5 w-2.5 rounded-full", tone.dot)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{stage}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {contacts === null
                      ? "Loading…"
                      : `${contacts.length} chat${
                          contacts.length === 1 ? "" : "s"
                        }`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onMinimize}
                  title="Minimize"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                >
                  <Minus className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  title="Close"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-rose-100 hover:text-rose-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Body */}
              <div className="min-h-0 flex-1 overflow-y-auto">
                {contacts === null ? (
                  <div className="flex items-center justify-center py-12 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </div>
                ) : error ? (
                  <div className="px-4 py-10 text-center text-[12px] text-destructive">
                    {error}
                  </div>
                ) : contacts.length === 0 ? (
                  <div className="px-4 py-10 text-center text-[12px] text-muted-foreground">
                    No chats in this stage.
                  </div>
                ) : (
                  contacts.map((c) => {
                    const m = c.assigned_to
                      ? members.byUserId.get(c.assigned_to)
                      : null;
                    const agent = m ? memberDisplayName(m) : "Unassigned";
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => onSelectContact(c)}
                        className="flex w-full items-center gap-3 border-b px-4 py-2.5 text-left transition hover:bg-secondary/60"
                      >
                        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-bold text-muted-foreground">
                          {contactInitials(c)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13px] font-semibold">
                              {contactDisplayName(c)}
                            </span>
                            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                              {timeAgo(c.last_message_at)}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <span
                              className={cn(
                                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1",
                                tone.bg,
                                tone.text,
                                tone.ring,
                              )}
                            >
                              {c.lsq_stage ?? stage}
                            </span>
                            <span className="truncate text-[11px] text-muted-foreground">
                              {agent}
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>

      {/* Minimised pill — parks to the left of the notifications bell. */}
      <AnimatePresence>
        {minimized ? (
          <motion.button
            key="pill"
            type="button"
            onClick={onRestore}
            initial={{ opacity: 0, scale: 0.3, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.3, y: 10 }}
            transition={{ type: "spring", stiffness: 420, damping: 26 }}
            className="fixed bottom-5 right-[4.5rem] z-[54] flex items-center gap-2 rounded-full border bg-card px-3.5 py-2.5 shadow-lg ring-1 ring-black/5 transition-colors hover:bg-secondary"
          >
            <ListChecks className="h-4 w-4 text-primary" />
            <span className="max-w-[150px] truncate text-[12px] font-semibold">
              {stage}
            </span>
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-primary">
              {contacts ? contacts.length : "…"}
            </span>
          </motion.button>
        ) : null}
      </AnimatePresence>
    </>
  );
}
