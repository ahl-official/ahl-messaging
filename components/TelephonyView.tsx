"use client";

import { useEffect, useState } from "react";
import { Cable, Copy, Check, Plus, Trash2, Upload, Save, Eye, EyeOff } from "lucide-react";
import { PremiumHeader } from "@/components/PremiumHeader";

// Universal Telephony connector — modelled on CRM's Tata-Smartflo
// connector. Each OPERATOR exposes a set of API hooks. INBOUND hooks
// (Call Route, Agent Popup, Call Log, Disposition, SSO) are OUR endpoints the
// operator configures — their URLs embed the connector key (from env, never
// hardcoded). OUTBOUND (Click-2-Call) is the operator's own API that we call.

const OPERATORS = [
  "Tata Smartflo",
  "My Operator",
  "Akom Technologies",
  "Ozonetel",
  "MCube",
  "Exotel",
  "Knowlarity",
  "Custom",
] as const;

const SECTIONS = [
  { key: "virtual", label: "Virtual Numbers" },
  { key: "call_route", label: "Call Route API" },
  { key: "agent_popup", label: "Agent Popup API" },
  { key: "call_log", label: "Call Log API" },
  { key: "click2call", label: "Click 2 Call" },
  { key: "disposition", label: "Call Disposition" },
  { key: "sso", label: "Single Sign-on API" },
  { key: "team", label: "Team Assignment" },
  { key: "ua_map", label: "User-Agent Mapping" },
] as const;

