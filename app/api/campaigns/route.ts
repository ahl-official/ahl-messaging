// GET  /api/campaigns         — list campaigns (with computed live stats)
// POST /api/campaigns         — create a draft campaign

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { resolveCredsForPhoneNumberId, listPortfolios } from "@/lib/portfolios";
import { getApiVersion } from "@/lib/whatsapp";
import { rateForCategory, WA_MSG_RATE_INR } from "@/lib/campaign-cost";

export const runtime = "nodejs";

// Per-number template→category map, cached 10 min so the polled list
// endpoint doesn't hit Meta on every refresh.
const CATEGORY_TTL_MS = 10 * 60_000;
const categoryCache = new Map<string, { at: number; map: Map<string, string> }>();

async function fetchTemplateCategories(
  waba: string,
  token: string,
): Promise<Map<string, string> | null> {
  const v = await getApiVersion();
  const url = `https://graph.facebook.com/${v}/${waba}/message_templates?fields=name,category&limit=200`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const json = (await res.json()) as {
    data?: Array<{ name?: string; category?: string }>;
    error?: unknown;
  };
  if (json.error || !Array.isArray(json.data)) return null;
  const map = new Map<string, string>();
  for (const t of json.data) {
    if (t.name) map.set(t.name.trim().toLowerCase(), (t.category ?? "MARKETING").toUpperCase());
  }
  return map;
}

// Resolve a template→category map for ANY number — no per-number env edits.
// New numbers only need a row in `business_numbers` (with its waba_id, set by
// onboarding/sync). We find a working access token by:
//   1. the number's own portfolio (if listed in PORTFOLIO_*_PHONE_IDS), else
//   2. any meta portfolio whose business_account_id == the number's WABA, else
//   3. trying every meta portfolio token until Meta accepts one (covers a
//      brand-new WABA under a known business app).
// The WABA comes from business_numbers first, falling back to the portfolio's.
async function getCategoryMap(bpid: string, waba: string | null): Promise<Map<string, string>> {
  const hit = categoryCache.get(bpid);
  if (hit && Date.now() - hit.at < CATEGORY_TTL_MS) return hit.map;

  let map = new Map<string, string>();
  try {
    const own = await resolveCredsForPhoneNumberId(bpid);
    const metaPortfolios = listPortfolios().filter(
      (p) => p.provider === "meta" && p.access_token,
    );
    const effWaba = (waba || own?.business_account_id || "").trim();

    // Ordered, de-duplicated (waba, token) attempts.
    const attempts: Array<{ waba: string; token: string }> = [];
    const push = (w: string | null | undefined, t: string | null | undefined) => {
      if (w && t && !attempts.some((a) => a.waba === w && a.token === t)) {
        attempts.push({ waba: w, token: t });
      }
    };
    if (own?.access_token) push(effWaba || own.business_account_id, own.access_token);
    const wabaMatch = metaPortfolios.find((p) => p.business_account_id?.trim() === effWaba);
    if (wabaMatch) push(effWaba, wabaMatch.access_token);
    for (const p of metaPortfolios) push(effWaba || p.business_account_id, p.access_token);

    for (const a of attempts) {
      const got = await fetchTemplateCategories(a.waba, a.token);
      if (got && got.size > 0) {
        map = got;
        break;
      }
    }
  } catch {
    /* best-effort — unknown categories fall back to Marketing rate */
  }
  categoryCache.set(bpid, { at: Date.now(), map });
  return map;
}

// Real send-cost per number = every outbound TEMPLATE send logged in the
// `messages` table (magic-message, campaign, welcome, LSQ, … all land here),
// bucketed by the template's Meta category. We count with head/count queries
// (a plain .select() caps at 1000 rows and would undercount) — one per
// (number, category). Cached 2 min so the polled list endpoint stays cheap.
// Only WhatsApp-Cloud numbers (numeric id) bill through Meta; evolution: and
// interakt: numbers are skipped by the caller.
const SENDS_TTL_MS = 2 * 60_000;
let sendsCache: { at: number; byBpid: Map<string, Record<string, number>> } | null = null;

