// POST /api/import/chats/batch
//
// Credits a chunk of contacts + messages against an existing import job.
// Idempotent — re-uploading the same batch on resume won't duplicate
// rows (contacts dedup on composite unique (wa_id, business_phone_number_id),
// messages dedup on wa_message_id unique). Caller should keep batches
// under ~500 messages to fit comfortably under the request size limit.
//
// Auth: owner / admin only. The same role that started the job.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { createHash } from "node:crypto";

export const runtime = "nodejs";

interface ImportContact {
  wa_id: string;
  name?: string | null;
  profile_name?: string | null;
  /** Optional override — when set, this contact lands on a different
   *  bpid than the job default. Lets a single import session split
   *  rows across two numbers if you ever need it; uncommon. */
  business_phone_number_id?: string | null;
}

interface ImportMessage {
  wa_id: string;
  /** WhatsApp's message id (wamid.xxx). When missing, we synthesise a
   *  stable `import:<sha>` so re-upload of the same batch is idempotent. */
  wa_message_id?: string | null;
  direction: "inbound" | "outbound";
  type?: string;
  content?: string | null;
  media_url?: string | null;
  media_mime_type?: string | null;
  status?: string | null;
  timestamp: string;
  business_phone_number_id?: string | null;
}

interface Body {
  job_id?: string;
  contacts?: ImportContact[];
  messages?: ImportMessage[];
}

