// GET /api/lsq/debug-activities?prospect_id=<id>[&token=<webhook_token>]
//
// Owner-only diagnostic. Probes ~20 different LSQ activity endpoint
// shapes (path × HTTP method × auth strategy) and reports the HTTP
// status + body preview for each. The output tells us exactly which
// shape this LSQ tenant actually accepts so we can pin the production
// code to it without more guessing.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { getLsqConfig } from "@/lib/lsq";

export const runtime = "nodejs";

interface ProbeResult {
  label: string;
  method: "GET" | "POST";
  url: string;
  status: number;
  body_preview: string;
  duration_ms: number;
}

interface Probe {
  label: string;
  method: "GET" | "POST";
  path: string;
  /** Extra query keys/values besides accessKey/secretKey. */
  queryExtra?: string;
  /** JSON body for POSTs. Pass undefined for GETs / no body. */
  body?: unknown;
  /** When true, send accessKey/secretKey as HTTP headers (x-LSQ-*)
   *  instead of query params. Some LSQ deployments accept this shape. */
  authViaHeaders?: boolean;
  /** When true, omit auth from query AND headers — used for the
   *  "is the service even reachable?" sanity probes. */
  skipAuth?: boolean;
}

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
            "Unauthorized. Either log in (same Chrome profile as the dashboard) OR append &token=<WEBHOOK_INTERNAL_TOKEN> to the URL.",
        },
        { status: 401 },
      );
    }
    if (member.role !== "owner") {
      return NextResponse.json({ error: "Owners only" }, { status: 403 });
    }
  }

  const prospectId = request.nextUrl.searchParams.get("prospect_id")?.trim();
  if (!prospectId) {
    return NextResponse.json({ error: "prospect_id is required" }, { status: 400 });
  }

  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return NextResponse.json({ error: "LSQ not configured" }, { status: 500 });
  }

  const baseAuth = `accessKey=${cfg.accessKey}&secretKey=${cfg.secretKey}`;

  const probes: Probe[] = [
    // ── Sanity check: known-working lead route, just to confirm host
    //     + auth + URL building still work end-to-end. ──────────────────
    {
      label: "[sanity] LeadManagement.svc/RetrieveLeadByLeadId (GET)",
      method: "GET",
      path: "/v2/LeadManagement.svc/RetrieveLeadByLeadId",
      queryExtra: `leadId=${encodeURIComponent(prospectId)}`,
    },

    // ── ProspectActivity.svc — every operation name I've seen in
    //     LSQ docs / forums / Postman collections. ───────────────────────
    {
      label: "ProspectActivity.svc/RetrieveByActivitySearch.aspx (POST)",
      method: "POST",
      path: "/v2/ProspectActivity.svc/RetrieveByActivitySearch.aspx",
      body: {
        Parameter: { LeadId: prospectId, ActivityEvent: 0, RemindersOnly: 0 },
        Sorting: { ColumnName: "CreatedOn", Direction: "1" },
        Paging: { PageIndex: 1, PageSize: 10 },
      },
    },
    {
      label: "ProspectActivity.svc/Retrieve_LeadActivities.aspx (POST)",
      method: "POST",
      path: "/v2/ProspectActivity.svc/Retrieve_LeadActivities.aspx",
      body: { LeadId: prospectId, PageIndex: 1, PageSize: 10 },
    },
    {
      label: "ProspectActivity.svc/Activity_RetrieveByActivitySearch.aspx (POST)",
      method: "POST",
      path: "/v2/ProspectActivity.svc/Activity_RetrieveByActivitySearch.aspx",
      body: {
        Parameter: { LeadId: prospectId, ActivityEvent: 0 },
        Paging: { PageIndex: 1, PageSize: 10 },
      },
    },
    {
      label: "ProspectActivity.svc/Activity_RetrieveAll.aspx (POST)",
      method: "POST",
      path: "/v2/ProspectActivity.svc/Activity_RetrieveAll.aspx",
      body: { LeadId: prospectId, PageIndex: 1, PageSize: 10 },
    },

    // ── LeadManagement.svc activity routes ────────────────────────────
    {
      label: "LeadManagement.svc/Lead.GetActivities.aspx (POST)",
      method: "POST",
      path: "/v2/LeadManagement.svc/Lead.GetActivities.aspx",
      body: { LeadId: prospectId, PageIndex: 1, PageSize: 10 },
    },
    {
      label: "LeadManagement.svc/Lead_GetActivities.aspx (POST)",
      method: "POST",
      path: "/v2/LeadManagement.svc/Lead_GetActivities.aspx",
      body: { LeadId: prospectId, PageIndex: 1, PageSize: 10 },
    },
    {
      label: "LeadManagement.svc/RetrieveLeadActivities.aspx (POST)",
      method: "POST",
      path: "/v2/LeadManagement.svc/RetrieveLeadActivities.aspx",
      body: { LeadId: prospectId, PageIndex: 1, PageSize: 10 },
    },

    // ── ProspectActivity, header-based auth (some tenants) ────────────
    {
      label: "ProspectActivity.svc/RetrieveByActivitySearch (POST, header auth)",
      method: "POST",
      path: "/v2/ProspectActivity.svc/RetrieveByActivitySearch",
      body: {
        Parameter: { LeadId: prospectId, ActivityEvent: 0 },
        Paging: { PageIndex: 1, PageSize: 10 },
      },
      authViaHeaders: true,
    },

    // ── Connector REST API (newer LSQ deployments) ────────────────────
    {
      label: "Connector v1/leads/{id}/activities (GET)",
      method: "GET",
      path: `/Connector/v1/leads/${prospectId}/activities`,
    },
    {
      label: "Connector Activity/Get (POST)",
      method: "POST",
      path: "/Connector/Activity/Get",
      body: { LeadId: prospectId, Page: 1, PageSize: 10 },
    },

    // ── Service-existence probes — no auth, no body. If the service
    //     is enabled at all, we'd get 400 / 401 here, not 404. ─────────
    {
      label: "[probe] /v2/ProspectActivity.svc/ root (GET, no auth)",
      method: "GET",
      path: "/v2/ProspectActivity.svc/",
      skipAuth: true,
    },
    {
      label: "[probe] /v2/ProspectActivity.svc (GET, no auth)",
      method: "GET",
      path: "/v2/ProspectActivity.svc",
      skipAuth: true,
    },
  ];

  const results: ProbeResult[] = [];
  for (const p of probes) {
    let url: string;
    if (p.skipAuth) {
      url = `${cfg.host}${p.path}${p.queryExtra ? `?${p.queryExtra}` : ""}`;
    } else if (p.authViaHeaders) {
      url = `${cfg.host}${p.path}${p.queryExtra ? `?${p.queryExtra}` : ""}`;
    } else {
      const q = p.queryExtra ? `${baseAuth}&${p.queryExtra}` : baseAuth;
      url = `${cfg.host}${p.path}?${q}`;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (p.authViaHeaders) {
      headers["x-LSQ-AccessKey"] = cfg.accessKey;
      headers["x-LSQ-SecretKey"] = cfg.secretKey;
    }

    const started = Date.now();
    let status = 0;
    let bodyText = "";
    try {
      const res = await fetch(url, {
        method: p.method,
        headers,
        body: p.body !== undefined ? JSON.stringify(p.body) : undefined,
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
      status = res.status;
      bodyText = await res.text();
    } catch (e) {
      bodyText = `network error: ${e instanceof Error ? e.message : "unknown"}`;
    }

    const maskedUrl = url.replace(
      /secretKey=[^&]+/,
      `secretKey=${cfg.secretKey.slice(0, 4)}…${cfg.secretKey.slice(-4)}`,
    );
    results.push({
      label: p.label,
      method: p.method,
      url: maskedUrl,
      status,
      body_preview: bodyText.slice(0, 800),
      duration_ms: Date.now() - started,
    });
  }

  return NextResponse.json({
    prospect_id: prospectId,
    host: cfg.host,
    probes: results,
    hint: "Find the row with status=200 and a JSON body. If every row is 404 with empty body, the LSQ tenant likely needs the Activity API enabled by support — paste this whole JSON to your LSQ account manager.",
  });
}
