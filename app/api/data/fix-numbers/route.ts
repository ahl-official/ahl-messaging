// POST /api/data/fix-numbers   { source?, csv?, from?, to?, mode }
//
// Chat imports whose source numbers had no country code land in the
// inbox as bare local numbers (wrong wa_id). Three ways to fix:
//
//   source "csv"    → CSV with `Mobile Number` + `country_code` columns;
//                     rebuilds wa_id = countryCode + mobile per row.
//   source "india"  → no CSV; scans every contact and prepends 91 to any
//                     wa_id that looks like a bare 10-digit Indian mobile
//                     (^[6-9]\d{9}) or a leading-0 one (^0[6-9]\d{9}).
//   source "manual" → one contact: { from, to } wa_ids.
//
// For each wrong contact:
//   • no contact yet under the correct (wa_id, business_number) → rename.
//   • a contact ALREADY exists under it → MERGE: move the bare contact's
//     messages / notes / logs into the real one, then delete the bare.
//
//   preview → counts + samples, nothing written
//   apply   → renames + merges
//
// Blank country_code defaults to 91 (India). Owner-only.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** RFC-4180-ish CSV parser — handles quoted fields with embedded
 *  commas and newlines (the WA Name / country_name columns need it). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      /* ignore */
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

interface Contact {
  id: string;
  wa_id: string;
  business_phone_number_id: string | null;
  unread_count: number | null;
}