function slug(op: string) {
  return op.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// ---- small shared UI bits -------------------------------------------------

function CopyUrl({ url, id, copied, onCopy }: { url: string; id: string; copied: string | null; onCopy: (u: string, id: string) => void }) {
  return (
    <div className="flex items-start gap-2">
      <code className="min-w-0 flex-1 break-all rounded-md border bg-secondary/30 px-3 py-2 font-mono text-[11px] leading-relaxed">{url}</code>
      <button type="button" onClick={() => onCopy(url, id)} className="shrink-0 rounded-md border px-2 py-2 text-muted-foreground transition hover:bg-secondary hover:text-foreground" title="Copy URL">
        {copied === id ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function Endpoint({ name, url, method, id, copied, onCopy, note }: { name: string; url: string; method?: string; id: string; copied: string | null; onCopy: (u: string, id: string) => void; note?: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{name}</span>
        {method ? <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary ring-1 ring-primary/25">{method}</span> : null}
      </div>
      <CopyUrl url={url} id={id} copied={copied} onCopy={onCopy} />
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div>
      <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} type={type}
        className="mt-1 w-full rounded-md border px-3 py-2 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
    </div>
  );
}

// Provider-payload → our key mapping (Agent Popup / Call Log custom mapping).
const MAP_FIELDS = ["SourceNumber", "DestinationNumber", "DisplayNumber", "StartTime", "EndTime", "CallDuration", "Status", "Direction", "CallSessionId", "ResourceURL", "CallNotes"];

export function TelephonyView({ connectorKey }: { connectorKey: string }) {
  const [operator, setOperator] = useState<string>(OPERATORS[0]);
  const [sectionKey, setSectionKey] = useState<string>("call_route");
  const [copied, setCopied] = useState<string | null>(null);

  // sub-tabs
  const [popupTab, setPopupTab] = useState<"api" | "mapping" | "panel">("api");
  const [logTab, setLogTab] = useState<"api" | "mapping">("api");

  // editable config (local scaffold — wire to a settings endpoint later)
  const [vnums, setVnums] = useState<Array<{ number: string; tag: string }>>([{ number: "", tag: "" }]);
  const [uaMap, setUaMap] = useState<Array<{ user: string; agent: string }>>([{ user: "", agent: "" }]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [panel, setPanel] = useState({ url: "https://cloudphone.tatateleservices.com/dialer/login", perms: "geolocation;microphone;camera", title: "Smartflo India Dialer" });
  const [c2c, setC2c] = useState({ url: "https://api-smartflo.tatateleservices.com/v1/click_to_call", method: "POST", reqType: "JSON", agentNumber: "", dataTemplate: '{\n  "agent_number": "{{agent_phone}}",\n  "destination_number": "{{lead_phone}}"\n}', headers: [] as Array<{ key: string; value: string }>, responseKeyword: "", responseType: "JSON", supportEmail: "", enabled: true });
  const [tokenSet, setTokenSet] = useState(false);
  const [savingC2c, setSavingC2c] = useState(false);
  const [savedC2c, setSavedC2c] = useState(false);
  const [revealHdr, setRevealHdr] = useState<Set<number>>(new Set());
  const [dispo, setDispo] = useState({ url: "", method: "POST", action: "task", taskName: "Follow-Up", activity: "" });

  // Load the saved Click-2-Call config + token status. Header values come back
  // already masked (KK01••••1863) — the real keys never leave the server.
  async function loadConfig() {
    try {
      const r = await fetch("/api/telephony/config", { cache: "no-store" });
      const j = (await r.json()) as { config?: { click2call?: typeof c2c & { operator?: string } }; tokenSet?: boolean };
      setTokenSet(!!j.tokenSet);
      const cc = j.config?.click2call;
      if (cc) {
        setC2c({
          url: cc.url,
          method: cc.method,
          reqType: cc.reqType,
          agentNumber: cc.agentNumber ?? "",
          dataTemplate: cc.dataTemplate ?? "",
          headers: Array.isArray(cc.headers) ? cc.headers : [],
          responseKeyword: cc.responseKeyword ?? "",
          responseType: cc.responseType ?? "JSON",
          supportEmail: cc.supportEmail ?? "",
          enabled: cc.enabled !== false,
        });
        if (cc.operator) setOperator(cc.operator);
      }
      setRevealHdr(new Set()); // re-hide everything after a (re)load
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveC2c() {
    setSavingC2c(true);
    try {
      const res = await fetch("/api/telephony/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ click2call: { operator, ...c2c } }),
      });
      if (res.ok) {
        setSavedC2c(true);
        setTimeout(() => setSavedC2c(false), 2000);
        // Pull the masked values back so the entered key turns into
        // KK01••••1863 immediately — no page reload needed.
        await loadConfig();
      }
    } finally {
      setSavingC2c(false);
    }
  }

  const base = typeof window !== "undefined" ? window.location.origin : "";
  const opSlug = slug(operator);
  const key = connectorKey || "<connector-key>";
  const hook = (path: string, query = "") => `${base}/api/telephony/${path}/${key}?operator=${opSlug}${query ? "&" + query : ""}`;

  async function onCopy(text: string, id: string) {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(null), 1500); } catch { /* ignore */ }
  }

  const section = SECTIONS.find((s) => s.key === sectionKey) ?? SECTIONS[1];

  return (
    <div className="min-h-full">
      <PremiumHeader icon={Cable} title="Telephony" subtitle="Universal telephony connector — apne calling operator ke API hooks configure karo." />

      <div className="mx-auto max-w-5xl px-6 py-6">
        {!connectorKey ? (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            <b>TELEPHONY_CONNECTOR_KEY</b> set nahi — URLs mein <code>&lt;connector-key&gt;</code> placeholder dikh raha hai. Env mein key daalo (hardcode mat karo).
          </div>
        ) : null}

        <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          {/* Operator tabs */}
          <div className="flex items-center gap-1 overflow-x-auto border-b bg-secondary/30 px-2 py-2">
            {OPERATORS.map((op) => (
              <button key={op} type="button" onClick={() => setOperator(op)}
                className={"whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition " + (operator === op ? "bg-white text-primary shadow-sm ring-1 ring-primary/25" : "text-muted-foreground hover:bg-white/60")}>
                {operator === op ? "✓ " : ""}{op}
              </button>
            ))}
            <button type="button" className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded-lg text-muted-foreground hover:bg-white/60" title="Add operator (coming soon)">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="flex min-h-[460px]">
            {/* Section list */}
            <div className="w-52 shrink-0 space-y-0.5 border-r bg-secondary/10 p-2">
              {SECTIONS.map((s) => (
                <button key={s.key} type="button" onClick={() => setSectionKey(s.key)}
                  className={"block w-full rounded-md px-3 py-2 text-left text-xs font-semibold transition " + (sectionKey === s.key ? "bg-primary/10 text-primary ring-1 ring-primary/25" : "text-foreground/70 hover:bg-secondary/50")}>
                  {s.label}
                </button>
              ))}
            </div>

            {/* Section body */}
            <div className="min-w-0 flex-1 space-y-4 p-5">
              {/* 1. VIRTUAL NUMBERS */}
              {section.key === "virtual" ? (
                <>
                  <SectionNote>Provider ke DID / virtual numbers ki list (tag ke saath). Inbound call inhi numbers pe aati hai.</SectionNote>
                  <div className="space-y-2">
                    {vnums.map((v, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input value={v.number} onChange={(e) => setVnums((p) => p.map((x, j) => j === i ? { ...x, number: e.target.value } : x))} placeholder="+91 80XXXXXXXX"
                          className="flex-1 rounded-md border px-3 py-2 font-mono text-xs outline-none focus:border-primary" />
                        <input value={v.tag} onChange={(e) => setVnums((p) => p.map((x, j) => j === i ? { ...x, tag: e.target.value } : x))} placeholder="Tag (e.g. Sales Team)"
                          className="flex-1 rounded-md border px-3 py-2 text-xs outline-none focus:border-primary" />
                        <button type="button" onClick={() => setVnums((p) => p.filter((_, j) => j !== i))} className="rounded p-1.5 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setVnums((p) => [...p, { number: "", tag: "" }])} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-semibold hover:bg-secondary"><Plus className="h-3.5 w-3.5" /> Add number</button>
                    <button type="button" className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary"><Upload className="h-3.5 w-3.5" /> Upload CSV</button>
                  </div>
                </>
              ) : null}

              {/* 2. CALL ROUTE */}
              {section.key === "call_route" ? (
                <>
                  <SectionNote>Inbound call ko sahi lead owner tak route karta hai. In URLs ko apne {operator} config mein hook karo.</SectionNote>
                  <Endpoint name="Call Route API" id="cr1" copied={copied} onCopy={onCopy} url={hook("call-route", "caller_id=<caller phone>&virtualNumber=<virtual number>&ivr=<ivr option>")} />
                  <Endpoint name="Lead Route V2" id="cr2" copied={copied} onCopy={onCopy} url={hook("lead-route-v2", "caller_id=<caller phone>&agentInfo=<true to return full agent info>")} />
                  <Endpoint name="Opportunity Route API" id="cr3" copied={copied} onCopy={onCopy} url={hook("opportunity-route", "caller_id=<caller phone>&virtualNumber=<virtual number>&ivr=<ivr option>")} />
                </>
              ) : null}

              {/* 3. AGENT POPUP */}
              {section.key === "agent_popup" ? (
                <>
                  <SubTabs tabs={[["api", "API Details"], ["mapping", "Custom Mapping"], ["panel", "Agent Panel Settings"]]} active={popupTab} onPick={(t) => setPopupTab(t as typeof popupTab)} />
                  {popupTab === "api" ? (
                    <Endpoint name="Agent Popup API" id="ap1" copied={copied} onCopy={onCopy} url={hook("agent-popup", "caller_id=<caller phone>&agent=<agent id>")} note="Call connect hone par agent ki screen pe lead screen-pop kholta hai." />
                  ) : popupTab === "mapping" ? (
                    <MappingTable fields={MAP_FIELDS} mapping={mapping} setMapping={setMapping} />
                  ) : (
                    <div className="space-y-3">
                      <Field label="Panel URL (softphone embed)" value={panel.url} onChange={(v) => setPanel((p) => ({ ...p, url: v }))} />
                      <Field label="Permissions" value={panel.perms} onChange={(v) => setPanel((p) => ({ ...p, perms: v }))} />
                      <Field label="Title" value={panel.title} onChange={(v) => setPanel((p) => ({ ...p, title: v }))} />
                    </div>
                  )}
                </>
              ) : null}

              {/* 4. CALL LOG */}
              {section.key === "call_log" ? (
                <>
                  <SubTabs tabs={[["api", "API Details"], ["mapping", "Custom Mapping"]]} active={logTab} onPick={(t) => setLogTab(t as typeof logTab)} />
                  {logTab === "api" ? (
                    <>
                      <Endpoint name="Log Call Complete" method="POST" id="cl1" copied={copied} onCopy={onCopy} url={hook("log-call-complete")} note="Inbound/Outbound call ke baad provider yahan POST karega — activity log ho jayegi." />
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Expected JSON body</div>
                        <pre className="mt-1 overflow-x-auto rounded-md border bg-secondary/30 px-3 py-2 font-mono text-[11px] leading-relaxed">{`{
  "SourceNumber": "...",
  "DestinationNumber": "...",
  "DisplayNumber": "...",
  "StartTime": "...",
  "EndTime": "...",
  "CallDuration": "...",
  "Status": "...",
  "CallNotes": "...",
  "ResourceURL": "...",
  "Direction": "Inbound|Outbound",
  "CallSessionId": "..."
}`}</pre>
                      </div>
                    </>
                  ) : (
                    <MappingTable fields={MAP_FIELDS} mapping={mapping} setMapping={setMapping} />
                  )}
                </>
              ) : null}

              {/* 5. CLICK 2 CALL (outbound — we call the operator) */}
              {section.key === "click2call" ? (
                <>
                  <SectionNote>Dashboard se outbound call trigger — ye {operator} ki API ko call karta hai.</SectionNote>
                  <Field label="API URL" value={c2c.url} onChange={(v) => setC2c((p) => ({ ...p, url: v }))} />
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Method</label>
                      <select value={c2c.method} onChange={(e) => setC2c((p) => ({ ...p, method: e.target.value }))} className="mt-1 w-full rounded-md border bg-white px-3 py-2 text-xs outline-none focus:border-primary">
                        <option>POST</option><option>GET</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Request Type</label>
                      <select value={c2c.reqType} onChange={(e) => setC2c((p) => ({ ...p, reqType: e.target.value }))} className="mt-1 w-full rounded-md border bg-white px-3 py-2 text-xs outline-none focus:border-primary">
                        <option>JSON</option><option>FORM</option>
                      </select>
                    </div>
                  </div>
                  <Field label="Agent number (call pehle ispe ring hoti hai)" value={c2c.agentNumber} onChange={(v) => setC2c((p) => ({ ...p, agentNumber: v }))} placeholder="+91 9XXXXXXXXX" />
                  <div className={"rounded-md border px-3 py-2 text-[11px] " + (tokenSet ? "border-primary/25 bg-primary/10 text-primary" : "border-amber-200 bg-amber-50 text-amber-800")}>
                    {tokenSet ? "✓ Auth token set hai (TELEPHONY_AUTH_TOKEN env) — Bearer header auto lagega." : "⚠ Env Bearer token nahi mila. Niche custom header (Authorization / apikey) add kar sakte ho."}
                  </div>

                  {/* Custom request headers — operator API auth / API key */}
                  <div className="rounded-lg border p-3">
                    <div className="flex items-center justify-between">
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">API Headers (auth / API key)</label>
                      <button type="button" onClick={() => setC2c((p) => ({ ...p, headers: [...p.headers, { key: "", value: "" }] }))}
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold hover:bg-secondary"><Plus className="h-3 w-3" /> Add header</button>
                    </div>
                    {c2c.headers.length === 0 ? (
                      <p className="mt-2 text-[11px] text-muted-foreground">Koi custom header nahi. Operator ko API key chahiye to add karo — e.g. <code>Authorization</code> = <code>Token abc123</code>, ya <code>apikey</code> = <code>…</code>.</p>
                    ) : (
                      <div className="mt-2 space-y-2">
                        {c2c.headers.map((h, i) => {
                          const shown = revealHdr.has(i);
                          return (
                          <div key={i} className="flex items-center gap-2">
                            <input value={h.key} onChange={(e) => setC2c((p) => ({ ...p, headers: p.headers.map((x, j) => j === i ? { ...x, key: e.target.value } : x) }))} placeholder="Header name (e.g. Authorization)"
                              className="w-44 shrink-0 rounded-md border px-3 py-2 font-mono text-xs outline-none focus:border-primary" />
                            <span className="text-muted-foreground">:</span>
                            <div className="relative flex-1">
                              <input type={shown ? "text" : "password"} value={h.value}
                                onChange={(e) => setC2c((p) => ({ ...p, headers: p.headers.map((x, j) => j === i ? { ...x, value: e.target.value } : x) }))}
                                onFocus={() => { if (h.value.includes("•")) setC2c((p) => ({ ...p, headers: p.headers.map((x, j) => j === i ? { ...x, value: "" } : x) })); }}
                                placeholder="Value (e.g. Token abc123)"
                                className="w-full rounded-md border px-3 py-2 pr-9 font-mono text-xs outline-none focus:border-primary" />
                              <button type="button" onClick={() => setRevealHdr((p) => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; })}
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground" title={shown ? "Hide" : "Show"}>
                                {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                              </button>
                            </div>
                            <button type="button" onClick={() => setC2c((p) => ({ ...p, headers: p.headers.filter((_, j) => j !== i) }))} className="rounded p-1.5 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                          </div>
                          );
                        })}
                        <p className="text-[11px] text-muted-foreground">
                          🔒 Values DB me <b>encrypt</b> hoke save hoti hain; reload pe <code>KK01••••1863</code> jaise masked dikhti hain. Badalne ke liye field clear karke nayi key daalo (masked rakhoge to same rahegi). Value me <code>@leadPhone</code> / <code>{"{{lead_phone}}"}</code> merge bhi chalte hain.
                        </p>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Data template (mail-merge)</label>
                    <textarea value={c2c.dataTemplate} onChange={(e) => setC2c((p) => ({ ...p, dataTemplate: e.target.value }))} rows={6}
                      className="mt-1 w-full rounded-md border px-3 py-2 font-mono text-[11px] outline-none focus:border-primary" />
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Available: <code>@leadPhone</code>, <code>@agentPhone</code>, <code>@agentEmail</code>, <code>@VirtualNumberTag</code> (ya <code>{"{{lead_phone}}"}</code> / <code>{"{{agent_phone}}"}</code> / <code>{"{{agent_email}}"}</code> / <code>{"{{virtual_number_tag}}"}</code>).
                    </p>
                  </div>

                  {/* Response handling */}
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Response keyword (success check)" value={c2c.responseKeyword} onChange={(v) => setC2c((p) => ({ ...p, responseKeyword: v }))} placeholder="e.g. queued successfully" />
                    <div>
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Response Type</label>
                      <select value={c2c.responseType} onChange={(e) => setC2c((p) => ({ ...p, responseType: e.target.value }))} className="mt-1 w-full rounded-md border bg-white px-3 py-2 text-xs outline-none focus:border-primary">
                        <option>JSON</option><option>TEXT</option><option>XML</option>
                      </select>
                    </div>
                  </div>
                  <p className="-mt-2 text-[11px] text-muted-foreground">Khali chhodo to HTTP 2xx = success. Provider 200 pe bhi fail bhejta ho (jaise Ozonetel) to yahan success string daalo.</p>

                  <Field label="Provider support email" value={c2c.supportEmail} onChange={(v) => setC2c((p) => ({ ...p, supportEmail: v }))} placeholder="support@operator.com" />

                  <label className="flex items-center gap-2 text-xs font-semibold">
                    <input type="checkbox" checked={c2c.enabled} onChange={(e) => setC2c((p) => ({ ...p, enabled: e.target.checked }))} className="h-4 w-4 rounded border-input accent-primary" />
                    Enable Click-2-Call connector
                  </label>

                  <button type="button" onClick={saveC2c} disabled={savingC2c || !c2c.url.trim()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-primary/90 disabled:opacity-50">
                    {savedC2c ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
                    {savedC2c ? "Saved" : savingC2c ? "Saving…" : "Save Click-2-Call"}
                  </button>
                </>
              ) : null}

              {/* 6. CALL DISPOSITION */}
              {section.key === "disposition" ? (
                <>
                  <SectionNote>Call khatam hone par disposition capture karta hai.</SectionNote>
                  <Field label="Provider Disposition URL" value={dispo.url} onChange={(v) => setDispo((p) => ({ ...p, url: v }))} placeholder="https://...?call_session_id=<id>&agent_name=<name>" />
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Method</label>
                    <select value={dispo.method} onChange={(e) => setDispo((p) => ({ ...p, method: e.target.value }))} className="mt-1 w-40 rounded-md border bg-white px-3 py-2 text-xs outline-none focus:border-primary">
                      <option>POST</option><option>GET</option>
                    </select>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="text-xs font-semibold">On disposition, create:</div>
                    <div className="mt-2 flex gap-4 text-xs">
                      <label className="flex items-center gap-1.5"><input type="radio" checked={dispo.action === "task"} onChange={() => setDispo((p) => ({ ...p, action: "task" }))} /> Task</label>
                      <label className="flex items-center gap-1.5"><input type="radio" checked={dispo.action === "activity"} onChange={() => setDispo((p) => ({ ...p, action: "activity" }))} /> Custom Activity</label>
                    </div>
                    {dispo.action === "task" ? (
                      <Field label="Task name" value={dispo.taskName} onChange={(v) => setDispo((p) => ({ ...p, taskName: v }))} />
                    ) : (
                      <Field label="Custom activity name" value={dispo.activity} onChange={(v) => setDispo((p) => ({ ...p, activity: v }))} placeholder="e.g. Call Outcome" />
                    )}
                  </div>
                </>
              ) : null}

              {/* 7. SSO */}
              {section.key === "sso" ? (
                <>
                  <SectionNote>Dashboard ko telephony app ke andar embed karne ke liye auth.</SectionNote>
                  <Endpoint name="Get Single Sign-on Key" id="sso1" copied={copied} onCopy={onCopy} url={hook("sso/get-key")} note="Auth key generate karta hai." />
                  <Endpoint name="Lead Details" id="sso2" copied={copied} onCopy={onCopy} url={hook("sso/lead-details", "key=<sso key>&leadphone=<lead phone>")} />
                  <Endpoint name="Opportunity Details" id="sso3" copied={copied} onCopy={onCopy} url={hook("sso/opportunity-details", "key=<sso key>&opportunityId=<id>&opportunityEvent=<event>")} />
                </>
              ) : null}

              {/* 8. TEAM ASSIGNMENT */}
              {section.key === "team" ? (
                <>
                  <SectionNote>Ye connector instance kin teams ke liye chalega — select karo. (Internal config, koi external API nahi.)</SectionNote>
                  <p className="text-xs text-muted-foreground">Teams ki list aapke workspace se aati hai — yahan select karke save karoge.</p>
                  <div className="rounded-md border p-3 text-xs text-muted-foreground">Teams checkbox tree — wiring pending (workspace teams se populate hoga).</div>
                </>
              ) : null}

              {/* 9. USER-AGENT MAPPING */}
              {section.key === "ua_map" ? (
                <>
                  <SectionNote>Dashboard user ko provider ke agent identifier (extension) se map karo.</SectionNote>
                  <div className="space-y-2">
                    {uaMap.map((m, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input value={m.user} onChange={(e) => setUaMap((p) => p.map((x, j) => j === i ? { ...x, user: e.target.value } : x))} placeholder="Dashboard user name" className="flex-1 rounded-md border px-3 py-2 text-xs outline-none focus:border-primary" />
                        <span className="text-muted-foreground">→</span>
                        <input value={m.agent} onChange={(e) => setUaMap((p) => p.map((x, j) => j === i ? { ...x, agent: e.target.value } : x))} placeholder="Agent extension / id" className="flex-1 rounded-md border px-3 py-2 font-mono text-xs outline-none focus:border-primary" />
                        <button type="button" onClick={() => setUaMap((p) => p.filter((_, j) => j !== i))} className="rounded p-1.5 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setUaMap((p) => [...p, { user: "", agent: "" }])} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-semibold hover:bg-secondary"><Plus className="h-3.5 w-3.5" /> Add mapping</button>
                    <button type="button" className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary"><Upload className="h-3.5 w-3.5" /> Upload CSV</button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <p className="mt-3 text-[11px] text-muted-foreground">
          Note: ye connector <b>config UI</b> hai. Inbound hook URLs <code>/api/telephony/*</code> backend routes pe point karti hain (abhi wiring pending). Outbound (Click-2-Call) operator ki API ko call karega.
        </p>
      </div>
    </div>
  );
}

function SectionNote({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] text-sky-800">{children}</div>;
}

function SubTabs({ tabs, active, onPick }: { tabs: [string, string][]; active: string; onPick: (t: string) => void }) {
  return (
    <div className="flex gap-1 border-b">
      {tabs.map(([k, label]) => (
        <button key={k} type="button" onClick={() => onPick(k)}
          className={"border-b-2 px-3 py-1.5 text-xs font-semibold transition " + (active === k ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
          {label}
        </button>
      ))}
    </div>
  );
}

function MappingTable({ fields, mapping, setMapping }: { fields: string[]; mapping: Record<string, string>; setMapping: (f: (p: Record<string, string>) => Record<string, string>) => void }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">Provider ke payload field ko hamare key se map karo.</p>
      {fields.map((f) => (
        <div key={f} className="flex items-center gap-2">
          <span className="w-40 shrink-0 font-mono text-[11px] text-muted-foreground">{f}</span>
          <span className="text-muted-foreground">→</span>
          <input value={mapping[f] ?? ""} onChange={(e) => setMapping((p) => ({ ...p, [f]: e.target.value }))} placeholder="provider field name"
            className="flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus:border-primary" />
        </div>
      ))}
    </div>
  );
}
