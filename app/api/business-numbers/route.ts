// GET  /api/business-numbers — list all connected business numbers,
//                              joined with their portfolio assignment.
// POST /api/business-numbers — manually register a new number and
//                              optionally assign it to a portfolio.
// PUT  /api/business-numbers — update a number's nickname.
//
// Owner sees + edits everything. Other roles (admin, superadmin, teammate)
// can read but not edit.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { getEffectivePermissionsFor } from "@/lib/permissions";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { listPortfolios, invalidatePortfolioCache } from "@/lib/portfolios";
import { appendPhoneIdToPortfolio } from "@/lib/env-writer";

export const runtime = "nodejs";

interface DbRow {
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  nickname: string | null;
  memo: string | null;
  is_active: boolean | null;
  created_at: string;
  meta_status?: string | null;
  meta_checked_at?: string | null;
  waba_id?: string | null;
  /** 'meta' (Cloud API, default) or 'evolution' (Baileys / unofficial). */
  provider?: "meta" | "evolution" | null;
  evolution_instance_name?: string | null;
  evolution_jid?: string | null;
  evolution_connection_state?: "open" | "connecting" | "close" | null;
  evolution_group_id?: string | null;
  profile_pic_url?: string | null;
}

/** Build a digits-only key for matching the same phone across
 *  Meta + Evolution rows (display_phone_number may include "+",
 *  spaces, or no formatting at all depending on source). */
function phoneKey(s: string | null | undefined): string | null {
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
}

// =====================================================================
// GET — list numbers + their portfolio_key (resolved from env, since
// portfolio assignment lives in PORTFOLIO_<key>_PHONE_IDS).
//
// The returned `is_active` is per-user: it reflects whether THIS
// operator has the number in their personal `hidden_number_ids` set.
// The row's global business_numbers.is_active is no longer surfaced
// through this endpoint — the UserMenu toggle is a personal preference,
// not a workspace switch.
// =====================================================================
export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Number access scope. Owner sees every number; everyone else only sees the
  // numbers they've been granted (perms.allowed_number_ids). null = all,
  // [] = none. This is what every picker (new chat, magic-message "Send from")
  // and the UserMenu read, so the gate lives here once.
  let allowedNumberIds: string[] | null = null;
  if (member.role !== "owner") {
    const perms = await getEffectivePermissionsFor(member);
    allowedNumberIds = perms.allowed_number_ids;
  }
  if (allowedNumberIds !== null && allowedNumberIds.length === 0) {
    return NextResponse.json({ numbers: [] });
  }

  const admin = createServiceRoleClient();
  let dbQuery = admin
    .from("business_numbers")
    .select("phone_number_id, display_phone_number, verified_name, nickname, memo, is_active, created_at, meta_status, meta_checked_at, waba_id, provider, evolution_instance_name, evolution_jid, evolution_connection_state, evolution_group_id, profile_pic_url")
    .order("created_at", { ascending: true });
  if (allowedNumberIds !== null) {
    dbQuery = dbQuery.in("phone_number_id", allowedNumberIds);
  }
  const { data, error } = await dbQuery;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Reverse-index portfolios so each phone_number_id resolves in O(1).
  const portfolioByPhoneId = new Map<string, { key: string; name: string }>();
  for (const p of listPortfolios()) {
    for (const id of p.phone_number_ids) {
      portfolioByPhoneId.set(id, { key: p.key, name: p.name });
    }
  }

  const hidden = new Set(member.hidden_number_ids ?? []);

  // Sibling lookup — Meta Cloud API doesn't expose profile pictures,
  // so when an operator has the SAME phone connected both as a Meta
  // number (verified template-capable line) and as an Evolution number
  // (Baileys / QR-scanned line), we re-use the Evolution row's cached
  // pic on the Meta row. Match is on digits-only display_phone_number,
  // so "+91 86799 56852" and "918679956852" hit the same key.
  const evoPicByPhone = new Map<string, string>();
  for (const row of (data ?? []) as DbRow[]) {
    if (row.provider !== "evolution") continue;
    if (!row.profile_pic_url) continue;
    const k = phoneKey(row.display_phone_number);
    if (k) evoPicByPhone.set(k, row.profile_pic_url);
  }

  const numbers = ((data ?? []) as DbRow[]).map((row) => {
    const picKey = phoneKey(row.display_phone_number);
    const inheritedPic =
      !row.profile_pic_url && picKey ? evoPicByPhone.get(picKey) ?? null : null;
    return {
      phone_number_id: row.phone_number_id,
      display_phone_number: row.display_phone_number,
      verified_name: row.verified_name,
      nickname: row.nickname,
      // Operator's memory note — separate from `nickname` (which is the
      // display label). Used as a subtitle / chip in the UI.
      memo: row.memo,
      // Per-user view: shown if the user hasn't hidden it. The global
      // row-level is_active is intentionally not multiplied in here so
      // each operator's UserMenu reflects only their own choice.
      is_active: !hidden.has(row.phone_number_id),
      created_at: row.created_at,
      updated_at: row.created_at,
      meta_status: row.meta_status ?? "unknown",
      meta_checked_at: row.meta_checked_at ?? null,
      waba_id: row.waba_id ?? null,
      provider: row.provider ?? "meta",
      evolution_instance_name: row.evolution_instance_name ?? null,
      evolution_jid: row.evolution_jid ?? null,
      evolution_connection_state: row.evolution_connection_state ?? null,
      evolution_group_id: row.evolution_group_id ?? null,
      profile_pic_url: row.profile_pic_url ?? inheritedPic,
      portfolio: portfolioByPhoneId.get(row.phone_number_id) ?? null,
    };
  });

  return NextResponse.json({ numbers });
}