async function countTpl(
  admin: ReturnType<typeof createServiceRoleClient>,
  bpid: string,
  names: string[] | null,
): Promise<number> {
  let q = admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("direction", "outbound")
    .eq("business_phone_number_id", bpid);
  q = names ? q.in("template_name", names) : q.not("template_name", "is", null);
  const { count } = await q;
  return count ?? 0;
}

async function getTemplateSendCounts(
  admin: ReturnType<typeof createServiceRoleClient>,
  bpids: string[],
  maps: Map<string, Map<string, string>>,
): Promise<Map<string, Record<string, number>>> {
  if (sendsCache && Date.now() - sendsCache.at < SENDS_TTL_MS) return sendsCache.byBpid;
  const byBpid = new Map<string, Record<string, number>>();
  await Promise.all(
    bpids.map(async (bpid) => {
      const map = maps.get(bpid) ?? new Map<string, string>();
      // group this number's template names by their Meta category
      const namesByCat = new Map<string, string[]>();
      for (const [name, cat] of map) {
        const arr = namesByCat.get(cat) ?? namesByCat.set(cat, []).get(cat)!;
        arr.push(name);
      }
      const total = await countTpl(admin, bpid, null);
      if (total <= 0) return;
      const counts: Record<string, number> = {};
      let known = 0;
      await Promise.all(
        [...namesByCat.entries()].map(async ([cat, names]) => {
          // template_name is stored as-sent; match the lowercased map keys
          const c = await countTpl(admin, bpid, names);
          if (c > 0) {
            counts[cat] = (counts[cat] ?? 0) + c;
            known += c;
          }
        }),
      );
      // Template sends whose template no longer exists in Meta's list (deleted
      // templates) → charge at Marketing rate so we never under-estimate.
      const unknown = total - known;
      if (unknown > 0) counts.MARKETING = (counts.MARKETING ?? 0) + unknown;
      byBpid.set(bpid, counts);
    }),
  );
  sendsCache = { at: Date.now(), byBpid };
  return byBpid;
}

