/**
 * Submit 12 Task 2 Meta templates + create 12 DISABLED drip campaigns
 * (one campaign per template / day).
 *
 * Cadence from enrollment: Day1=0, Day3=+2d, Day7=+6d, Day14=+13d.
 * Qualified pilot uses Warm Lead (Cold/Deferred can be cloned after migration).
 *
 * Usage: node scripts/seed-task2-templates-and-drips.mjs
 *        node scripts/seed-task2-templates-and-drips.mjs --templates-only
 *        node scripts/seed-task2-templates-and-drips.mjs --drips-only
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const envPath = resolve(root, ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const k = m[1].trim();
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

const BPID = process.env.AHL_MESSAGING_BPID || "1198859879988526";
const TEMPLATE_LANG = "en_US";
const API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";
const DAY = 24 * 60;

const qr = (...labels) =>
  labels.map((text) => ({ type: "QUICK_REPLY", text: String(text).slice(0, 25) }));

const TEMPLATES = [
  {
    name: "ahl_leak3_d1_a_book",
    body: "Hi {{1}}, thank you for speaking with us. Would you like to schedule your consultation? Please share two preferred slots with the day and time, and our team will help you confirm.",
    examples: ["Rahul"],
    buttons: qr("BOOK", "SHARE SLOTS", "NOT NOW"),
  },
  {
    name: "ahl_leak3_d3_b_reminder",
    body: "Hi {{1}}, just following up to check if you would like to schedule your consultation. Reply BOOK and {{2}} will help you confirm a suitable time.",
    examples: ["Rahul", "Mehjabeen"],
    buttons: qr("BOOK", "CALL ME", "STOP"),
  },
  {
    name: "ahl_leak3_d7_b2_objection",
    body: "Hi {{1}}, if price, family approval or travel is holding you back from booking your consultation, please let us know. We will be happy to help with your concerns.",
    examples: ["Rahul"],
    buttons: qr("PRICE", "FAMILY", "TRAVEL"),
  },
  {
    name: "ahl_leak3_d14_d_final",
    body: "Hi {{1}}, just one last follow-up regarding your consultation. Reply YES if you would like to book, or LATER with a suitable date if you need more time.",
    examples: ["Rahul"],
    buttons: qr("YES", "LATER", "STOP"),
  },
  {
    name: "ahl_noshow_d1_a_reschedule",
    body: "Hi {{1}}, we noticed you couldn't attend your scheduled consultation at American Hairline. Would you like to reschedule? Please share two preferred slots, and {{2}} will help you confirm.",
    examples: ["Rahul", "Mehjabeen"],
    buttons: qr("RESCHEDULE", "CALL ME", "NOT NOW"),
  },
  {
    name: "ahl_noshow_d3_b_reminder",
    body: "Hi {{1}}, just checking if you would like to reschedule your missed consultation. Please share your preferred date, and our team will help you arrange a new appointment.",
    examples: ["Rahul"],
    buttons: qr("YES", "PREFERRED DATE", "STOP"),
  },
  {
    name: "ahl_noshow_d7_b2_urgency",
    body: "Hi {{1}}, just checking in to see if you are still planning to visit American Hairline. Reply BOOK to schedule a new consultation or CALL if you would like to speak with our team.",
    examples: ["Rahul"],
    buttons: qr("BOOK", "CALL", "STOP"),
  },
  {
    name: "ahl_noshow_d14_d_final",
    body: "Hi {{1}}, this is our last follow-up regarding your missed consultation. Reply READY whenever you would like to reschedule, or STOP if you do not wish to receive further messages.",
    examples: ["Rahul"],
    buttons: qr("READY", "STOP"),
  },
  {
    name: "ahl_visited_d1_a_followup",
    body: "Hi {{1}}, thank you for visiting American Hairline. This is {{2}}. We wanted to check if you have any questions about the options discussed during your consultation. We will be happy to assist you.",
    examples: ["Rahul", "Mehjabeen"],
    buttons: qr("ASK QUESTION", "CALL ME", "NOT NOW"),
  },
  {
    name: "ahl_visited_d3_b_reminder",
    body: "Hi {{1}}, we hope you had a good experience during your visit. Would you like a callback to discuss your options or clarify any concerns?",
    examples: ["Rahul"],
    buttons: qr("YES", "SHARE CONCERN", "STOP"),
  },
  {
    name: "ahl_visited_d7_b2_objection",
    body: "Hi {{1}}, if price, timing or the expected look is a concern after your consultation, please let us know. We will be happy to understand your concerns and help you with the available options.",
    examples: ["Rahul"],
    buttons: qr("PRICE", "TIMING", "LOOK"),
  },
  {
    name: "ahl_visited_d14_d_final",
    body: "Hi {{1}}, this is our last follow-up regarding your consultation. Reply READY if you would like to proceed or discuss the next steps, or STOP if you do not wish to receive further messages.",
    examples: ["Rahul"],
    buttons: qr("READY", "STOP"),
  },
];

/** 12 drip campaigns — one per template. */
const DRIPS = [
  { name: "AHL Task2 Qualified D1", stage: "Warm Lead", delay_minutes: 0, template_name: "ahl_leak3_d1_a_book" },
  { name: "AHL Task2 Qualified D3", stage: "Warm Lead", delay_minutes: 2 * DAY, template_name: "ahl_leak3_d3_b_reminder" },
  { name: "AHL Task2 Qualified D7", stage: "Warm Lead", delay_minutes: 6 * DAY, template_name: "ahl_leak3_d7_b2_objection" },
  { name: "AHL Task2 Qualified D14", stage: "Warm Lead", delay_minutes: 13 * DAY, template_name: "ahl_leak3_d14_d_final" },
  { name: "AHL Task2 Noshow D1", stage: "Consultation Booked", delay_minutes: 0, template_name: "ahl_noshow_d1_a_reschedule" },
  { name: "AHL Task2 Noshow D3", stage: "Consultation Booked", delay_minutes: 2 * DAY, template_name: "ahl_noshow_d3_b_reminder" },
  { name: "AHL Task2 Noshow D7", stage: "Consultation Booked", delay_minutes: 6 * DAY, template_name: "ahl_noshow_d7_b2_urgency" },
  { name: "AHL Task2 Noshow D14", stage: "Consultation Booked", delay_minutes: 13 * DAY, template_name: "ahl_noshow_d14_d_final" },
  { name: "AHL Task2 Visited D1", stage: "Consultation Visited", delay_minutes: 0, template_name: "ahl_visited_d1_a_followup" },
  { name: "AHL Task2 Visited D3", stage: "Consultation Visited", delay_minutes: 2 * DAY, template_name: "ahl_visited_d3_b_reminder" },
  { name: "AHL Task2 Visited D7", stage: "Consultation Visited", delay_minutes: 6 * DAY, template_name: "ahl_visited_d7_b2_objection" },
  { name: "AHL Task2 Visited D14", stage: "Consultation Visited", delay_minutes: 13 * DAY, template_name: "ahl_visited_d14_d_final" },
];

