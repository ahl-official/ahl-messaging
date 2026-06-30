// POST /api/evolution/status
//
// Post a WhatsApp Status (24-hour "story") from an Evolution number.
// Only valid on provider='evolution' rows — Meta Cloud API doesn't
// expose Status at all, so we reject upfront when the number is Meta.
//
// Body: {
//   phone_number_id: string,           // which business number to post from
//   type: "text" | "image" | "video" | "audio",
//   content: string,                   // text body OR public media URL
//   caption?: string,                  // media caption (image/video)
//   background_color?: string,         // text-only — hex e.g. "#075E54"
//   font?: 0|1|2|3|4|5,                // text-only — font index
// }

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { sendStatus, type StatusType } from "@/lib/evolution";
import { getCurrentEffectivePermissions } from "@/lib/permissions";
import { numberAllowed } from "@/lib/permission-types";

export const runtime = "nodejs";

interface PostBody {
  phone_number_id?: string;
  type?: StatusType;
  content?: string;
  caption?: string;
  background_color?: string;
  font?: number;
}

const VALID_TYPES: StatusType[] = ["text", "image", "video", "audio"];

export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const pnid = body.phone_number_id?.trim();
  if (!pnid) {
    return NextResponse.json(
      { error: "phone_number_id is required" },
      { status: 400 },
    );
  }
  const type = body.type;
  if (!type || !VALID_TYPES.includes(type)) {
    return NextResponse.json(
      { error: `type must be one of: ${VALID_TYPES.join(", ")}` },
      { status: 400 },
    );
  }
  const content = body.content?.trim();
  if (!content) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }
  if (type === "text" && content.length > 1024) {
    return NextResponse.json(
      { error: "Text status too long (1024 chars max)" },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  const { data: row } = await admin
    .from("business_numbers")
    .select("provider, evolution_instance_name, evolution_api_key")
    .eq("phone_number_id", pnid)
    .maybeSingle();
  if (!row) {
    return NextResponse.json({ error: "Number not found" }, { status: 404 });
  }
  if (
    row.provider !== "evolution" ||
    !row.evolution_instance_name ||
    !row.evolution_api_key
  ) {
    return NextResponse.json(
      {
        error:
          "Status is only supported on Evolution (unofficial) numbers. Meta Cloud API doesn't expose the Status surface.",
      },
      { status: 400 },
    );
  }

  // Per-number gate — Status posting broadcasts under the number's
  // brand to its entire saved-contacts list. Operators restricted to
  // specific numbers must not be able to post a Status on a number
  // outside their allowed list. Owner bypasses.
  const ctx = await getCurrentEffectivePermissions();
  if (
    ctx &&
    ctx.member.role !== "owner" &&
    !numberAllowed(ctx.perms, pnid)
  ) {
    return NextResponse.json(
      { error: "Forbidden — number not in your allowed list" },
      { status: 403 },
    );
  }

  try {
    const r = await sendStatus({
      instanceName: row.evolution_instance_name,
      apiKey: row.evolution_api_key,
      type,
      content,
      caption: body.caption?.trim() || undefined,
      backgroundColor:
        type === "text" ? body.background_color?.trim() || undefined : undefined,
      font: type === "text" && typeof body.font === "number" ? body.font : undefined,
      allContacts: true,
      // Bound each attempt so a hung instance returns a fast 502 instead
      // of blocking the route (and the bulk-status worker) indefinitely.
      timeoutMs: 45_000,
    });

    // Log this post so the dashboard's "Recent statuses" list has
    // something to render — Evolution's API doesn't expose a "list my
    // posted statuses" endpoint, so we mirror it ourselves.
    await admin.from("evolution_status_posts").insert({
      business_phone_number_id: pnid,
      posted_by_user_id: user.id,
      posted_by_email: user.email ?? null,
      type,
      content_preview:
        type === "text" ? content.slice(0, 200) : body.caption?.trim() ?? null,
      media_url: type === "text" ? null : content,
      background_color: type === "text" ? body.background_color ?? null : null,
      wa_message_id: r.key?.id ?? null,
    });

    return NextResponse.json({ ok: true, wa_message_id: r.key?.id ?? null });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Status post failed" },
      { status: 502 },
    );
  }
}