// =====================================================================
// POST — manually register a new business number. Body:
//   { phone_number_id, display_phone_number?, verified_name?, nickname?,
//     portfolio_key? }
// Owner-only. Inserts into business_numbers (idempotent on phone_number_id)
// and, if portfolio_key is supplied, appends the ID to
// PORTFOLIO_<key>_PHONE_IDS via the same env-writer used by the orphan flow.
// =====================================================================
interface PostBody {
  phone_number_id?: string;
  display_phone_number?: string | null;
  verified_name?: string | null;
  nickname?: string | null;
  portfolio_key?: string | null;
}

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const phoneNumberId = body.phone_number_id?.trim();
  if (!phoneNumberId || !/^\d{6,}$/.test(phoneNumberId)) {
    return NextResponse.json(
      { error: "phone_number_id must be a numeric Meta ID" },
      { status: 400 },
    );
  }

  const displayPhoneNumber = body.display_phone_number?.toString().trim() || null;
  const verifiedName = body.verified_name?.toString().trim() || null;
  const nickname = body.nickname?.toString().trim() || null;
  if (nickname && nickname.length > 80) {
    return NextResponse.json({ error: "Nickname too long (80 max)" }, { status: 400 });
  }

  const portfolioKey = body.portfolio_key?.toString().trim() || null;
  if (portfolioKey && !listPortfolios().some((p) => p.key === portfolioKey)) {
    return NextResponse.json(
      { error: `Unknown portfolio: ${portfolioKey}` },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();

  // Guard against silently overwriting a DIFFERENT connected number.
  // The upsert below is keyed on phone_number_id — if the operator
  // mistypes the Meta ID and it collides with a number already on the
  // list, a plain upsert would repoint that row's display/name and the
  // other number would vanish. Block the save with a clear message
  // instead. (A genuine idempotent re-add — same number, e.g. the
  // webhook created a bare row first — still goes through because the
  // phone digits match.)
  const { data: existingRow } = await admin
    .from("business_numbers")
    .select("display_phone_number, verified_name")
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();
  if (existingRow) {
    const onFile = (existingRow.display_phone_number ?? "").replace(/\D/g, "");
    const submitted = (displayPhoneNumber ?? "").replace(/\D/g, "");
    if (onFile && submitted && onFile !== submitted) {
      return NextResponse.json(
        {
          error:
            `This Meta phone-number ID is already connected as ` +
            `"${existingRow.verified_name ?? existingRow.display_phone_number}". ` +
            `Double-check the ID — saving it would overwrite that number.`,
        },
        { status: 409 },
      );
    }
  }

  // Idempotent insert — if the row already exists (e.g. webhook beat us
  // to it), update its display fields instead of erroring.
  const { error: upsertErr } = await admin.from("business_numbers").upsert(
    {
      phone_number_id: phoneNumberId,
      display_phone_number: displayPhoneNumber,
      verified_name: verifiedName,
      nickname,
    },
    { onConflict: "phone_number_id" },
  );
  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  let assignedPersisted: boolean | null = null;
  let assignMessage: string | undefined;
  if (portfolioKey) {
    const result = await appendPhoneIdToPortfolio(portfolioKey, phoneNumberId);
    invalidatePortfolioCache();
    assignedPersisted = result.persisted;
    assignMessage = result.message;
  }

  return NextResponse.json({
    ok: true,
    phone_number_id: phoneNumberId,
    portfolio_key: portfolioKey,
    assigned_persisted: assignedPersisted,
    message: assignMessage,
  });
}

// =====================================================================
// PUT — update mutable number fields. Body:
//   { phone_number_id, nickname?, is_active?, waba_id? }
//
// `is_active` is per-user: it writes to the caller's
// team_members.hidden_number_ids set rather than the global flag.
// Any active member can toggle their own visibility (no role gate).
//
// `nickname` and `waba_id` remain workspace-global edits and stay
// gated to owner/superadmin since they affect every operator.
// =====================================================================
interface PutBody {
  phone_number_id?: string;
  /** Bulk per-user visibility toggle — flips every id in one go.
   *  Used by the UserMenu's per-portfolio / "enable all" toggles. */
  phone_number_ids?: string[];
  nickname?: string | null;
  /** Free-form operator memory note. Separate from nickname — never
   *  displayed as the primary label; renders as a small subtitle/chip
   *  on the Numbers settings card + UserMenu connected-numbers list. */
  memo?: string | null;
  is_active?: boolean;
  /** WABA id this number actually belongs to — overrides the
   *  portfolio-level business_account_id for template fetches. Empty
   *  string clears it (falls back to portfolio default). */
  waba_id?: string | null;
  /** Operator-defined cluster for Evolution numbers (Mumbai / Noida /
   *  Haridwar clinic …). null clears the assignment. */
  evolution_group_id?: string | null;
}

export async function PUT(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  // Bulk per-user visibility toggle. Critically this is ONE atomic
  // read-modify-write of hidden_number_ids — firing N single-id PUTs in
  // parallel made each one clobber the others' array (that was the
  // "Enable all doesn't work" bug).
  if (
    Array.isArray(body.phone_number_ids) &&
    typeof body.is_active === "boolean"
  ) {
    const ids = body.phone_number_ids
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (ids.length === 0) {
      return NextResponse.json(
        { error: "phone_number_ids is empty" },
        { status: 400 },
      );
    }
    const current = new Set(member.hidden_number_ids ?? []);
    for (const id of ids) {
      if (body.is_active) current.delete(id);
      else current.add(id);
    }
    const { error } = await createServiceRoleClient()
      .from("team_members")
      .update({
        hidden_number_ids: Array.from(current),
        updated_at: new Date().toISOString(),
      })
      .eq("id", member.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      is_active: body.is_active,
      count: ids.length,
    });
  }

  const phoneNumberId = body.phone_number_id?.trim();
  if (!phoneNumberId) {
    return NextResponse.json({ error: "phone_number_id is required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();

  // Per-user visibility toggle — written to the caller's row in
  // team_members.hidden_number_ids. Doesn't require any elevated role.
  if ("is_active" in body && typeof body.is_active === "boolean") {
    const current = new Set(member.hidden_number_ids ?? []);
    if (body.is_active) {
      current.delete(phoneNumberId);
    } else {
      current.add(phoneNumberId);
    }
    const next = Array.from(current);
    const { error: hErr } = await admin
      .from("team_members")
      .update({ hidden_number_ids: next, updated_at: new Date().toISOString() })
      .eq("id", member.id);
    if (hErr) return NextResponse.json({ error: hErr.message }, { status: 500 });

    // If the request was visibility-only, return now.
    if (
      !("nickname" in body) &&
      !("waba_id" in body) &&
      !("memo" in body) &&
      !("evolution_group_id" in body)
    ) {
      return NextResponse.json({ ok: true, is_active: body.is_active });
    }
  }

  // Workspace-level edits stay gated to owner / superadmin.
  if (
    ("nickname" in body ||
      "memo" in body ||
      "waba_id" in body ||
      "evolution_group_id" in body) &&
    member.role !== "owner" &&
    member.role !== "superadmin"
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const patch: Record<string, unknown> = {};
  if ("nickname" in body) {
    const nickname = body.nickname?.toString().trim() || null;
    if (nickname && nickname.length > 80) {
      return NextResponse.json({ error: "Nickname too long (80 max)" }, { status: 400 });
    }
    patch.nickname = nickname;
  }
  if ("memo" in body) {
    const memo = body.memo?.toString().trim() || null;
    if (memo && memo.length > 200) {
      return NextResponse.json({ error: "Memo too long (200 max)" }, { status: 400 });
    }
    patch.memo = memo;
  }
  if ("waba_id" in body) {
    const waba = body.waba_id?.toString().trim() || null;
    if (waba && !/^\d{6,}$/.test(waba)) {
      return NextResponse.json(
        { error: "WABA id must be a numeric Meta id" },
        { status: 400 },
      );
    }
    patch.waba_id = waba;
  }
  if ("evolution_group_id" in body) {
    // null clears the assignment ("Ungrouped"). Otherwise must be a UUID.
    const gid = body.evolution_group_id?.toString().trim() || null;
    if (gid && !/^[0-9a-f-]{36}$/i.test(gid)) {
      return NextResponse.json(
        { error: "evolution_group_id must be a UUID or null" },
        { status: 400 },
      );
    }
    patch.evolution_group_id = gid;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { error } = await admin
    .from("business_numbers")
    .update(patch)
    .eq("phone_number_id", phoneNumberId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, ...patch });
}
