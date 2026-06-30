// POST /api/v1/media — relay multipart media upload to Meta.
//
// Same auth as /api/v1/messages. Caller posts a multipart/form-data
// body with at least `file` (the bytes) and `type` (the mime, e.g.
// image/jpeg). We forward the multipart payload to Meta and return its
// { id } response — that id can then be used as media_id in a
// subsequent /api/v1/messages call.

import { NextResponse, type NextRequest } from "next/server";
import { bearerFrom, resolveApiToken } from "@/lib/api-tokens";
import { resolveCredsForPhoneNumberId } from "@/lib/portfolios";
import { getApiVersion } from "@/lib/whatsapp";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
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

  // Forward the original multipart form to Meta. We re-build the
  // FormData rather than streaming the request body straight through —
  // it's simpler and lets us inject `messaging_product` if the caller
  // forgot. Files are kept as Blobs so we don't load the whole thing
  // into a string.
  let incoming: FormData;
  try {
    incoming = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400 },
    );
  }
  if (!incoming.get("file")) {
    return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 });
  }

  const out = new FormData();
  for (const [k, v] of incoming.entries()) out.append(k, v);
  if (!out.has("messaging_product")) out.append("messaging_product", "whatsapp");

  const creds = await resolveCredsForPhoneNumberId(tok.business_phone_number_id);
  if (!creds) {
    return NextResponse.json(
      {
        error: `No portfolio creds configured for phone_number_id ${tok.business_phone_number_id}`,
      },
      { status: 500 },
    );
  }
  const apiVersion = await getApiVersion();
  const url = `https://graph.facebook.com/${apiVersion}/${tok.business_phone_number_id}/media`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.access_token}` },
    body: out,
  });
  const json = await res.json().catch(() => ({}));
  return NextResponse.json(json, { status: res.status });
}
