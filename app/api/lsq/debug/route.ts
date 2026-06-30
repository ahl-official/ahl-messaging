// GET /api/lsq/debug?phone=91-9045454045
//
// Diagnostic endpoint that talks to LeadSquared with the exact phone
// value provided (no variant rewriting), returns the full URL we hit
// (with secret key redacted), the HTTP status, and the raw body.
// Owner-only. Useful when "lead not found" mysteries strike — paste
// the response into chat and we can see exactly what LSQ said.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { getLsqConfig } from "@/lib/lsq";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }

  const phone = request.nextUrl.searchParams.get("phone")?.trim();
  if (!phone) {
    return NextResponse.json(
      { error: "phone is required, e.g. ?phone=91-9045454045" },
      { status: 400 },
    );
  }

  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return NextResponse.json({ error: "LSQ not configured" }, { status: 500 });
  }

  const params = new URLSearchParams({
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    phone,
  });
  const fullUrl = `${cfg.host}/v2/LeadManagement.svc/RetrieveLeadByPhoneNumber?${params.toString()}`;
  // Mask the secret key in the diagnostic — accessKey is fine since the
  // user is owner and it's already in their env. SecretKey is redacted
  // so a screenshot of the diagnostic doesn't leak it.
  const maskedUrl = fullUrl.replace(
    /secretKey=[^&]+/,
    `secretKey=${cfg.secretKey.slice(0, 4)}…${cfg.secretKey.slice(-4)}`,
  );

  const started = Date.now();
  let status = 0;
  let bodyText = "";
  let parsed: unknown = null;
  try {
    const res = await fetch(fullUrl, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    bodyText = await res.text();
    try {
      parsed = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      parsed = null;
    }
  } catch (e) {
    return NextResponse.json({
      url: maskedUrl,
      access_key_first4: cfg.accessKey.slice(0, 4),
      access_key_last4: cfg.accessKey.slice(-4),
      access_key_length: cfg.accessKey.length,
      secret_key_length: cfg.secretKey.length,
      host: cfg.host,
      error: e instanceof Error ? e.message : "Network error",
      duration_ms: Date.now() - started,
    });
  }

  return NextResponse.json({
    url: maskedUrl,
    access_key_first4: cfg.accessKey.slice(0, 4),
    access_key_last4: cfg.accessKey.slice(-4),
    access_key_length: cfg.accessKey.length,
    secret_key_length: cfg.secretKey.length,
    host: cfg.host,
    http_status: status,
    duration_ms: Date.now() - started,
    body_length: bodyText.length,
    body_preview: bodyText.slice(0, 2000),
    parsed_shape:
      parsed === null
        ? "null"
        : Array.isArray(parsed)
          ? `array[${parsed.length}]`
          : typeof parsed === "object"
            ? `object(keys: ${Object.keys(parsed as object).slice(0, 6).join(", ")})`
            : typeof parsed,
  });
}
