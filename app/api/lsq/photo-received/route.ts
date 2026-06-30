// POST /api/lsq/photo-received
//
// Triggered by the inbound webhook whenever a customer sends an image.
// Runs four sequential LSQ writes (mirrors the operator's n8n template):
//
//   1. ProspectActivity.svc/Create        — note "Received Image"
//   2. files-in21.../File/Upload          — multipart photo upload
//   3. ProspectActivity.svc/Attachment/Add — link upload to activity
//   4. (optional) Lead.Update / ProspectStage = configured target
//      iff the lead's CURRENT stage is in the configured allow-list.
//
// Auth: shared WEBHOOK_INTERNAL_TOKEN (same handshake the webhook
// uses for /api/automation/process and /api/lsq/ensure-lead). Fire-
// and-forget from the webhook so a slow LSQ write never blocks
// Meta's 5s ack budget.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCredential } from "@/lib/credentials";
import {
  getLsqConfig,
  lsqAttachToActivity,
  lsqCreateActivity,
  lsqGetLeadByMobile,
  lsqGetProspectStage,
  lsqUpdateProspectStage,
  lsqUploadFile,
} from "@/lib/lsq";

export const runtime = "nodejs";

interface Body {
  contact_id?: string;
  /** Public Supabase Storage URL of the uploaded image (whatever the
   *  webhook stashed via downloadInboundMedia). */
  media_url?: string;
  /** Image MIME — e.g. image/jpeg / image/png. Falls back to jpeg. */
  media_mime?: string;
  /** ISO timestamp when the image landed; used as the activity
   *  timestamp so LSQ history matches the chat thread. */
  timestamp?: string;
  token?: string;
}

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const expected = await getCredential("webhook_internal_token");
  if (!expected) {
    return NextResponse.json(
      { error: "WEBHOOK_INTERNAL_TOKEN not set" },
      { status: 500 },
    );
  }
  const auth = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  if (auth !== expected && body.token !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const contactId = body.contact_id?.trim();
  const mediaUrl = body.media_url?.trim();
  if (!contactId || !mediaUrl) {
    return NextResponse.json(
      { error: "contact_id and media_url are required" },
      { status: 400 },
    );
  }

  if (!getLsqConfig().configured) {
    return NextResponse.json({ ok: true, skipped: "lsq_not_configured" });
  }

  const admin = createServiceRoleClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("id, wa_id, lsq_prospect_id, business_phone_number_id")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  // Capability gate — operator can disable the photo→stage automation
  // per number. Default true so legacy rows behave unchanged.
  if (contact.business_phone_number_id) {
    const { data: gateCfg } = await admin
      .from("automation_configs")
      .select("lsq_photo_stage_enabled")
      .eq("business_phone_number_id", contact.business_phone_number_id)
      .maybeSingle();
    if (gateCfg && gateCfg.lsq_photo_stage_enabled === false) {
      return NextResponse.json({ ok: true, skipped: "lsq_photo_stage_disabled" });
    }
  }

  // Race-safe prospect_id resolution. The webhook fires this route
  // and /api/lsq/ensure-lead in parallel — when an image is the FIRST
  // inbound from a new contact, ensure-lead may not have cached the
  // prospect_id yet by the time we get here. Poll-with-backoff for up
  // to ~5s; if still missing, do our own phone lookup so we never
  // bail just because the cache hasn't landed.
  let prospectId = contact.lsq_prospect_id ?? null;
  if (!prospectId && contact.wa_id) {
    for (let i = 0; i < 5 && !prospectId; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      const { data: refreshed } = await admin
        .from("contacts")
        .select("lsq_prospect_id")
        .eq("id", contact.id)
        .maybeSingle();
      if (refreshed?.lsq_prospect_id) {
        prospectId = refreshed.lsq_prospect_id;
        break;
      }
    }
  }
  if (!prospectId && contact.wa_id) {
    const lookup = await lsqGetLeadByMobile(contact.wa_id);
    if (lookup.found && lookup.lead?.prospect_id) {
      prospectId = lookup.lead.prospect_id;
      // Cache it so subsequent lookups are instant.
      void admin
        .from("contacts")
        .update({ lsq_prospect_id: prospectId })
        .eq("id", contact.id);
    }
  }
  if (!prospectId) {
    return NextResponse.json({ ok: true, skipped: "no_prospect_id" });
  }

  // Pull the operator-configured stage gate (target + allow-list) for
  // this number. Fall back to defaults so the flow still works on a
  // freshly-migrated row that hasn't been edited yet.
  let stageTarget = "Photos Received";
  let stageAllowedFrom: string[] = [
    "Prospect",
    "Engaged",
    "Pending First Contact",
    "Photo Awaited",
  ];
  if (contact.business_phone_number_id) {
    const { data: cfg } = await admin
      .from("automation_configs")
      .select("photo_lead_stage_target, photo_lead_stage_allowed_from")
      .eq("business_phone_number_id", contact.business_phone_number_id)
      .maybeSingle();
    if (cfg) {
      if (typeof cfg.photo_lead_stage_target === "string" && cfg.photo_lead_stage_target.trim()) {
        stageTarget = cfg.photo_lead_stage_target.trim();
      }
      if (Array.isArray(cfg.photo_lead_stage_allowed_from)) {
        stageAllowedFrom = (cfg.photo_lead_stage_allowed_from as unknown[]).filter(
          (s): s is string => typeof s === "string" && s.trim().length > 0,
        );
      }
    }
  }

  // Stagger parallel calls — when a customer sends 6 photos in one
  // burst, the webhook fires this route 6× concurrently. LSQ rate-
  // limits at 10/5s, so a few of them die with 429. We jitter the
  // start (0–8s, salted by activity_id later) so the parallel runs
  // spread across a sensible window.
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 8000)));

  // Helper: retry a flaky LSQ call up to 3× with exponential backoff
  // (1s → 2s → 4s) so transient 429/5xx don't lose the upload. The
  // operator's expectation is "kuchh time lag jaye but LSQ pe pohonchna
  // chahiye", so we trade latency for reliability.
  async function withRetry<T extends { ok: boolean; error?: string | null }>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let last = await fn();
    for (let attempt = 1; attempt <= 3 && !last.ok; attempt++) {
      const wait = 1000 * 2 ** (attempt - 1);
      console.warn(
        `[photo-received] ${label} attempt ${attempt} failed (${last.error}); retrying in ${wait}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
      last = await fn();
    }
    return last;
  }

  // Step 1: create the activity FIRST so we have an id to attach to.
  const ts = new Date(body.timestamp ?? Date.now())
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const created = await withRetry("create_activity", () =>
    lsqCreateActivity({
      prospectId,
      note: "Received Image",
      fields: [
        { SchemaName: "mx_Custom_1", Value: ts },
        { SchemaName: "mx_Custom_2", Value: "Inbound" },
      ],
    }).then((r) => ({ ...r, ok: r.ok && !!r.activity_id })),
  );
  if (!created.ok || !created.activity_id) {
    console.warn(
      `[photo-received] step1 create_activity FAILED for ${prospectId}: ${created.error}`,
    );
    return NextResponse.json(
      { ok: false, step: "create_activity", error: created.error },
      { status: 502 },
    );
  }
  console.log(
    `[photo-received] step1 activity created: ${created.activity_id}`,
  );

  // Step 2: download the image bytes from Supabase Storage. The image
  // is a public URL (downloadInboundMedia caches it in our own bucket),
  // so a plain fetch is enough.
  let buffer: Buffer | null = null;
  let mimeType = body.media_mime ?? "image/jpeg";
  let filename = `whatsapp-${Date.now()}.${(mimeType.split("/")[1] ?? "jpg").toLowerCase()}`;
  try {
    const dl = await fetch(mediaUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!dl.ok) {
      return NextResponse.json(
        {
          ok: false,
          step: "download_media",
          error: `HTTP ${dl.status}`,
          activity_id: created.activity_id,
        },
        { status: 502 },
      );
    }
    if (dl.headers.get("content-type")) {
      mimeType = dl.headers.get("content-type")!;
    }
    buffer = Buffer.from(await dl.arrayBuffer());
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        step: "download_media",
        error: e instanceof Error ? e.message : "Network error",
        activity_id: created.activity_id,
      },
      { status: 502 },
    );
  }

  console.log(
    `[photo-received] step2 downloaded ${buffer.length} bytes (${mimeType})`,
  );

  // Step 3: upload bytes to LSQ files endpoint.
  const uploaded = await withRetry("upload_file", () =>
    lsqUploadFile(buffer!, filename, mimeType).then((r) => ({
      ...r,
      ok: r.ok && !!r.path,
    })),
  );
  if (!uploaded.ok || !uploaded.path) {
    console.warn(
      `[photo-received] step3 upload_file FAILED: ${uploaded.error}`,
    );
    return NextResponse.json(
      {
        ok: false,
        step: "upload_file",
        error: uploaded.error,
        activity_id: created.activity_id,
      },
      { status: 502 },
    );
  }
  console.log(
    `[photo-received] step3 uploaded path=${uploaded.path} name=${uploaded.name}`,
  );

  // Step 4: link upload to the activity.
  const attached = await withRetry("attach", () =>
    lsqAttachToActivity(
      created.activity_id!,
      uploaded.name ?? filename,
      uploaded.path!,
    ),
  );
  if (!attached.ok) {
    console.warn(
      `[photo-received] step4 attach FAILED activity=${created.activity_id}: ${attached.error}`,
    );
    return NextResponse.json(
      {
        ok: false,
        step: "attach",
        error: attached.error,
        activity_id: created.activity_id,
      },
      { status: 502 },
    );
  }
  console.log(
    `[photo-received] step4 attached file to activity ${created.activity_id}`,
  );

  // Step 5 (optional): stage transition, gated by allow-list. Look up
  // the lead's current stage; only flip when it's in the configured
  // set. Outside the set we silently no-op so manually-progressed
  // leads (Meeting Booked / Closed Won / etc.) aren't bumped back.
  let stageResult: {
    attempted: boolean;
    from?: string | null;
    to?: string;
    ok?: boolean;
    error?: string | null;
  } = { attempted: false };
  if (stageTarget && stageAllowedFrom.length > 0) {
    const cur = await lsqGetProspectStage(prospectId);
    if (cur.ok && cur.stage && stageAllowedFrom.includes(cur.stage)) {
      const upd = await lsqUpdateProspectStage(
        prospectId,
        stageTarget,
      );
      stageResult = {
        attempted: true,
        from: cur.stage,
        to: stageTarget,
        ok: upd.ok,
        error: upd.error,
      };
    } else {
      stageResult = {
        attempted: false,
        from: cur.stage,
      };
    }
  }

  return NextResponse.json({
    ok: true,
    activity_id: created.activity_id,
    file: { path: uploaded.path, name: uploaded.name },
    stage: stageResult,
  });
}
