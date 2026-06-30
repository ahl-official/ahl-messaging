// GET /api/v1/templates/[name]?language=en_US
//
// Inspect an approved template so the operator (or their automation)
// knows exactly which components + parameters to send to avoid Meta's
// 135000 "Generic user error". Returns the body text, header type,
// button list, and which placeholders need to be filled.

import { NextResponse, type NextRequest } from "next/server";
import { bearerFrom, resolveApiToken } from "@/lib/api-tokens";
import { resolveCredsForPhoneNumberId } from "@/lib/portfolios";
import { getApiVersion } from "@/lib/whatsapp";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const bearer = bearerFrom(request.headers);
  if (!bearer) {
    return NextResponse.json(
      { error: "Missing Authorization: Bearer <token>" },
      { status: 401 },
    );
  }
  const tok = await resolveApiToken(bearer);
  if (!tok) {
    return NextResponse.json(
      { error: "Invalid or disabled API token" },
      { status: 401 },
    );
  }
  const creds = await resolveCredsForPhoneNumberId(tok.business_phone_number_id);
  if (!creds?.business_account_id) {
    return NextResponse.json(
      { error: "Portfolio missing business_account_id" },
      { status: 500 },
    );
  }

  const { name } = await params;
  const language = request.nextUrl.searchParams.get("language") ?? "en_US";

  const apiVersion = await getApiVersion();
  const url =
    `https://graph.facebook.com/${apiVersion}/${creds.business_account_id}/message_templates` +
    `?fields=name,language,status,category,components&name=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.access_token}` },
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: Array<{
      name?: string;
      language?: string;
      status?: string;
      components?: Array<Record<string, unknown>>;
    }>;
  };
  const row =
    json.data?.find((t) => t.name === name && t.language === language) ??
    json.data?.[0];
  if (!row) {
    return NextResponse.json(
      { error: `Template '${name}' (lang=${language}) not found on this WABA` },
      { status: 404 },
    );
  }

  // Build a "send shape" — exactly what components[].parameters the
  // caller must include to satisfy this template.
  const required: Array<Record<string, unknown>> = [];
  for (const c of row.components ?? []) {
    const type = (c.type as string | undefined)?.toUpperCase();
    if (type === "HEADER") {
      const fmt = (c.format as string | undefined)?.toUpperCase();
      if (fmt === "TEXT" && typeof c.text === "string" && c.text.includes("{{")) {
        required.push({
          type: "header",
          example: { parameters: [{ type: "text", text: "<your value>" }] },
        });
      } else if (fmt === "IMAGE" || fmt === "VIDEO" || fmt === "DOCUMENT") {
        required.push({
          type: "header",
          example: {
            parameters: [
              {
                type: fmt.toLowerCase(),
                [fmt.toLowerCase()]: { id: "<upload via /api/v1/media>" },
              },
            ],
          },
        });
      }
    }
    if (type === "BODY") {
      const text = (c.text as string | undefined) ?? "";
      const varCount = (text.match(/\{\{\s*\d+\s*\}\}/g) ?? []).length;
      if (varCount > 0) {
        required.push({
          type: "body",
          variables: varCount,
          example: {
            parameters: Array.from({ length: varCount }, (_, i) => ({
              type: "text",
              text: `<var ${i + 1}>`,
            })),
          },
        });
      }
    }
    if (type === "BUTTONS") {
      const btns = (c.buttons as Array<Record<string, unknown>> | undefined) ?? [];
      btns.forEach((b, i) => {
        const bType = (b.type as string | undefined)?.toUpperCase();
        if (bType === "URL" && typeof b.url === "string" && b.url.includes("{{")) {
          required.push({
            type: "button",
            sub_type: "url",
            index: String(i),
            example: { parameters: [{ type: "text", text: "<url variable>" }] },
          });
        }
      });
    }
  }

  return NextResponse.json({
    name: row.name,
    language: row.language,
    status: row.status,
    components: row.components,
    required_send_components: required,
  });
}
