"use client";

// Settings → Payments.
// Per-clinic (American Hairline, Alchemane) multi-account: each clinic gets its own
// collapsible card containing Razorpay + PayU subsections + an
// auto-receipt toggle. Operators can label accounts, flip the active
// account independently per clinic, and switch clinics from the
// composer's clinic chooser.

import { useCallback, useEffect, useState } from "react";
import {
  Building2,
  Check,
  ChevronDown,
  Copy,
  IndianRupee,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

type ProviderId = "razorpay" | "payu";
type Clinic = "americanhairline" | "alchemane";

const CLINIC_CONFIG: Array<{
  key: Clinic;
  label: string;
  tagline: string;
  comingSoon?: boolean;
}> = [
  {
    key: "americanhairline",
    label: "American Hairline",
    tagline: "American Hairline · primary",
  },
  {
    key: "alchemane",
    label: "Alchemane",
    tagline: "Alchemane · add accounts to start minting",
  },
];

interface AccountRow {
  id: string;
  clinic: Clinic;
  provider: ProviderId;
  label: string;
  is_active: boolean;
  is_env_fallback: boolean;
  has_webhook_secret: boolean;
  env: "live" | "test" | null;
  created_by: string | null;
  created_at: string;
}

interface Payload {
  accounts: AccountRow[];
  auto_receipt: Record<Clinic, boolean>;
  webhook_base_url: string;
}

interface AddingTarget {
  clinic: Clinic;
  provider: ProviderId;
}

export function PaymentsSettingsView() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [adding, setAdding] = useState<AddingTarget | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<Clinic, boolean>>({
    americanhairline: true,
    alchemane: false,
  });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/payments", { cache: "no-store" });
      const j = (await res.json()) as Payload & { error?: string };
      if (!res.ok) {
        setErr(j.error ?? `HTTP ${res.status}`);
        return;
      }
      setPayload(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function call(method: string, url: string, body?: unknown) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) {
        setErr(j.error ?? `HTTP ${res.status}`);
        return false;
      }
      await load();
      return true;
    } finally {
      setBusy(false);
    }
  }

  function flash(msg: string) {
    setSavedFlash(msg);
    setTimeout(() => setSavedFlash(null), 1500);
  }

  function copyWebhook(account: AccountRow) {
    const base = payload?.webhook_base_url || window.location.origin;
    const url = account.is_env_fallback
      ? `${base}/api/payments/webhook/${account.provider}`
      : `${base}/api/payments/webhook/${account.provider}?account=${account.id}`;
    void navigator.clipboard.writeText(url);
    setCopiedKey(account.id);
    setTimeout(() => setCopiedKey(null), 1500);
  }

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <div className="min-h-0 flex-1 overflow-auto p-6 lg:p-8">
        <div className="mx-auto max-w-3xl space-y-6">
          <header>
            <h1 className="text-lg font-semibold tracking-tight">Payments</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Each clinic keeps its own Razorpay + PayU accounts and auto-receipt
              behaviour. Switch clinics from the composer&apos;s ₹ icon when
              sending a payment link.
            </p>
          </header>
          {err ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {err}
            </div>
          ) : null}

          {CLINIC_CONFIG.map((c) => {
            const clinicAccounts =
              payload?.accounts.filter((a) => a.clinic === c.key) ?? [];
            return (
              <ClinicCard
                key={c.key}
                clinicKey={c.key}
                label={c.label}
                tagline={c.tagline}
                expanded={expanded[c.key]}
                onToggle={() =>
                  setExpanded((e) => ({ ...e, [c.key]: !e[c.key] }))
                }
                accounts={clinicAccounts}
                autoReceipt={payload?.auto_receipt[c.key] === true}
                busy={busy}
                payloadReady={!!payload}
                copiedKey={copiedKey}
                onAdd={(provider) => setAdding({ clinic: c.key, provider })}
                onActivate={(id) =>
                  call(
                    "POST",
                    `/api/settings/payment-accounts/${encodeURIComponent(id)}/activate`,
                  ).then((ok) => ok && flash(`${c.label} active account changed.`))
                }
                onDelete={(id) => {
                  if (confirm("Delete this account? Past payments stay linked.")) {
                    void call(
                      "DELETE",
                      `/api/settings/payment-accounts/${encodeURIComponent(id)}`,
                    );
                  }
                }}
                onCopyWebhook={copyWebhook}
                onToggleAutoReceipt={(v) =>
                  call("PUT", "/api/settings/payments", {
                    [`auto_receipt_${c.key}`]: v,
                  }).then((ok) =>
                    ok &&
                    flash(`${c.label} auto-send ${v ? "on" : "off"}.`),
                  )
                }
              />
            );
          })}

          {savedFlash ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <Check className="mr-1 inline h-3.5 w-3.5" /> {savedFlash}
            </div>
          ) : null}
        </div>
      </div>

      {adding ? (
        <AddAccountDialog
          clinic={adding.clinic}
          clinicLabel={
            CLINIC_CONFIG.find((c) => c.key === adding.clinic)?.label ??
            adding.clinic.toUpperCase()
          }
          provider={adding.provider}
          onClose={() => setAdding(null)}
          onCreated={() => {
            setAdding(null);
            void load();
            flash("Account added.");
          }}
        />
      ) : null}
    </div>
  );
}

