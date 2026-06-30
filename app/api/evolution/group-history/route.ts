// POST /api/evolution/group-history  { contactId }
//
// Backfills past messages for one WhatsApp group. The "Sync groups"
// action only creates the group contact rows — message history is
// pulled lazily here the first time an agent opens a group, so we
// never bulk-backfill all 199 groups up front.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { findMessages } from "@/lib/evolution";
import { handleMessageUpsert } from "@/app/api/evolution/webhook/[name]/ingest";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { contactId?: string };
  try {
    body = (await request.json()) as { contactId?: string };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const contactId = body.contactId?.trim();
  if (!contactId) {
    return NextResponse.json({ error: "contactId required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("wa_id, is_group, business_phone_number_id")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact || !contact.is_group) {
    return NextResponse.json({ error: "Not a group" }, { status: 400 });
  }

  const { data: bn } = await admin
    .from("business_numbers")
    .select("evolution_instance_name, evolution_api_key, provider")
    .eq("phone_number_id", contact.business_phone_number_id)
    .maybeSingle();
  if (
    !bn ||
    bn.provider !== "evolution" ||
    !bn.evolution_instance_name ||
    !bn.evolution_api_key
  ) {
    return NextResponse.json(
      { error: "Group is not on an Evolution number" },
      { status: 400 },
    );
  }

  const groupJid = `${contact.wa_id}@g.us`;
  try {
    const page = await findMessages({
      instanceName: bn.evolution_instance_name as string,
      apiKey: bn.evolution_api_key as string,
      remoteJid: groupJid,
      pageSize: 300,
    });
    const records = Array.isArray(page.messages?.records)
      ? (page.messages!.records as Record<string, unknown>[])
      : [];
    if (records.length > 0) {
      // Reuse the exact webhook ingest path — it dedupes on
      // wa_message_id, so re-runs are safe. evo omitted → media keeps
      // its raw url (no inline download) to keep the backfill fast.
      await handleMessageUpsert(
        admin,
        contact.business_phone_number_id as string,
        { messages: records },
      );
    }
    return NextResponse.json({ ok: true, fetched: records.length });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "History sync failed" },
      { status: 502 },
    );
  }
}
