// Submit Task 2 Meta marketing templates on AHL Messaging WABA (12 total):
//   leak3 (qualified but didn’t book) · booked_noshow · visited_noorder
//
//   GET /api/admin/seed-task2-templates
//   GET /api/admin/seed-task2-templates?group=leak3
//   GET /api/admin/seed-task2-templates?group=booked_noshow
//   GET /api/admin/seed-task2-templates?group=visited_noorder
//   GET /api/admin/seed-task2-templates?dry=1
//   Authorization: Bearer <WEBHOOK_INTERNAL_TOKEN>
//
// Creates PENDING templates in Meta (Marketing / en_US). Already-existing
// names are reported as skipped (Meta rejects duplicate name+language).

import { NextResponse, type NextRequest } from "next/server";
import { AHL_MESSAGING_BPID } from "@/lib/ahl-messaging-contact";
import {
  resolveTemplateCreds,
  TEMPLATE_CREDS_MISSING_MSG,
} from "@/lib/template-creds";
import {
  task2TemplatesByGroup,
  type Task2TemplateDef,
} from "@/lib/task2-leak-templates";
import { getApiVersion } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEMPLATE_LANG = "en_US";

function expectedToken(): string {
  return (process.env.WEBHOOK_INTERNAL_TOKEN || "").trim();
}

function authorized(req: NextRequest): boolean {
  const expected = expectedToken();
  if (!expected) return false;
  const header = req.headers.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer && bearer === expected) return true;
  const q = req.nextUrl.searchParams.get("token")?.trim() || "";
  return !!q && q === expected;
}

type MetaCreateResult = {
  name: string;
  label: string;
  group: string;
  ok: boolean;
  id?: string;
  status?: string;
  skipped?: boolean;
  error?: string;
};

async function createOne(
  def: Task2TemplateDef,
  opts: { token: string; waba: string; fallbackWaba: string | null; apiVersion: string },
): Promise<MetaCreateResult> {
  const components: Array<Record<string, unknown>> = [
    {
      type: "BODY",
      text: def.body,
      example: { body_text: [def.examples] },
    },
  ];
  if (def.buttons.length > 0) {
    components.push({
      type: "BUTTONS",
      buttons: def.buttons.map((b) => ({
        type: "QUICK_REPLY",
        text: b.text.slice(0, 25),
      })),
    });
  }

  const payload = {
    name: def.name,
    language: def.language || TEMPLATE_LANG,
    category: def.category || "MARKETING",
    components,
  };

  const post = async (waba: string) => {
    const url = `https://graph.facebook.com/${opts.apiVersion}/${waba}/message_templates`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as {
      id?: string;
      status?: string;
      error?: {
        message?: string;
        error_user_msg?: string;
        code?: number;
        error_subcode?: number;
      };
    };
    return { res, json };
  };

  let { res, json } = await post(opts.waba);
  if (!res.ok && json.error?.code === 100 && opts.fallbackWaba) {
    ({ res, json } = await post(opts.fallbackWaba));
  }

  if (!res.ok) {
    const msg =
      json.error?.error_user_msg ||
      json.error?.message ||
      `Meta API ${res.status}`;
    // Duplicate name+language → treat as already submitted.
    const dup = /already exists|already being used|duplicate|content is identical/i.test(
      msg,
    );
    return {
      name: def.name,
      label: def.label,
      group: def.group,
      ok: dup,
      skipped: dup,
      error: dup ? `already exists — ${msg}` : msg,
    };
  }

  return {
    name: def.name,
    label: def.label,
    group: def.group,
    ok: true,
    id: json.id,
    status: json.status ?? "PENDING",
  };
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const groupParam = (req.nextUrl.searchParams.get("group") || "all").trim();
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const bpid =
    (req.nextUrl.searchParams.get("bpid") || AHL_MESSAGING_BPID).trim();

  const defs = task2TemplatesByGroup(
    groupParam as Parameters<typeof task2TemplatesByGroup>[0],
  );
  if (defs.length === 0) {
    return NextResponse.json(
      {
        error: `Unknown group="${groupParam}". Use all|leak3|booked_noshow|visited_noorder`,
      },
      { status: 400 },
    );
  }

  if (dry) {
    return NextResponse.json({
      ok: true,
      dry: true,
      bpid,
      count: defs.length,
      templates: defs.map((d) => ({
        name: d.name,
        label: d.label,
        group: d.group,
        vars: d.examples.length,
        buttons: d.buttons.map((b) => b.text),
        body: d.body,
      })),
      how_to_run:
        "GET /api/admin/seed-task2-templates with Authorization: Bearer WEBHOOK_INTERNAL_TOKEN",
    });
  }

  const creds = await resolveTemplateCreds({ phoneNumberId: bpid });
  if (!creds) {
    return NextResponse.json({ error: TEMPLATE_CREDS_MISSING_MSG }, { status: 400 });
  }

  const apiVersion = await getApiVersion();
  const results: MetaCreateResult[] = [];

  // Sequential — Meta rate-limits template creates.
  for (const def of defs) {
    try {
      results.push(
        await createOne(def, {
          token: creds.token,
          waba: creds.waba,
          fallbackWaba: creds.fallbackWaba,
          apiVersion,
        }),
      );
    } catch (e) {
      results.push({
        name: def.name,
        label: def.label,
        group: def.group,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const created = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.ok).length;

  return NextResponse.json({
    ok: failed === 0,
    bpid,
    waba: creds.waba,
    group: groupParam,
    summary: { total: results.length, created, skipped, failed },
    results,
    note: "Templates enter Meta review as PENDING. Use them in drips once APPROVED (language en_US).",
  });
}
