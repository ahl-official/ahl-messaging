// Server-only Ozonetel CloudAgent helpers. Click-to-call runs through
// the documented REST "Agent Manual Dial" endpoint: with the operator
// already logged into CloudAgent (manual/blended mode), we POST the
// customer number and CloudAgent rings the agent first, then bridges
// the customer.
//
// Config lives in the ozonetel_settings table (one active row), with a
// .env.local fallback so a single-tenant install works before anyone
// opens the Settings UI. Each operator's agentID + landing phone live
// on their team_members row.

import { createServiceRoleClient } from "@/lib/supabase/server";

export interface OzonetelSettings {
  id: string;
  base_url: string;
  user_name: string;
  api_key: string;
  campaign_name: string;
  is_active: boolean;
  is_env_fallback: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS =
  "id, base_url, user_name, api_key, campaign_name, is_active, created_by, created_at, updated_at";

const DEFAULT_BASE_URL = "https://in1-ccaas-api.ozonetel.com";

/** The active CloudAgent account, or the env-var account when no DB row
 *  exists, or null when nothing is configured. */
export async function getActiveOzonetelSettings(): Promise<OzonetelSettings | null> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("ozonetel_settings")
    .select(SELECT_COLS)
    .eq("is_active", true)
    .maybeSingle();
  if (data) return { ...data, is_env_fallback: false } as OzonetelSettings;
  return envFallbackSettings();
}

function envFallbackSettings(): OzonetelSettings | null {
  const user_name = process.env.OZONETEL_USER_NAME;
  const api_key = process.env.OZONETEL_API_KEY;
  const campaign_name = process.env.OZONETEL_CAMPAIGN;
  if (!user_name || !api_key || !campaign_name) return null;
  return {
    id: "env:ozonetel",
    base_url: process.env.OZONETEL_BASE_URL || DEFAULT_BASE_URL,
    user_name,
    api_key,
    campaign_name,
    is_active: true,
    is_env_fallback: true,
    created_by: null,
    created_at: "1970-01-01T00:00:00Z",
    updated_at: "1970-01-01T00:00:00Z",
  };
}

/** Upsert the single active account. We keep one row — update it in
 *  place when present, else insert. */
export async function saveOzonetelSettings(input: {
  base_url: string;
  user_name: string;
  api_key: string;
  campaign_name: string;
  created_by: string | null;
}): Promise<void> {
  const admin = createServiceRoleClient();
  const { data: existing } = await admin
    .from("ozonetel_settings")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();
  const patch = {
    base_url: input.base_url,
    user_name: input.user_name,
    api_key: input.api_key,
    campaign_name: input.campaign_name,
    updated_at: new Date().toISOString(),
  };
  if (existing?.id) {
    await admin.from("ozonetel_settings").update(patch).eq("id", existing.id);
  } else {
    await admin.from("ozonetel_settings").insert({
      ...patch,
      is_active: true,
      created_by: input.created_by,
    });
  }
}

/** Customer number → digits CloudAgent expects. wa_id is stored as
 *  countrycode+number (e.g. "919045045045"); Ozonetel India manual dial
 *  wants the 10-digit subscriber number, so we strip a leading 91. */
