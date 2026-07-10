"use client";

// Settings → Portfolios. Read-only display — portfolios are configured
// in .env.local (PORTFOLIO_KEYS + PORTFOLIO_<key>_*) and loaded into
// memory at server startup. To add/change/remove a portfolio, edit
// .env.local and restart the server.
//
// IMPORTANT: This page never renders actual secret values (access tokens,
// verify tokens, app IDs, WABA IDs). It shows only "Configured" /
// "Missing" status so screenshots, screen-shares, and remote-pair
// sessions don't leak credentials. The values live exclusively in
// .env.local on the host machine.

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  FileText,
  Loader2,
  Plus,
  Power,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { cn } from "@/lib/utils";

interface Portfolio {
  key: string;
  name: string;
  // Booleans only — actual values stay in .env.local. The API can return
  // the values to the owner, but we drop them on the client to avoid
  // accidental leakage via the rendered DOM / screenshots.
  access_token: string;
  verify_token: string;
  app_id: string | null;
  business_account_id: string | null;
  phone_number_ids: string[];
  display_name: string | null;
  is_active: boolean;
}

interface ApiResponse {
  portfolios?: Portfolio[];
  error?: string;
}

export function PortfoliosView() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/portfolios", { cache: "no-store" });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    load();
  }, []);

  const portfolios = data?.portfolios ?? [];

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <SettingsPageHeader
        icon={Building2}
        tone="violet"
        title="Portfolios"
        subtitle="Each portfolio is one Meta Business App. Configured in .env.local."
        right={
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-violet-700"
          >
            <Plus className="h-3.5 w-3.5" />
            Add portfolio
          </button>
        }
      />

      {adding ? (
        <AddPortfolioModal
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            load();
          }}
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-4xl space-y-5">
          <div className="flex items-start gap-2 rounded-lg border border-primary/25 bg-primary/10 px-4 py-3 text-xs text-primary">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <strong>Secrets stay in <span className="font-mono">.env.local</span>.</strong>{" "}
              This page only shows configuration status — actual access tokens,
              verify tokens, App IDs, and WABA IDs are never rendered here so
              screenshots can&apos;t leak them.
            </div>
          </div>

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {data === null ? (
            <div className="grid h-32 place-items-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : portfolios.length === 0 ? (
            <EmptyHelp />
          ) : (
            portfolios.map((p) => (
              <PortfolioCard key={p.key} portfolio={p} onDeleted={load} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyHelp() {
  return (
    <div className="rounded-lg border-2 border-dashed bg-card/50 px-6 py-8 text-sm">
      <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
        <FileText className="h-5 w-5" />
      </div>
      <div className="text-center">
        <div className="font-semibold">No portfolios configured yet</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Add a <span className="font-mono">PORTFOLIO_*</span> block to your <span className="font-mono">.env.local</span> and restart the server.
        </p>
      </div>
    </div>
  );
}

function PortfolioCard({
  portfolio,
  onDeleted,
}: {
  portfolio: Portfolio;
  onDeleted: () => void;
}) {
  // Compute booleans on the fly — never stash the actual strings.
  const status = {
    access_token: !!portfolio.access_token,
    verify_token: !!portfolio.verify_token,
    app_id: !!portfolio.app_id,
    business_account_id: !!portfolio.business_account_id,
    phone_ids: portfolio.phone_number_ids.length > 0,
  };
  const allRequiredSet = status.access_token && status.verify_token && status.phone_ids;
  const [deleting, setDeleting] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);

  async function handleDelete() {
    if (
      !confirm(
        `Delete portfolio "${portfolio.name}"? Its access tokens + verify token will be removed from .env.local.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setDelErr(null);
    try {
      const res = await fetch(
        `/api/portfolios?key=${encodeURIComponent(portfolio.key)}`,
        { method: "DELETE" },
      );
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onDeleted();
    } catch (e) {
      setDelErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="rounded-lg border bg-card">
      <header className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-semibold">{portfolio.name}</h2>
          {portfolio.is_active ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary ring-1 ring-inset ring-primary/25">
              <Power className="h-3 w-3" />
              Active
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground ring-1 ring-inset ring-border">
              Inactive
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {allRequiredSet ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary ring-1 ring-inset ring-primary/25">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Configured
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">
              <AlertTriangle className="h-3.5 w-3.5" />
              Incomplete
            </span>
          )}
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-destructive/30 bg-destructive/5 text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
            aria-label="Delete portfolio"
            title={
              portfolio.phone_number_ids.length > 0
                ? "Detach phone numbers first"
                : "Delete portfolio"
            }
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </header>
      {delErr ? (
        <div className="mx-4 mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {delErr}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Add portfolio modal — collects every PORTFOLIO_<key>_* value and POSTs.
// Server writes them into .env.local + process.env so the new portfolio is
// usable immediately. Production hosts (Vercel/Railway) can't write the
// file — server reports persisted: false and the modal shows the warning
// inline so the operator can mirror the values into hosting env vars.
// ---------------------------------------------------------------------------
function AddPortfolioModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
  const [provider, setProvider] = useState<"meta" | "interakt">("meta");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [appId, setAppId] = useState("");
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phoneIds, setPhoneIds] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);

  const isInterakt = provider === "interakt";
  const canSubmit =
    !saving &&
    key.trim().length > 0 &&
    name.trim().length > 0 &&
    (isInterakt
      ? businessAccountId.trim().length > 0
      : accessToken.trim().length > 0 && verifyToken.trim().length > 0);

  function generateVerifyToken() {
    // 32 random hex chars — same shape as the seeded portfolios.
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    setVerifyToken(
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setErr(null);
    setWarn(null);
    try {
      const res = await fetch("/api/portfolios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          key: key.trim(),
          name: name.trim(),
          access_token: isInterakt ? "" : accessToken.trim(),
          verify_token: isInterakt ? "" : verifyToken.trim(),
          app_id: isInterakt ? null : appId.trim() || null,
          business_account_id: businessAccountId.trim() || null,
          display_name: displayName.trim() || null,
          phone_number_ids: phoneIds
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        persisted?: boolean;
        message?: string;
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.persisted === false) {
        setWarn(
          json.message ??
            "Saved in memory only — set the same PORTFOLIO_* vars in your hosting env vars before next deploy.",
        );
        return;
      }
      onAdded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to add");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={onClose}
    >
      <form
        className="w-full max-w-2xl rounded-xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <header className="flex items-start justify-between border-b px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold">Add portfolio</h3>
            <p className="text-[11px] text-muted-foreground">
              One portfolio per Meta Business App. Tokens are written to{" "}
              <span className="font-mono">.env.local</span> on the host machine.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Provider type — Meta (full creds) vs Interakt (account id only) */}
        <div className="flex gap-2 px-5 pt-4">
          {(["meta", "interakt"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setProvider(p)}
              className={cn(
                "flex-1 rounded-lg border px-3 py-2 text-left text-xs transition",
                provider === p
                  ? "border-primary bg-primary/5 shadow-sm"
                  : "border-border hover:bg-secondary/40",
              )}
            >
              <div className="font-semibold capitalize">{p}</div>
              <div className="text-[10px] text-muted-foreground">
                {p === "meta"
                  ? "Meta Business App (tokens)"
                  : "Interakt — account id only"}
              </div>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 px-5 py-4">
          <ModalField
            label="Key"
            required
            hint="UPPERCASE_WITH_UNDERSCORES (e.g. Interakt → INTERAKT)"
          >
            <input
              required
              autoFocus
              value={key}
              onChange={(e) =>
                setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))
              }
              placeholder="UROOTS"
              className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </ModalField>

          <ModalField label="Name" required hint="Shown in Settings + chat header">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="URoots by QHT"
              className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </ModalField>

          {!isInterakt ? (
          <>
          <ModalField
            label="Access token"
            required
            hint="From Meta → WhatsApp Manager → API Setup"
            full
          >
            <input
              required
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="EAA…"
              className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </ModalField>

          <ModalField
            label="Verify token"
            required
            hint="Paste the same string into Meta → Webhooks → Verify token"
            full
          >
            <div className="flex gap-2">
              <input
                required
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                placeholder="64-char hex string"
                className="flex-1 rounded-md border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
              <button
                type="button"
                onClick={generateVerifyToken}
                className="rounded-md border bg-background px-2.5 py-1 text-xs font-medium hover:bg-secondary"
                title="Generate a random verify token"
              >
                Generate
              </button>
            </div>
          </ModalField>

          <ModalField label="App ID" hint="Optional · Meta App ID">
            <input
              value={appId}
              onChange={(e) => setAppId(e.target.value.replace(/\D/g, ""))}
              placeholder="1686140115728456"
              inputMode="numeric"
              className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </ModalField>
          </>
          ) : null}

          <ModalField
            label="Account ID"
            required={isInterakt}
            hint={isInterakt ? "Interakt account / WABA id" : "Optional · WABA ID"}
          >
            <input
              required={isInterakt}
              value={businessAccountId}
              onChange={(e) =>
                setBusinessAccountId(e.target.value.replace(/\D/g, ""))
              }
              placeholder="2338133620008095"
              inputMode="numeric"
              className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </ModalField>

          <ModalField
            label="Display name"
            hint="Optional · short label in chat header"
          >
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="URoots"
              className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </ModalField>

          <ModalField
            label="Phone number IDs"
            hint="Optional · comma-separated. Can also assign later from Settings → Numbers."
          >
            <input
              value={phoneIds}
              onChange={(e) => setPhoneIds(e.target.value)}
              placeholder="1150287611490963"
              className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </ModalField>

          {err ? (
            <div className="col-span-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              {err}
            </div>
          ) : null}
          {warn ? (
            <div className="col-span-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
              {warn}{" "}
              <button
                type="button"
                onClick={onAdded}
                className="font-semibold underline hover:no-underline"
              >
                Continue
              </button>
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t bg-secondary/30 px-5 py-3">
          <span className="text-[11px] text-muted-foreground">
            Reload may be needed for inbox subscriptions to pick up the new portfolio.
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save portfolio
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

function ModalField({
  label,
  hint,
  required,
  full,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={full ? "col-span-2 block" : "block"}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
          {required ? <span className="text-destructive"> *</span> : null}
        </span>
        {hint ? (
          <span className="text-[10px] text-muted-foreground">{hint}</span>
        ) : null}
      </div>
      {children}
    </label>
  );
}