function ClinicCard({
  clinicKey,
  label,
  tagline,
  expanded,
  onToggle,
  accounts,
  autoReceipt,
  busy,
  payloadReady,
  copiedKey,
  onAdd,
  onActivate,
  onDelete,
  onCopyWebhook,
  onToggleAutoReceipt,
}: {
  clinicKey: Clinic;
  label: string;
  tagline: string;
  expanded: boolean;
  onToggle: () => void;
  accounts: AccountRow[];
  autoReceipt: boolean;
  busy: boolean;
  payloadReady: boolean;
  copiedKey: string | null;
  onAdd: (provider: ProviderId) => void;
  onActivate: (id: string) => void;
  onDelete: (id: string) => void;
  onCopyWebhook: (a: AccountRow) => void;
  onToggleAutoReceipt: (v: boolean) => void;
}) {
  const razorpayAccounts = accounts.filter((a) => a.provider === "razorpay");
  const payuAccounts = accounts.filter((a) => a.provider === "payu");
  const activeCount = accounts.filter((a) => a.is_active).length;

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 border-b px-5 py-4 text-left transition hover:bg-accent/30"
      >
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm ring-1 ring-inset",
              clinicKey === "americanhairline"
                ? "from-emerald-500 to-teal-600 ring-emerald-200/60"
                : "from-violet-500 to-fuchsia-600 ring-violet-200/60",
            )}
          >
            <Building2 className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-bold">{label}</h2>
            <p className="text-[11px] text-muted-foreground">
              {accounts.length === 0
                ? tagline
                : `${accounts.length} account${accounts.length === 1 ? "" : "s"} · ${activeCount === 1 ? "1 active" : `${activeCount} active`}`}
            </p>
          </div>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            expanded ? "rotate-180" : "rotate-0",
          )}
        />
      </button>

      {expanded ? (
        <div className="space-y-4 px-5 py-4">
          <ProviderSubsection
            title="Razorpay"
            tint="sky"
            accounts={razorpayAccounts}
            busy={busy}
            copiedKey={copiedKey}
            onAdd={() => onAdd("razorpay")}
            onActivate={onActivate}
            onDelete={onDelete}
            onCopyWebhook={onCopyWebhook}
          />
          <ProviderSubsection
            title="PayU"
            tint="emerald"
            accounts={payuAccounts}
            busy={busy}
            copiedKey={copiedKey}
            onAdd={() => onAdd("payu")}
            onActivate={onActivate}
            onDelete={onDelete}
            onCopyWebhook={onCopyWebhook}
          />

          <div className="rounded-lg border bg-secondary/30 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">Auto-send receipt</div>
                <div className="text-[11px] text-muted-foreground">
                  When this clinic&apos;s gateway webhook reports a successful
                  payment, the PDF receipt fires automatically.
                </div>
              </div>
              <Toggle
                checked={autoReceipt}
                disabled={busy || !payloadReady}
                onChange={onToggleAutoReceipt}
              />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ProviderSubsection({
  title,
  tint,
  accounts,
  busy,
  copiedKey,
  onAdd,
  onActivate,
  onDelete,
  onCopyWebhook,
}: {
  title: string;
  tint: "sky" | "emerald";
  accounts: AccountRow[];
  busy: boolean;
  copiedKey: string | null;
  onAdd: () => void;
  onActivate: (id: string) => void;
  onDelete: (id: string) => void;
  onCopyWebhook: (a: AccountRow) => void;
}) {
  const tintClasses =
    tint === "sky"
      ? "from-sky-500 to-indigo-600 ring-sky-200/60"
      : "from-emerald-500 to-teal-600 ring-emerald-200/60";
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <header className="flex items-center justify-between border-b bg-secondary/20 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br text-white shadow-sm ring-1 ring-inset",
              tintClasses,
            )}
          >
            <IndianRupee className="h-3 w-3" />
          </span>
          <div>
            <h3 className="text-xs font-bold">{title}</h3>
            <p className="text-[10.5px] text-muted-foreground">
              {accounts.length === 0
                ? "No accounts yet."
                : `${accounts.length} account${accounts.length === 1 ? "" : "s"}.`}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[10.5px] font-semibold hover:bg-accent"
        >
          <Plus className="h-3 w-3" /> Add account
        </button>
      </header>
      <ul className="divide-y">
        {accounts.length === 0 ? (
          <li className="px-4 py-4 text-center text-[11px] text-muted-foreground">
            Click &ldquo;Add account&rdquo; to connect a {title} account.
          </li>
        ) : (
          accounts.map((a) => (
            <AccountRowItem
              key={a.id}
              account={a}
              busy={busy}
              copied={copiedKey === a.id}
              onActivate={() => onActivate(a.id)}
              onDelete={() => onDelete(a.id)}
              onCopyWebhook={() => onCopyWebhook(a)}
            />
          ))
        )}
      </ul>
    </div>
  );
}

