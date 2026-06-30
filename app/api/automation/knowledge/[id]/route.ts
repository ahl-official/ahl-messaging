// PATCH  /api/automation/knowledge/[id]   — update chunk text/source
// DELETE /api/automation/knowledge/[id]   — drop a chunk
//
// PATCH re-embeds when chunk_text actually changes; if only source
// changes we skip the embed call (cheaper).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { embedText } from "@/lib/embeddings";

export const runtime = "nodejs";
export const maxDuration = 60;

interface PatchBody {
  source?: string;
  chunk_text?: string;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const { id } = await params;
  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data: existing, error: fetchErr } = await admin
    .from("knowledge_chunks")
    .select("id, chunk_text")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Chunk not found" }, { status: 404 });

  const update: Record<string, unknown> = {};
  if (typeof body.source === "string") update.source = body.source.trim() || "general";
  if (typeof body.chunk_text === "string") {
    const text = body.chunk_text.trim();
    if (!text) {
      return NextResponse.json({ error: "chunk_text cannot be empty" }, { status: 400 });
    }
    if (text.length > 8000) {
      return NextResponse.json(
        { error: "chunk_text too long (8000 max)" },
        { status: 400 },
      );
    }
    update.chunk_text = text;
    if (text !== existing.chunk_text) {
      try {
        const embed = await embedText(text);
        update.embedding = embed.vector;
        update.token_count = embed.tokens;
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : "Re-embed failed" },
          { status: 502 },
        );
      }
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data, error } = await admin
    .from("knowledge_chunks")
    .update(update)
    .eq("id", id)
    .select("id, business_phone_number_id, source, chunk_text, token_count, created_at, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ chunk: data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const { id } = await params;
  const admin = createServiceRoleClient();
  const { error } = await admin.from("knowledge_chunks").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