export async function POST(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }

  let body: {
    csv?: string;
    mode?: string;
    source?: string;
    from?: string;
    to?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const source =
    body.source === "india"
      ? "india"
      : body.source === "manual"
        ? "manual"
        : "csv";
  const apply = body.mode === "apply";

  // ---- Build the wrong → correct rule per source --------------------
  const csvMap = new Map<string, string>(); // wrong wa_id → correct wa_id
  const manualFrom = (body.from ?? "").replace(/\D/g, "");
  const manualTo = (body.to ?? "").replace(/\D/g, "");

  if (source === "csv") {
    const csv = body.csv ?? "";
    if (!csv.trim()) {
      return NextResponse.json({ error: "Empty CSV" }, { status: 400 });
    }
    const rows = parseCsv(csv);
    if (rows.length < 2) {
      return NextResponse.json({ error: "CSV has no data rows" }, { status: 400 });
    }
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const mobileIdx = header.indexOf("mobile number");
    const ccIdx = header.indexOf("country_code");
    if (mobileIdx === -1 || ccIdx === -1) {
      return NextResponse.json(
        { error: 'CSV must have "Mobile Number" and "country_code" columns.' },
        { status: 400 },
      );
    }
    for (let r = 1; r < rows.length; r++) {
      const mobile = (rows[r][mobileIdx] ?? "").replace(/\D/g, "");
      if (mobile.length < 6) continue;
      const cc = (rows[r][ccIdx] ?? "").replace(/\D/g, "") || "91";
      const correct = cc + mobile;
      if (correct !== mobile) csvMap.set(mobile, correct);
    }
    if (csvMap.size === 0) {
      return NextResponse.json({ error: "No usable rows in CSV" }, { status: 400 });
    }
  } else if (source === "manual") {
    if (manualFrom.length < 6 || manualTo.length < 6) {
      return NextResponse.json(
        { error: "Both numbers are required (6+ digits)." },
        { status: 400 },
      );
    }
    if (manualFrom === manualTo) {
      return NextResponse.json(
        { error: "The two numbers are identical." },
        { status: 400 },
      );
    }
  }

  /** The correct wa_id for a contact, or null if it's already fine. */
  function correctFor(wa: string): string | null {
    if (source === "csv") {
      const c = csvMap.get(wa);
      return c && c !== wa ? c : null;
    }
    if (source === "manual") {
      return wa === manualFrom ? manualTo : null;
    }
    // india
    if (/^[6-9]\d{9}$/.test(wa)) return "91" + wa;
    if (/^0[6-9]\d{9}$/.test(wa)) return "91" + wa.slice(1);
    return null;
  }

  // ---- Load every contact -------------------------------------------
  const admin = createServiceRoleClient();
  const contacts: Contact[] = [];
  for (let from = 0; from < 500_000; from += 1000) {
    const { data, error } = await admin
      .from("contacts")
      .select("id, wa_id, business_phone_number_id, unread_count")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const batch = (data ?? []) as Contact[];
    contacts.push(...batch);
    if (batch.length < 1000) break;
  }

  // Index contacts by (wa_id, business_number) — uniqueness key.
  const key = (wa: string, biz: string | null) => `${wa}|${biz ?? ""}`;
  const byKey = new Map<string, Contact[]>();
  for (const c of contacts) {
    const k = key(c.wa_id, c.business_phone_number_id);
    const list = byKey.get(k);
    if (list) list.push(c);
    else byKey.set(k, [c]);
  }

  // ---- Plan ----------------------------------------------------------
  const toFix: Array<{ id: string; from: string; to: string }> = [];
  const toMerge: Array<{
    fromId: string;
    toId: string;
    from: string;
    to: string;
  }> = [];
  // wa_ids the CSV/manual rule wants to fix but no contact carries.
  const wantedWrong = new Set<string>();
  if (source === "csv") for (const w of csvMap.keys()) wantedWrong.add(w);
  if (source === "manual") wantedWrong.add(manualFrom);
  const seenWrong = new Set<string>();

  // destKey → contact id that a rename will land there (so a second
  // contact heading to the same key merges into the first instead).
  const claimedBy = new Map<string, string>();

  for (const c of contacts) {
    const correct = correctFor(c.wa_id);
    if (!correct || correct === c.wa_id) continue;
    seenWrong.add(c.wa_id);
    const destKey = key(correct, c.business_phone_number_id);
    const existing = (byKey.get(destKey) ?? []).filter((x) => x.id !== c.id);
    if (existing.length > 0) {
      toMerge.push({ fromId: c.id, toId: existing[0].id, from: c.wa_id, to: correct });
    } else if (claimedBy.has(destKey)) {
      toMerge.push({
        fromId: c.id,
        toId: claimedBy.get(destKey)!,
        from: c.wa_id,
        to: correct,
      });
    } else {
      toFix.push({ id: c.id, from: c.wa_id, to: correct });
      claimedBy.set(destKey, c.id);
    }
  }

  let notFound = 0;
  for (const w of wantedWrong) if (!seenWrong.has(w)) notFound++;

  if (!apply) {
    return NextResponse.json({
      mode: "preview",
      source,
      toFix: toFix.length,
      toMerge: toMerge.length,
      notFound,
      samples: toFix
        .slice(0, source === "csv" ? 8 : 500)
        .map((f) => ({ from: f.from, to: f.to })),
      mergeSamples: toMerge
        .slice(0, source === "csv" ? 8 : 500)
        .map((m) => ({ from: m.from, to: m.to })),
    });
  }

  // ---- Apply ---------------------------------------------------------
  let fixed = 0;
  let merged = 0;
  let failed = 0;

  // Simple renames first.
  for (const f of toFix) {
    const { error } = await admin
      .from("contacts")
      .update({ wa_id: f.to })
      .eq("id", f.id);
    if (error) failed++;
    else fixed++;
  }

  // Merges: move the bare contact's history into the real contact,
  // then delete the bare. campaign_recipients is left alone — its FK is
  // ON DELETE SET NULL, and reassigning could hit its (campaign,
  // contact) unique index.
  const unreadById = new Map(
    contacts.map((c) => [c.id, c.unread_count ?? 0] as const),
  );
  for (const m of toMerge) {
    try {
      for (const table of [
        "messages",
        "contact_notes",
        "automation_logs",
      ]) {
        const { error } = await admin
          .from(table)
          .update({ contact_id: m.toId })
          .eq("contact_id", m.fromId);
        if (error) throw new Error(error.message);
      }
      // Refresh the target's last-message meta from its newest message.
      const { data: last } = await admin
        .from("messages")
        .select("direction, status, type, content, timestamp")
        .eq("contact_id", m.toId)
        .order("timestamp", { ascending: false })
        .limit(1);
      const lm = last?.[0] as
        | {
            direction: string;
            status: string | null;
            type: string;
            content: string | null;
            timestamp: string;
          }
        | undefined;
      const patch: Record<string, unknown> = {
        unread_count:
          (unreadById.get(m.toId) ?? 0) + (unreadById.get(m.fromId) ?? 0),
      };
      if (lm) {
        patch.last_message_at = lm.timestamp;
        patch.last_message_preview = lm.content ?? `[${lm.type}]`;
        patch.last_message_direction = lm.direction;
        patch.last_message_status =
          lm.direction === "inbound" ? "received" : lm.status ?? "sent";
      }
      const { error: upErr } = await admin
        .from("contacts")
        .update(patch)
        .eq("id", m.toId);
      if (upErr) throw new Error(upErr.message);

      const { error: delErr } = await admin
        .from("contacts")
        .delete()
        .eq("id", m.fromId);
      if (delErr) throw new Error(delErr.message);
      merged++;
    } catch {
      failed++;
    }
  }

  return NextResponse.json({
    mode: "apply",
    source,
    fixed,
    merged,
    failed,
    notFound,
  });
}
