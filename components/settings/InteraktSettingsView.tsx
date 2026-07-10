"use client";

// Settings → Interakt. Owner-only. Manage one or more Interakt numbers —
// each Interakt account gets its own API key + webhook URL/secret. Inbound
// events are matched to a number by the secret in the webhook URL (Interakt's
// payload only carries the customer number). Parallel to Meta — nothing here
// touches the Meta/Evolution routing.

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Copy,
  Info,
  Loader2,
  Phone,
  Plus,
  RefreshCw,
  Trash2,
  Webhook,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface InteraktNum {
  phone_number_id: string;
  waba: string;
  nickname: string | null;
  has_api_key: boolean;
  api_key_masked: string | null;
  webhook_secret: string | null;
  webhook_url: string | null;
  forward_urls: string[];
}

export function InteraktSettingsView() {
  const [numbers, setNumbers] = useState<InteraktNum[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Add form
  const [waba, setWaba] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/interakt", { cache: "no-store" });
      const j = (await res.json()) as { numbers?: InteraktNum[]; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setNumbers(j.numbers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addNumber() {
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/interakt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waba: waba.trim(), api_key: apiKey.trim() }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Failed");
      setWaba("");
      setApiKey("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-6 py-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Webhook className="h-5 w-5 text-primary" />
          Interakt numbers
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Har Interakt account ka apna API key + webhook URL. Niche jo URL bane,
          woh Interakt ke &ldquo;Configure Webhook URL&rdquo; me daalo (same secret).
          Events automatically us number ke neeche inbox me aayenge.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {/* Add number */}
      <section className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Plus className="h-4 w-4 text-primary" /> Add Interakt number
        </h2>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <input
            value={waba}
            onChange={(e) => setWaba(e.target.value)}
            inputMode="numeric"
            placeholder="WhatsApp number e.g. 919045454046"
            className="rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
          />
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Interakt API key"
            className="rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
          />
          <button
            type="button"
            onClick={addNumber}
            disabled={adding || waba.replace(/\D/g, "").length < 6}
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          API key: Interakt dashboard → Developer Settings → API key. Number country
          code ke saath (e.g. 91…).
        </p>
      </section>

      {/* List */}
      {numbers === null ? (
        <div className="grid h-24 place-items-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : numbers.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed bg-card/50 px-6 py-10 text-center text-sm text-muted-foreground">
          Abhi koi Interakt number nahi. Upar se add karo.
        </div>
      ) : (
        <div className="space-y-4">
          {numbers.map((n) => (
            <NumberCard key={n.phone_number_id} number={n} onChanged={load} onError={setError} />
          ))}
        </div>
      )}
    </div>
  );
}

function NumberCard({
  number,
  onChanged,
  onError,
}: {
  number: InteraktNum;
  onChanged: () => Promise<void>;
  onError: (e: string) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [forwardUrls, setForwardUrls] = useState<string[]>(
    number.forward_urls.length > 0 ? number.forward_urls : [""],
  );
  const [busy, setBusy] = useState<"key" | "secret" | "forward" | "delete" | null>(null);

  async function patch(payload: Record<string, unknown>, which: "key" | "secret" | "forward") {
    setBusy(which);
    try {
      const res = await fetch("/api/settings/interakt", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number_id: number.phone_number_id, ...payload }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Failed");
      setApiKey("");
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!confirm(`Remove Interakt number ${number.waba}?`)) return;
    setBusy("delete");
    try {
      const res = await fetch(
        `/api/settings/interakt?phone_number_id=${encodeURIComponent(number.phone_number_id)}`,
        { method: "DELETE" },
      );
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Failed");
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-inset ring-primary/25">
          <Phone className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{number.nickname || number.waba}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{number.waba}</div>
        </div>
        <button
          type="button"
          onClick={remove}
          disabled={busy === "delete"}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
          aria-label="Remove"
        >
          {busy === "delete" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      </div>

      <CopyField label="Webhook URL" value={number.webhook_url ?? ""} />
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <CopyField label="Secret key" value={number.webhook_secret ?? ""} mono />
        </div>
        <button
          type="button"
          onClick={() => patch({ regenerate_secret: true }, "secret")}
          disabled={busy === "secret"}
          className="inline-flex h-[38px] items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-semibold text-foreground transition hover:bg-secondary disabled:opacity-50"
          title="Naya secret (purana URL band ho jayega)"
        >
          {busy === "secret" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          API key
        </label>
        {number.has_api_key ? (
          <div className="mb-1.5 flex items-center gap-2 text-xs">
            <Check className="h-3.5 w-3.5 text-primary" />
            <code className="rounded bg-secondary px-1.5 py-0.5 font-mono">{number.api_key_masked}</code>
          </div>
        ) : (
          <div className="mb-1.5 flex items-start gap-1.5 text-[11px] text-amber-700">
            <Info className="mt-0.5 h-3 w-3 shrink-0" /> Reply bhejne ke liye API key chahiye.
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={number.has_api_key ? "Naya key se replace karo…" : "Interakt API key"}
            className="flex-1 rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
          />
          <button
            type="button"
            onClick={() => patch({ api_key: apiKey.trim() }, "key")}
            disabled={busy === "key" || apiKey.trim().length === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {busy === "key" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>

      {/* Forward events to other webhooks (n8n / external backends). */}
      <div className="border-t pt-3">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Forward events to (optional)
          </label>
          <button
            type="button"
            onClick={() => setForwardUrls((prev) => [...prev, ""])}
            className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-[11px] font-semibold text-foreground transition hover:bg-secondary"
          >
            <Plus className="h-3 w-3" /> Add webhook
          </button>
        </div>
        <div className="space-y-2">
          {forwardUrls.map((url, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={url}
                onChange={(e) =>
                  setForwardUrls((prev) => prev.map((u, j) => (j === i ? e.target.value : u)))
                }
                placeholder="https://your-server.com/webhook"
                className="flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={() =>
                  setForwardUrls((prev) => {
                    const next = prev.filter((_, j) => j !== i);
                    return next.length > 0 ? next : [""];
                  })
                }
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-rose-600 transition hover:bg-rose-50"
                aria-label="Remove webhook"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-[10px] text-muted-foreground">
            Har event hu-ba-hu in sab URLs pe POST hoga (raw JSON). Sab khali = forwarding off.
          </p>
          <button
            type="button"
            onClick={() =>
              patch(
                { forward_urls: forwardUrls.map((u) => u.trim()).filter(Boolean) },
                "forward",
              )
            }
            disabled={busy === "forward"}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {busy === "forward" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save webhooks
          </button>
        </div>
      </div>
    </section>
  );
}

function CopyField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  }
  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className={cn(
            "flex-1 rounded-md border bg-secondary/40 px-3 py-2 text-sm outline-none",
            mono && "font-mono",
          )}
        />
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-white transition hover:bg-primary/90"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
