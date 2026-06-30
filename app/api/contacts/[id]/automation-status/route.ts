// GET /api/contacts/[id]/automation-status
// Returns the AI auto-reply state for this specific contact's chat:
//   - enabled         — is automation_configs.enabled true for the
//                       contact's business_phone_number_id?
//   - paused          — is the bot currently held back (human typing
//                       OR human reply within takeover window)?
//   - paused_reason   — "typing" | "recent_reply" | null
//   - resumes_in_sec  — seconds until the takeover window expires
//   - takeover_minutes— configured human_takeover_minutes value
//
// ChatWindow polls this every few seconds to render the "Bot is live"
// vs "Bot paused" pill in the composer.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { AI_SENDER_EMAIL } from "@/lib/automation";

export const runtime = "nodejs";

interface ContactRow {
  id: string;
  business_phone_number_id: string | null;
  last_human_typing_at: string | null;
  bot_blocked_at: string | null;
  bot_blocked_reason: string | null;
}

interface ConfigRow {
  enabled: boolean;
  human_takeover_minutes: number;
}

interface MessageRow {
  timestamp: string;
}

export async function GET(
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
  const { data: contactData } = await admin
    .from("contacts")
    .select("id, business_phone_number_id, last_human_typing_at, bot_blocked_at, bot_blocked_reason")
    .eq("id", id)
    .maybeSingle();
  if (!contactData) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  const contact = contactData as ContactRow;

  // No business number assigned → automation can't run.
  if (!contact.business_phone_number_id) {
    return NextResponse.json({
      enabled: false,
      paused: false,
      paused_reason: null,
      resumes_in_sec: 0,
      takeover_minutes: 0,
      blocked: false,
    });
  }

  // Off-topic block — the bot muted itself for this chat. Surfaced as a
  // distinct banner; a human can still reply manually.
  if (contact.bot_blocked_at) {
    return NextResponse.json({
      enabled: true,
      paused: false,
      paused_reason: null,
      resumes_in_sec: 0,
      takeover_minutes: 0,
      blocked: true,
      blocked_reason: contact.bot_blocked_reason ?? "app_guidelines",
    });
  }

  const { data: cfgData } = await admin
    .from("automation_configs")
    .select("enabled, human_takeover_minutes")
    .eq("business_phone_number_id", contact.business_phone_number_id)
    .maybeSingle();
  const cfg = (cfgData as ConfigRow | null) ?? null;

  if (!cfg || !cfg.enabled) {
    return NextResponse.json({
      enabled: false,
      paused: false,
      paused_reason: null,
      resumes_in_sec: 0,
      takeover_minutes: cfg?.human_takeover_minutes ?? 0,
      blocked: false,
    });
  }

  const windowMs = cfg.human_takeover_minutes * 60 * 1000;
  const now = Date.now();
  let pausedReason: "typing" | "recent_reply" | null = null;
  let pauseEndMs = 0;

  // (a) typing pause
  if (contact.last_human_typing_at) {
    const typingEndMs = new Date(contact.last_human_typing_at).getTime() + windowMs;
    if (typingEndMs > now) {
      pausedReason = "typing";
      pauseEndMs = typingEndMs;
    }
  }

  // (b) recent human reply pause — checked only if not already paused for typing
  if (!pausedReason && cfg.human_takeover_minutes > 0) {
    const cutoff = new Date(now - windowMs).toISOString();
    const { data: recent } = await admin
      .from("messages")
      .select("timestamp, sent_by_email")
      .eq("contact_id", contact.id)
      .eq("direction", "outbound")
      .gt("timestamp", cutoff)
      .order("timestamp", { ascending: false })
      .limit(5);
    const humanRecent = (recent ?? []).find(
      (m) => m.sent_by_email && m.sent_by_email !== AI_SENDER_EMAIL,
    ) as MessageRow | undefined;
    if (humanRecent) {
      const endMs = new Date(humanRecent.timestamp).getTime() + windowMs;
      if (endMs > now) {
        pausedReason = "recent_reply";
        pauseEndMs = endMs;
      }
    }
  }

  return NextResponse.json({
    enabled: true,
    paused: pausedReason !== null,
    paused_reason: pausedReason,
    resumes_in_sec: pauseEndMs > 0 ? Math.max(0, Math.round((pauseEndMs - now) / 1000)) : 0,
    takeover_minutes: cfg.human_takeover_minutes,
    blocked: false,
  });
}

// POST — toggle the bot block for this contact.
//   body { action: "block" }   → mute the bot (agent handles manually)
//   body { action: "unblock" } → resume the bot (default for empty body)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  let action = "unblock";
  try {
    const body = (await request.json()) as { action?: string };
    if (body?.action === "block") action = "block";
  } catch {
    /* empty body → unblock (back-compat) */
  }

  const admin = createServiceRoleClient();
  const patch =
    action === "block"
      ? { bot_blocked_at: new Date().toISOString(), bot_blocked_reason: "manual", offtopic_strikes: 0 }
      : { bot_blocked_at: null, bot_blocked_reason: null, offtopic_strikes: 0 };
  const { error } = await admin.from("contacts").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, blocked: action === "block" });
}
