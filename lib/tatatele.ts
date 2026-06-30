// Server-only Tata Tele (Smartflo) click-to-call helpers.
//
// Smartflo's /v1/click_to_call is a clean agent→customer dialer: it
// rings the agent_number first, then bridges destination_number, and
// returns immediately. No pre-login step (unlike Ozonetel). Auth is the
// portal API token sent verbatim as the Authorization header.
//
// Config lives in tatatele_settings (one active row) + a .env.local
// fallback. Each operator's Smartflo agent id lives on their
// team_members row (tatatele_agent_number).

import { createServiceRoleClient } from "@/lib/supabase/server";

export interface TataTeleSettings {
  id: string;
  base_url: string;
  api_token: string;
  caller_id: string;
  is_active: boolean;
  is_env_fallback: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS =
  "id, base_url, api_token, caller_id, is_active, created_by, created_at, updated_at";

const DEFAULT_BASE_URL = "https://api-smartflo.tatateleservices.com";

export async function getActiveTataTeleSettings(): Promise<TataTeleSettings | null> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("tatatele_settings")
    .select(SELECT_COLS)
    .eq("is_active", true)
    .maybeSingle();
  if (data) return { ...data, is_env_fallback: false } as TataTeleSettings;
  return envFallbackSettings();
}

function envFallbackSettings(): TataTeleSettings | null {
  const api_token = process.env.TATATELE_API_TOKEN;
  const caller_id = process.env.TATATELE_CALLER_ID;
  if (!api_token || !caller_id) return null;
  return {
    id: "env:tatatele",
    base_url: process.env.TATATELE_BASE_URL || DEFAULT_BASE_URL,
    api_token,
    caller_id,
    is_active: true,
    is_env_fallback: true,
    created_by: null,
    created_at: "1970-01-01T00:00:00Z",
    updated_at: "1970-01-01T00:00:00Z",
  };
}

export async function saveTataTeleSettings(input: {
  base_url: string;
  api_token: string;
  caller_id: string;
  created_by: string | null;
}): Promise<void> {
  const admin = createServiceRoleClient();
  const { data: existing } = await admin
    .from("tatatele_settings")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();
  const patch = {
    base_url: input.base_url,
    api_token: input.api_token,
    caller_id: input.caller_id,
    updated_at: new Date().toISOString(),
  };
  if (existing?.id) {
    await admin.from("tatatele_settings").update(patch).eq("id", existing.id);
  } else {
    await admin.from("tatatele_settings").insert({
      ...patch,
      is_active: true,
      created_by: input.created_by,
    });
  }
}

/** Customer number → digits Smartflo expects (10–15 digits). wa_id is
 *  already countrycode+number; we just strip non-digits. */
export function normalizeDestination(waId: string): string {
  return (waId || "").replace(/\D/g, "");
}

export interface DialResult {
  ok: boolean;
  message?: string;
  error?: string;
}

/** POST Smartflo's click_to_call. Rings the agent first, then the
 *  customer. Returns immediately (async=1). */
export async function clickToCall(args: {
  settings: TataTeleSettings;
  agentNumber: string;
  destinationNumber: string;
}): Promise<DialResult> {
  const { settings, agentNumber, destinationNumber } = args;
  const url = `${settings.base_url.replace(/\/+$/, "")}/v1/click_to_call`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // Smartflo wants the token raw — no "Bearer" prefix.
        Authorization: settings.api_token,
      },
      body: JSON.stringify({
        agent_number: agentNumber,
        destination_number: destinationNumber,
        caller_id: settings.caller_id,
        async: 1,
        get_call_id: 1,
      }),
      cache: "no-store",
      signal: ctrl.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? `No response from ${url} in 15s — check the base URL / token.`
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
    return res.ok
      ? { ok: true, message: text || "Call originated" }
      : { ok: false, error: text || `HTTP ${res.status}` };
  }

  const success = json.success === true || json.success === "true";
  const message =
    typeof json.message === "string" ? json.message : undefined;
  if (!res.ok || json.success === false || json.success === "false") {
    return { ok: false, error: message || `HTTP ${res.status}` };
  }
  return { ok: success || res.ok, message };
}
