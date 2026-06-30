// GET  /api/evolution/instances/[name]/settings
//   Returns the per-instance Evolution settings (call rejection, read
//   receipts, etc.) so the dashboard can render the current state.
//
// POST /api/evolution/instances/[name]/settings
//   Body: Partial<InstanceSettings> — only the keys the operator
//   actually changed. Evolution merges server-side so omitted keys
//   keep their previous value.
//
// Auth: any signed-in dashboard user can read; admin+ can write
//   (matches the gate on the rest of the Evolution config writes).

import { NextResponse, type NextRequest } from "next/server";
import {
  fetchInstanceSettings,
  updateInstanceSettings,
} from "@/lib/evolution";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

async function resolveInstance(name: string) {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("business_numbers")
    .select("evolution_instance_name, evolution_api_key, provider")
    .eq("evolution_instance_name", name)
    .maybeSingle();
  if (!data || data.provider !== "evolution" || !data.evolution_api_key) {
    return null;
  }
  return {
    instanceName: data.evolution_instance_name as string,
    apiKey: data.evolution_api_key as string,
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const member = await getCurrentMember();
  if (!member) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { name } = await params;
  const inst = await resolveInstance(name);
  if (!inst) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }
  try {
    const settings = await fetchInstanceSettings(inst.instanceName, inst.apiKey);
    return NextResponse.json({ settings });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Fetch failed" },
      { status: 502 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const member = await getCurrentMember();
  if (!member) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  const { name } = await params;
  const inst = await resolveInstance(name);
  if (!inst) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }
  let patch: Record<string, unknown>;
  try {
    patch = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (typeof patch.msgCall === "string" && patch.msgCall.length > 500) {
    return NextResponse.json(
      { error: "msgCall too long (500 chars max)" },
      { status: 400 },
    );
  }
  try {
    await updateInstanceSettings({
      instanceName: inst.instanceName,
      apiKey: inst.apiKey,
      patch,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Update failed" },
      { status: 502 },
    );
  }
}
