// GET / PATCH /api/system-settings
//
// App-wide settings — a single row in `public.system_settings` (PK=1).
// Currently only holds the notice-banner config; new toggles slot in as
// extra columns rather than separate tables.
//
// GET is open to any signed-in user (the banner is read by every page
// load via TopBar). PATCH requires admin+ since it changes what every
// teammate sees.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";

export interface SystemSettings {
  notice_banner_text: string | null;
  notice_banner_enabled: boolean;
  notice_banner_tone: "info" | "success" | "warning" | "danger";
}

const DEFAULTS: SystemSettings = {
  notice_banner_text: null,
  notice_banner_enabled: false,
  notice_banner_tone: "info",
};

export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("system_settings")
    .select("notice_banner_text, notice_banner_enabled, notice_banner_tone")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    // Defensive: missing table = use defaults rather than crash the
    // page (operator hasn't run the migration yet).
    return NextResponse.json(DEFAULTS);
  }
  return NextResponse.json({
    ...DEFAULTS,
    ...(data ?? {}),
  } as SystemSettings);
}

interface PatchBody {
  notice_banner_text?: string | null;
  notice_banner_enabled?: boolean;
  notice_banner_tone?: "info" | "success" | "warning" | "danger";
}

export async function PATCH(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const update: Record<string, unknown> = {
    id: 1,
    updated_at: new Date().toISOString(),
    updated_by: member.user_id,
  };
  if (body.notice_banner_text !== undefined) {
    if (
      body.notice_banner_text !== null &&
      typeof body.notice_banner_text !== "string"
    ) {
      return NextResponse.json(
        { error: "notice_banner_text must be a string or null" },
        { status: 400 },
      );
    }
    if (
      typeof body.notice_banner_text === "string" &&
      body.notice_banner_text.length > 500
    ) {
      return NextResponse.json(
        { error: "notice_banner_text too long (500 max)" },
        { status: 400 },
      );
    }
    update.notice_banner_text =
      typeof body.notice_banner_text === "string"
        ? body.notice_banner_text.trim() || null
        : null;
  }
  if (body.notice_banner_enabled !== undefined) {
    update.notice_banner_enabled = !!body.notice_banner_enabled;
  }
  if (body.notice_banner_tone !== undefined) {
    if (
      !["info", "success", "warning", "danger"].includes(
        body.notice_banner_tone,
      )
    ) {
      return NextResponse.json(
        { error: "Invalid tone" },
        { status: 400 },
      );
    }
    update.notice_banner_tone = body.notice_banner_tone;
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("system_settings")
    .upsert(update, { onConflict: "id" })
    .select("notice_banner_text, notice_banner_enabled, notice_banner_tone")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, settings: data });
}