function AccountRowItem({
  account,
  busy,
  copied,
  onActivate,
  onDelete,
  onCopyWebhook,
}: {
  account: AccountRow;
  busy: boolean;
  copied: boolean;
  onActivate: () => void;
  onDelete: () => void;
  onCopyWebhook: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {account.label}
          </span>
          {account.is_active ? (
            <span className="rounded-full bg-emerald-600 px-2 py-0 text-[9.5px] font-bold uppercase tracking-wider text-white">
              Active
            </span>
          ) : null}
          {account.is_env_fallback ? (
            <span className="rounded-full bg-secondary px-2 py-0 text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground">
              From .env.local
            </span>
          ) : null}
          {account.env ? (
            <span className="rounded-full bg-amber-100 px-2 py-0 text-[9.5px] font-bold uppercase tracking-wider text-amber-800">
              {account.env}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {account.provider === "razorpay" ? (
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="h-3 w-3 text-emerald-600" /> Keys stored
              {!account.has_webhook_secret ? (
                <span className="ml-1 text-amber-700">
                  · webhook secret missing
                </span>
              ) : null}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="h-3 w-3 text-emerald-600" /> Keys stored
            </span>
          )}
          {account.created_by ? (
            <span className="ml-1">· added by {account.created_by}</span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onCopyWebhook}
          className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px] font-semibold hover:bg-accent"
          title="Copy webhook URL for this account"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-600" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> Webhook
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onActivate}
          disabled={busy || account.is_active}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition",
            account.is_active
              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
              : "bg-background hover:bg-accent",
            (busy || account.is_active) && "opacity-60",
          )}
        >
          {account.is_active ? "Active" : "Set active"}
        </button>
        {!account.is_env_fallback ? (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy || account.is_active}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
            title="Delete account"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        ) : null}
      </div>
    </li>
  );
}

