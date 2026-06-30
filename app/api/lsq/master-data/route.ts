// GET /api/lsq/master-data
//
// Pulls the full LSQ master lists in one shot — used to populate the
// campaign recipient filter UI with every stage, source, sub-source,
// and owner that exists in the operator's LSQ tenant (not just the ones
// already cached locally on the contacts table).
//
// All four LSQ calls run in parallel; if one fails we still return the
// rest with the failing field as an empty array + a per-field error
// message so the UI can render whatever it has.

import { NextResponse } from "next/server";
import { getCurrentMember, isAtLeast } from "@/lib/team";
import { getLsqConfig, lsqFetch } from "@/lib/lsq";

export const runtime = "nodejs";

interface ProspectStageRow {
  ProspectStage?: string;
  ProspectStageId?: string;
}
interface UserRow {
  ID?: string;
  AssociatedPhoneNumbers?: string;
  FirstName?: string;
  LastName?: string;
  EmailAddress?: string;
  AssociatedFullName?: string;
  Role?: string;
}

export async function GET() {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(member.role, "admin")) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const cfg = getLsqConfig();
  if (!cfg.configured) {
    return NextResponse.json(
      { error: "LSQ not configured. Set LSQ_HOST + LSQ_ACCESS_KEY + LSQ_SECRET_KEY." },
      { status: 400 },
    );
  }

  // Run all four lookups in parallel. Each one is failure-tolerant —
  // if LSQ is rate-limited or the field is missing on this tenant, we
  // log the error and return [] so the UI doesn't blow up.
  const [stagesRes, sourcesRes, subSourcesRes, usersRes] = await Promise.all([
    lsqFetch<ProspectStageRow[] | { ProspectStages?: ProspectStageRow[] }>({
      method: "GET",
      path: "/v2/LeadManagement.svc/ProspectStages.Get",
      timeoutMs: 15_000,
    }),
    // Sources are stored as a custom-dropdown field on the lead. Pull
    // its master values via Master.svc — schema-name `Source` matches
    // the standard QHT setup (mx_Source on tenants that customised it
    // — caller can rename if needed).
    lsqFetch<unknown>({
      method: "POST",
      path: "/v2/LeadManagement.svc/Lead.GetDropdownValues",
      body: { SchemaName: "Source" },
      timeoutMs: 15_000,
    }),
    lsqFetch<unknown>({
      method: "POST",
      path: "/v2/LeadManagement.svc/Lead.GetDropdownValues",
      body: { SchemaName: "mx_Sub_source" },
      timeoutMs: 15_000,
    }),
    lsqFetch<UserRow[] | { Users?: UserRow[] }>({
      method: "GET",
      path: "/v2/UserManagement.svc/Users.Get",
      timeoutMs: 15_000,
    }),
  ]);

  const stages = extractStages(stagesRes.data);
  const sources = extractDropdown(sourcesRes.data);
  const sub_sources = extractDropdown(subSourcesRes.data);
  const owners = extractUsers(usersRes.data);

  return NextResponse.json({
    ok: true,
    stages,
    sources,
    sub_sources,
    owners,
    errors: {
      stages: stagesRes.ok ? null : stagesRes.error,
      sources: sourcesRes.ok ? null : sourcesRes.error,
      sub_sources: subSourcesRes.ok ? null : subSourcesRes.error,
      owners: usersRes.ok ? null : usersRes.error,
    },
  });
}

function extractStages(data: unknown): string[] {
  if (!data) return [];
  const rows: ProspectStageRow[] = Array.isArray(data)
    ? (data as ProspectStageRow[])
    : ((data as { ProspectStages?: ProspectStageRow[] }).ProspectStages ?? []);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const name = (r.ProspectStage ?? "").toString().trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function extractDropdown(data: unknown): string[] {
  if (!data) return [];
  // GetDropdownValues replies in a few shapes across LSQ tenants:
  //   • [{ Value: "WhatsApp" }, …]
  //   • { List: [{ Value: "WhatsApp" }, …] }
  //   • [{ Name: "WhatsApp", Value: "WhatsApp" }, …]
  const list: Array<Record<string, unknown>> = Array.isArray(data)
    ? (data as Array<Record<string, unknown>>)
    : ((data as { List?: Array<Record<string, unknown>> }).List ?? []);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    const v =
      (typeof r.Value === "string" && r.Value) ||
      (typeof r.Name === "string" && r.Name) ||
      (typeof r.DisplayName === "string" && r.DisplayName) ||
      "";
    const trimmed = v.toString().trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function extractUsers(data: unknown): Array<{ id: string; name: string; email: string | null }> {
  if (!data) return [];
  const rows: UserRow[] = Array.isArray(data)
    ? (data as UserRow[])
    : ((data as { Users?: UserRow[] }).Users ?? []);
  const out: Array<{ id: string; name: string; email: string | null }> = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const id = (r.ID ?? "").toString().trim();
    const name =
      (r.AssociatedFullName ?? "").toString().trim() ||
      [r.FirstName, r.LastName].filter(Boolean).join(" ").trim();
    if (!id && !name) continue;
    const key = id || name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: id || name,
      name: name || id,
      email: r.EmailAddress ?? null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
