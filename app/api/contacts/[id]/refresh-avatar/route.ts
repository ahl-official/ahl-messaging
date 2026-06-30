// POST /api/contacts/[id]/refresh-avatar
//
// Pulls the WhatsApp profile picture for an Evolution-side contact
// from Baileys and caches it on contacts.avatar_url. Called silently
// from the chat header / contact card when avatar_url is missing.
//
// Only works for contacts on Evolution numbers — Meta Cloud API
// doesn't expose contact profile pics.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { fetchProfilePictureUrl } from "@/lib/evolution";
import { getCurrentEffectivePermissions } from "@/lib/permissions";
import { numberAllowed } from "@/lib/permission-types";

export const runtime = "nodejs";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("id, wa_id, business_phone_number_id")
    .eq("id", id)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  if (!contact.wa_id) {
    return NextResponse.json({ ok: true, avatar_url: null });
  }

  // Per-number gate — operators restricted to specific numbers must
  // not be able to refresh / read avatars of contacts on numbers they
  // can't see. Owner bypasses (matches the export + send routes).
  if (contact.business_phone_number_id) {
    const ctx = await getCurrentEffectivePermissions();
    if (
      ctx &&
      ctx.member.role !== "owner" &&
      !numberAllowed(ctx.perms, contact.business_phone_number_id)
    ) {
      return NextResponse.json(
        { error: "Forbidden — number not in your allowed list" },
        { status: 403 },
      );
    }
  }

  const { data: bn } = await admin
    .from("business_numbers")
    .select("evolution_instance_name, evolution_api_key, provider")
    .eq("phone_number_id", contact.business_phone_number_id ?? "")
    .maybeSingle();
  if (
    !bn ||
    bn.provider !== "evolution" ||
    !bn.evolution_instance_name ||
    !bn.evolution_api_key
  ) {
    // Meta contact — no avatar fetch path. Caller falls back to initials.
    return NextResponse.json({ ok: true, avatar_url: null });
  }

  const url = await fetchProfilePictureUrl({
    instanceName: bn.evolution_instance_name,
    apiKey: bn.evolution_api_key,
    jidOrNumber: contact.wa_id,
  });

  if (url) {
    await admin
      .from("contacts")
      .update({ avatar_url: url })
      .eq("id", contact.id);
  }

  return NextResponse.json({ ok: true, avatar_url: url });
}
