// POST /api/evolution/instances/[name]/sync-history
//
// Manual history backfill for an Evolution instance. Pulls messages
// straight from Evolution's own DB and bulk-inserts them into ours.
//
// Why this is its own ingest path (not the webhook handler): the webhook
// is per-message (4 SQL queries each — contact upsert, dupe check, insert,
// last_message update). For a 1,800-message backfill that's 7,200 round
// trips and we were running 5+ minutes. This endpoint batches:
//   - one contacts upsert per page (~5 queries for 100 messages instead of 100)
//   - one messages upsert per page (1 query / page, dedupes by wa_message_id)
//   - one last_message update per unique contact at the very end
//
// Same dedupe guarantee as the webhook (messages.wa_message_id is UNIQUE
// in migration 0001) so re-running this is safe.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { getCredential } from "@/lib/credentials";
import {
  findMessages,
  isEvolutionConfigured,
  jidToWaId,
} from "@/lib/evolution";
import {
  decodeMessage,
  mapEvolutionStatus,
  type EvoMessageData,
} from "@/app/api/evolution/webhook/[name]/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // up to 5 min for very large backfills

// Bigger page = fewer round trips to Evolution (the dominant latency).
// 1000 keeps the payload manageable while cutting requests 5× vs 200.
const PAGE_SIZE = 1000;
// Number of pages we fetch from Evolution in parallel. Evolution handles
// concurrent reads fine on its own DB; the bottleneck is per-request
// overhead, so 3 parallel pages roughly triples throughput.
const PARALLEL_PAGES = 3;

type LastMsgCache = Map<
  string, // wa_id
  { ts: string; preview: string; direction: "inbound" | "outbound"; status: string }
>;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  // Auth: accept either a logged-in owner/superadmin OR the shared
  // WEBHOOK_INTERNAL_TOKEN (lets /api/cron/nightly-sync trigger this
  // route without spinning up a user session).
  const authHeader = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  const expected = await getCredential("webhook_internal_token");
  const internalOk = !!expected && authHeader === expected;
  if (!internalOk) {
    const me = await getCurrentMember();
    if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (me.role !== "owner" && me.role !== "superadmin") {
      return NextResponse.json(
        { error: "Owner / superadmin only" },
        { status: 403 },
      );
    }
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json(
      { error: "Evolution not configured" },
      { status: 500 },
    );
  }
  const { name } = await params;

  const admin = createServiceRoleClient();
  const { data: bn } = await admin
    .from("business_numbers")
    .select(
      "phone_number_id, evolution_instance_name, evolution_api_key, provider",
    )
    .eq("evolution_instance_name", name)
    .maybeSingle();
  if (!bn || bn.provider !== "evolution" || !bn.evolution_api_key) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  const bpid = bn.phone_number_id;
  const apiKey = bn.evolution_api_key as string;

  // Tracks the latest message per contact across the whole backfill so we
  // can update contacts.last_message_* in a single pass at the end —
  // running an UPDATE per message would re-introduce the per-row latency
  // the bulk path is designed to eliminate.
  const lastByWaId: LastMsgCache = new Map();

  const MAX_PAGES = 500;
  let pagesFetched = 0;
  let totalIngested = 0;
  let totalReported = 0;

  try {
    // Probe page 1 first — gives us both the data AND the totalPages /
    // total reported counts. After that we fan out the remaining pages
    // in parallel batches so we don't serially wait on Evolution.
    const first = await findMessages({
      instanceName: name,
      apiKey,
      page: 1,
      pageSize: PAGE_SIZE,
    });
    const firstWrapper = first.messages ?? {};
    const firstRecords = Array.isArray(firstWrapper.records)
      ? (firstWrapper.records as EvoMessageData[])
      : [];
    totalReported = firstWrapper.total ?? 0;
    const totalPages = Math.min(firstWrapper.pages ?? 1, MAX_PAGES);
    pagesFetched = 1;
    if (firstRecords.length > 0) {
      totalIngested += await ingestPage(admin, bpid, firstRecords, lastByWaId);
    }

    // Remaining pages 2..totalPages in parallel batches.
    for (let start = 2; start <= totalPages; start += PARALLEL_PAGES) {
      const batch = [];
      for (
        let p = start;
        p < start + PARALLEL_PAGES && p <= totalPages;
        p += 1
      ) {
        batch.push(
          findMessages({
            instanceName: name,
            apiKey,
            page: p,
            pageSize: PAGE_SIZE,
          }),
        );
      }
      const results = await Promise.all(batch);
      pagesFetched += results.length;

      // Concat batch results and ingest in one shot — keeps each
      // contacts/messages upsert big enough to amortise round-trip
      // overhead.
      const merged: EvoMessageData[] = [];
      for (const res of results) {
        const records = Array.isArray(res.messages?.records)
          ? (res.messages!.records as EvoMessageData[])
          : [];
        merged.push(...records);
      }
      if (merged.length === 0) break;
      totalIngested += await ingestPage(admin, bpid, merged, lastByWaId);
    }

    // Flush last_message_* per contact in one round trip per contact. We
    // resolve contact ids once with a single in-list query so we don't
    // hit the DB twice per chat.
    if (lastByWaId.size > 0) {
      const waIds = Array.from(lastByWaId.keys());
      const { data: contactRows } = await admin
        .from("contacts")
        .select("id, wa_id")
        .eq("business_phone_number_id", bpid)
        .in("wa_id", waIds);
      const idByWa = new Map(
        (contactRows ?? []).map((r) => [r.wa_id as string, r.id as string]),
      );
      await Promise.all(
        Array.from(lastByWaId.entries()).map(([wa, m]) => {
          const id = idByWa.get(wa);
          if (!id) return Promise.resolve();
          return admin
            .from("contacts")
            .update({
              last_message_at: m.ts,
              last_message_preview: m.preview.slice(0, 120),
              last_message_direction: m.direction,
              last_message_status: m.status,
            })
            .eq("id", id);
        }),
      );
    }
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Backfill failed",
        pages_fetched: pagesFetched,
        ingested: totalIngested,
      },
      { status: 502 },
    );
  }

  console.log(
    `[sync-history] instance=${name} bpid=${bpid} pages=${pagesFetched} ingested=${totalIngested} reported_total=${totalReported}`,
  );

  return NextResponse.json({
    ok: true,
    instance: name,
    pages_fetched: pagesFetched,
    ingested: totalIngested,
    evolution_total: totalReported,
  });
}

