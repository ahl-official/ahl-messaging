// Telephony connector config + outbound Click-2-Call. Config (non-secret) is
// stored in app_settings as JSON; the auth token is read from env only
// (TELEPHONY_AUTH_TOKEN) so no secret lands in the DB.
//
// Server-only.

import { getAppSetting, setAppSetting } from "@/lib/app-settings";
import { decryptSecret } from "@/lib/crypto-secret";

export interface Click2CallConfig {
  operator: string;
  url: string;
  method: string; // POST | GET
  reqType: string; // JSON | FORM
  dataTemplate: string; // body w/ merge fields (see applyMerge)
  agentNumber: string; // default agent phone the call rings first
  /** Custom request headers — operator API auth (Authorization / apikey /
   *  x-api-key …). Stored in app_settings, so treat values as DB-stored
   *  secrets. Merge fields are supported in the values too. */
  headers?: Array<{ key: string; value: string }>;
  /** Success is the response BODY containing this string (case-insensitive),
   *  e.g. Ozonetel returns 200 + "queued successfully". Empty ⇒ HTTP 2xx. */
  responseKeyword?: string;
  responseType?: string; // JSON | TEXT — informational, for the operator
  supportEmail?: string; // provider support email — informational
  enabled?: boolean; // connector on/off (default on)
}

/** Merge context for the data template + header values. */
export interface Click2CallContext {
  agentPhone?: string;
  agentEmail?: string;
  virtualNumberTag?: string;
}

// Fill both LeadSquared-style `@tokens` and our `{{snake_case}}` placeholders.
function applyMerge(
  tpl: string,
  ctx: { agent: string; lead: string; agentEmail: string; vnTag: string },
): string {
  return (tpl || "")
    .replaceAll("{{agent_phone}}", ctx.agent)
    .replaceAll("{{lead_phone}}", ctx.lead)
    .replaceAll("{{agent_email}}", ctx.agentEmail)
    .replaceAll("{{virtual_number_tag}}", ctx.vnTag)
    .replaceAll("@leadPhone", ctx.lead)
    .replaceAll("@agentPhone", ctx.agent)
    .replaceAll("@agentEmail", ctx.agentEmail)
    .replaceAll("@VirtualNumberTag", ctx.vnTag);
}

export interface TelephonyConfig {
  click2call: Click2CallConfig | null;
}

const KEY = "telephony_config";

export async function getTelephonyConfig(): Promise<TelephonyConfig> {
  const raw = await getAppSetting(KEY);
  if (!raw) return { click2call: null };
  try {
    return JSON.parse(raw) as TelephonyConfig;
  } catch {
    return { click2call: null };
  }
}

export async function setTelephonyConfig(cfg: TelephonyConfig): Promise<void> {
  await setAppSetting(KEY, JSON.stringify(cfg));
}

export function telephonyTokenSet(): boolean {
  return !!(process.env.TELEPHONY_AUTH_TOKEN && process.env.TELEPHONY_AUTH_TOKEN.trim());
}

const digits = (s: string) => (s ?? "").replace(/\D/g, "");

/** Fire an outbound click-to-call via the configured operator API. */
export async function placeClickToCall(
  leadPhone: string,
  opts?: Click2CallContext,
): Promise<{ ok: boolean; status: number; body: string }> {
  const { click2call: c } = await getTelephonyConfig();
  if (!c || !c.url) throw new Error("Click-2-Call not configured. Telephony tab me URL + template save karo.");
  if (c.enabled === false) throw new Error("Click-2-Call connector disabled hai. Telephony tab me Enable karo.");

  const agent = digits(opts?.agentPhone || c.agentNumber || "");
  const lead = digits(leadPhone);
  if (!lead) throw new Error("Lead phone missing.");
  // Agent phone is optional — some operators (e.g. Ozonetel) identify the
  // agent by email/agentID instead, so we don't hard-require it.

  const ctx = {
    agent,
    lead,
    agentEmail: (opts?.agentEmail || "").trim(),
    vnTag: (opts?.virtualNumberTag || "").trim(),
  };
  const filled = applyMerge(c.dataTemplate || "", ctx);

  const token = process.env.TELEPHONY_AUTH_TOKEN?.trim();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  // Operator-specific headers from the UI (API key / custom auth). Applied
  // after the env token so an explicit Authorization header here overrides it.
  for (const h of c.headers ?? []) {
    const k = (h?.key ?? "").trim();
    if (!k) continue;
    // Header values are encrypted at rest — decrypt before merge + send.
    headers[k] = applyMerge(decryptSecret(h?.value ?? ""), ctx);
  }
  const method = (c.method || "POST").toUpperCase();

  let url = c.url;
  let body: string | undefined;
  if (method === "GET") {
    // Append merge fields as query params for GET-style providers.
    const sep = url.includes("?") ? "&" : "?";
    url = `${url}${sep}agent_number=${encodeURIComponent(agent)}&destination_number=${encodeURIComponent(lead)}`;
  } else if (c.reqType === "FORM") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = filled || `agent_number=${encodeURIComponent(agent)}&destination_number=${encodeURIComponent(lead)}`;
  } else {
    headers["Content-Type"] = "application/json";
    body = filled || JSON.stringify({ agent_number: agent, destination_number: lead });
  }

  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20_000) });
  const text = await res.text().catch(() => "");
  // Some providers return HTTP 200 even on failure — treat success as the
  // response body containing the configured keyword (e.g. "queued successfully").
  const kw = (c.responseKeyword || "").trim().toLowerCase();
  const ok = kw ? res.ok && text.toLowerCase().includes(kw) : res.ok;
  return { ok, status: res.status, body: text.slice(0, 2000) };
}
