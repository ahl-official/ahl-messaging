// GET /api/evolution/media/[wamid]
//
// Streams the decrypted binary of one Evolution-sourced WhatsApp media
// message back to the browser. Reason: the URL Baileys stores on the
// imageMessage / videoMessage / audioMessage payload (and that lands
// in our `messages.media_url` column) is the ENCRYPTED CDN URL —
// fetching it raw returns ciphertext that no <img> can render. The
// real decrypted bytes are accessible only via Evolution's
// `/chat/getBase64FromMediaMessage/<instance>` endpoint, which needs
// the instance API key.
//
// We look the message up by wa_message_id → resolve its bpid →
// resolve the Evolution instance + per-instance api key → ask
// Evolution for the base64 → stream the decoded bytes back with the
// correct Content-Type. Browser then renders the <img> normally.
//
// Caching: public, 1-hour browser cache by Content-Disposition (the
// underlying media is immutable per wamid). No on-disk persistence
// yet — that lives in Supabase storage as a follow-up.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { getEffectivePermissionsFor } from "@/lib/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVER_URL = (process.env.EVOLUTION_SERVER_URL ?? "").replace(/\/$/, "");

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ wamid: string }> },
) {
  const { wamid } = await params;
  if (!wamid) {
    return NextResponse.json({ error: "wamid required" }, { status: 400 });
  }

  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceRoleClient();
  // Look up the message → know which instance to fetch from + which
  // bpid to gate against.
  const { data: msg } = await admin
    .from("messages")
    .select("wa_message_id, business_phone_number_id, type, media_mime_type")
    .eq("wa_message_id", wamid)
    .maybeSingle();
  if (!msg) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  // Permission gate: the caller must be allowed to see this number,
  // otherwise a teammate with no access to bpid X could still pull
  // media by guessing wa_message_ids.
  const perms = await getEffectivePermissionsFor(me);
  if (
    perms.allowed_number_ids !== null &&
    !perms.allowed_number_ids.includes(
      msg.business_phone_number_id as string,
    )
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: bn } = await admin
    .from("business_numbers")
    .select("provider, evolution_instance_name, evolution_api_key")
    .eq("phone_number_id", msg.business_phone_number_id)
    .maybeSingle();
  if (!bn || bn.provider !== "evolution" || !bn.evolution_instance_name || !bn.evolution_api_key) {
    return NextResponse.json(
      { error: "Not an Evolution-sourced message" },
      { status: 400 },
    );
  }
  if (!SERVER_URL) {
    return NextResponse.json(
      { error: "Evolution not configured" },
      { status: 500 },
    );
  }

  // Evolution v2: POST /chat/getBase64FromMediaMessage/<instance>
  // body: { message: { key: { id: <wamid> } }, convertToMp4: false }
  // returns: { base64: "<...>", mimetype: "image/jpeg", fileName?: ... }
  // Some older forks shape the body as { id: <wamid> } directly — we
  // try the canonical v2 form; fall back on a 400 to the legacy shape.
  async function ask(bodyShape: Record<string, unknown>): Promise<Response> {
    return fetch(
      `${SERVER_URL}/chat/getBase64FromMediaMessage/${encodeURIComponent(
        bn!.evolution_instance_name as string,
      )}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: bn!.evolution_api_key as string,
        },
        body: JSON.stringify(bodyShape),
        signal: AbortSignal.timeout(30_000),
      },
    );
  }

  let upstream: Response;
  try {
    upstream = await ask({
      message: { key: { id: wamid } },
      convertToMp4: false,
    });
    if (!upstream.ok && upstream.status === 400) {
      // Legacy fork shape
      upstream = await ask({ id: wamid, convertToMp4: false });
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Network error" },
      { status: 502 },
    );
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json(
      {
        error: `Evolution HTTP ${upstream.status}: ${text.slice(0, 200)}`,
      },
      { status: 502 },
    );
  }
  const json = (await upstream.json()) as {
    base64?: string;
    mimetype?: string;
  };
  if (!json.base64) {
    return NextResponse.json(
      { error: "Evolution returned no media payload" },
      { status: 502 },
    );
  }

  const buf = Buffer.from(json.base64, "base64");
  const contentType =
    json.mimetype || msg.media_mime_type || "application/octet-stream";
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(buf.length),
      // wa_message_id is immutable, so 1 h public cache is safe and
      // keeps the inbox scroll snappy when the operator scrolls back.
      "Cache-Control": "public, max-age=3600, immutable",
    },
  });
}
