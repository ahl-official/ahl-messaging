// POST /api/contacts/[id]/typing
// Heartbeat called by MessageInput while a human agent types in this
// chat. Bumps contacts.last_human_typing_at = now(), which the
// automation pipeline consults before firing an AI reply (treats typing
// like a fresh human message — pauses the bot for human_takeover_minutes).

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const admin = createServiceRoleClient();
  const { error } = await admin
    .from("contacts")
    .update({ last_human_typing_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
