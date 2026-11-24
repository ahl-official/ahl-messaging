/**
 * Diagnose latest V3 run stuck on voice/concern for test contact.
 * Usage: node scripts/check-voice-stuck.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env.local");
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

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const CONTACT_ID = "0e94cc37-0e90-4199-8736-577ba430ddbe";

const { data: msgs } = await sb
  .from("messages")
  .select(
    "id,timestamp,direction,type,content,transcript,media_url,media_mime_type",
  )
  .eq("contact_id", CONTACT_ID)
  .gte("timestamp", "2026-11-24T12:50:00Z")
  .order("timestamp", { ascending: true });

console.log("=== THREAD since 6:25 IST ===");
for (const m of msgs || []) {
  console.log(
    JSON.stringify({
      t: m.timestamp,
      dir: m.direction,
      type: m.type,
      media: !!m.media_url,
      mime: m.media_mime_type,
      tr: (m.transcript || "").slice(0, 80),
      c: (m.content || "").slice(0, 100),
      id: m.id.slice(0, 8),
    }),
  );
}

const { data: runs } = await sb
  .from("trigger_runs")
  .select("id,status,current_node_id,started_at,updated_at,flow_id")
  .eq("contact_id", CONTACT_ID)
  .order("started_at", { ascending: false })
  .limit(2);

console.log("\n=== RUNS ===");
console.log(JSON.stringify(runs, null, 2));

if (runs?.[0]) {
  const { data: node } = await sb
    .from("trigger_nodes")
    .select("id,node_type,config")
    .eq("id", runs[0].current_node_id)
    .maybeSingle();
  console.log("\n=== PARKED NODE ===");
  console.log(
    JSON.stringify(
      {
        type: node?.node_type,
        var: node?.config?.var_name,
        text: String(node?.config?.text || "").slice(0, 120),
      },
      null,
      2,
    ),
  );
  const { data: vars } = await sb
    .from("trigger_run_vars")
    .select("key,value")
    .eq("run_id", runs[0].id)
    .in("key", [
      "concern",
      "concern_mode",
      "city",
      "flow_event",
      "__flow_webhook_count",
    ]);
  console.log("\n=== KEY VARS ===");
  console.log(JSON.stringify(vars, null, 2));
}

const audio = (msgs || []).filter((m) => m.type === "audio" || m.type === "voice");
console.log("\n=== AUDIO ROWS ===", audio.length);
for (const a of audio) {
  console.log(
    JSON.stringify({
      id: a.id,
      t: a.timestamp,
      media_url: a.media_url,
      transcript: a.transcript,
      content: a.content,
      mime: a.media_mime_type,
    }),
  );
}
