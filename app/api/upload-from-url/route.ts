import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { uploadMediaBytes } from "@/lib/storage";
import { getCredential } from "@/lib/credentials";
import { getApiVersion } from "@/lib/whatsapp";
import { resolveCredsForPhoneNumberId } from "@/lib/portfolios";

export const runtime = "nodejs";

// Same allow-list as /api/upload-media — kept duplicated rather than imported
// because the two endpoints have different inputs and may diverge.
const ALLOWED: Record<string, string[]> = {
  image: ["image/jpeg", "image/png"],
  video: ["video/mp4", "video/3gp"],
  audio: ["audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"],
  document: ["application/pdf"],
};

function kindForMime(mime: string): "image" | "video" | "audio" | "document" | null {
  for (const kind of Object.keys(ALLOWED)) {
    if (ALLOWED[kind].includes(mime)) return kind as never;
  }
  return null;
}

interface Body {
  url?: string;
  /** Optional template_id — if provided, the resulting Supabase URL is cached
   *  in template_assets so subsequent sends of the same template skip the
   *  download+upload round trip. */
  template_id?: string;
  /** Which business number to upload under — resolves the right portfolio's
   *  Meta creds (multi-portfolio). Falls back to the global env creds. */
  phone_number_id?: string;
}

// =====================================================================
// POST /api/upload-from-url
//
// Downloads a public URL server-side, uploads it as fresh media to Meta
// (so we get a usable `media_id` for sends), and also caches the bytes in
// Supabase Storage so the dashboard has a stable preview URL.
//
// Used when an agent picks "Send approved sample" in the template dialog —
// Meta's own scontent.whatsapp.net URLs aren't fetchable by Meta's send
// infrastructure (they require WhatsApp client auth), so we have to mirror
// the bytes through Storage + Cloud API to get a sendable handle.
// =====================================================================
export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const sourceUrl = body.url?.trim();
  if (!sourceUrl) return NextResponse.json({ error: "url required" }, { status: 400 });

  // Prefer per-number portfolio creds (multi-portfolio). Fall back to the
  // legacy global env creds when no phone_number_id is supplied.
  let phoneNumberId: string | null = null;
  let accessToken: string | null = null;
  const apiVersion = await getApiVersion();
  if (body.phone_number_id?.trim()) {
    const creds = await resolveCredsForPhoneNumberId(body.phone_number_id.trim());
    if (creds) {
      phoneNumberId = body.phone_number_id.trim();
      accessToken = creds.access_token;
    }
  }
  if (!phoneNumberId || !accessToken) {
    [phoneNumberId, accessToken] = await Promise.all([
      getCredential("whatsapp_phone_number_id"),
      getCredential("whatsapp_access_token"),
    ]);
  }
  if (!phoneNumberId || !accessToken) {
    return NextResponse.json(
      { error: "WhatsApp credentials missing — pass phone_number_id or set them in Settings → Credentials" },
      { status: 500 },
    );
  }

  // ---- 1. Fast path: re-use cached Supabase URL ----------------------
  // If we mirrored this same source URL before AND it's tied to a template,
  // we can skip the download. We still need a fresh media_id though, so we
  // can't fully short-circuit — we re-upload from the cached Supabase URL
  // which is safely public and reachable by Meta.
  let storageUrl: string | null = null;
  if (body.template_id) {
    const admin = createServiceRoleClient();
    const { data: cached } = await admin
      .from("template_assets")
      .select("header_url")
      .eq("template_id", body.template_id)
      .maybeSingle();
    // Only re-use the cached URL when it's clearly our own Supabase Storage
    // host — never trust an upstream scontent URL as a "cached" value, since
    // we explicitly want to replace those.
    if (cached?.header_url && /supabase\.co\//i.test(cached.header_url)) {
      storageUrl = cached.header_url;
    }
  }

  // ---- 2. Download the source bytes ----------------------------------
  const downloadFrom = storageUrl ?? sourceUrl;
  let dlRes: Response;
  try {
    dlRes = await fetch(downloadFrom);
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to fetch source: ${e instanceof Error ? e.message : "network error"}` },
      { status: 502 },
    );
  }
  if (!dlRes.ok) {
    return NextResponse.json(
      { error: `Source fetch failed: HTTP ${dlRes.status}` },
      { status: 502 },
    );
  }
  const mime = (dlRes.headers.get("content-type") ?? "").split(";")[0].trim() || "image/jpeg";
  const kind = kindForMime(mime);
  if (!kind) {
    return NextResponse.json({ error: `Unsupported mime: ${mime}` }, { status: 400 });
  }
  const bytes = await dlRes.arrayBuffer();

  // ---- 3. Mirror to Supabase Storage (skip if we already used the cache) -
  if (!storageUrl) {
    try {
      const uploaded = await uploadMediaBytes(bytes, {
        mime,
        folder: "outbound",
        suggestedName: "approved-sample",
      });
      storageUrl = uploaded.publicUrl;
    } catch (e) {
      // Storage failure is non-fatal — Meta upload below will still produce a
      // usable media_id for the immediate send.
      console.error(
        "[upload-from-url] Supabase Storage upload failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // ---- 4. Upload to Meta to get a fresh media_id ----------------------
  const metaForm = new FormData();
  metaForm.append("messaging_product", "whatsapp");
  metaForm.append("type", mime);
  metaForm.append("file", new Blob([bytes], { type: mime }), `sample.${mime.split("/")[1] ?? "bin"}`);

  const metaUploadUrl = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/media`;
  const metaRes = await fetch(metaUploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: metaForm,
  });
  const metaJson = (await metaRes.json()) as { id?: string; error?: { message?: string } };
  if (!metaRes.ok || !metaJson.id) {
    return NextResponse.json(
      { error: metaJson.error?.message ?? `Meta upload failed (${metaRes.status})` },
      { status: 502 },
    );
  }

  // ---- 5. Persist Supabase URL in template_assets so subsequent sends -
  // skip the download step (and so the templates list shows our stable URL).
  if (body.template_id && storageUrl) {
    const admin = createServiceRoleClient();
    // Only write when we actually have a Supabase URL — never overwrite with
    // a scontent URL.
    const isSupabase = /supabase\.co\//i.test(storageUrl);
    if (isSupabase) {
      await admin.from("template_assets").upsert(
        {
          template_id: body.template_id,
          template_name: body.template_id, // best-effort placeholder
          language: "en_US",
          header_format: kind === "image" ? "IMAGE" : kind === "video" ? "VIDEO" : "DOCUMENT",
          header_url: storageUrl,
        },
        { onConflict: "template_id" },
      );
    }
  }

  return NextResponse.json({
    media_id: metaJson.id,
    media_url: storageUrl,
    kind,
    mime,
  });
}
