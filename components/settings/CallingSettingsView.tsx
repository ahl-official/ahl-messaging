"use client";

import { useEffect, useState } from "react";
import { PhoneCall, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { memberDisplayName } from "@/lib/team-types";

interface AgentRow {
  id: string;
  email: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  role: string;
  ozonetel_agent_id: string | null;
  ozonetel_phone: string | null;
  tatatele_agent_number: string | null;
}

interface OzonetelForm {
  base_url: string;
  user_name: string;
  api_key: string;
  campaign_name: string;
}
interface TataForm {
  base_url: string;
  api_token: string;
  caller_id: string;
}

const OZO_EMPTY: OzonetelForm = {
  base_url: "https://in1-ccaas-api.ozonetel.com",
  user_name: "",
  api_key: "",
  campaign_name: "",
};
const TATA_EMPTY: TataForm = {
  base_url: "https://api-smartflo.tatateleservices.com",
  api_token: "",
  caller_id: "",
};

export function CallingSettingsView() {
  const [loading, setLoading] = useState(true);
  const [ozo, setOzo] = useState<OzonetelForm>(OZO_EMPTY);
  const [ozoEnv, setOzoEnv] = useState(false);
  const [tata, setTata] = useState<TataForm>(TATA_EMPTY);
  const [tataEnv, setTataEnv] = useState(false);
  const [agents, setAgents] = useState<AgentRow[]>([]);

  useEffect(() => {
    void fetch("/api/settings/calling", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j?.ozonetel) {
          setOzo({
            base_url: j.ozonetel.base_url ?? OZO_EMPTY.base_url,
            user_name: j.ozonetel.user_name ?? "",
            api_key: j.ozonetel.api_key ?? "",
            campaign_name: j.ozonetel.campaign_name ?? "",
          });
          setOzoEnv(!!j.ozonetel.is_env_fallback);
        }
        if (j?.tatatele) {
          setTata({
            base_url: j.tatatele.base_url ?? TATA_EMPTY.base_url,
            api_token: j.tatatele.api_token ?? "",
            caller_id: j.tatatele.caller_id ?? "",
          });
          setTataEnv(!!j.tatatele.is_env_fallback);
        }
        setAgents((j?.agents ?? []) as AgentRow[]);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <header className="flex items-start gap-3">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <PhoneCall className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-lg font-semibold">Calling providers</h2>
          <p className="text-sm text-muted-foreground">
            Wire the dialers behind the inbox <strong>Call</strong> button. Each
            click rings the operator&apos;s agent first, then bridges the
            contact.
          </p>
        </div>
      </header>

      {/* Tata Tele */}
      <ProviderCard
        title="Tata Tele (Smartflo)"
        isEnv={tataEnv}
        provider="tatatele"
        getBody={() => ({ provider: "tatatele", ...tata })}
        onSaved={() => setTataEnv(false)}
        fields={
          <>
            <Field label="API base URL">
              <Input
                value={tata.base_url}
                onChange={(e) => setTata({ ...tata, base_url: e.target.value })}
              />
            </Field>
            <Field label="Caller ID (DID / pilot number)">
              <Input
                value={tata.caller_id}
                onChange={(e) => setTata({ ...tata, caller_id: e.target.value })}
                placeholder="9180694XXXXX"
              />
            </Field>
            <Field label="API token">
              <Input
                type="password"
                value={tata.api_token}
                onChange={(e) => setTata({ ...tata, api_token: e.target.value })}
                placeholder="Smartflo portal token"
              />
            </Field>
          </>
        }
      />

      {/* Ozonetel */}
      <ProviderCard
        title="Ozonetel (CloudAgent)"
        isEnv={ozoEnv}
        provider="ozonetel"
        getBody={() => ({ provider: "ozonetel", ...ozo })}
        onSaved={() => setOzoEnv(false)}
        fields={
          <>
            <Field label="API base URL">
              <Input
                value={ozo.base_url}
                onChange={(e) => setOzo({ ...ozo, base_url: e.target.value })}
              />
            </Field>
            <Field label="Campaign name">
              <Input
                value={ozo.campaign_name}
                onChange={(e) => setOzo({ ...ozo, campaign_name: e.target.value })}
                placeholder="OutboundSales"
              />
            </Field>
            <Field label="Account username">
              <Input
                value={ozo.user_name}
                onChange={(e) => setOzo({ ...ozo, user_name: e.target.value })}
              />
            </Field>
            <Field label="API key">
              <Input
                type="password"
                value={ozo.api_key}
                onChange={(e) => setOzo({ ...ozo, api_key: e.target.value })}
                placeholder="••••••••"
              />
            </Field>
          </>
        }
      />

      {/* Per-agent bindings */}
      <section className="rounded-xl border bg-card p-5">
        <h3 className="text-sm font-semibold">Agent mapping</h3>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Per operator: Tata Tele agent number, plus Ozonetel agentID + landing
          phone. A provider stays blocked for anyone missing its agent value.
        </p>
        <div className="mt-4 divide-y">
          {agents.map((a) => (
            <AgentBinding key={a.id} agent={a} />
          ))}
          {agents.length === 0 ? (
            <p className="py-4 text-xs text-muted-foreground">No active members.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function ProviderCard({
  title,
  isEnv,
  fields,
  getBody,
  onSaved,
}: {
  title: string;
  isEnv: boolean;
  provider: string;
  fields: React.ReactNode;
  getBody: () => Record<string, string>;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/calling", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(getBody()),
      });
      const j = await res.json().catch(() => ({}));
      setMsg(res.ok ? "Saved." : j.error ?? `HTTP ${res.status}`);
      if (res.ok) onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border bg-card p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {isEnv ? (
        <p className="mt-1 text-[11px] text-amber-700">
          Using values from .env.local. Saving here moves them into the database.
        </p>
      ) : null}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{fields}</div>
      <div className="mt-4 flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          Save
        </Button>
        {msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function AgentBinding({ agent }: { agent: AgentRow }) {
  const [tataNum, setTataNum] = useState(agent.tatatele_agent_number ?? "");
  const [ozoId, setOzoId] = useState(agent.ozonetel_agent_id ?? "");
  const [ozoPhone, setOzoPhone] = useState(agent.ozonetel_phone ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const name = memberDisplayName(agent) || agent.email;

  const dirty =
    tataNum !== (agent.tatatele_agent_number ?? "") ||
    ozoId !== (agent.ozonetel_agent_id ?? "") ||
    ozoPhone !== (agent.ozonetel_phone ?? "");

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/calling", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          member_id: agent.id,
          tatatele_agent_number: tataNum,
          ozonetel_agent_id: ozoId,
          ozonetel_phone: ozoPhone,
        }),
      });
      if (res.ok) {
        agent.tatatele_agent_number = tataNum || null;
        agent.ozonetel_agent_id = ozoId || null;
        agent.ozonetel_phone = ozoPhone || null;
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {agent.email} · {agent.role}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={save} disabled={!dirty || saving}>
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : saved ? (
            <Check className="h-3.5 w-3.5 text-primary" />
          ) : (
            "Save"
          )}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <LabeledInput label="Tata agent #" value={tataNum} onChange={setTataNum} w="w-36" />
        <LabeledInput label="Ozo agentID" value={ozoId} onChange={setOzoId} w="w-32" />
        <LabeledInput label="Ozo phone" value={ozoPhone} onChange={setOzoPhone} w="w-36" />
      </div>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  w,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  w: string;
}) {
  return (
    <div>
      <span className="mb-0.5 block text-[9px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`h-9 ${w}`}
      />
    </div>
  );
}
