// POST /api/contacts/refresh-avatars
//
// Body: { contact_ids: string[] }   (cap 50 ids per call)
//
// Batch-fetches WhatsApp profile pictures for a set of Evolution
// contacts and updates contacts.avatar_url for each. Returns a map of
// id → url so the caller (ContactList sidebar) can patch local state
// without a full reload.
//
// Used to bulk-populate the sidebar avatars on first inbox open instead
// of having to wait for each conversation to be opened. Cheap because
// Evolution's fetchProfilePictureUrl is a single round-trip per number;
// we cap concurrency to keep from saturating the upstream.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { fetchProfilePictureUrl } from "@/lib/evolution";
import { getCurrentEffectivePermissions } from "@/lib/permissions";
import { numberAllowed } from "@/lib/permission-types";

export const runtime = "nodejs";

const MAX_IDS = 50;
const CONCURRENCY = 4;

interface Body {
  contact_ids?: string[];
}

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
  const ids = (body.contact_ids ?? []).slice(0, MAX_IDS).filter(Boolean);
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, updated: {} });
  }

  const admin = createServiceRoleClient();
  // Pull contact + business_number details in one go so we can skip
  // Meta contacts (no profile pic via Cloud API) and dedupe instances.
  const { data: contacts } = await admin
    .from("contacts")
    .select(
      "id, wa_id, business_phone_number_id, avatar_url",
    )
    .in("id", ids);
  if (!contacts || contacts.length === 0) {
    return NextResponse.json({ ok: true, updated: {} });
  }

  const bpids = Array.from(
    new Set(
      contacts
        .map((c) => c.business_phone_number_id)
        .filter((x): x is string => typeof x === "string"),
    ),
  );
  const { data: bns } = await admin
    .from("business_numbers")
    .select("phone_number_id, evolution_instance_name, evolution_api_key, provider")
    .in("phone_number_id", bpids);
  const bnByPid = new Map(
    (bns ?? []).map((b) => [b.phone_number_id, b] as const),
  );

  // Per-number permission gate — drop any contact the caller can't
  // see before we start the fetch loop. Owner bypasses.
  const ctx = await getCurrentEffectivePermissions();
  const isOwner = ctx?.member.role === "owner";

  const updated: Record<string, string | null> = {};

  // Pool — drain `tasks` with up to CONCURRENCY workers in parallel
  // so we don't blast Evolution with 50 simultaneous requests.
  const tasks = contacts
    .map((c) => {
      if (c.avatar_url) return null;
      if (!c.business_phone_number_id) return null;
      if (
        !isOwner &&
        ctx &&
        !numberAllowed(ctx.perms, c.business_phone_number_id)
      ) {
        return null;
      }
      const bn = bnByPid.get(c.business_phone_number_id);
      if (
        !bn ||
        bn.provider !== "evolution" ||
        !bn.evolution_instance_name ||
        !bn.evolution_api_key
      ) {
        return null;
      }
      return { contact: c, bn };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  async function worker(): Promise<void> {
    for (;;) {
      const item = tasks.shift();
      if (!item) return;
      try {
        const url = await fetchProfilePictureUrl({
          instanceName: item.bn.evolution_instance_name!,
          apiKey: item.bn.evolution_api_key!,
          jidOrNumber: item.contact.wa_id,
        });
        if (url) {
          await admin
            .from("contacts")
            .update({ avatar_url: url })
            .eq("id", item.contact.id);
          updated[item.contact.id] = url;
        }
      } catch {
        /* per-contact failure shouldn't break the batch */
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()),
  );

  return NextResponse.json({ ok: true, updated });
}
