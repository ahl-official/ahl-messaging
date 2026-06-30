"use client";

import { useState } from "react";
import { Loader2, ShieldCheck, User as UserIcon } from "lucide-react";
import { ROLE_LABEL, type TeamMember } from "@/lib/team-types";
import { cn } from "@/lib/utils";

interface Props {
  initial: TeamMember;
}

interface ApiResponse {
  profile?: TeamMember;
  error?: string;
}

export function ProfileForm({ initial }: Props) {
  const [first, setFirst] = useState(initial.first_name ?? "");
  const [last, setLast] = useState(initial.last_name ?? "");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmedFirst = first.trim();
  const trimmedLast = last.trim();
  const isComplete = !!(initial.first_name?.trim() && initial.last_name?.trim());
  const dirty =
    trimmedFirst !== (initial.first_name?.trim() ?? "") ||
    trimmedLast !== (initial.last_name?.trim() ?? "");
  const canSave = !!trimmedFirst && !!trimmedLast && dirty && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ first_name: trimmedFirst, last_name: trimmedLast }),
      });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSavedAt(Date.now());
      // Refresh the initial values via window reload — simplest way to keep
      // the "dirty" flag honest after a successful save.
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <div className="flex items-center gap-3 border-b bg-card px-6 py-4">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg border bg-background">
          <UserIcon className="h-5 w-5 text-muted-foreground" />
        </span>
        <div>
          <h1 className="text-lg font-semibold leading-tight">Profile</h1>
          <p className="text-xs text-muted-foreground">
            How you appear to your team and on outgoing Magic Messages.
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-2xl space-y-4">
          {!isComplete ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200/70 text-amber-900 text-[11px] font-bold">
                !
              </span>
              <div>
                <div className="font-semibold">Complete your profile to send Magic Messages</div>
                <div className="text-amber-800">
                  Magic Messages credit the sender on the card footer. Add your
                  first and last name below — sends are blocked until both are
                  set.
                </div>
              </div>
            </div>
          ) : null}

          <div className="rounded-lg border bg-card p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  First name <span className="text-rose-600">*</span>
                </label>
                <input
                  type="text"
                  value={first}
                  onChange={(e) => setFirst(e.target.value)}
                  placeholder="Khushnaseeb"
                  maxLength={60}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  disabled={saving}
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Last name <span className="text-rose-600">*</span>
                </label>
                <input
                  type="text"
                  value={last}
                  onChange={(e) => setLast(e.target.value)}
                  placeholder="Khan"
                  maxLength={60}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  disabled={saving}
                />
              </div>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Email
                </label>
                <input
                  type="email"
                  value={initial.email}
                  readOnly
                  className="w-full rounded-md border bg-secondary/40 px-3 py-2 text-sm text-muted-foreground"
                />
                <div className="mt-1 text-[10px] text-muted-foreground">
                  Tied to your sign-in. Changing this needs an admin.
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Role
                </label>
                <div className="inline-flex items-center gap-1.5 rounded-md border bg-secondary/40 px-3 py-2 text-sm">
                  <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{ROLE_LABEL[initial.role]}</span>
                </div>
              </div>
            </div>

            {error ? (
              <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}

            <div className="mt-5 flex items-center justify-end gap-2 border-t pt-4">
              {savedAt && !saving ? (
                <span className="mr-auto text-xs text-emerald-700">
                  ✓ Saved
                </span>
              ) : null}
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm",
                  "hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                {saving ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save"
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