function collectTokenWabaPairs() {
  const pairs = [];
  const push = (token, waba, label) => {
    if (token && waba) pairs.push({ token: token.trim(), waba: waba.trim(), label });
  };
  push(process.env.WHATSAPP_ACCESS_TOKEN, process.env.WHATSAPP_BUSINESS_ACCOUNT_ID, "legacy");
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(/^PORTFOLIO_(.+)_ACCESS_TOKEN$/i);
    if (!m || !v) continue;
    const key = m[1];
    const waba = process.env[`PORTFOLIO_${key}_BUSINESS_ACCOUNT_ID`] || "";
    const phones = (process.env[`PORTFOLIO_${key}_PHONE_IDS`] || "").split(",");
    push(v, waba, `PORTFOLIO_${key}`);
    // Prefer portfolio that owns AHL Messaging BPID
    if (phones.map((p) => p.trim()).includes(BPID) && waba) {
      pairs.unshift({ token: v.trim(), waba: waba.trim(), label: `PORTFOLIO_${key} (bpid match)` });
    }
  }
  return pairs;
}

async function createTemplate(def, token, waba) {
  const components = [
    {
      type: "BODY",
      text: def.body,
      example: { body_text: [def.examples] },
    },
    { type: "BUTTONS", buttons: def.buttons },
  ];
  const url = `https://graph.facebook.com/${API_VERSION}/${waba}/message_templates`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: def.name,
      language: TEMPLATE_LANG,
      category: "MARKETING",
      components,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.error_user_msg || json?.error?.message || `HTTP ${res.status}`;
    const dup = /already exists|already being used|duplicate|identical/i.test(msg);
    return { name: def.name, ok: dup, skipped: dup, error: msg, status: dup ? "EXISTS" : "FAILED" };
  }
  return { name: def.name, ok: true, id: json.id, status: json.status || "PENDING" };
}

