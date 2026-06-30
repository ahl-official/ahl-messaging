// GET /api/lead-distribution/config  — config (auto-creates default + secret)
// PUT /api/lead-distribution/config  — update enabled / stages / hours

import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";

async function loadOrCreate(admin: ReturnType<typeof createServiceRoleClient>) {
  const { data } = await admin.from("lead_distribution_config").select("*").eq("id", true).maybeSingle();
  if (data) {
    if (!data.webhook_secret) {
      const secret = randomUUID().replace(/-/g, "");
      await admin.from("lead_distribution_config").update({ webhook_secret: secret }).eq("id", true);
      data.webhook_secret = secret;
    }
    return data;
  }
  const secret = randomUUID().replace(/-/g, "");
  const { data: created } = await admin
    .from("lead_distribution_config")
    .insert({ id: true, webhook_secret: secret })
    .select("*")
    .single();
  return created;
}

function webhookUrl(secret: string | null): string {
  if (!secret) return "";
  // Always the live production base so the URL works even when viewed from a
  // local dev server (NEXT_PUBLIC_APP_URL is localhost in dev). Override with
  // LEAD_DIST_WEBHOOK_BASE if the domain ever changes.
  const base = (process.env.LEAD_DIST_WEBHOOK_BASE || "https://wa.americanhairline.com")
    .trim()
    .replace(/\/$/, "");
  return `${base}/api/lead-distribution/webhook/${secret}`;
}

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createServiceRoleClient();
  const config = await loadOrCreate(admin);
  return NextResponse.json({ config, webhook_url: webhookUrl(config?.webhook_secret ?? null) });
}

export async function PUT(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  let body: {
    enabled?: boolean;
    stages?: string[];
    brands?: string[];
    sources?: string[];
    working_start?: string;
    working_end?: string;
    regenerate_secret?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  await loadOrCreate(admin); // ensure row exists
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.enabled === "boolean") update.enabled = body.enabled;
  if (Array.isArray(body.stages)) update.stages = body.stages.map((s) => String(s).trim()).filter(Boolean);
  if (Array.isArray(body.brands)) update.brands = body.brands.map((s) => String(s).trim()).filter(Boolean);
  if (Array.isArray(body.sources)) update.sources = body.sources.map((s) => String(s).trim()).filter(Boolean);
  if (typeof body.working_start === "string") update.working_start = body.working_start.trim() || "10:00";
  if (typeof body.working_end === "string") update.working_end = body.working_end.trim() || "18:30";
  if (body.regenerate_secret) update.webhook_secret = randomUUID().replace(/-/g, "");

  const { data, error } = await admin
    .from("lead_distribution_config")
    .update(update)
    .eq("id", true)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ config: data, webhook_url: webhookUrl(data?.webhook_secret ?? null) });
}
