// GET  /api/automation/knowledge?business_phone_number_id=...
// POST /api/automation/knowledge
//
// Knowledge-base chunks for the RAG pipeline. Per business number.
// Embeddings are computed at write time (POST + PATCH) so retrieval
// stays fast and the embedding cost is paid once, not on every reply.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { embedText } from "@/lib/embeddings";

export const runtime = "nodejs";
export const maxDuration = 60;

interface ChunkRow {
  id: string;
  business_phone_number_id: string;
  source: string;
  chunk_text: string;
  token_count: number | null;
  created_at: string;
  updated_at: string;
}

// =====================================================================
// GET — list every chunk for a business number. Embeddings are large
// (1536 floats) so we strip them from the wire payload — the operator
// doesn't need them, just the text + metadata.
// =====================================================================
export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const businessPhoneNumberId = request.nextUrl.searchParams
    .get("business_phone_number_id")
    ?.trim();
  if (!businessPhoneNumberId) {
    return NextResponse.json(
      { error: "business_phone_number_id is required" },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("knowledge_chunks")
    .select("id, business_phone_number_id, source, chunk_text, token_count, created_at, updated_at")
    .eq("business_phone_number_id", businessPhoneNumberId)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const chunks = (data ?? []) as ChunkRow[];
  const totalTokens = chunks.reduce((sum, c) => sum + (c.token_count ?? 0), 0);
  return NextResponse.json({ chunks, total_tokens: totalTokens });
}

// =====================================================================
// POST — create a chunk + embed inline. Body:
//   { business_phone_number_id, source?, chunk_text }
// =====================================================================
interface PostBody {
  business_phone_number_id?: string;
  source?: string;
  chunk_text?: string;
}

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const businessPhoneNumberId = body.business_phone_number_id?.trim();
  const text = (body.chunk_text ?? "").trim();
  const source = (body.source ?? "general").trim() || "general";
  if (!businessPhoneNumberId) {
    return NextResponse.json(
      { error: "business_phone_number_id is required" },
      { status: 400 },
    );
  }
  if (!text) {
    return NextResponse.json({ error: "chunk_text is required" }, { status: 400 });
  }
  if (text.length > 8000) {
    return NextResponse.json(
      { error: "chunk_text too long — split into smaller chunks (8000 char max)" },
      { status: 400 },
    );
  }

  let embed: { vector: number[]; tokens: number };
  try {
    embed = await embedText(text);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Embedding failed" },
      { status: 502 },
    );
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("knowledge_chunks")
    .insert({
      business_phone_number_id: businessPhoneNumberId,
      source,
      chunk_text: text,
      embedding: embed.vector,
      token_count: embed.tokens,
    })
    .select("id, business_phone_number_id, source, chunk_text, token_count, created_at, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ chunk: data });
}
