import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface PatchBody {
  first_name?: string;
  last_name?: string;
}

// =====================================================================
// GET /api/profile — current user's team_members row
// =====================================================================
export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("team_members")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ profile: data });
}

// =====================================================================
// PATCH /api/profile — update first_name + last_name on the current
// user's team_members row. Email + role are managed elsewhere (admin UI).
// =====================================================================
export async function PATCH(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const first = body.first_name?.trim();
  const last = body.last_name?.trim();
  if (!first || !last) {
    return NextResponse.json(
      { error: "Both first name and last name are required." },
      { status: 400 },
    );
  }
  if (first.length > 60 || last.length > 60) {
    return NextResponse.json(
      { error: "Names must be 60 characters or fewer." },
      { status: 400 },
    );
  }
  if (!/^[\p{L}\p{M} '.\-]+$/u.test(first) || !/^[\p{L}\p{M} '.\-]+$/u.test(last)) {
    return NextResponse.json(
      { error: "Names can only contain letters, spaces, apostrophes, dots, and hyphens." },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("team_members")
    .update({
      first_name: first,
      last_name: last,
      // Keep full_name in sync so older code paths still work.
      full_name: `${first} ${last}`,
    })
    .eq("user_id", user.id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ profile: data });
}
