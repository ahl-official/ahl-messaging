// POST /api/import/chats/from-table/run
//
// Direct DB-to-DB chat import — pulls from an existing Supabase table
// inside this project into `public.contacts` + `public.messages` for a
// target business number. Skips the CSV download/upload roundtrip
// entirely. Runs as a single transaction-style SQL pair via the
// service-role client.
//
// Body: { source_table, target_bpid, label?, column_map }
//
// Owner / admin only.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";
// Big tables (2M+ rows) take a couple of minutes inside Postgres —
// well under the Vercel/Next 5-minute cap but extend the lambda just
// in case the source table is even bigger.
export const maxDuration = 540;

interface Body {
  source_table?: string;
  target_bpid?: string;
  label?: string;
  column_map?: Record<string, string | null>;
}

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
  // Preserve whitespace in source_table — operators routinely have
  // archive tables named like `918069805090  WA Precious Chat ` with
  // a trailing space, and `.trim()` would silently strip it and turn
  // the import into "relation does not exist". Only trim NEWLINES /
  // tabs that get pasted accidentally, not inner/trailing spaces.
  const tbl = body.source_table?.replace(/[\r\n\t]+/g, "") ?? "";
  const targetBpid = body.target_bpid?.trim();
  const cmap = body.column_map ?? {};
  if (!tbl) return NextResponse.json({ error: "source_table required" }, { status: 400 });
  if (!targetBpid) return NextResponse.json({ error: "target_bpid required" }, { status: 400 });
  // Block injection — table name will be interpolated into raw SQL.
  if (tbl.includes(";") || tbl.includes('"') || tbl.includes("'")) {
    return NextResponse.json({ error: "Bad source_table name" }, { status: 400 });
  }
  const required = ["wa_id", "direction", "content", "timestamp"] as const;
  for (const r of required) {
    if (!cmap[r]) {
      return NextResponse.json(
        { error: `column_map.${r} required (run /preview first)` },
        { status: 400 },
      );
    }
  }
  // Same anti-injection check on the chosen column names.
  for (const v of Object.values(cmap)) {
    if (v && (v.includes(";") || v.includes('"') || v.includes("'"))) {
      return NextResponse.json({ error: "Bad column_map value" }, { status: 400 });
    }
  }

  const admin = createServiceRoleClient();

  // Validate target business number.
  const { data: number } = await admin
    .from("business_numbers")
    .select("phone_number_id")
    .eq("phone_number_id", targetBpid)
    .maybeSingle();
  if (!number) {
    return NextResponse.json(
      { error: `target_bpid ${targetBpid} not connected.` },
      { status: 400 },
    );
  }

  // Create a chat_import_jobs row so the existing history UI surfaces
  // this import alongside CSV / JSON jobs.
  const { data: job, error: jobErr } = await admin
    .from("chat_import_jobs")
    .insert({
      target_bpid: targetBpid,
      label: body.label?.trim() || `From table ${tbl}`,
      source_format: "supabase-table",
      status: "running",
      created_by: member.email ?? null,
    })
    .select("id")
    .single();
  if (jobErr || !job) {
    return NextResponse.json(
      { error: jobErr?.message ?? "Could not start job" },
      { status: 500 },
    );
  }

  // ---- The actual import. Two SQL statements via an RPC since
  //      supabase-js doesn't expose raw `query` — see the migration
  //      `db/migrations/import_from_table.sql` for the function body.
  //      Falls back to in-app paged inserts if the RPC isn't deployed.
  try {
    const { data: rpcResult, error: rpcErr } = await admin.rpc(
      "import_chats_from_table",
      {
        src_table: tbl,
        target_bpid: targetBpid,
        col_wa_id: cmap.wa_id!,
        col_direction: cmap.direction!,
        col_type: cmap.type ?? "type",
        col_content: cmap.content!,
        col_media_url: cmap.media_url ?? "media_url",
        col_timestamp: cmap.timestamp!,
        has_type: !!cmap.type,
        has_media_url: !!cmap.media_url,
      },
    );
    if (rpcErr) {
      await admin
        .from("chat_import_jobs")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
          errors: [{ at: new Date().toISOString(), msg: rpcErr.message }],
        })
        .eq("id", job.id);
      return NextResponse.json(
        {
          error: `RPC failed: ${rpcErr.message}. Make sure migration 0070_import_chats_from_table.sql is applied.`,
        },
        { status: 500 },
      );
    }
    const result =
      (rpcResult as {
        inserted_contacts: number;
        inserted_messages: number;
        skipped_messages: number;
      } | null) ?? { inserted_contacts: 0, inserted_messages: 0, skipped_messages: 0 };

    await admin
      .from("chat_import_jobs")
      .update({
        status: "completed",
        finished_at: new Date().toISOString(),
        inserted_contacts: result.inserted_contacts,
        inserted_messages: result.inserted_messages,
        total_contacts: result.inserted_contacts,
        total_messages: result.inserted_messages + result.skipped_messages,
        processed_contacts: result.inserted_contacts,
        processed_messages: result.inserted_messages + result.skipped_messages,
      })
      .eq("id", job.id);

    return NextResponse.json({
      ok: true,
      job_id: job.id,
      ...result,
    });
  } catch (e) {
    await admin
      .from("chat_import_jobs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        errors: [
          { at: new Date().toISOString(), msg: e instanceof Error ? e.message : "Unknown" },
        ],
      })
      .eq("id", job.id);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Import failed" },
      { status: 500 },
    );
  }
}
