/**
 * Strip emojis from live AHL trigger flow copy (Messaging BPID).
 * Professional / warm tone — no hearts, waves, cameras, etc.
 *
 *   node scripts/strip-ahl-flow-emojis.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function loadEnv() {
  const raw = readFileSync(resolve(root, ".env.local"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const BPID = process.env.AHL_MESSAGING_BPID || "1198859879988526";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const admin = createClient(url, key, { auth: { persistSession: false } });

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{20E3}]/gu;

function stripEmojis(s) {
  return s
    .replace(EMOJI_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ?\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ ([,.!?])/g, "$1")
    .trimEnd();
}

function patchValue(v) {
  if (typeof v === "string") {
    const next = stripEmojis(v);
    return { value: next, changed: next !== v };
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((item) => {
      const r = patchValue(item);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: out, changed };
  }
  if (v && typeof v === "object") {
    let changed = false;
    const out = {};
    for (const [k, child] of Object.entries(v)) {
      const r = patchValue(child);
      out[k] = r.value;
      if (r.changed) changed = true;
    }
    return { value: out, changed };
  }
  return { value: v, changed: false };
}

async function main() {
  const { data: flows, error: fErr } = await admin
    .from("trigger_flows")
    .select("id, name")
    .eq("business_phone_number_id", BPID)
    .ilike("name", "%AHL%");
  if (fErr) throw fErr;

  const flowIds = (flows || []).map((f) => f.id);
  console.log(
    `AHL flows on ${BPID}:`,
    (flows || []).map((f) => f.name),
  );
  if (!flowIds.length) {
    console.log("No AHL flows found.");
    return;
  }

  const { data: nodes, error } = await admin
    .from("trigger_nodes")
    .select("id, flow_id, node_type, config")
    .in("flow_id", flowIds);
  if (error) throw error;

  let patched = 0;
  for (const n of nodes || []) {
    const { value, changed } = patchValue(n.config || {});
    if (!changed) continue;
    const { error: upErr } = await admin
      .from("trigger_nodes")
      .update({ config: value })
      .eq("id", n.id);
    if (upErr) throw upErr;
    patched += 1;
    console.log(`  patched ${n.node_type} ${n.id}`);
  }
  console.log(`Done. Patched ${patched} AHL node(s).`);
}

main().catch((e) => {
  console.error("FAILED:", e.message || e);
  process.exit(1);
});
