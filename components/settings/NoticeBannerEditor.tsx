"use client";

// Settings → Notice editor. Loads the singleton row from
// /api/system-settings, lets the operator toggle visibility, pick a
// tone (info / success / warning / danger), and edit the banner copy.
// Save round-trips back to the API and reloads the page so the
// TopBar's live banner picks up the change immediately.

import { useEffect, useState } from "react";
import { Loader2, Megaphone } from "lucide-react";

type Tone = "info" | "success" | "warning" | "danger";

interface Settings {
  notice_banner_text: string | null;
  notice_banner_enabled: boolean;
  notice_banner_tone: Tone;
}

const TONE_PREVIEW: Record<Tone, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-800",
  success: "border-primary/25 bg-primary/10 text-primary",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-rose-200 bg-rose-50 text-rose-800",
};

const TONE_LABELS: Record<Tone, string> = {
  info: "Info",
  success: "Success",
  warning: "Warning",
  danger: "Critical",
};

export function NoticeBannerEditor() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [tone, setTone] = useState<Tone>("info");
  const [text, setText] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/system-settings", { cache: "no-store" });
        const json = (await res.json()) as Settings;
        if (cancelled) return;
        setEnabled(!!json.notice_banner_enabled);
        setTone(json.notice_banner_tone ?? "info");
        setText(json.notice_banner_text ?? "");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/system-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notice_banner_enabled: enabled,
          notice_banner_tone: tone,
          notice_banner_text: text,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  const trimmed = text.trim();

  return (
    <div className="space-y-5">
      {/* Live preview pill — exact same render path as the TopBar
          banner, so what you see here is what the team sees. */}
      <div className="rounded-xl border bg-card p-4">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Preview
        </div>
        {enabled && trimmed ? (
          <div
            className={
              "flex h-9 max-w-2xl items-center gap-2 truncate rounded-full border px-3 text-[13px] font-medium " +
              TONE_PREVIEW[tone]
            }
          >
            <Megaphone className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{trimmed}</span>
          </div>
        ) : (
          <div className="rounded-md border border-dashed bg-secondary/40 px-3 py-2 text-[12px] italic text-muted-foreground">
            Banner is hidden — toggle on and add some text to preview.
          </div>
        )}
      </div>

      {/* Toggle + tone */}
      <div className="rounded-xl border bg-card p-4 space-y-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
          />
          <div>
            <div className="text-sm font-medium">Show notice banner</div>
            <div className="text-xs text-muted-foreground">
              When off, the banner is hidden everywhere — text and tone are
              preserved so you can flip it back on without retyping.
            </div>
          </div>
        </label>

        <div>
          <div className="mb-2 text-xs font-medium">Tone</div>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(TONE_LABELS) as Tone[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTone(t)}
                className={
                  "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition " +
                  (tone === t
                    ? TONE_PREVIEW[t] + " ring-2 ring-offset-1 " + (
                        t === "info" ? "ring-sky-400" :
                        t === "success" ? "ring-primary/40" :
                        t === "warning" ? "ring-amber-400" :
                        "ring-rose-400"
                      )
                    : "border-border bg-background text-muted-foreground hover:bg-secondary")
                }
              >
                {TONE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium">Message</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="e.g. Maintenance window tonight 9–10 PM. Don't assign new leads."
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>Visible to every team member.</span>
            <span>{text.length}/500</span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        {error ? (
          <span className="mr-auto text-xs text-destructive">{error}</span>
        ) : null}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-brand-600 disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save changes
        </button>
      </div>
    </div>
  );
}
