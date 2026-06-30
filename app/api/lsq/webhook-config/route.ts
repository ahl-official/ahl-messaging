// LSQ webhook management — owner-only. Powers the LeadSquared card.
//
//   GET    /api/lsq/webhook-config        → list webhooks + status
//   POST   /api/lsq/webhook-config        → create a named webhook  {name}
//   DELETE /api/lsq/webhook-config?id=...  → remove a webhook
//
// LSQ fires one webhook per event type, so the operator creates one
// named endpoint per event (Stage Change, Ownership Change, …).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import {
  listLsqWebhooks,
  addLsqWebhook,
  deleteLsqWebhook,
  type LsqWebhookEntry,
} from "@/lib/lsq-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reconstruct the public origin from proxy headers (live runs behind
 *  nginx on wa.hairmedindia.com). */
function originOf(request: NextRequest): string {
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    request.nextUrl.host;
  return `${proto}://${host}`;
}

function shape(request: NextRequest, w: LsqWebhookEntry) {
  return {
    id: w.id,
    name: w.name,
    url: `${originOf(request)}/api/lsq/webhook/${w.secret}`,
    created_at: w.created_at,
    last_received_at: w.last_received_at,
    event_count: w.event_count,
    connected: !!w.last_received_at,
    last_payload: w.last_payload ?? null,
    last_payload_at: w.last_payload_at ?? null,
  };
}

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  const list = await listLsqWebhooks();
  return NextResponse.json(
    { webhooks: list.map((w) => shape(request, w)) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }

  let name = "";
  try {
    const body = (await request.json()) as { name?: string };
    name = (body?.name ?? "").trim();
  } catch {
    /* empty body → default name */
  }
  if (!name) name = "Webhook";
  if (name.length > 60) name = name.slice(0, 60);

  const entry = await addLsqWebhook(name);
  return NextResponse.json({ webhook: shape(request, entry) });
}

export async function DELETE(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  await deleteLsqWebhook(id);
  return NextResponse.json({ ok: true });
}
