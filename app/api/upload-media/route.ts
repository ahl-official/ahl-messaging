import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { uploadMediaBytes } from "@/lib/storage";
import { getApiVersion } from "@/lib/whatsapp";
import { requireCredsForPhoneNumberId } from "@/lib/portfolios";

export const runtime = "nodejs";

// Meta allowed mime types per message type
const ALLOWED: Record<string, string[]> = {
  image: ["image/jpeg", "image/png"],
  video: ["video/mp4", "video/3gp"],
  audio: ["audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"],
  document: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
  ],
};

// Meta size limits (bytes)
const MAX_SIZE: Record<string, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
};

function kindForMime(mime: string): "image" | "video" | "audio" | "document" | null {
  for (const kind of Object.keys(ALLOWED)) {
    if (ALLOWED[kind].includes(mime)) return kind as "image" | "video" | "audio" | "document";
  }
  return null;
}

export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const phoneNumberId = request.nextUrl.searchParams.get("phone_number_id");
  if (!phoneNumberId) {
    return NextResponse.json(
      { error: "phone_number_id is required (pass it as a query param)" },
      { status: 400 },
    );
  }
  // storage_only=1 → skip the Meta media upload and return just the public
  // URL. Used by rich quick replies (sent as cta_url, which needs a link not a
  // media_id), so the upload works regardless of the number's Meta creds.
  const storageOnly = request.nextUrl.searchParams.get("storage_only") === "1";

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const mime = file.type || "application/octet-stream";
  const kind = kindForMime(mime);
  if (!kind) {
    return NextResponse.json({ error: `Unsupported file type: ${mime}` }, { status: 400 });
  }
  if (file.size > MAX_SIZE[kind]) {
    return NextResponse.json(
      { error: `File too large for ${kind} (${Math.round(MAX_SIZE[kind] / 1024 / 1024)}MB max)` },
      { status: 400 },
    );
  }

  // Read file bytes once — reused for Meta + Supabase upload
  const bytes = await file.arrayBuffer();

  // Mirror to Supabase Storage in PARALLEL with the Meta upload below — it's
  // only used for the dashboard preview, so its failure is non-fatal (resolve
  // to null). Kicked off here so it overlaps the creds lookup + Meta upload
  // instead of running sequentially after them.
  const storagePromise: Promise<string | null> = uploadMediaBytes(bytes, {
    mime,
    folder: "outbound",
    suggestedName: file.name,
  })
    .then((u) => {
      console.log(`[upload-media] ✓ stored to bucket: ${u.publicUrl}`);
      return u.publicUrl as string | null;
    })
    .catch((e) => {
      console.error(
        "[upload-media] ✗ storage upload failed:",
        e instanceof Error ? e.message : e,
        "\n  → Likely cause: Supabase Storage bucket 'whatsapp-media' is missing or not public.",
      );
      return null;
    });

  // Interakt numbers don't use the Meta media graph — Interakt fetches the
  // file from a public URL. Skip the Meta upload (it has no creds for an
  // "interakt:" id and would 502) and return just the public media_url.
  if (phoneNumberId.startsWith("interakt:") || storageOnly) {
    const publicUrl = await storagePromise;
    if (!publicUrl) {
      return NextResponse.json(
        { error: "Storage upload failed — check the 'whatsapp-media' bucket is public." },
        { status: 502 },
      );
    }
    return NextResponse.json({ media_id: null, media_url: publicUrl, kind, mime, filename: file.name, size: file.size });
  }

  // Forward to Meta (for sending via Cloud API)
  const metaForm = new FormData();
  metaForm.append("messaging_product", "whatsapp");
  metaForm.append("type", mime);
  metaForm.append("file", new Blob([bytes], { type: mime }), file.name);

  const [creds, apiVersion] = await Promise.all([
    requireCredsForPhoneNumberId(phoneNumberId),
    getApiVersion(),
  ]);
  const accessToken = creds.access_token;
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/media`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: metaForm,
  });
  const json = (await res.json()) as { id?: string; error?: { message?: string } };

  // Wait for the (parallel) storage mirror before responding so the persisted
  // row gets a real media_url. Meta is the success gate — a storage miss just
  // means publicUrl=null, never a failed send.
  const publicUrl = await storagePromise;

  if (!res.ok || !json.id) {
    return NextResponse.json(
      { error: json.error?.message ?? `Meta upload failed (${res.status})` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    media_id: json.id,
    media_url: publicUrl,
    kind,
    mime,
    filename: file.name,
    size: file.size,
  });
}
