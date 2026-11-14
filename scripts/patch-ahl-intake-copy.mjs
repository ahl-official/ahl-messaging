/**
 * Patch live AHL trigger_nodes + automation personas for warmer CTWA/intake copy.
 * Does NOT recreate flows — only rewrites known dry form lines in node config JSON.
 *
 *   node scripts/patch-ahl-intake-copy.mjs
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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const admin = createClient(url, key, { auth: { persistSession: false } });

const REPLACEMENTS = [
  [
    "May I know, which city are you from?",
    "Welcome! Which city are you in so I can guide you better?",
  ],
  [
    "What product are you interested in?",
    "Got it 🙂 What would you like help with?",
  ],
];

function patchObj(obj) {
  if (!obj || typeof obj !== "object") return { obj, changed: false };
  let changed = false;
  const out = Array.isArray(obj) ? [...obj] : { ...obj };
  if (typeof out.text === "string") {
    for (const [from, to] of REPLACEMENTS) {
      if (out.text === from) {
        out.text = to;
        changed = true;
      }
    }
  }
  for (const [k, v] of Object.entries(out)) {
    if (v && typeof v === "object") {
      const nested = patchObj(v);
      if (nested.changed) {
        out[k] = nested.obj;
        changed = true;
      }
    }
  }
  return { obj: out, changed };
}

async function main() {
  const { data: nodes, error } = await admin
    .from("trigger_nodes")
    .select("id, flow_id, config, node_type");
  if (error) throw error;

  let patched = 0;
  for (const n of nodes ?? []) {
    const { obj, changed } = patchObj(n.config ?? {});
    if (!changed) continue;
    const { error: upErr } = await admin
      .from("trigger_nodes")
      .update({ config: obj })
      .eq("id", n.id);
    if (upErr) throw upErr;
    patched += 1;
    console.log(`  patched node ${n.id} (${n.node_type})`);
  }
  console.log(`Done. Patched ${patched} trigger node(s).`);
}

main().catch((e) => {
  console.error("FAILED:", e.message || e);
  process.exit(1);
});
