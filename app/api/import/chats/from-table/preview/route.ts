// POST /api/import/chats/from-table/preview
//
// Read-only probe of an existing Supabase table so the operator can
// confirm shape + row counts BEFORE running the actual import. No
// data is written — UI uses the response to fill a preview card.
//
// Body: { source_table: string }
//
// Returns:
//   { ok, total_rows, distinct_contacts, sample, column_map, warnings }
//
// Owner / admin only — this also doubles as a "does the table exist /
// am I authorised to read it" check.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";

interface Body {
  source_table?: string;
}

// Columns the importer EXPECTS to find on the source. We accept a few
// common aliases so old per-number archive tables and chat-export
// dumps both work without a hand-mapped column list.
const COLUMN_CANDIDATES: Record<string, string[]> = {
  wa_id: ["wa_id", "phone", "from", "to", "contact_phone", "session_id"],
  direction: ["direction"],
  type: ["type", "message_type"],
  content: ["content", "body", "text", "message"],
  media_url: ["media_url", "url", "media"],
  timestamp: ["timestamp", "ts", "created_at", "sent_at", "occurred_at"],
};

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
  // Keep inner / trailing spaces — they're significant in Postgres
  // identifiers. Only strip stray newlines / tabs from accidental
  // paste. Whitespace-tolerant resolution below handles other drift.
  const tbl = body.source_table?.replace(/[\r\n\t]+/g, "") ?? "";
  if (!tbl) {
    return NextResponse.json({ error: "source_table required" }, { status: 400 });
  }
  // Whitelist what's reachable — only `public` schema, no schema-prefix
  // shenanigans. Operators paste plain table names like
  //   `918069805090  WA Precious Chat `
  // (yes, with spaces and trailing space — Supabase Studio allows it).
  // We keep the literal name and quote it later.
  if (tbl.includes(";") || tbl.includes('"') || tbl.includes("'")) {
    return NextResponse.json(
      { error: "Table name can't contain quotes or semicolons." },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();

  // 1) Resolve the table name. Whitespace counts in Postgres
  // identifiers (`"abc  def "` ≠ `"abc def"`), and operators almost
  // never copy the exact spacing. Look up the closest match via the
  // `list_public_tables` RPC (PostgREST doesn't expose
  // information_schema directly, so we shim it).
  let resolvedTbl = tbl;
  {
    const { data: rpcTbls, error: rpcTblsErr } = await admin.rpc(
      "list_public_tables",
    );
    if (rpcTblsErr || !rpcTbls) {
      return NextResponse.json(
        {
          error:
            "Could not list tables (migration 0070_import_chats_from_table.sql may not be applied yet). Apply it via Supabase SQL editor and retry.",
        },
        { status: 500 },
      );
    }
    const all = (rpcTbls as Array<{ table_name: string }>).map((r) => r.table_name);
    const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    const want = norm(tbl);
    const exact = all.find((n) => n === tbl);
    const fuzzy = all.find((n) => norm(n) === want);
    if (exact) resolvedTbl = exact;
    else if (fuzzy) resolvedTbl = fuzzy;
    else {
      const first = tbl.split(/\s+/)[0]?.toLowerCase() ?? "";
      return NextResponse.json(
        {
          error: `Table "${tbl}" not found in public schema. Spaces are significant — copy the exact name from the Table Editor sidebar.`,
          similar_tables: all
            .filter((n) => first && n.toLowerCase().includes(first))
            .slice(0, 5),
        },
        { status: 404 },
      );
    }
  }

  // 2) Column discovery via information_schema. Tells us which of our
  //    candidate column names actually exist on the source so the
  //    importer can build a safe INSERT … SELECT.
  const { data: cols, error: colErr } = await admin
    .from("information_schema.columns" as never)
    .select("column_name, data_type")
    .eq("table_schema", "public")
    .eq("table_name", resolvedTbl);
  // Supabase JS does NOT support information_schema directly via PostgREST
  // unless exposed; fall back to a raw RPC if the above failed.
  let columnSet: Set<string>;
  if (colErr || !cols) {
    const { data: rpcCols, error: rpcErr } = await admin.rpc(
      "get_columns",
      { schema_name: "public", tbl_name: resolvedTbl },
    );
    if (rpcErr || !rpcCols) {
      // Last-ditch: try one row from the table and read its keys. Works
      // even without an RPC, just slower.
      const { data: one, error: oneErr } = await admin
        .from(resolvedTbl as never)
        .select("*")
        .limit(1);
      if (oneErr) {
        return NextResponse.json(
          {
            error: `Could not read table "${tbl}": ${oneErr.message}. Make sure the name is exact (spaces matter).`,
          },
          { status: 404 },
        );
      }
      const row = (one ?? [])[0] as Record<string, unknown> | undefined;
      columnSet = new Set(Object.keys(row ?? {}));
    } else {
      columnSet = new Set(
        (rpcCols as Array<{ column_name: string }>).map((c) => c.column_name),
      );
    }
  } else {
    columnSet = new Set(
      (cols as Array<{ column_name: string }>).map((c) => c.column_name),
    );
  }

  // 2) Resolve each canonical field → actual source column name.
  const columnMap: Record<string, string | null> = {};
  for (const [canonical, aliases] of Object.entries(COLUMN_CANDIDATES)) {
    columnMap[canonical] = aliases.find((a) => columnSet.has(a)) ?? null;
  }
  const warnings: string[] = [];
  for (const required of ["wa_id", "direction", "content", "timestamp"]) {
    if (!columnMap[required]) {
      warnings.push(
        `Required column "${required}" not found on source (tried: ${COLUMN_CANDIDATES[required].join(", ")}).`,
      );
    }
  }

  // 3) Row count + distinct contacts. Use head:'exact' so we get an
  //    accurate total instead of a 1000-row page cap.
  const { count: totalRows } = await admin
    .from(resolvedTbl as never)
    .select("*", { count: "exact", head: true });

  let distinctContacts: number | null = null;
  if (columnMap.wa_id) {
    // No clean way to do COUNT(DISTINCT) via PostgREST. Pull up to
    // 50k wa_ids and dedupe in app. 50k is generous; if the source
    // has more we cap honestly and warn.
    const { data: phones } = await admin
      .from(resolvedTbl as never)
      .select(columnMap.wa_id)
      .limit(50_000);
    const set = new Set<string>();
    for (const row of (phones ?? []) as unknown as Array<Record<string, unknown>>) {
      const v = row[columnMap.wa_id!];
      if (typeof v === "string" && v) {
        const digits = v.replace(/\D/g, "");
        if (digits.length >= 7) set.add(digits);
      }
    }
    distinctContacts = set.size;
    if ((phones ?? []).length === 50_000) {
      warnings.push(
        "Distinct contact count capped at 50,000 — the real number may be higher.",
      );
    }
  }

  // 4) Sample 10 rows for the preview card.
  const sampleCols = Object.values(columnMap).filter(Boolean) as string[];
  const { data: sample } = await admin
    .from(resolvedTbl as never)
    .select(sampleCols.join(", ") || "*")
    .limit(10);

  return NextResponse.json({
    ok: true,
    source_table: resolvedTbl,
    resolved_from: tbl !== resolvedTbl ? tbl : null,
    total_rows: totalRows ?? 0,
    distinct_contacts: distinctContacts,
    column_map: columnMap,
    sample: sample ?? [],
    warnings,
  });
}