// GET /api/evolution/status
//
// • ?phone_number_id=<id>  → post log for that one number (used by
//                             the per-number Post Status modal).
// • ?all=1                 → post log across ALL Evolution numbers,
//                             joined with the number's nickname/phone
//                             so the cross-number "Recent statuses"
//                             panel on the Numbers page can label rows.
// • ?range=24h|7d|30d|all   → time window (default 7d). The 24h
//                             window matches WhatsApp's status TTL
//                             (after which the status is gone on the
//                             viewer side) but operators want to see
//                             historical posts they made too — hence
//                             the wider default.
export async function GET(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const pnid = request.nextUrl.searchParams.get("phone_number_id");
  const all = request.nextUrl.searchParams.get("all") === "1";
  if (!pnid && !all) {
    return NextResponse.json(
      { error: "Pass either phone_number_id=<id> or all=1" },
      { status: 400 },
    );
  }

  const range = (request.nextUrl.searchParams.get("range") ?? "7d").toLowerCase();
  const cutoff = (() => {
    if (range === "all") return null;
    const h =
      range === "24h"
        ? 24
        : range === "7d"
          ? 24 * 7
          : range === "30d"
            ? 24 * 30
            : 24 * 7;
    return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
  })();

  const admin = createServiceRoleClient();

  if (all) {
    // Join through business_numbers so each row carries the label/phone
    // the operator recognises (instance name alone is opaque).
    let q = admin
      .from("evolution_status_posts")
      .select(
        `id, business_phone_number_id, type, content_preview, media_url, background_color, posted_at, expires_at, posted_by_email, wa_message_id, seen_count, last_views_synced_at,
         business_numbers!inner ( nickname, verified_name, display_phone_number, provider )`,
      )
      .order("posted_at", { ascending: false })
      .limit(100);
    if (cutoff) q = q.gte("posted_at", cutoff);
    const { data, error } = await q;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    // Supabase typegen represents the joined row as an array even when
    // the FK is one-to-one (here, via business_phone_number_id). Pick
    // the first (and only) element.
    interface NumberFK {
      nickname: string | null;
      verified_name: string | null;
      display_phone_number: string | null;
      provider: string | null;
    }
    interface Joined {
      id: string;
      business_phone_number_id: string;
      type: string;
      content_preview: string | null;
      media_url: string | null;
      background_color: string | null;
      posted_at: string;
      expires_at: string;
      posted_by_email: string | null;
      wa_message_id: string | null;
      seen_count: number | null;
      last_views_synced_at: string | null;
      business_numbers: NumberFK[] | NumberFK | null;
    }
    const posts = ((data as unknown as Joined[]) ?? [])
      .map((r) => ({
        ...r,
        bn: Array.isArray(r.business_numbers)
          ? r.business_numbers[0] ?? null
          : r.business_numbers,
      }))
      .filter((r) => r.bn?.provider === "evolution")
      .map((r) => ({
        id: r.id,
        business_phone_number_id: r.business_phone_number_id,
        number_label:
          r.bn?.nickname?.trim() ||
          r.bn?.verified_name ||
          r.bn?.display_phone_number ||
          r.business_phone_number_id,
        type: r.type,
        content_preview: r.content_preview,
        media_url: r.media_url,
        background_color: r.background_color,
        posted_at: r.posted_at,
        expires_at: r.expires_at,
        posted_by_email: r.posted_by_email,
        wa_message_id: r.wa_message_id,
        seen_count: r.seen_count ?? 0,
        last_views_synced_at: r.last_views_synced_at,
      }));
    return NextResponse.json({ posts });
  }

  let q = admin
    .from("evolution_status_posts")
    .select(
      "id, type, content_preview, media_url, background_color, posted_at, expires_at, posted_by_email, wa_message_id, seen_count, last_views_synced_at",
    )
    .eq("business_phone_number_id", pnid!)
    .order("posted_at", { ascending: false })
    .limit(50);
  if (cutoff) q = q.gte("posted_at", cutoff);
  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ posts: data ?? [] });
}
