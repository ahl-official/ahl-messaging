// Persists Evolution/WhatsApp media to Supabase Storage.
//
// Baileys hands us the ENCRYPTED WhatsApp CDN url (mmg.whatsapp.net/…enc)
// and that url expires in ~2-3 weeks — after which the media is gone
// from WhatsApp's servers for good. So we must download + store the
// decrypted bytes on receipt; otherwise old photos 404 forever.
//
// Server-only.

import { uploadMediaBytes } from "@/lib/storage";

const SERVER_URL = (process.env.EVOLUTION_SERVER_URL ?? "").replace(/\/$/, "");

/** Downloads the decrypted media for `wamid` from Evolution and uploads
 *  it to the permanent `whatsapp-media` bucket. Returns the public url,
 *  or null if anything fails — the caller then keeps the raw url so the
 *  message row still inserts. */
export async function persistEvolutionMedia(opts: {
  instanceName: string;
  apiKey: string;
  wamid: string;
  mime: string;
  direction: "inbound" | "outbound";
}): Promise<string | null> {
  if (!SERVER_URL) return null;
  try {
    const res = await fetch(
      `${SERVER_URL}/chat/getBase64FromMediaMessage/${encodeURIComponent(
        opts.instanceName,
      )}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: opts.apiKey },
        body: JSON.stringify({
          message: { key: { id: opts.wamid } },
          convertToMp4: false,
        }),
        signal: AbortSignal.timeout(45_000),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { base64?: string; mimetype?: string };
    if (!json.base64) return null;

    const bytes = Buffer.from(json.base64, "base64");
    const { publicUrl } = await uploadMediaBytes(bytes, {
      mime: json.mimetype || opts.mime,
      folder: opts.direction === "inbound" ? "inbound" : "outbound",
      suggestedName: opts.wamid,
    });
    return publicUrl;
  } catch {
    return null;
  }
}
