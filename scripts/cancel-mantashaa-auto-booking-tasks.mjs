/**
 * Cancel Mantashaa's flood of auto-created Book Zenoti / Call client tasks.
 * Leaves manually created tasks alone.
 *
 *   node scripts/cancel-mantashaa-auto-booking-tasks.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split(/\r?\n/)) {
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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

function isAutoJunk(t) {
  const tl = (t.title || "").toLowerCase();
  const d = t.description || "";
  return (
    tl.startsWith("book zenoti") ||
    tl.startsWith("call client") ||
    d.startsWith("Auto-created from WhatsApp reply.")
  );
}

const { data: members, error: mErr } = await sb
  .from("team_members")
  .select("id, full_name, first_name, email")
  .eq("is_active", true);
if (mErr) throw mErr;

const mant = (members || []).filter((r) => {
  const full = (r.full_name || "").toLowerCase();
  const first = (r.first_name || "").toLowerCase();
  const email = (r.email || "").toLowerCase();
  return (
    full.includes("mantashaa") ||
    first === "mantashaa" ||
    email.includes("mantashaa")
  );
});

console.log(
  "Mantashaa members:",
  mant.map((m) => ({ id: m.id, name: m.full_name || m.first_name, email: m.email })),
);
if (!mant.length) {
  console.error("No Mantashaa team member found");
  process.exit(1);
}

const ids = mant.map((m) => m.id);
const { data: tasks, error } = await sb
  .from("tasks")
  .select("id, title, description, status, assigned_to, created_at")
  .in("assigned_to", ids)
  .in("status", ["open", "in_progress", "blocked"])
  .order("created_at", { ascending: false })
  .limit(500);
if (error) throw error;

const auto = (tasks || []).filter(isAutoJunk);
console.log(
  `open/blocked total=${(tasks || []).length} auto_junk=${auto.length}`,
);
for (const t of auto.slice(0, 8)) {
  console.log(`  - [${t.status}] ${t.title.slice(0, 90)}`);
}

if (!auto.length) {
  console.log("Nothing to cancel.");
  process.exit(0);
}

const now = new Date().toISOString();
const { error: upErr, count } = await sb
  .from("tasks")
  .update({ status: "cancelled", updated_at: now }, { count: "exact" })
  .in(
    "id",
    auto.map((t) => t.id),
  );

if (upErr) throw upErr;
console.log(`Cancelled ${count ?? auto.length} auto booking task(s).`);
