// POST /api/evolution/instances
// Body: { display_name?: string, memo?: string, portfolio_key?: string }
//
// Creates a new Evolution API instance and a corresponding
// business_numbers row with provider='evolution'. The QR code returned
// here is what the operator scans on their phone to bind the
// WhatsApp account. Connection completes asynchronously — once Evolution
// emits a CONNECTION_UPDATE webhook with state=open we'll patch the
// row's jid / display_phone_number from the webhook handler.
//
// GET /api/evolution/instances?name=<instance>
// Returns latest connection state + QR (if still waiting for scan).
// Front-end polls this every ~2s during the QR modal.
//
// Owner / superadmin only — same gate as Meta number add.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  createInstance,
  getConnectionState,
  reconnectInstance,
  webhookUrlFor,
  isEvolutionConfigured,
} from "@/lib/evolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PostBody {
  /** Optional display label — what shows in the dashboard before
   *  Evolution returns the real WhatsApp profile name. */
  display_name?: string;
  /** Operator memory note — same field as the existing memo on
   *  business_numbers. */
  memo?: string;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (member.role !== "owner" && member.role !== "superadmin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json(
      {
        error:
          "Evolution not configured. Set EVOLUTION_SERVER_URL + EVOLUTION_GLOBAL_API_KEY in .env.local.",
      },
      { status: 500 },
    );
  }

  let body: PostBody = {};
  try {
    body = (await request.json()) as PostBody;
  } catch {
    /* empty body is fine */
  }

  const seed = slugify(body.display_name ?? "wa") || "wa";
  // Append a random suffix so two operators creating the same label
  // simultaneously don't collide on Evolution's side.
  const instanceName = `${seed}-${Math.random().toString(36).slice(2, 8)}`;
  const webhookUrl = webhookUrlFor(instanceName);

  let evo;
  try {
    evo = await createInstance({ instanceName, webhookUrl });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Evolution create failed" },
      { status: 502 },
    );
  }

  // Evolution v2 returns the per-instance API key in one of several
  // shapes depending on the build:
  //   v2.1.1: { instance: { ..., hash: "STRING" } }       ← current self-host
  //   older : { hash: "STRING" }
  //   v1.x  : { hash: { apikey: "STRING" } }
  // Normalize across all of them so we don't break when the user
  // upgrades the Evolution image.
  const evoAny = evo as unknown as {
    hash?: string | { apikey?: string };
    instance?: { hash?: string; instanceId?: string };
  };
  const instanceApiKey =
    (typeof evoAny.instance?.hash === "string" ? evoAny.instance.hash : null) ??
    (typeof evoAny.hash === "string" ? evoAny.hash : null) ??
    (typeof evoAny.hash === "object" ? evoAny.hash?.apikey ?? null : null);
  if (!instanceApiKey) {
    return NextResponse.json(
      { error: "Evolution didn't return an instance API key" },
      { status: 502 },
    );
  }

  // Create response doesn't include the QR on v2.1.1 — only `qrcode.count`.
  // The actual base64 lives behind a follow-up GET /instance/connect call,
  // which we fire here so the operator sees the QR immediately without
  // a second client hop. Failure is non-fatal: the UI poll will retry.
  let qrBase64: string | null = evo.qrcode?.base64 ?? null;
  if (!qrBase64) {
    try {
      const r = await reconnectInstance(instanceName);
      qrBase64 = r.base64 ?? null;
    } catch {
      /* poll endpoint will retry */
    }
  }

  // Insert the placeholder row. phone_number_id is required + unique on
  // the existing table — we use a synthetic `evo:<name>` so Meta numbers
  // and Evolution numbers can coexist without colliding. After the QR
  // is scanned, the webhook handler will patch display_phone_number +
  // evolution_jid from the CONNECTION_UPDATE event.
  const admin = createServiceRoleClient();
  const phoneNumberId = `evo:${instanceName}`;
  const { error: insErr } = await admin.from("business_numbers").insert({
    phone_number_id: phoneNumberId,
    display_phone_number: null,
    verified_name: null,
    nickname: body.display_name?.trim() || null,
    memo: body.memo?.trim() || null,
    provider: "evolution",
    evolution_instance_name: instanceName,
    evolution_api_key: instanceApiKey,
    evolution_connection_state: "connecting",
    evolution_last_state_at: new Date().toISOString(),
  });
  if (insErr) {
    return NextResponse.json(
      { error: `DB insert failed: ${insErr.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    phone_number_id: phoneNumberId,
    instance_name: instanceName,
    qr_base64: qrBase64,
    qr_code: evo.qrcode?.code ?? null,
  });
}

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const name = request.nextUrl.searchParams.get("name");
  if (!name) {
    return NextResponse.json(
      { error: "name query param required" },
      { status: 400 },
    );
  }

  // Confirm the caller owns / can see this instance (any member is fine
  // for reading state — we already gate write/delete elsewhere).
  const admin = createServiceRoleClient();
  const { data: row } = await admin
    .from("business_numbers")
    .select(
      "phone_number_id, evolution_connection_state, evolution_jid, display_phone_number",
    )
    .eq("evolution_instance_name", name)
    .maybeSingle();
  if (!row) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  // Live state from Evolution — webhook may not have fired yet right
  // after create. If we're still 'connecting', also pull the latest QR
  // (Evolution rotates it every ~20s).
  let liveState: "open" | "connecting" | "close" = "connecting";
  let qrBase64: string | null = null;
  try {
    const s = await getConnectionState(name);
    liveState = s.instance.state;
    if (liveState !== "open") {
      try {
        const r = await reconnectInstance(name);
        qrBase64 = r.base64 ?? null;
      } catch {
        /* QR endpoint sometimes 404s right after create — non-fatal */
      }
    }
  } catch {
    /* network blip — return whatever we have in DB */
  }

  return NextResponse.json({
    instance_name: name,
    phone_number_id: row.phone_number_id,
    state: liveState,
    qr_base64: qrBase64,
    jid: row.evolution_jid,
    display_phone_number: row.display_phone_number,
  });
}
