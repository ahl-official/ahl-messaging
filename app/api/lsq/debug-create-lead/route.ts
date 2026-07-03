// GET /api/lsq/debug-create-lead?wa_id=<waid>&token=<webhook_token>
//
// Owner / token-only diagnostic. Calls Lead.CreateOrUpdate with the
// configured access keys and shows the full URL, body, HTTP status,
// and raw response — so when "lead not created" mysteries strike we
// can see whether (a) the API rejected us, (b) the API succeeded but
// we're parsing the response shape wrong, or (c) auth is for a
// read-only key without CreateOrUpdate permission.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { getLsqConfig } from "@/lib/lsq";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const tokenParam = request.nextUrl.searchParams.get("token")?.trim();
  const expectedToken = (process.env.WEBHOOK_INTERNAL_TOKEN || "").trim();
  const tokenAuthorized =
    tokenParam && expectedToken && tokenParam === expectedToken;

  if (!tokenAuthorized) {
    const member = await getCurrentMember();
    if (!member) {
      return NextResponse.json(
        {
          error:
            "Unauthorized. Append &token=<WEBHOOK_INTERNAL_TOKEN> or log in as owner.",
        },
        { status: 401 },
      );
    }
    if (member.role !== "owner") {
      return NextResponse.json({ error: "Owners only" }, { status: 403 });
    }
  }

  const waId = request.nextUrl.searchParams.get("wa_id")?.trim();
  if (!waId) {
    return NextResponse.json(
      { error: "wa_id is required, e.g. ?wa_id=919045454045" },
      { status: 400 },
    );
  }

  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return NextResponse.json({ error: "CRM not configured" }, { status: 500 });
  }

  const digits = waId.replace(/\D/g, "");
  const cc = digits.length > 10 ? digits.slice(0, digits.length - 10) : "";
  const last10 = digits.length > 10 ? digits.slice(-10) : digits;
  const phoneFormatted = cc ? `${cc}-${last10}` : last10;

  // Header-based auth + Lead.CreateOrUpdate body shape pinned from the
  // working "Create Lead1" n8n template on this tenant. SearchBy goes
  // LAST. Mirrors lsqCreateLeadByPhone() in lib/lsq.ts.
  const url = `${cfg.host}/v2/LeadManagement.svc/Lead.CreateOrUpdate`;
  const body = [
    { Attribute: "Phone", Value: phoneFormatted },
    { Attribute: "SearchBy", Value: "Phone" },
  ];

  const started = Date.now();
  let httpStatus = 0;
  let bodyText = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-LSQ-AccessKey": cfg.accessKey,
        "x-LSQ-SecretKey": cfg.secretKey,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    httpStatus = res.status;
    bodyText = await res.text();
  } catch (e) {
    return NextResponse.json({
      url,
      auth_mode: "headers",
      access_key_first4: cfg.accessKey.slice(0, 4),
      access_key_last4: cfg.accessKey.slice(-4),
      access_key_length: cfg.accessKey.length,
      phone_formatted: phoneFormatted,
      request_body: body,
      error: e instanceof Error ? e.message : "Network error",
      duration_ms: Date.now() - started,
    });
  }

  let parsed: unknown = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    /* leave as null */
  }

  return NextResponse.json({
    url,
    auth_mode: "headers",
    access_key_first4: cfg.accessKey.slice(0, 4),
    access_key_last4: cfg.accessKey.slice(-4),
    access_key_length: cfg.accessKey.length,
    phone_formatted: phoneFormatted,
    request_body: body,
    http_status: httpStatus,
    duration_ms: Date.now() - started,
    raw_response_text: bodyText.slice(0, 2000),
    parsed_response: parsed,
    response_shape:
      parsed === null
        ? "null"
        : Array.isArray(parsed)
          ? `array[${parsed.length}]`
          : typeof parsed === "object"
            ? `object(keys: ${Object.keys(parsed as object).join(", ")})`
            : typeof parsed,
  });
}
