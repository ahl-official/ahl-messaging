// GET /api/automation/usage
// Aggregates automation_logs into spend + token totals per period and per
// model. The Automation page's Usage panel reads this for the at-a-glance
// numbers. OpenAI doesn't expose remaining balance via API key, so we show
// estimated spend from our own logs (every successful run logs token
// counts) and link out to the OpenAI dashboard for the actual remaining
// credit number.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { estimateCostUsd, priceFor } from "@/lib/openai-pricing";

export const runtime = "nodejs";

interface LogRow {
  status: string;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  business_phone_number_id: string | null;
}

interface ByModel {
  model: string;
  runs: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  priced: boolean;
}

interface PeriodTotals {
  runs: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
}

function emptyTotals(): PeriodTotals {
  return { runs: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 };
}

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const phoneFilter =
    request.nextUrl.searchParams.get("business_phone_number_id")?.trim() || null;

  // Pull only success rows — failed/skipped don't bill OpenAI either.
  const admin = createServiceRoleClient();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const last7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const last30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  let query = admin
    .from("automation_logs")
    .select("status, model, prompt_tokens, completion_tokens, business_phone_number_id, created_at")
    .eq("status", "success")
    .gte("created_at", last30.toISOString());
  if (phoneFilter) query = query.eq("business_phone_number_id", phoneFilter);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const today = emptyTotals();
  const week = emptyTotals();
  const month = emptyTotals();
  const byModelMap = new Map<string, ByModel>();

  for (const r of (data ?? []) as Array<LogRow & { created_at: string }>) {
    const at = new Date(r.created_at);
    const prompt = r.prompt_tokens ?? 0;
    const completion = r.completion_tokens ?? 0;
    const cost = estimateCostUsd(r.model, prompt, completion);

    const bumpInto = (t: PeriodTotals) => {
      t.runs += 1;
      t.prompt_tokens += prompt;
      t.completion_tokens += completion;
      t.cost_usd += cost;
    };

    bumpInto(month);
    if (at >= last7) bumpInto(week);
    if (at >= startOfDay) bumpInto(today);

    const key = r.model || "unknown";
    const existing = byModelMap.get(key) ?? {
      model: key,
      runs: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      priced: priceFor(key) !== null,
    };
    existing.runs += 1;
    existing.prompt_tokens += prompt;
    existing.completion_tokens += completion;
    existing.cost_usd += cost;
    byModelMap.set(key, existing);
  }

  const by_model = [...byModelMap.values()].sort((a, b) => b.cost_usd - a.cost_usd);

  return NextResponse.json({
    today,
    last_7_days: week,
    last_30_days: month,
    by_model,
    note:
      "Estimated from OpenAI public pricing. For exact remaining balance see your OpenAI dashboard.",
  });
}
