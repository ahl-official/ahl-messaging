// POST /api/contacts/[id]/avatar    — upload a new avatar (multipart)
// PUT  /api/contacts/[id]/avatar    — point avatar at an existing URL
//                                     (used by "Set as profile" on
//                                      photos already cached in our
//                                      public bucket — saves the
//                                      double-upload round trip)
// DELETE /api/contacts/[id]/avatar  — remove the current avatar
//
// Stores the file in the public `contact-avatars` Supabase Storage
// bucket and writes the resulting public URL to contacts.avatar_url so
// every consumer (contact list, chat header, contact-details panel)
// can render <img src=...> without a signed-URL round trip.
//
// Auth: any signed-in team member (operators routinely add patient
// photos during triage). Service-role client used for storage + DB
// writes; we validate role at the request boundary.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB ceiling — patient face shots fit easily.
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: contactId } = await params;
  if (!contactId) {
    return NextResponse.json({ error: "Contact id is required" }, { status: 400 });
  }

  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json(
      { error: "Multipart 'file' field is required" },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Image too large (max ${MAX_BYTES / (1024 * 1024)}MB)` },
      { status: 400 },
    );
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported type: ${file.type}` },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("id, avatar_url")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  // Use a fresh path each upload — overwriting the same key would let
  // the CDN serve stale bytes. Old files are best-effort deleted below.
  const ext = file.type.split("/")[1] ?? "jpg";
  const path = `${contactId}/${Date.now()}.${ext}`;

  const buffer = Buffer.from(await file.arrayBuffer());
  const { error: uploadErr } = await admin.storage
    .from("contact-avatars")
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
  } = admin.storage.from("contact-avatars").getPublicUrl(path);

  // Best-effort delete old object — don't block on it.
  if (contact.avatar_url) {
    const oldPath = extractStoragePath(contact.avatar_url);
    if (oldPath) {
      void admin.storage.from("contact-avatars").remove([oldPath]);
    }
  }

  const { error: updateErr } = await admin
    .from("contacts")
    .update({ avatar_url: publicUrl })
    .eq("id", contactId);
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, avatar_url: publicUrl });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: contactId } = await params;
  if (!contactId) {
    return NextResponse.json({ error: "Contact id is required" }, { status: 400 });
  }

  let body: { url?: string };
  try {
    body = (await request.json()) as { url?: string };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const url = body.url?.trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json(
      { error: "url is required and must be http(s)" },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  const { error } = await admin
    .from("contacts")
    .update({ avatar_url: url })
    .eq("id", contactId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, avatar_url: url });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: contactId } = await params;
  if (!contactId) {
    return NextResponse.json({ error: "Contact id is required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("id, avatar_url")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  if (contact.avatar_url) {
    const path = extractStoragePath(contact.avatar_url);
    if (path) {
      void admin.storage.from("contact-avatars").remove([path]);
    }
  }

  const { error } = await admin
    .from("contacts")
    .update({ avatar_url: null })
    .eq("id", contactId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

/** Extract `<contactId>/<timestamp>.ext` from a Supabase public URL.
 *  Public URLs look like:
 *    https://<proj>.supabase.co/storage/v1/object/public/contact-avatars/<path>
 *  We just slice everything after `/contact-avatars/`. */
function extractStoragePath(url: string): string | null {
  const marker = "/contact-avatars/";
  const idx = url.indexOf(marker);
  if (idx < 0) return null;
  return url.slice(idx + marker.length);
}