const MAX_MESSAGES_PER_BATCH = 1000;
const MAX_CONTACTS_PER_BATCH = 1000;

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const jobId = body.job_id?.trim();
  if (!jobId) return NextResponse.json({ error: "job_id required" }, { status: 400 });

  const contacts = Array.isArray(body.contacts) ? body.contacts : [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (contacts.length > MAX_CONTACTS_PER_BATCH) {
    return NextResponse.json(
      { error: `Too many contacts (max ${MAX_CONTACTS_PER_BATCH} per batch)` },
      { status: 400 },
    );
  }
  if (messages.length > MAX_MESSAGES_PER_BATCH) {
    return NextResponse.json(
      { error: `Too many messages (max ${MAX_MESSAGES_PER_BATCH} per batch)` },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();

  // Load the job — must be running.
  const { data: job } = await admin
    .from("chat_import_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "Unknown job_id" }, { status: 404 });
  if (job.status !== "running") {
    return NextResponse.json(
      { error: `Job is ${job.status}, not running.` },
      { status: 409 },
    );
  }

  // ------------------ Contacts ------------------
  let insertedContacts = 0;
  if (contacts.length > 0) {
    const rows = contacts
      .map((c) => {
        const waId = (c.wa_id ?? "").replace(/\D/g, "");
        if (!waId) return null;
        return {
          wa_id: waId,
          business_phone_number_id: c.business_phone_number_id ?? job.target_bpid,
          name: (c.name ?? "").trim() || null,
          profile_name: (c.profile_name ?? "").trim() || null,
          status: "open",
          // Flags the contact as a historical chat-import so the inbox
          // can mark it as a past chat (see migration 0057).
          imported: true,
        };
      })
      .filter(Boolean) as Array<Record<string, unknown>>;

    if (rows.length > 0) {
      const { data: upserted, error: cErr } = await admin
        .from("contacts")
        .upsert(rows, {
          onConflict: "wa_id,business_phone_number_id",
          ignoreDuplicates: false,
        })
        .select("id");
      if (cErr) {
        await appendError(admin, jobId, `contacts: ${cErr.message}`);
        return NextResponse.json({ error: cErr.message }, { status: 500 });
      }
      insertedContacts = upserted?.length ?? 0;
    }
  }

  // ------------------ Messages ------------------
  // Resolve contact_id for every wa_id in this batch. Single round-trip
  // per batch — much cheaper than per-message lookup.
  let insertedMessages = 0;
  if (messages.length > 0) {
    const wantedKeys = new Set<string>();
    const byKey = new Map<string, ImportMessage[]>();
    for (const m of messages) {
      const waId = (m.wa_id ?? "").replace(/\D/g, "");
      if (!waId) continue;
      const bpid = m.business_phone_number_id ?? job.target_bpid;
      const key = `${waId}::${bpid}`;
      wantedKeys.add(key);
      const arr = byKey.get(key) ?? [];
      arr.push(m);
      byKey.set(key, arr);
    }
    // Pull existing contact rows for every (wa_id, bpid) we need.
    const waIds = Array.from(new Set(Array.from(wantedKeys).map((k) => k.split("::")[0])));
    const bpids = Array.from(new Set(Array.from(wantedKeys).map((k) => k.split("::")[1])));
    const { data: cRows } = await admin
      .from("contacts")
      .select("id, wa_id, business_phone_number_id")
      .in("wa_id", waIds)
      .in("business_phone_number_id", bpids);
    const idByKey = new Map<string, string>();
    for (const r of cRows ?? []) {
      idByKey.set(`${r.wa_id}::${r.business_phone_number_id}`, r.id);
    }

    // Build message rows. Synthesise wa_message_id when absent so the
    // unique constraint guarantees idempotency on re-upload.
    const msgRows: Array<Record<string, unknown>> = [];
    let skippedBadTimestamp = 0;
    for (const m of messages) {
      const waId = (m.wa_id ?? "").replace(/\D/g, "");
      if (!waId) continue;
      const bpid = m.business_phone_number_id ?? job.target_bpid;
      const contactId = idByKey.get(`${waId}::${bpid}`);
      if (!contactId) continue; // contact didn't exist + wasn't in this batch's contacts

      // Reject rows with missing or unparseable timestamps. The messages
      // table column has `default now()`, so a row passed with timestamp
      // = null/empty/garbage previously landed with the import time
      // baked in — which then promoted those contacts to the top of the
      // inbox forever. Better to drop the bad row and log it than ship
      // a chat-thread with an obviously wrong "now" date on every old
      // message.
      const rawTs = (m.timestamp ?? "").toString().trim();
      const parsedTs = rawTs ? Date.parse(rawTs) : NaN;
      if (!rawTs || Number.isNaN(parsedTs)) {
        skippedBadTimestamp++;
        continue;
      }
      const tsIso = new Date(parsedTs).toISOString();

      const wamid =
        m.wa_message_id?.trim() ||
        // Stable hash → re-running the same batch deduplicates cleanly.
        `import:${createHash("sha256")
          .update(`${contactId}|${tsIso}|${m.direction}|${m.content ?? ""}`)
          .digest("hex")
          .slice(0, 24)}`;

      msgRows.push({
        contact_id: contactId,
        wa_message_id: wamid,
        direction: m.direction,
        type: m.type || "text",
        content: m.content ?? null,
        media_url: m.media_url ?? null,
        media_mime_type: m.media_mime_type ?? null,
        status: m.status ?? "delivered",
        timestamp: tsIso,
        business_phone_number_id: bpid,
      });
    }
    if (skippedBadTimestamp > 0) {
      await appendError(
        admin,
        jobId,
        `${skippedBadTimestamp} message rows dropped — missing or unparseable timestamp`,
      );
    }

    // Use upsert with ignoreDuplicates so re-uploading the same batch is
    // a no-op (relies on the wa_message_id unique constraint).
    if (msgRows.length > 0) {
      const { data: mInserted, error: mErr } = await admin
        .from("messages")
        .upsert(msgRows, { onConflict: "wa_message_id", ignoreDuplicates: true })
        .select("id");
      if (mErr) {
        await appendError(admin, jobId, `messages: ${mErr.message}`);
        return NextResponse.json({ error: mErr.message }, { status: 500 });
      }
      insertedMessages = mInserted?.length ?? 0;
    }
  }

  // Bump counters atomically via SQL fragments would be ideal, but
  // supabase-js doesn't expose that here without an RPC. Two consecutive
  // batches racing the same job will lose ~one increment in the rare
  // worst case — acceptable for a progress UI counter.
  const { data: bumped } = await admin
    .from("chat_import_jobs")
    .update({
      processed_contacts: (job.processed_contacts ?? 0) + contacts.length,
      processed_messages: (job.processed_messages ?? 0) + messages.length,
      inserted_contacts: (job.inserted_contacts ?? 0) + insertedContacts,
      inserted_messages: (job.inserted_messages ?? 0) + insertedMessages,
    })
    .eq("id", jobId)
    .select("*")
    .single();

  return NextResponse.json({
    job: bumped,
    batch: {
      processed_contacts: contacts.length,
      processed_messages: messages.length,
      inserted_contacts: insertedContacts,
      inserted_messages: insertedMessages,
    },
  });
}

async function appendError(
  admin: ReturnType<typeof createServiceRoleClient>,
  jobId: string,
  msg: string,
): Promise<void> {
  try {
    const { data: row } = await admin
      .from("chat_import_jobs")
      .select("errors")
      .eq("id", jobId)
      .maybeSingle();
    const errs = Array.isArray(row?.errors) ? (row!.errors as unknown[]) : [];
    const capped = [...errs, { at: new Date().toISOString(), msg }].slice(-50);
    await admin
      .from("chat_import_jobs")
      .update({ errors: capped })
      .eq("id", jobId);
  } catch {
    /* swallow — diagnostics only */
  }
}
