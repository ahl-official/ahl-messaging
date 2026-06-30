// GET /api/contacts/[id]/export
//
// Returns the full message thread for a contact as a plain-text file
// formatted like the WhatsApp "Export chat" dump:
//   [DD/MM/YYYY, HH:MM:SS] <Sender>: <message>
//
// Includes inbound + outbound messages, edits, deletions (shown as
// "<This message was deleted>"), and media references (the media itself
// isn't bundled — we point to the public URL so the operator can
// download it separately if they need to).
//
// The response is sent with Content-Disposition: attachment so the
// browser triggers a save dialog with a sensible filename.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentEffectivePermissions } from "@/lib/permissions";
import { numberAllowed } from "@/lib/permission-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** WhatsApp's native format: "[DD/MM/YYYY, HH:MM:SS]". Locale-fixed
 *  so exports from different operators always look identical. */
function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  return `[${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "chat";
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
  if (!id) {
    return NextResponse.json({ error: "contact id required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("id, wa_id, name, profile_name, business_phone_number_id")
    .eq("id", id)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  // Same per-number permission gate the send / delete routes use, so
  // an operator can't bulk-export numbers they aren't assigned to.
  if (contact.business_phone_number_id) {
    const ctx = await getCurrentEffectivePermissions();
    if (
      ctx &&
      ctx.member.role !== "owner" &&
      !numberAllowed(ctx.perms, contact.business_phone_number_id)
    ) {
      return NextResponse.json(
        { error: "Forbidden — number not in your allowed list" },
        { status: 403 },
      );
    }
  }

  const { data: messages, error } = await admin
    .from("messages")
    .select(
      "direction, type, content, media_url, media_mime_type, edited_at, deleted_at, sent_by_email, timestamp",
    )
    .eq("contact_id", id)
    .order("timestamp", { ascending: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const partnerName =
    contact.name?.trim() ||
    contact.profile_name?.trim() ||
    contact.wa_id ||
    "Customer";

  const lines: string[] = [];
  for (const m of messages ?? []) {
    const ts = fmtTimestamp(m.timestamp);
    const sender =
      m.direction === "outbound"
        ? m.sent_by_email ?? "Operator"
        : partnerName;
    let body: string;
    if (m.deleted_at) {
      body = "<This message was deleted>";
    } else if (m.type === "text") {
      body = (m.content ?? "").replace(/\r/g, "");
    } else if (["image", "video", "audio", "document", "sticker"].includes(m.type)) {
      const caption = (m.content ?? "").trim();
      const ref = m.media_url ? ` (${m.media_url})` : "";
      body = `<${m.type}${ref}>${caption ? `\n${caption}` : ""}`;
    } else {
      body = `<${m.type}>${m.content ? `: ${m.content}` : ""}`;
    }
    if (m.edited_at) body += " <edited>";
    lines.push(`${ts} ${sender}: ${body}`);
  }
  const body = lines.join("\n");

  const filename = `chat-${sanitizeFilename(partnerName)}-${contact.wa_id ?? id}.txt`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
