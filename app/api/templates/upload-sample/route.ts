import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { uploadMediaBytes } from "@/lib/storage";
import { getCredential } from "@/lib/credentials";
import { getApiVersion } from "@/lib/whatsapp";
import { listPortfolios } from "@/lib/portfolios";

export const runtime = "nodejs";

// Resolve { app_id, access_token } for media uploads. Same precedence as
// /api/templates: explicit ?portfolio_key=, then legacy single-tenant
// credentials, then first active portfolio. Multi-portfolio installs
// don't set the legacy app_credentials rows so the portfolio fallback
// is what actually fires here.
async function resolveAppCreds(
  portfolioKey?: string | null,
): Promise<{ app_id: string; access_token: string } | null> {
  if (portfolioKey) {
    const p = listPortfolios().find((x) => x.key === portfolioKey);
    if (p?.app_id && p.access_token) {
      return { app_id: p.app_id, access_token: p.access_token };
    }
    return null;
  }
  const [legacyAppId, legacyToken] = await Promise.all([
    getCredential("whatsapp_app_id"),
    getCredential("whatsapp_access_token"),
  ]);
  if (legacyAppId && legacyToken) {
    return { app_id: legacyAppId, access_token: legacyToken };
  }
  const p = listPortfolios().find(
    (x) => x.is_active && x.app_id && x.access_token,
  );
  if (p?.app_id && p.access_token) {
    return { app_id: p.app_id, access_token: p.access_token };
  }
  return null;
}

// Meta media limits for template samples
const LIMITS: Record<string, { max: number; mimes: string[] }> = {
  IMAGE: { max: 5 * 1024 * 1024, mimes: ["image/jpeg", "image/png"] },
  VIDEO: { max: 16 * 1024 * 1024, mimes: ["video/mp4", "video/3gp"] },
  DOCUMENT: {
    max: 100 * 1024 * 1024,
    mimes: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  },
};

export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const portfolioKey =
    request.nextUrl.searchParams.get("portfolio_key")?.trim() || null;
  const [creds, apiVersion] = await Promise.all([
    resolveAppCreds(portfolioKey),
    getApiVersion(),
  ]);
  if (!creds) {
    return NextResponse.json(
      {
        error:
          "Media header upload requires the WhatsApp App ID and Access Token — set them in Settings → Credentials.",
      },
      { status: 500 },
    );
  }
  const APP_ID = creds.app_id;
  const ACCESS_TOKEN = creds.access_token;

  const form = await request.formData();
  const file = form.get("file");
  const format = String(form.get("format") ?? "").toUpperCase();
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  const limit = LIMITS[format];
  if (!limit) {
    return NextResponse.json({ error: `Unsupported format: ${format}` }, { status: 400 });
  }
  if (!limit.mimes.includes(file.type)) {
    return NextResponse.json(
      { error: `Invalid type ${file.type} for ${format}. Allowed: ${limit.mimes.join(", ")}` },
      { status: 400 },
    );
  }
  if (file.size > limit.max) {
    return NextResponse.json(
      { error: `File too large — max ${Math.round(limit.max / 1024 / 1024)}MB for ${format}.` },
      { status: 400 },
    );
  }

  const bytes = await file.arrayBuffer();

  // Step 1: create upload session
  const sessionUrl = new URL(`https://graph.facebook.com/${apiVersion}/${APP_ID}/uploads`);
  sessionUrl.searchParams.set("file_name", file.name);
  sessionUrl.searchParams.set("file_length", String(file.size));
  sessionUrl.searchParams.set("file_type", file.type);
  sessionUrl.searchParams.set("access_token", ACCESS_TOKEN);

  const sessionRes = await fetch(sessionUrl.toString(), { method: "POST", cache: "no-store" });
  const sessionJson = (await sessionRes.json()) as {
    id?: string;
    error?: { message?: string; error_user_msg?: string };
  };
  if (!sessionRes.ok || !sessionJson.id) {
    return NextResponse.json(
      {
        error:
          sessionJson.error?.error_user_msg ??
          sessionJson.error?.message ??
          `Failed to open upload session (${sessionRes.status})`,
      },
      { status: 502 },
    );
  }

  // Step 2: upload file bytes
  const uploadRes = await fetch(`https://graph.facebook.com/${apiVersion}/${sessionJson.id}`, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${ACCESS_TOKEN}`,
      file_offset: "0",
    },
    body: bytes,
    cache: "no-store",
  });
  const uploadJson = (await uploadRes.json()) as {
    h?: string;
    error?: { message?: string; error_user_msg?: string };
  };
  if (!uploadRes.ok || !uploadJson.h) {
    return NextResponse.json(
      {
        error:
          uploadJson.error?.error_user_msg ??
          uploadJson.error?.message ??
          `Upload failed (${uploadRes.status})`,
      },
      { status: 502 },
    );
  }

  // Also push the same bytes into Supabase Storage so the dashboard can
  // render a preview thumbnail later (Meta's API doesn't return a public
  // URL for the sample, only the opaque handle). Best-effort — Storage
  // failures shouldn't block the Meta side that's already succeeded.
  let previewUrl: string | null = null;
  try {
    const uploaded = await uploadMediaBytes(bytes, {
      mime: file.type || "application/octet-stream",
      folder: "outbound", // existing bucket folder; templates samples ride along
      suggestedName: `template-${Date.now()}-${file.name}`,
    });
    previewUrl = uploaded.publicUrl;
  } catch (e) {
    console.error(
      "[upload-sample] storage mirror failed:",
      e instanceof Error ? e.message : e,
    );
  }

  return NextResponse.json({ handle: uploadJson.h, preview_url: previewUrl });
}
