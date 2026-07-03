// GET /api/lsq/debug-raw-create?wa_id=919045454045&token=<webhook_token>
//
// Hardcoded byte-for-byte copy of the working n8n "Create Lead1"
// template — same endpoint, same headers, same body order, same field
// names. ZERO abstraction so we can verify creds + endpoint + LSQ
// tenant config without any of our own logic in the way.
//
// Use this as the ground-truth check whenever lead creation breaks:
// if THIS works but ensure-lead doesn't, the issue is in our pipeline.
// If this fails, the issue is creds / network / tenant config.

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
    if (!member || member.role !== "owner") {
      return NextResponse.json(
        { error: "Owners only (or pass &token=...)" },
        { status: 403 },
      );
    }
  }

  const waId = request.nextUrl.searchParams.get("wa_id")?.trim();
  if (!waId) {
    return NextResponse.json({ error: "wa_id is required" }, { status: 400 });
  }

  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return NextResponse.json({ error: "CRM not configured" }, { status: 500 });
  }

  // Phone format: cc-last10 (e.g. "91-9045454045") — same as the n8n
  // template builds via `{{ country_code }}-{{ Mobile Number }}`.
  const digits = waId.replace(/\D/g, "");
  const cc = digits.length > 10 ? digits.slice(0, digits.length - 10) : "91";
  const last10 = digits.length > 10 ? digits.slice(-10) : digits;
  const phone = `${cc}-${last10}`;

  // Body in EXACTLY the order from the n8n template — FirstName first,
  // Phone second, then static fields, SearchBy last.
  const body = [
    { Attribute: "FirstName", Value: "WA Test Lead" },
    { Attribute: "Phone", Value: phone },
    { Attribute: "Source", Value: "WhatsApp Test" },
    { Attribute: "mx_Country_Code", Value: cc },
    { Attribute: "SearchBy", Value: "Phone" },
  ];

  const url = `${cfg.host}/v2/LeadManagement.svc/Lead.CreateOrUpdate`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-LSQ-AccessKey": cfg.accessKey,
    "x-LSQ-SecretKey": cfg.secretKey,
  };

  const started = Date.now();
  let httpStatus = 0;
  let bodyText = "";
  let netErr: string | null = null;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    httpStatus = res.status;
    bodyText = await res.text();
  } catch (e) {
    netErr = e instanceof Error ? e.message : "Network error";
  }

  let parsed: unknown = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    /* leave as null */
  }

  return NextResponse.json({
    request: {
      url,
      method: "POST",
      headers: {
        "Content-Type": headers["Content-Type"],
        Accept: headers.Accept,
        "x-LSQ-AccessKey": `${cfg.accessKey.slice(0, 4)}…${cfg.accessKey.slice(-4)} (len=${cfg.accessKey.length})`,
        "x-LSQ-SecretKey": `${cfg.secretKey.slice(0, 4)}…${cfg.secretKey.slice(-4)} (len=${cfg.secretKey.length})`,
      },
      body,
    },
    response: {
      http_status: httpStatus,
      duration_ms: Date.now() - started,
      network_error: netErr,
      raw_body: bodyText.slice(0, 2000),
      parsed,
    },
    verdict:
      httpStatus === 200 && parsed && typeof parsed === "object" && (parsed as { Status?: string }).Status === "Success"
        ? `✅ SUCCESS — lead id: ${(parsed as { Message?: { Id?: string } }).Message?.Id ?? "(no Id in response)"}`
        : `❌ FAILED — see response.parsed / response.raw_body for the LSQ error`,
  });
}
