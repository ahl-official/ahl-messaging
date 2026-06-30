// POST /api/automation/config/copy
//
// Copies one number's AI Intent setup — persona / system prompt, model +
// behaviour settings, image flow, field mappings AND the RAG knowledge
// chunks — onto another number. Number-specific LSQ attribution (lead
// defaults, activity suffix, FB-ad mappings) is intentionally NOT copied
// — those encode the number itself and must stay per-number.
//
// The target's auto-reply is forced OFF so the copy never starts replying
// to real customers the instant it lands; the operator reviews + enables
// it. Owner/admin only.
//
// Body: { source_business_phone_number_id, target_business_phone_number_id }

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";

export const runtime = "nodejs";

interface Body {
  source_business_phone_number_id?: string;
  target_business_phone_number_id?: string;
}

// Columns never carried across a copy:
//   - row identity (id / bpid / timestamps)
//   - number-specific LSQ attribution. Source / Sub Source / activity
//     suffix / FB-ad mappings are unique to each number (they encode the
//     number itself, e.g. "WA 918679947350"). Copying them would clobber
//     the target's CRM attribution — so the copy carries only the AI
//     Intent setup (persona, model, image flow, RAG), not LSQ defaults.
const SKIP_COLS = new Set([
  "id",
  "business_phone_number_id",
  "created_at",
  "updated_at",
  "lead_defaults",
  "update_lead_fields",
  "activity_note_suffix",
  "update_existing_lead_source",
  "update_existing_lead_max_age_days",
  "lsq_fb_ads_fields",
]);

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

  const source = body.source_business_phone_number_id?.trim();
  const target = body.target_business_phone_number_id?.trim();
  if (!source || !target) {
    return NextResponse.json(
      { error: "source and target business_phone_number_id are required" },
      { status: 400 },
    );
  }
  if (source === target) {
    return NextResponse.json({ error: "Source and target are the same number" }, { status: 400 });
  }

  const admin = createServiceRoleClient();

  // 1. Copy the automation_configs row (every column except identity),
  //    forcing auto-reply OFF on the target.
  const { data: srcConfig, error: srcErr } = await admin
    .from("automation_configs")
    .select("*")
    .eq("business_phone_number_id", source)
    .maybeSingle();
  if (srcErr) {
    return NextResponse.json({ error: srcErr.message }, { status: 500 });
  }
  if (!srcConfig) {
    return NextResponse.json(
      { error: "Source number has no AI config to copy yet" },
      { status: 400 },
    );
  }

  const copyRow: Record<string, unknown> = {
    business_phone_number_id: target,
    enabled: false,
  };
  for (const [k, v] of Object.entries(srcConfig as Record<string, unknown>)) {
    if (SKIP_COLS.has(k) || k === "enabled") continue;
    copyRow[k] = v;
  }

  const { error: upErr } = await admin
    .from("automation_configs")
    .upsert(copyRow, { onConflict: "business_phone_number_id" });
  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  // 2. Copy the RAG knowledge chunks. Replace the target's existing chunks
  //    so a re-copy stays idempotent. Embeddings are carried over as-is
  //    (same text → same vector) — no re-embedding needed.
  const { data: chunks } = await admin
    .from("knowledge_chunks")
    .select("source, chunk_text, embedding, token_count")
    .eq("business_phone_number_id", source);

  await admin.from("knowledge_chunks").delete().eq("business_phone_number_id", target);

  let chunksCopied = 0;
  if (chunks && chunks.length > 0) {
    const rows = (chunks as Array<Record<string, unknown>>).map((c) => ({
      business_phone_number_id: target,
      source: c.source,
      chunk_text: c.chunk_text,
      embedding: c.embedding,
      token_count: c.token_count,
    }));
    const { error: chErr } = await admin.from("knowledge_chunks").insert(rows);
    if (chErr) {
      return NextResponse.json(
        { error: `Config copied, but chunks failed: ${chErr.message}` },
        { status: 500 },
      );
    }
    chunksCopied = rows.length;
  }

  return NextResponse.json({ ok: true, chunks_copied: chunksCopied });
}