async function resolveWorkingCreds() {
  const pairs = collectTokenWabaPairs();
  if (!pairs.length) {
    // Try app_credentials
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (url && key) {
      const sb = createClient(url, key, { auth: { persistSession: false } });
      const { data: rows } = await sb.from("app_credentials").select("key, value");
      const map = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
      if (map.whatsapp_access_token && map.whatsapp_business_account_id) {
        pairs.push({
          token: map.whatsapp_access_token,
          waba: map.whatsapp_business_account_id,
          label: "app_credentials",
        });
      }
    }
  }
  if (!pairs.length) {
    throw new Error("No WhatsApp token/WABA found in .env.local or app_credentials");
  }

  // Probe which pair can read the WABA
  for (const p of pairs) {
    const url = `https://graph.facebook.com/${API_VERSION}/${p.waba}?fields=id,name`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${p.token}` },
    });
    if (res.ok) {
      console.log(`Using creds: ${p.label} WABA=${p.waba}`);
      return p;
    }
    const j = await res.json().catch(() => ({}));
    console.warn(`Creds ${p.label} failed:`, j?.error?.message || res.status);
  }
  throw new Error("No working Meta token/WABA pair (all probes failed)");
}

async function seedTemplates() {
  const { token, waba } = await resolveWorkingCreds();
  console.log(`Submitting ${TEMPLATES.length} templates…`);
  const results = [];
  for (const def of TEMPLATES) {
    const r = await createTemplate(def, token, waba);
    results.push(r);
    console.log(
      `  ${r.ok ? "OK" : "FAIL"} ${def.name} ${r.status || ""} ${r.skipped ? "(exists)" : ""} ${r.error || ""}`.trim(),
    );
    await new Promise((r) => setTimeout(r, 400));
  }
  return results;
}

async function upsertDrip(sb, def) {
  const { data: existing } = await sb
    .from("drip_campaigns")
    .select("id")
    .eq("name", def.name)
    .eq("business_phone_number_id", BPID)
    .maybeSingle();

  const row = {
    enabled: false,
    trigger_stage: def.stage,
    trigger_source: null,
    quiet_hours_start: "21:00",
    quiet_hours_end: "09:00",
  };

  let dripId;
  if (existing) {
    dripId = existing.id;
    const { error } = await sb.from("drip_campaigns").update(row).eq("id", dripId);
    if (error) throw error;
    await sb.from("drip_steps").delete().eq("drip_id", dripId);
  } else {
    const { data: drip, error } = await sb
      .from("drip_campaigns")
      .insert({
        name: def.name,
        business_phone_number_id: BPID,
        created_by_email: "admin-seed-task2",
        ...row,
      })
      .select("id")
      .single();
    if (error) throw error;
    dripId = drip.id;
  }

  const { error: sErr } = await sb.from("drip_steps").insert({
    drip_id: dripId,
    step_order: 1,
    step_type: "template",
    delay_minutes: def.delay_minutes,
    template_name: def.template_name,
    template_language: TEMPLATE_LANG,
    text_body: null,
  });
  if (sErr) throw sErr;
  return { id: dripId, name: def.name, stage: def.stage, template: def.template_name, delay_minutes: def.delay_minutes, enabled: false };
}

async function seedDrips() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { data: bn } = await sb
    .from("business_numbers")
    .select("phone_number_id")
    .eq("phone_number_id", BPID)
    .maybeSingle();
  if (!bn) throw new Error(`business_numbers missing ${BPID}`);

  // Clean legacy multi-step / old names
  const { data: legacy } = await sb
    .from("drip_campaigns")
    .select("id, name")
    .eq("business_phone_number_id", BPID)
    .or(
      [
        "name.eq.AHL Task2 Leak3 Pilot",
        "name.like.AHL Task2 Leak3 Pilot — %",
        "name.eq.AHL Task2 — Qualified (no book)",
        "name.eq.AHL Task2 — Booked no-show",
        "name.eq.AHL Task2 — Visited no order",
      ].join(","),
    );
  for (const row of legacy || []) {
    await sb.from("drip_campaigns").delete().eq("id", row.id);
    console.log("Deleted legacy drip:", row.name);
  }

  const out = [];
  for (const def of DRIPS) {
    const r = await upsertDrip(sb, def);
    out.push(r);
    console.log(`Drip OK (disabled): ${r.name} → ${r.template}`);
  }
  return out;
}

const args = new Set(process.argv.slice(2));
const templatesOnly = args.has("--templates-only");
const dripsOnly = args.has("--drips-only");

const summary = {};
try {
  if (!dripsOnly) summary.templates = await seedTemplates();
} catch (e) {
  console.error("TEMPLATES ERROR:", e.message || e);
  summary.templates_error = String(e.message || e);
}
try {
  if (!templatesOnly) summary.drips = await seedDrips();
} catch (e) {
  console.error("DRIPS ERROR:", e.message || e);
  summary.drips_error = String(e.message || e);
}

console.log("\nDONE");
console.log(
  JSON.stringify(
    {
      templates: summary.templates
        ? {
            total: summary.templates.length,
            ok: summary.templates.filter((t) => t.ok).length,
            failed: summary.templates.filter((t) => !t.ok).length,
          }
        : summary.templates_error || null,
      drips: summary.drips
        ? { count: summary.drips.length, enabled: false }
        : summary.drips_error || null,
      note: "Keep drips disabled until Meta marks all 12 templates APPROVED.",
    },
    null,
    2,
  ),
);