// One page of messages → at most 3 SQL round trips (contacts upsert,
// messages upsert, contact-id resolve happens in the final flush above).
async function ingestPage(
  admin: ReturnType<typeof createServiceRoleClient>,
  bpid: string,
  records: EvoMessageData[],
  lastByWaId: LastMsgCache,
): Promise<number> {
  // 1. De-dupe + transform records → message rows. Group contacts by waId.
  type Prepared = {
    waId: string;
    wamid: string;
    direction: "inbound" | "outbound";
    type: string;
    content: string | null;
    mediaUrl: string | null;
    mediaMime: string | null;
    status: string;
    tsIso: string;
    pushName: string | null;
  };
  const prepared: Prepared[] = [];
  const contactsByWaId = new Map<string, { pushName: string | null }>();

  for (const m of records) {
    const remoteJid = m.key?.remoteJid;
    const wamid = m.key?.id;
    if (!remoteJid || !wamid) continue;
    if (remoteJid.endsWith("@g.us")) continue; // skip groups
    // Only ingest genuine 1:1 chats. Allowlist the individual-JID
    // suffixes — anything else (privacy/Linked-ID @lid, broadcast,
    // status, channels/newsletter) leaks in as garbage 15-digit
    // "numbers" and pollutes LSQ with fake leads (718 of them at
    // QHT last we checked). Webhook already had this filter; the
    // bulk backfill path was missing it.
    if (
      !remoteJid.endsWith("@s.whatsapp.net") &&
      !remoteJid.endsWith("@c.us")
    ) {
      continue;
    }
    const waId = jidToWaId(remoteJid);
    const direction = m.key?.fromMe ? "outbound" : "inbound";
    const tsNum =
      typeof m.messageTimestamp === "string"
        ? parseInt(m.messageTimestamp, 10)
        : (m.messageTimestamp ?? Math.floor(Date.now() / 1000));
    const tsIso = new Date(tsNum * 1000).toISOString();
    const { type, content, mediaUrl, mediaMime } = decodeMessage(m);
    const status = mapEvolutionStatus(m.status, direction);

    prepared.push({
      waId,
      wamid,
      direction,
      type,
      content,
      mediaUrl,
      mediaMime,
      status,
      tsIso,
      pushName: m.pushName ?? null,
    });

    // Newest pushName wins (it's the most recent display name we saw).
    if (!contactsByWaId.has(waId)) {
      contactsByWaId.set(waId, { pushName: m.pushName ?? null });
    } else if (m.pushName) {
      contactsByWaId.set(waId, { pushName: m.pushName });
    }

    // Track latest per contact for the final last_message_* flush.
    const prev = lastByWaId.get(waId);
    if (!prev || tsIso > prev.ts) {
      lastByWaId.set(waId, {
        ts: tsIso,
        preview: content || `[${type}]`,
        direction,
        status,
      });
    }
  }

  if (prepared.length === 0) return 0;

  // 2. Bulk upsert contacts (one query). onConflict on the existing
  //    (wa_id, business_phone_number_id) unique index from migration 0001.
  const contactRows = Array.from(contactsByWaId.entries()).map(([wa, c]) => ({
    wa_id: wa,
    business_phone_number_id: bpid,
    name: c.pushName,
    profile_name: c.pushName,
    status: "open" as const,
  }));
  const { data: upsertedContacts, error: cErr } = await admin
    .from("contacts")
    .upsert(contactRows, {
      onConflict: "wa_id,business_phone_number_id",
      ignoreDuplicates: false,
    })
    .select("id, wa_id");
  if (cErr || !upsertedContacts) {
    throw new Error(`Contacts upsert failed: ${cErr?.message ?? "unknown"}`);
  }
  const idByWa = new Map(
    upsertedContacts.map((r) => [r.wa_id as string, r.id as string]),
  );

  // 3. Bulk insert messages (one query). messages.wa_message_id is UNIQUE
  //    (migration 0001), so onConflict + ignoreDuplicates makes re-runs
  //    a no-op for already-ingested rows.
  const messageRows = prepared
    .map((p) => {
      const cid = idByWa.get(p.waId);
      if (!cid) return null;
      return {
        contact_id: cid,
        wa_message_id: p.wamid,
        direction: p.direction,
        type: p.type,
        content: p.content,
        media_url: p.mediaUrl,
        media_mime_type: p.mediaMime,
        status: p.status,
        timestamp: p.tsIso,
        business_phone_number_id: bpid,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (messageRows.length === 0) return 0;

  const { error: mErr } = await admin
    .from("messages")
    .upsert(messageRows, {
      onConflict: "wa_message_id",
      ignoreDuplicates: true,
    });
  if (mErr) {
    throw new Error(`Messages upsert failed: ${mErr.message}`);
  }

  return messageRows.length;
}
