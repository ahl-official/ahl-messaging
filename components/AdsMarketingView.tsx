"use client";

// Settings -> Ads / Marketing. Per-number Meta Marketing (ads_read)
// token used to resolve a Click-to-WhatsApp lead's source_id into
// campaign / ad set / ad NAMES (shown in the contact details panel).
//
// The token is set per number (grouped by portfolio for readability).
// Resolution at read time: number -> env META_ADS_TOKEN.
//
// Token values are write-only from the UI — the API returns only a
// "set" / "missing" status, never the secret.

import { useEffect, useState } from "react";
import {
  Building2,
  CheckCircle2,
  Loader2,
  Radio,
  Save,
  Trash2,
  XCircle,
} from "lucide-react";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";

interface NumberAds {
  phone_number_id: string;
  number: string;
  label: string;
  token_set: boolean;
  ad_account_id: string | null;
}

interface PortfolioAds {
  key: string;
  name: string;
  display_name: string | null;
  numbers: NumberAds[];
}

export function AdsMarketingView() {
  const [portfolios, setPortfolios] = useState<PortfolioAds[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/settings/ads-tokens", { cache: "no-store" });
      const json = (await res.json()) as { portfolios?: PortfolioAds[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setPortfolios(json.portfolios ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <SettingsPageHeader
        icon={Radio}
        tone="sky"
        title="Ads / Marketing"
        subtitle="Har number ka apna Meta Marketing (ads_read) token. Isse us number par aayi CTWA lead ka campaign / ad set / ad name resolve hota hai aur contact panel me dikhta hai."
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-4 px-6 py-6">
          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-900">
            Token ko Meta me <strong>ads_read</strong> permission us number ke ad
            account par chahiye. System User token recommend (expire nahi hota).
            Token yahan save hota hai — browser ko kabhi wapas nahi bheja jaata.
          </div>

          {portfolios === null ? (
            <div className="grid h-32 place-items-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : portfolios.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed bg-card/50 px-6 py-10 text-center text-sm text-muted-foreground">
              Koi Meta portfolio nahi mila. Settings → Portfolios me add karo.
            </div>
          ) : (
            <div className="space-y-5">
              {portfolios.map((p) => (
                <div key={p.key}>
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-semibold text-muted-foreground">
                      {p.name}
                    </span>
                    <span className="text-[11px] text-muted-foreground/70">
                      · {p.numbers.length} number{p.numbers.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {p.numbers.length === 0 ? (
                    <div className="rounded-xl border border-dashed bg-card/50 px-4 py-4 text-xs text-muted-foreground">
                      Is portfolio me koi number nahi.
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {p.numbers.map((n) => (
                        <NumberCard key={n.phone_number_id} num={n} onSaved={load} />
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NumberCard({ num, onSaved }: { num: NumberAds; onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [acct, setAcct] = useState(num.ad_account_id ?? "");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(body: { ads_token?: string; ad_account_id?: string }) {
    setSaving(true);
    setErr(null);
    setDone(false);
    try {
      const res = await fetch("/api/settings/ads-tokens", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number_id: num.phone_number_id, ...body }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setToken("");
      setDone(true);
      setTimeout(() => setDone(false), 2000);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="rounded-xl border bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{num.label}</div>
          <div className="font-mono text-[11px] text-muted-foreground">{num.number}</div>
        </div>
        {num.token_set ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary ring-1 ring-inset ring-primary/25">
            <CheckCircle2 className="h-3.5 w-3.5" /> Token set
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
            <XCircle className="h-3.5 w-3.5" /> No token
          </span>
        )}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
            ads_read token
          </span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={num.token_set ? "•••• set — blank = keep" : "Paste token"}
            className="w-full rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-400/40"
            autoComplete="off"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
            Ad account id <span className="font-normal">(optional, act_…)</span>
          </span>
          <input
            type="text"
            value={acct}
            onChange={(e) => setAcct(e.target.value)}
            placeholder="act_1234567890"
            className="w-full rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-400/40"
            autoComplete="off"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() =>
            run({
              ...(token.trim() ? { ads_token: token.trim() } : {}),
              ad_account_id: acct.trim(),
            })
          }
          className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-sky-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </button>
        {num.token_set ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              if (confirm(`Remove ads token for "${num.label}"?`)) run({ ads_token: "" });
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove
          </button>
        ) : null}
        {done ? <span className="text-xs font-medium text-primary">Saved</span> : null}
        {err ? <span className="text-xs text-destructive">{err}</span> : null}
      </div>
    </li>
  );
}
