// POST /api/voice-note  (multipart: file)
//   → stores a recorded voice note in Supabase Storage and returns its public
//     URL. Used by the composer's mic button. The URL is then sent via
//     /api/send-message (kind=media, media_kind=audio) which dispatches to the
//     right provider — Evolution sendWhatsAppAudio, Meta audio, or Interakt.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { uploadMediaBytes } from "@/lib/storage";

export const runtime = "nodejs";

const MAX = 16 * 1024 * 1024; // 16MB

export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });
  if (!file.type.startsWith("audio/")) return NextResponse.json({ error: "audio file required" }, { status: 400 });
  if (file.size > MAX) return NextResponse.json({ error: "Voice note too large (16MB max)" }, { status: 400 });

  try {
    const bytes = await file.arrayBuffer();
    const { publicUrl } = await uploadMediaBytes(bytes, {
      mime: file.type,
      folder: "outbound",
      suggestedName: "voice",
    });
    if (!publicUrl) throw new Error("storage upload returned no URL");
    return NextResponse.json({ media_url: publicUrl, kind: "audio", mime: file.type });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Voice upload failed (check the 'whatsapp-media' bucket is public)." },
      { status: 502 },
    );
  }
}
