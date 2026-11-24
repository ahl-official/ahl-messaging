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

/** Strip parameters (`audio/ogg; codecs=opus` → `audio/ogg`). WhatsApp
 *  voice notes always ship codecs in the mime; without this, storage
 *  paths become `file.ogg; codecs=opus` and the upload fails → no
 *  media_url → Whisper never runs. */
export function normalizeMime(mime: string): string {
  return (mime || "").split(";")[0].trim().toLowerCase();
}

export function extForMime(mime: string, fallback = "bin"): string {
  const base = normalizeMime(mime);
  return EXT_FOR_MIME[base] ?? base.split("/")[1] ?? fallback;
}

export interface UploadedMedia {
  path: string; // path in bucket
  publicUrl: string; // permanent public URL
}

let bucketReady: Promise<void> | null = null;

/** Create the public media bucket once if missing (prod had none → every
 *  inbound voice/image download failed with media_url=null). */
async function ensureMediaBucket(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<void> {
  if (!bucketReady) {
    bucketReady = (async () => {
      const { data } = await supabase.storage.listBuckets();
      if ((data ?? []).some((b) => b.name === MEDIA_BUCKET)) return;
      const { error } = await supabase.storage.createBucket(MEDIA_BUCKET, {
        public: true,
        fileSizeLimit: 50 * 1024 * 1024,
      });
      // Race: another process created it — ignore "already exists".
      if (error && !/already exists|duplicate/i.test(error.message)) {
        console.warn("[storage] createBucket:", error.message);
      }
    })().catch((e) => {
      bucketReady = null;
      throw e;
    });
  }
  await bucketReady;
}

export async function uploadMediaBytes(
  bytes: ArrayBuffer | Uint8Array | Blob,
  opts: { mime: string; folder: "inbound" | "outbound"; suggestedName?: string },
): Promise<UploadedMedia> {
  const supabase = createServiceRoleClient();
  await ensureMediaBucket(supabase);
  const mime = normalizeMime(opts.mime) || "application/octet-stream";
  const ext = extForMime(mime);
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
      : new Blob([bytes as ArrayBuffer], { type: mime });

  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, blob, {
    contentType: mime,
    cacheControl: "3600",
    upsert: false,
  });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path);
  return { path, publicUrl: data.publicUrl };
}
