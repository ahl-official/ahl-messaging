// GET /api/automation/blocked-chats
// Lists chats the AI bot has auto-blocked for repeated off-topic / personal
// messages (contacts.bot_blocked_at is set). Shown in the Automation → AI
// Intent tab so agents can see + clear blocks in one place. Unblocking is
// done via POST /api/contacts/[id]/automation-status.

import { NextResponse } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("contacts")
    .select("id, wa_id, name, profile_name, business_phone_number_id, bot_blocked_at, bot_blocked_reason, offtopic_strikes")
    .not("bot_blocked_at", "is", null)
    .order("bot_blocked_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ chats: data ?? [] });
}
