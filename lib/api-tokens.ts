// Helpers for the per-number API tokens used by /api/v1/* relay
// endpoints. External integrators (n8n, Make, custom servers) present
// these tokens as `Authorization: Bearer <token>`. The token is mapped
// to exactly one business_phone_number_id; that BPID's portfolio
// access-token (in .env.local) is then used to call Meta from the
// server. Net effect: integrators never see Meta credentials.

import crypto from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";

// `qht_` prefix makes it easy to grep for in logs and to spot in code
// reviews. 40 hex chars = 160 bits of entropy, plenty for a Bearer.
export function generateApiToken(): string {
  return "qht_" + crypto.randomBytes(20).toString("hex");
}

export interface ResolvedToken {
  id: string;
  business_phone_number_id: string;
  name: string;
  /** The dashboard user who generated this token — stamped onto messages
   *  sent through it so the chat can show "via API · <token>, by <person>". */
  created_by_user_id: string | null;
}

/**
 * Look up a Bearer token. Returns the resolved token row when valid +
 * enabled; null otherwise. Bumps `last_used_at` and `request_count` on
 * a hit (best-effort, non-blocking).
 */
export async function resolveApiToken(token: string): Promise<ResolvedToken | null> {
  if (!token || !token.startsWith("qht_")) return null;
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("api_tokens")
    .select("id, business_phone_number_id, name, enabled, request_count, created_by_user_id")
    .eq("token", token)
    .maybeSingle();
  if (!data || !data.enabled) return null;

  // Bump last_used_at + counter. Race-tolerant: small drift is fine.
  void admin
    .from("api_tokens")
    .update({
      last_used_at: new Date().toISOString(),
      request_count: ((data.request_count as number | undefined) ?? 0) + 1,
    })
    .eq("id", data.id);

  return {
    id: data.id as string,
    business_phone_number_id: data.business_phone_number_id as string,
    name: data.name as string,
    created_by_user_id: (data.created_by_user_id as string | null) ?? null,
  };
}

/**
 * Pull the Bearer value out of a Next.js Request Authorization header.
 * Returns null if missing / wrong scheme.
 */
export function bearerFrom(headers: Headers): string | null {
  const raw = headers.get("authorization") || headers.get("Authorization");
  if (!raw) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

/**
 * Append a row to api_request_log. Fire-and-forget — callers shouldn't
 * await this; a failing log write must NEVER block the real response.
 */
export function logApiRequest(opts: {
  tokenId?: string | null;
  tokenName?: string | null;
  businessPhoneNumberId?: string | null;
  method: string;
  path: string;
  status: number;
  durationMs?: number;
  userAgent?: string | null;
  sourceIp?: string | null;
}): void {
  const admin = createServiceRoleClient();
  void (async () => {
    try {
      await admin.from("api_request_log").insert({
        token_id: opts.tokenId ?? null,
        token_name: opts.tokenName ?? null,
        business_phone_number_id: opts.businessPhoneNumberId ?? null,
        method: opts.method,
        path: opts.path.slice(0, 500),
        status: opts.status,
        duration_ms: opts.durationMs ?? null,
        user_agent: opts.userAgent ? opts.userAgent.slice(0, 300) : null,
        source_ip: opts.sourceIp ?? null,
      });
    } catch {
      /* swallow — logging must never break the request path */
    }
  })();
}

/** Derive a coarse "platform" label from a User-Agent string. Used by
 *  the API monitor so operators can see "n8n" / "Make" / "Postman" /
 *  "Browser" at a glance instead of staring at the raw UA. */
export function platformFromUserAgent(ua: string | null | undefined): string {
  if (!ua) return "unknown";
  const s = ua.toLowerCase();
  if (s.includes("n8n")) return "n8n";
  if (s.includes("zapier")) return "Zapier";
  if (s.includes("make/") || s.includes("integromat")) return "Make";
  if (s.includes("postman")) return "Postman";
  if (s.includes("insomnia")) return "Insomnia";
  if (s.includes("curl/")) return "curl";
  if (s.includes("axios")) return "axios";
  if (s.includes("python-requests")) return "Python";
  if (s.includes("go-http-client")) return "Go";
  if (s.includes("node-fetch") || s.includes("undici")) return "Node";
  if (s.includes("googlebot") || s.includes("bingbot")) return "bot";
  if (s.includes("mozilla") || s.includes("safari") || s.includes("chrome")) {
    return "Browser";
  }
  // Fall back to the first slash-separated client token, capped — that's
  // usually the library / runtime name in most UAs.
  const first = ua.split(/[ /;]/)[0] ?? ua;
  return first.slice(0, 30) || "unknown";
}
