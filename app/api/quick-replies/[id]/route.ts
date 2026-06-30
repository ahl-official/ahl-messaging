import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface PatchBody {
  shortcut?: string;
  body?: string;
  business_phone_number_ids?: string[];
  media_url?: string | null;
  media_kind?: "image" | "video" | null;
  button_text?: string | null;
  button_url?: string | null;
  buttons?: Array<{ type?: string; text?: string; url?: string }>;
}

function sanitizeButtons(input: unknown): Array<{ type: "quick_reply" | "url"; text: string; url?: string }> {
  if (!Array.isArray(input)) return [];
  const replies: Array<{ type: "quick_reply"; text: string }> = [];
  let urlBtn: { type: "url"; text: string; url: string } | null = null;
  for (const b of input as Array<{ type?: string; text?: string; url?: string }>) {
    const text = (b?.text ?? "").trim();
    if (!text) continue;
    if (b.type === "url" && (b.url ?? "").trim()) {
      if (!urlBtn) urlBtn = { type: "url", text: text.slice(0, 20), url: b.url!.trim() };
    } else if (b.type === "quick_reply" && replies.length < 3) {
      replies.push({ type: "quick_reply", text: text.slice(0, 20) });
    }
  }
  return [...replies, ...(urlBtn ? [urlBtn] : [])];
}

// =====================================================================
// PATCH — edit a quick reply
// =====================================================================
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let input: PatchBody;
  try {
    input = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};

  if (input.shortcut !== undefined) {
    const sc = input.shortcut
      .trim()
      .replace(/^\/+/, "")
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_-]/g, "");
    if (sc.length === 0 || sc.length > 40) {
      return NextResponse.json(
        { error: "Shortcut is required and must be ≤ 40 chars." },
        { status: 400 },
      );
    }
    update.shortcut = sc;
  }

  if (input.body !== undefined) {
    const b = input.body.trim();
    if (b.length === 0 || b.length > 10000) {
      return NextResponse.json(
        { error: "Body is required and must be ≤ 10000 chars." },
        { status: 400 },
      );
    }
    update.body = b;
  }

  if (input.business_phone_number_ids !== undefined) {
    const next = Array.isArray(input.business_phone_number_ids)
      ? Array.from(
          new Set(
            input.business_phone_number_ids
              .map((s) => String(s).trim())
              .filter(Boolean),
          ),
        )
      : [];
    if (next.length === 0) {
      return NextResponse.json(
        { error: "Pick at least one business number for this snippet." },
        { status: 400 },
      );
    }
    update.business_phone_number_ids = next;
  }

  // Rich content — empty string clears the field.
  const clean = (v: string | null | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null);
  if (input.media_url !== undefined) update.media_url = clean(input.media_url);
  if (input.media_kind !== undefined) update.media_kind = input.media_kind === "video" ? "video" : input.media_kind === "image" ? "image" : null;
  if (input.button_text !== undefined) update.button_text = clean(input.button_text);
  if (input.button_url !== undefined) update.button_url = clean(input.button_url);
  if (input.buttons !== undefined) update.buttons = sanitizeButtons(input.buttons);

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("quick_replies")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "Another quick reply already uses that shortcut." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ quick_reply: data });
}

// =====================================================================
// DELETE — remove a quick reply
// =====================================================================
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceRoleClient();
  const { error } = await admin.from("quick_replies").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