export function normalizeCustomerNumber(waId: string): string {
  const digits = (waId || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

export interface DialResult {
  ok: boolean;
  ucid?: string;
  status?: string;
  error?: string;
}

/** POST CloudAgent's Agent Manual Dial. Requires the agent to already be
 *  logged in and Ready in manual/blended mode. */
/** Looks up the currently logged-in agent on CloudAgent and returns
 *  the campaign / AgentId Ozonetel has them bound to. We need this
 *  because saved-in-settings `campaign_name` often drifts from what
 *  the agent is actually live on — Ozonetel then rejects the dial with
 *  "Please pass Valid Campaign Details". Mirrors the "agent ready or
 *  not" node in the operator's n8n workflow that does the same lookup
 *  before dialling. */
async function agentLoginStatus(
  settings: OzonetelSettings,
  agentId: string,
): Promise<{ campaignName: string | null; agentId: string | null }> {
  const url = `${settings.base_url.replace(/\/+$/, "")}/ca_apis/AgentLoginStatus`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apiKey: settings.api_key,
      },
      body: JSON.stringify({
        userName: settings.user_name,
        agentID: agentId,
      }),
      cache: "no-store",
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      console.warn(
        `[ozonetel] AgentLoginStatus returned non-JSON: ${text.slice(0, 200)}`,
      );
      return { campaignName: null, agentId: null };
    }
    // Common shapes:
    //   { status, message: [{ AgentId, Campaign, ... }] }
    //   { status, message: { AgentId, CampaignName, ... } }
    //   { status, AgentId, Campaign }
    const msg = (json.message ?? json) as Record<string, unknown> | unknown[];
    const first = Array.isArray(msg) ? (msg[0] as Record<string, unknown>) : msg;
    const campaign =
      (first?.Campaign as string | undefined) ??
      (first?.CampaignName as string | undefined) ??
      (first?.campaignName as string | undefined) ??
      null;
    const aid =
      (first?.AgentId as string | undefined) ??
      (first?.agentID as string | undefined) ??
      null;
    console.log(
      `[ozonetel] AgentLoginStatus → campaign=${campaign} agentId=${aid}`,
    );
    return { campaignName: campaign, agentId: aid };
  } catch (e) {
    console.warn(
      `[ozonetel] AgentLoginStatus failed: ${e instanceof Error ? e.message : e}`,
    );
    return { campaignName: null, agentId: null };
  }
}

export async function agentManualDial(args: {
  settings: OzonetelSettings;
  agentId: string;
  customerNumber: string;
}): Promise<DialResult> {
  const { settings, customerNumber } = args;
  // Ask Ozonetel which campaign + AgentId this agent is currently
  // logged into. Saved settings campaign_name is only used as fallback
  // because operators frequently switch campaigns on the CloudAgent
  // side without updating settings — and a mismatched campaign throws
  // "Please pass Valid Campaign Details" on every dial.
  const live = await agentLoginStatus(settings, args.agentId);
  const campaignName = live.campaignName || settings.campaign_name;
  const agentId = live.agentId || args.agentId;
  console.log(
    `[ozonetel] dialing campaign=${JSON.stringify(campaignName)} ` +
      `agentId=${JSON.stringify(agentId)} ` +
      `(live=${live.campaignName !== null}, fallback=${!live.campaignName})`,
  );
  const url = `${settings.base_url.replace(/\/+$/, "")}/ca_apis/AgentManualDial`;
  // Hard 15s cap — without it a wrong base URL / unreachable data-centre
  // leaves the request hanging forever and the UI stuck on "Dialing…".
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apiKey: settings.api_key,
      },
      body: JSON.stringify({
        userName: settings.user_name,
        agentID: agentId,
        // Use the campaign Ozonetel reports for this live agent (set
        // 3 lines up). Falling back to settings.campaign_name here
        // would throw away the agentLoginStatus result and re-create
        // the "Please pass Valid Campaign Details" failure.
        campaignName,
        customerNumber,
        // Ozonetel's CloudAgent API wants `uui` (lowercase) with a
        // string tag for the dial source — NOT `UCID: "true"`. Using
        // the wrong field name caused every dial to fail silently.
        uui: "Click2call",
      }),
      cache: "no-store",
      signal: ctrl.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? `No response from ${url} in 15s — check the base URL / data-centre.`
        : e instanceof Error
          ? e.message
          : "network error",
    };
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Non-JSON body — surface the raw text so misconfig is visible.
    return res.ok
      ? { ok: true, status: text || "queued" }
      : { ok: false, error: text || `HTTP ${res.status}` };
  }

  // Success looks like { ucid, status: "queued successfully" }.
  // Failure looks like { status: "false", message: "Invalid User Details" }.
  const status = typeof json.status === "string" ? json.status : undefined;
  const ucid = typeof json.ucid === "string" ? json.ucid : undefined;
  if (!res.ok || status === "false" || status === "error") {
    const message =
      (typeof json.message === "string" && json.message) ||
      status ||
      `HTTP ${res.status}`;
    return { ok: false, error: message };
  }
  return { ok: true, ucid, status };
}
