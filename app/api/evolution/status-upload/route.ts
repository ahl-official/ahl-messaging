// POST /api/evolution/status-upload
//
// Operator picked an image or video to attach to a WhatsApp Status post.
// We stash it in the public `automation-trigger-images` bucket (already
// public, re-used to avoid adding new bucket config) and return the
// public URL. The PostStatusModal then passes that URL to
// /api/evolution/status which forwards to Evolution's sendStatus.
//
// Auth: any signed-in member can upload — the status post itself is
// gated by the operator having access to the Evolution number.
//
// Limits:
//   • images: 5MB        (matches the existing trigger-image cap)
//   • videos: 16MB       (WhatsApp Status caps at ~30s anyway)

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);
const VIDEO_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json(
      { error: "Multipart 'file' is required" },
      { status: 400 },
    );
  }

  const isImage = IMAGE_TYPES.has(file.type);
  const isVideo = VIDEO_TYPES.has(file.type);
  if (!isImage && !isVideo) {
    return NextResponse.json(
      { error: `Unsupported type: ${file.type}` },
      { status: 400 },
    );
  }
  const cap = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (file.size > cap) {
    return NextResponse.json(
      { error: `File too large (max ${cap / (1024 * 1024)}MB)` },
      { status: 400 },
    );
  }

  const ext = file.type.split("/")[1] ?? (isVideo ? "mp4" : "jpg");
  const path = `status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const admin = createServiceRoleClient();
  const { error: uploadErr } = await admin.storage
    .from("automation-trigger-images")
    .upload(path, buffer, {
      contentType: file.type,
      cacheControl: "3600",
      upsert: false,
    });
  if (uploadErr) {
    return NextResponse.json({ error: uploadErr.message }, { status: 500 });
  }

  const {
    data: { publicUrl },
  } = admin.storage.from("automation-trigger-images").getPublicUrl(path);

  return NextResponse.json({
    ok: true,
    url: publicUrl,
    path,
    kind: isVideo ? "video" : "image",
  });
}