interface PostBody {
  name?: string;
  type?: "template" | "magic_message";
  business_phone_number_id?: string;
  template_name?: string;
  template_language?: string;
  template_components?: unknown;
  template_body_preview?: string;
  template_media_url?: string | null;
  template_footer?: string | null;
  template_buttons?: unknown;
  magic_prompt?: string;
  magic_persona_override?: string | null;
  magic_tone?: string | null;
  schedule_at?: string | null;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  rate_limit_per_minute?: number;
}

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("campaigns")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const campaigns = data ?? [];

  // Send-cost split by category AND by number — every outbound TEMPLATE send
  // logged in `messages` (magic-message, campaign, welcome, LSQ, …), bucketed
  // by the template's Meta category. Category comes from a per-number Meta
  // lookup (cached 10 min) so the polled endpoint stays cheap. Only
  // WhatsApp-Cloud numbers (numeric id) bill through Meta — evolution: and
  // interakt: numbers are skipped.
  const { data: numberRows } = await admin
    .from("business_numbers")
    .select("phone_number_id, nickname, verified_name, display_phone_number, waba_id");
  const labelOf = new Map<string, { name: string; phone: string | null }>();
  const wabaOf = new Map<string, string | null>();
  for (const n of numberRows ?? []) {
    const id = n.phone_number_id as string;
    labelOf.set(id, {
      name:
        (n.nickname as string | null) ||
        (n.verified_name as string | null) ||
        (n.display_phone_number as string | null) ||
        id,
      phone: (n.display_phone_number as string | null) ?? null,
    });
    wabaOf.set(id, (n.waba_id as string | null) ?? null);
  }
  // Any number in business_numbers with a numeric (cloud) id — new numbers
  // appear here automatically once onboarding/sync inserts the row.
  const cloudBpids = (numberRows ?? [])
    .map((n) => n.phone_number_id as string)
    .filter((id) => /^\d+$/.test(id));

  const maps = new Map<string, Map<string, string>>();
  await Promise.all(
    cloudBpids.map(async (bpid) =>
      maps.set(bpid, await getCategoryMap(bpid, wabaOf.get(bpid) ?? null)),
    ),
  );

  const sendsByBpid = await getTemplateSendCounts(admin, cloudBpids, maps);

  type Bucket = { sent: number; cost: number };
  const blank = (): Record<string, Bucket> => ({});
  const totals = blank();
  const perNumber = new Map<string, Record<string, Bucket>>();
  const addTo = (acc: Record<string, Bucket>, category: string, sent: number) => {
    if (sent <= 0) return;
    const b = (acc[category] ??= { sent: 0, cost: 0 });
    b.sent += sent;
    b.cost += rateForCategory(category) * sent;
  };

  for (const [bpid, counts] of sendsByBpid) {
    const acc = perNumber.set(bpid, blank()).get(bpid)!;
    for (const [category, sent] of Object.entries(counts)) {
      addTo(totals, category, sent);
      addTo(acc, category, sent);
    }
  }

  const catBucket = (acc: Record<string, Bucket>, cat: string): Bucket =>
    acc[cat] ?? { sent: 0, cost: 0 };
  const byNumber = [...perNumber.entries()]
    .map(([bpid, acc]) => {
      const meta = labelOf.get(bpid);
      const total = Object.values(acc).reduce((a, b) => a + b.cost, 0);
      return {
        bpid,
        label: meta?.name ?? bpid,
        phone: meta?.phone ?? null,
        utility: catBucket(acc, "UTILITY"),
        marketing: catBucket(acc, "MARKETING"),
        authentication: catBucket(acc, "AUTHENTICATION"),
        total_cost: total,
      };
    })
    .sort((a, b) => b.total_cost - a.total_cost);

  return NextResponse.json({
    campaigns,
    cost_summary: {
      utility: catBucket(totals, "UTILITY"),
      marketing: catBucket(totals, "MARKETING"),
      authentication: catBucket(totals, "AUTHENTICATION"),
      total_cost: Object.values(totals).reduce((a, b) => a + b.cost, 0),
      by_number: byNumber,
      rates: WA_MSG_RATE_INR,
    },
  });
}

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (body.type !== "template" && body.type !== "magic_message") {
    return NextResponse.json(
      { error: "type must be 'template' or 'magic_message'" },
      { status: 400 },
    );
  }
  const bpid = (body.business_phone_number_id ?? "").trim();
  if (!bpid) {
    return NextResponse.json(
      { error: "business_phone_number_id is required" },
      { status: 400 },
    );
  }
  if (body.type === "template" && !body.template_name?.trim()) {
    return NextResponse.json({ error: "template_name is required" }, { status: 400 });
  }
  if (body.type === "magic_message" && !body.magic_prompt?.trim()) {
    return NextResponse.json({ error: "magic_prompt is required" }, { status: 400 });
  }
  const rate = Math.max(1, Math.min(120, body.rate_limit_per_minute ?? 30));

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("campaigns")
    .insert({
      name,
      type: body.type,
      status: "draft",
      business_phone_number_id: bpid,
      template_name: body.template_name?.trim() || null,
      template_language: body.template_language?.trim() || null,
      template_components: body.template_components ?? null,
      template_body_preview: body.template_body_preview?.trim() || null,
      template_media_url: body.template_media_url ?? null,
      template_footer: body.template_footer ?? null,
      template_buttons: body.template_buttons ?? null,
      magic_prompt: body.magic_prompt?.trim() || null,
      magic_persona_override: body.magic_persona_override ?? null,
      magic_tone: body.magic_tone ?? null,
      schedule_at: body.schedule_at ?? null,
      quiet_hours_start: body.quiet_hours_start ?? null,
      quiet_hours_end: body.quiet_hours_end ?? null,
      rate_limit_per_minute: rate,
      created_by: me.user_id,
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ campaign: data });
}
