// Helpers for uploading WhatsApp media to Supabase Storage so we can render
// previews in the dashboard. Server-only.

import { randomUUID } from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const MEDIA_BUCKET = "whatsapp-media";

const EXT_FOR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/3gp": "3gp",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/amr": "amr",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
};

export function extForMime(mime: string, fallback = "bin"): string {
  return EXT_FOR_MIME[mime] ?? mime.split("/")[1] ?? fallback;
}

export interface UploadedMedia {
  path: string;       // path in bucket
  publicUrl: string;  // permanent public URL
}

export async function uploadMediaBytes(
  bytes: ArrayBuffer | Uint8Array | Blob,
  opts: { mime: string; folder: "inbound" | "outbound"; suggestedName?: string },
): Promise<UploadedMedia> {
  const supabase = createServiceRoleClient();
  const ext = extForMime(opts.mime);
  const safeBase = opts.suggestedName
    ? opts.suggestedName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60)
    : `${Date.now()}`;
  // Use a full UUID for unguessable object paths — the bucket is public-read
  // by path, so weak entropy (timestamp + 6 base36 chars) made objects
  // enumerable. randomUUID() is crypto-strong.
  const path = `${opts.folder}/${randomUUID()}-${safeBase}${safeBase.endsWith("." + ext) ? "" : "." + ext}`;

  const blob =
    bytes instanceof Blob
      ? bytes
      : new Blob([bytes as ArrayBuffer], { type: opts.mime });

  const { error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(path, blob, {
      contentType: opts.mime,
      cacheControl: "3600",
      upsert: false,
    });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path);
  return { path, publicUrl: data.publicUrl };
}
