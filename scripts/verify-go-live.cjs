#!/usr/bin/env node
/**
 * AHL go-live readiness check (Phases 0–4 from the system guide).
 * Reads .env.local (or ENV_FILE). Does not print secret values.
 *
 *   node scripts/verify-go-live.mjs
 *   ENV_FILE=/opt/QHT-Messaging/.env.local node scripts/verify-go-live.mjs
 *   CHECK_TICKS=1 node scripts/verify-go-live.mjs   # POST localhost ticks
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const envFile = process.env.ENV_FILE || path.join(root, ".env.local");

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function present(v) {
  return !!(v && String(v).trim().length > 0);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function check(label, ok, hint) {
  console.log(`${ok ? "OK   " : "NEED "} ${label}${hint && !ok ? ` — ${hint}` : ""}`);
  return ok;
}

async function main() {
  const env = loadEnv(envFile);
  let failed = 0;

  section(`Env file: ${envFile}`);
  if (!fs.existsSync(envFile)) {
    console.log("NEED  .env.local missing");
    process.exit(1);
  }

  section("Phase 0 — Runtime");
  const p0 = [
    check("NEXT_PUBLIC_SUPABASE_URL", present(env.NEXT_PUBLIC_SUPABASE_URL)),
    check("NEXT_PUBLIC_SUPABASE_ANON_KEY", present(env.NEXT_PUBLIC_SUPABASE_ANON_KEY)),
    check("SUPABASE_SERVICE_ROLE_KEY", present(env.SUPABASE_SERVICE_ROLE_KEY)),
    check("NEXT_PUBLIC_APP_URL", present(env.NEXT_PUBLIC_APP_URL)),
    check("WEBHOOK_INTERNAL_TOKEN", present(env.WEBHOOK_INTERNAL_TOKEN), "scheduler will skip all ticks"),
  ];
  if (present(env.NEXT_PUBLIC_APP_URL) && /localhost|127\.0\.0\.1/.test(env.NEXT_PUBLIC_APP_URL)) {
    console.log("WARN  NEXT_PUBLIC_APP_URL is localhost — set HTTPS public URL on VPS before production webhooks");
  }
  const eco = path.join(root, "ecosystem.config.cjs");
  check("ecosystem.config.cjs (fork/1)", fs.existsSync(eco), "commit/deploy this file; pm2 startOrReload ecosystem.config.cjs");
  failed += p0.filter((x) => !x).length;

  section("Phase 1 — Auth + WhatsApp");
  const p1 = [
    check(
      "NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN",
      present(env.NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN),
    ),
  ];
  const hasWaha = present(env.WAHA_SERVER_URL) && present(env.WAHA_API_KEY);
  const hasEvo =
    present(env.EVOLUTION_SERVER_URL) && present(env.EVOLUTION_GLOBAL_API_KEY);
  const hasMeta =
    present(env.WHATSAPP_ACCESS_TOKEN) ||
    present(env.PORTFOLIO_KEYS);
  check("WhatsApp path (WAHA|Evolution|Meta portfolio)", hasWaha || hasEvo || hasMeta);
  if (hasWaha) console.log("      WAHA configured");
  if (hasEvo) console.log("      Evolution configured");
  if (hasMeta) console.log("      Meta/portfolio keys present (verify token length on VPS)");
  failed += p1.filter((x) => !x).length;
  if (!(hasWaha || hasEvo || hasMeta)) failed += 1;

  section("Phase 2 — CRM");
  const hasLsq =
    present(env.LSQ_HOST) &&
    present(env.LSQ_ACCESS_KEY) &&
    present(env.LSQ_SECRET_KEY);
  const hasAhl =
    present(env.AHL_CRM_LEADS_URL) && present(env.AHL_CRM_API_KEY);
  check("LeadSquared (LSQ_*)", hasLsq, "optional if using Firebase only");
  check("AHL Firebase (AHL_CRM_*)", hasAhl, "optional if using LSQ only; WAHA/Meta/Evolution all call ahlEnsureLeadForContact");
  if (!hasLsq && !hasAhl) {
    console.log("NEED  At least one CRM path (LSQ or AHL_CRM)");
    failed += 1;
  }

  section("Phase 3 — AI");
  const hasAi = present(env.OPENROUTER_API_KEY) || present(env.OPENAI_API_KEY);
  if (!check("OPENROUTER_API_KEY or OPENAI_API_KEY", hasAi)) failed += 1;
  if (present(env.OPENROUTER_API_KEY)) console.log("      OpenRouter preferred path ready");

  section("Phase 4 — Payments + KRAs");
  const hasRz =
    present(env.RAZORPAY_KEY_ID) && present(env.RAZORPAY_KEY_SECRET);
  const hasPayu =
    present(env.PAYU_MERCHANT_KEY) && present(env.PAYU_MERCHANT_SALT);
  check("Razorpay", hasRz, "or configure PayU / Settings → Payments DB accounts");
  check("PayU", hasPayu, "optional if Razorpay covers you");
  check("RAZORPAY_WEBHOOK_SECRET", present(env.RAZORPAY_WEBHOOK_SECRET), "needed for paid webhooks");
  if (!hasRz && !hasPayu) {
    console.log("NEED  At least one payment provider");
    failed += 1;
  }
  console.log("NOTE  Targets/KRAs are set in UI: /settings/targets (not env)");

  section("Phase 5 — Deferred (do not block go-live)");
  console.log("SKIP  Telephony, Google Calendar booking, Embed, Meta Ads, drips — after go-live");

  if (process.env.CHECK_TICKS === "1" && present(env.WEBHOOK_INTERNAL_TOKEN)) {
    section("Tick smoke (localhost)");
    const port = process.env.PORT || "3000";
    const base = process.env.INTERNAL_TICK_BASE || `http://127.0.0.1:${port}`;
    const token = env.WEBHOOK_INTERNAL_TOKEN;
    const paths = [
      "/api/automation/sweep",
      "/api/campaigns/tick",
      "/api/drips/tick",
      "/api/triggers/tick",
      "/api/lead-distribution/tick",
    ];
    for (const p of paths) {
      try {
        const res = await fetch(`${base}${p}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(p.includes("triggers") ? { token } : {}),
        });
        const ok = res.status !== 403 && res.status !== 401;
        console.log(
          `${ok ? "OK   " : "FAIL "} ${p} → HTTP ${res.status}`,
        );
        if (!ok) failed += 1;
      } catch (e) {
        console.log(`FAIL  ${p} → ${e instanceof Error ? e.message : e}`);
        failed += 1;
      }
    }
  } else {
    console.log("\n(tip) CHECK_TICKS=1 with dev server running to POST tick routes");
    console.log("(tip) npm run verify:go-live");
  }

  console.log(`\n${failed === 0 ? "READY" : `GAPS: ${failed}`} — fix NEED lines before production AI/campaigns.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