function AddAccountDialog({
  clinic,
  clinicLabel,
  provider,
  onClose,
  onCreated,
}: {
  clinic: Clinic;
  clinicLabel: string;
  provider: ProviderId;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [label, setLabel] = useState("");
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [merchantKey, setMerchantKey] = useState("");
  const [merchantSalt, setMerchantSalt] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [merchantId, setMerchantId] = useState("");
  const [env, setEnv] = useState<"live" | "test">("live");
  const [setActive, setSetActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!label.trim()) {
      setErr("Label required");
      return;
    }
    setBusy(true);
    try {
      const credentials =
        provider === "razorpay"
          ? {
              key_id: keyId.trim(),
              key_secret: keySecret.trim(),
              webhook_secret: webhookSecret.trim() || undefined,
            }
          : {
              client_id: clientId.trim(),
              client_secret: clientSecret.trim(),
              merchant_id: merchantId.trim(),
              merchant_key: merchantKey.trim() || undefined,
              merchant_salt: merchantSalt.trim() || undefined,
              env,
            };
      const res = await fetch("/api/settings/payment-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clinic,
          provider,
          label: label.trim(),
          credentials,
          set_active: setActive,
        }),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) {
        setErr(j.error ?? `HTTP ${res.status}`);
        return;
      }
      onCreated();
    } finally {
      setBusy(false);
    }
  }

  const isRzp = provider === "razorpay";
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="relative w-full max-w-[480px] overflow-hidden rounded-2xl bg-card shadow-2xl ring-1 ring-border animate-in fade-in-0 zoom-in-95"
      >
        <div className="flex items-center justify-between border-b bg-gradient-to-r from-emerald-50 via-white to-teal-50 px-5 py-3.5">
          <div>
            <h3 className="text-[15px] font-bold leading-tight">
              Add {isRzp ? "Razorpay" : "PayU"} account · {clinicLabel}
            </h3>
            <p className="text-[11px] text-muted-foreground">
              Stored credentials live in Supabase. Owner-only access.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <Field label="Label">
            <input
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={
                isRzp
                  ? `${clinicLabel} Razorpay (live)`
                  : `${clinicLabel} PayU (live)`
              }
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40"
            />
          </Field>

          {isRzp ? (
            <>
              <Field label="Key ID">
                <input
                  value={keyId}
                  onChange={(e) => setKeyId(e.target.value)}
                  placeholder="rzp_live_xxxxxxxxxxxx"
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40"
                />
              </Field>
              <Field label="Key Secret">
                <input
                  type="password"
                  value={keySecret}
                  onChange={(e) => setKeySecret(e.target.value)}
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40"
                />
              </Field>
              <Field label="Webhook secret" optional>
                <input
                  type="password"
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40"
                />
              </Field>
            </>
          ) : (
            <>
              <div className="rounded-lg border border-sky-200 bg-sky-50/60 px-3 py-2 text-[11px] text-sky-900">
                Modern PayU API uses OAuth. Get <strong>Client ID</strong>,
                <strong> Client Secret</strong> and <strong>Merchant ID</strong>
                {" "}from PayU Dashboard → Settings → API credentials.
              </div>
              <Field label="Client ID">
                <input
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40"
                />
              </Field>
              <Field label="Client Secret">
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40"
                />
              </Field>
              <Field label="Merchant ID">
                <input
                  value={merchantId}
                  onChange={(e) => setMerchantId(e.target.value)}
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40"
                />
              </Field>
              <Field label="Merchant Key" optional>
                <input
                  value={merchantKey}
                  onChange={(e) => setMerchantKey(e.target.value)}
                  placeholder="(only needed for webhook verification)"
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40"
                />
              </Field>
              <Field label="Merchant Salt" optional>
                <input
                  type="password"
                  value={merchantSalt}
                  onChange={(e) => setMerchantSalt(e.target.value)}
                  placeholder="(only needed for webhook verification)"
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40"
                />
              </Field>
              <Field label="Environment">
                <div className="flex gap-2">
                  {(["live", "test"] as const).map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setEnv(opt)}
                      className={cn(
                        "rounded-md border px-3 py-1.5 text-xs font-semibold capitalize transition",
                        env === opt
                          ? "border-emerald-400 bg-emerald-50 text-emerald-800"
                          : "bg-background hover:bg-accent",
                      )}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </Field>
            </>
          )}

          <label className="mt-2 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={setActive}
              onChange={(e) => setSetActive(e.target.checked)}
            />
            Set as active account for {clinicLabel}
          </label>

          {err ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11.5px] text-rose-700">
              {err}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t bg-secondary/30 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3.5 py-2 text-xs font-semibold text-muted-foreground hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-600 px-4 py-2 text-xs font-bold text-white shadow-md hover:shadow-lg disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Add account
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold">
        {label}
        {optional ? (
          <span className="ml-1 text-[10px] font-medium text-muted-foreground">
            (optional)
          </span>
        ) : null}
      </label>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 rounded-full transition",
        checked ? "bg-emerald-600" : "bg-slate-300",
        disabled && "opacity-50",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-all",
          checked ? "left-[1.4rem]" : "left-0.5",
        )}
      />
    </button>
  );
}
