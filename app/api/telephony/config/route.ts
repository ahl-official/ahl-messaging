// GET  /api/telephony/config  → current Click-2-Call config + whether the
//                               auth token env var is set.
// POST /api/telephony/config  → save the Click-2-Call config (admin only).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { getTelephonyConfig, setTelephonyConfig, telephonyTokenSet, type Click2CallConfig } from "@/lib/telephony";
import { encryptSecret, decryptSecret, maskSecret, isEncrypted } from "@/lib/crypto-secret";

export const runtime = "nodejs";

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const config = await getTelephonyConfig();
  // Never send raw API keys to the browser — mask header values for display.
  // The • markers tell the POST handler the value is unchanged.
  if (config.click2call?.headers) {
    config.click2call = {
      ...config.click2call,
      headers: config.click2call.headers.map((h) => ({
        key: h.key,
        value: h.value ? maskSecret(decryptSecret(h.value)) : "",
      })),
    };
  }
  return NextResponse.json({ config, tokenSet: telephonyTokenSet() });
}

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) return NextResponse.json({ error: "Admins only" }, { status: 403 });

  let body: { click2call?: Partial<Click2CallConfig> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const c = body.click2call;
  if (!c?.url?.trim()) return NextResponse.json({ error: "URL required" }, { status: 400 });

  // Header values are encrypted at rest. A submitted value that still carries
  // the • mask (or is blank) means "unchanged" → keep the stored ciphertext for
  // that key; any other value is a fresh secret → encrypt it. Legacy plaintext
  // gets migrated to ciphertext on the next save.
  const prev = (await getTelephonyConfig()).click2call?.headers ?? [];
  const prevByKey = new Map(prev.map((h) => [h.key.toLowerCase(), h.value]));
  const headers = (Array.isArray(c.headers) ? c.headers : [])
    .map((h) => {
      const key = String(h?.key ?? "").trim();
      const raw = String(h?.value ?? "").trim();
      if (!key) return null;
      const unchanged = raw === "" || raw.includes("•");
      if (unchanged) {
        const stored = prevByKey.get(key.toLowerCase()) ?? "";
        return { key, value: stored && !isEncrypted(stored) ? encryptSecret(stored) : stored };
      }
      return { key, value: encryptSecret(raw) };
    })
    .filter((h): h is { key: string; value: string } => h !== null);

  const click2call: Click2CallConfig = {
    operator: (c.operator ?? "").trim() || "Custom",
    url: c.url.trim(),
    method: (c.method ?? "POST").trim() || "POST",
    reqType: (c.reqType ?? "JSON").trim() || "JSON",
    dataTemplate: c.dataTemplate ?? "",
    agentNumber: (c.agentNumber ?? "").trim(),
    headers,
    responseKeyword: (c.responseKeyword ?? "").trim(),
    responseType: (c.responseType ?? "JSON").trim() || "JSON",
    supportEmail: (c.supportEmail ?? "").trim(),
    enabled: c.enabled !== false,
  };
  await setTelephonyConfig({ click2call });
  return NextResponse.json({ ok: true, config: { click2call }, tokenSet: telephonyTokenSet() });
}
