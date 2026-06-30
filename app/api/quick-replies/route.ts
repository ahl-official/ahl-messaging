import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface QuickReplyRow {
  id: string;
  shortcut: string;
  body: string;
  business_phone_number_ids: string[];
  created_by: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
}

// =====================================================================
// GET — list quick replies, optionally scoped to one business number.
// When `?phone_number_id=<id>` is set we return rows that target that
// number AND rows with an empty number list (global snippets). Without
// the param we return everything (used by the manager UI's full view).
// =====================================================================
export async function GET(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const phoneNumberId = request.nextUrl.searchParams
    .get("phone_number_id")
    ?.trim();

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("quick_replies")
    .select("*")
    .order("shortcut", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Per-number filter applied in JS — keeps us off PostgREST's array
  // operators, which silently mis-match when the column value isn't
  // exactly the form they expect. The table is tiny (≤ few hundred
  // rows) so the cost is negligible.
  const rows = (data ?? []) as QuickReplyRow[];
  const scoped = phoneNumberId
    ? rows.filter((r) =>
        Array.isArray(r.business_phone_number_ids) &&
        r.business_phone_number_ids.includes(phoneNumberId),
      )
    : rows;
  return NextResponse.json({ quick_replies: scoped });
}

// =====================================================================
// POST — create a new quick reply
// =====================================================================
interface CreateBody {
  shortcut?: string;
  body?: string;
  business_phone_number_ids?: string[];
  media_url?: string | null;
  media_kind?: "image" | "video" | null;
  button_text?: string | null;
  button_url?: string | null;
  buttons?: Array<{ type?: string; text?: string; url?: string }>;
}

const cleanStr = (v: unknown) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s || null;
};

// WhatsApp free-form: up to 3 reply buttons OR one URL button (not mixed).
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
  // Reply buttons take precedence; a URL button can't coexist with them.
  return [...replies, ...(urlBtn ? [urlBtn] : [])];
}

export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let input: CreateBody;
  try {
    input = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  // Strip leading slashes only — operators often paste "/hours". Case +
  // arbitrary characters preserved so the shortcut can be anything they
  // can type into the composer's slash-trigger.
  // DB constraint: ^[a-z0-9_-]{1,40}$ — normalise so "My Reply" → "my_reply"
  // instead of failing the insert with a check-constraint error.
  const shortcut = (input.shortcut ?? "")
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
  const body = input.body?.trim() ?? "";
  const bpids = Array.isArray(input.business_phone_number_ids)
    ? Array.from(
        new Set(
          input.business_phone_number_ids
            .map((s) => String(s).trim())
            .filter(Boolean),
        ),
      )
    : [];

  if (shortcut.length === 0 || shortcut.length > 40) {
    return NextResponse.json(
      { error: "Shortcut is required and must be ≤ 40 chars." },
      { status: 400 },
    );
  }
  if (body.length === 0 || body.length > 10000) {
    return NextResponse.json(
      { error: "Body is required and must be ≤ 10000 chars." },
      { status: 400 },
    );
  }
  if (bpids.length === 0) {
    return NextResponse.json(
      { error: "Pick at least one business number to add this snippet to." },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("quick_replies")
    .insert({
      shortcut,
      body,
      business_phone_number_ids: bpids,
      media_url: cleanStr(input.media_url),
      media_kind: input.media_kind === "video" ? "video" : input.media_kind === "image" ? "image" : null,
      button_text: cleanStr(input.button_text),
      button_url: cleanStr(input.button_url),
      buttons: sanitizeButtons(input.buttons),
      created_by: user.id,
      created_by_email: user.email ?? null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: `A quick reply with shortcut "/${shortcut}" already exists.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ quick_reply: data as QuickReplyRow });
}
