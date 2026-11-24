/**
 * Diagnose + recover evening voice note stuck on V3 ask_text concern.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

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
const BPID = "1198859879988526";

function normalizeMime(mime) {
  return (mime || "").split(";")[0].trim().toLowerCase();
}

async function resolveToken(bpid) {
  const keys = String(process.env.PORTFOLIO_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  for (const key of keys) {
    const ids = String(process.env[`PORTFOLIO_${key}_PHONE_IDS`] || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (ids.includes(bpid)) {
      const t = String(process.env[`PORTFOLIO_${key}_ACCESS_TOKEN`] || "").trim();
      if (t) return t;
    }
  }
  return "";
}

const { data: msgs } = await sb
  .from("messages")
  .select("*")
  .eq("contact_id", CONTACT_ID)
  .gte("timestamp", "2026-11-24T13:20:00Z")
  .order("timestamp", { ascending: true });

console.log("=== RECENT ===");
for (const m of msgs || []) {
  console.log(
    m.timestamp,
    m.direction,
    m.type,
    "media=" + !!m.media_url,
    "tr=" + JSON.stringify((m.transcript || "").slice(0, 60)),
    JSON.stringify((m.content || "").slice(0, 80)),
    m.id,
  );
}

const audio = (msgs || []).filter((m) => m.type === "audio").pop();
const { data: run } = await sb
  .from("trigger_runs")
  .select("id,status,current_node_id,flow_id,updated_at")
  .eq("contact_id", CONTACT_ID)
  .eq("status", "waiting")
  .order("updated_at", { ascending: false })
  .limit(1)
  .maybeSingle();

console.log("\n=== WAITING RUN ===", JSON.stringify(run, null, 2));
if (run?.current_node_id) {
  const { data: node } = await sb
    .from("trigger_nodes")
    .select("node_type,config")
    .eq("id", run.current_node_id)
    .maybeSingle();
  console.log(
    "parked:",
    node?.node_type,
    node?.config?.var_name,
    String(node?.config?.text || "").slice(0, 80),
  );
}

if (!audio) {
  console.log("No audio message found after 13:20Z");
  process.exit(0);
}

console.log("\n=== AUDIO RAW ===", {
  id: audio.id,
  media_url: audio.media_url,
  mime: audio.media_mime_type,
  transcript: audio.transcript,
  content: audio.content,
  mediaId: audio.raw_payload?.audio?.id,
});

// Recover if needed
let mediaUrl = audio.media_url;
let mime = normalizeMime(audio.media_mime_type || "audio/ogg");
const mediaId = audio.raw_payload?.audio?.id;
const payloadUrl = audio.raw_payload?.audio?.url;
const token = await resolveToken(BPID);
const apiVersion = process.env.WHATSAPP_API_VERSION || "v21.0";

let bytes = null;
if (!mediaUrl && mediaId && token) {
  let downloadUrl = "";
  const metaRes = await fetch(
    `https://graph.facebook.com/${apiVersion}/${mediaId}?fields=url,mime_type`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  console.log("graph", metaRes.status);
  if (metaRes.ok) {
    const meta = await metaRes.json();
    downloadUrl = meta.url || "";
    if (meta.mime_type) mime = normalizeMime(meta.mime_type);
  }
  if (!downloadUrl) downloadUrl = payloadUrl || "";
  if (downloadUrl) {
    const dl = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log("download", dl.status);
    if (dl.ok) {
      bytes = Buffer.from(await dl.arrayBuffer());
      const { data: buckets } = await sb.storage.listBuckets();
      if (!(buckets || []).some((b) => b.name === "whatsapp-media")) {
        await sb.storage.createBucket("whatsapp-media", {
          public: true,
          fileSizeLimit: 50 * 1024 * 1024,
        });
      }
      const path = `inbound/${randomUUID()}-${mediaId}.ogg`;
      const { error: upErr } = await sb.storage
        .from("whatsapp-media")
        .upload(path, bytes, { contentType: mime || "audio/ogg", upsert: false });
      if (upErr) console.warn("upload", upErr.message);
      else {
        mediaUrl = sb.storage.from("whatsapp-media").getPublicUrl(path).data.publicUrl;
        await sb
          .from("messages")
          .update({ media_url: mediaUrl, media_mime_type: mime })
          .eq("id", audio.id);
        console.log("saved media_url", mediaUrl);
      }
    }
  }
} else if (mediaUrl) {
  const dl = await fetch(mediaUrl);
  if (dl.ok) bytes = Buffer.from(await dl.arrayBuffer());
}

let transcript = (audio.transcript || "").trim();
if (!transcript && bytes) {
  const openaiKey = process.env.OPENAI_API_KEY || "";
  if (!openaiKey) {
    console.error("No OPENAI_API_KEY");
    process.exit(1);
  }
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime || "audio/ogg" }), "voice.ogg");
  form.append("model", "whisper-1");
  const wh = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: form,
  });
  const whRaw = await wh.text();
  console.log("whisper", wh.status, whRaw.slice(0, 200));
  if (wh.ok) {
    transcript = (JSON.parse(whRaw).text || "").trim();
    await sb
      .from("messages")
      .update({
        transcript,
        content: `[voice note] ${transcript}`,
      })
      .eq("id", audio.id);
  }
}

console.log("transcript:", transcript);

if (!transcript || !run) {
  console.log("Cannot resume — missing transcript or waiting run");
  process.exit(1);
}

// Resume: set concern, jump to product ask
await sb.from("trigger_run_vars").upsert(
  [
    { run_id: run.id, key: "concern", value: transcript },
    { run_id: run.id, key: "concern_mode", value: "Send a voice note" },
  ],
  { onConflict: "run_id,key" },
);

const { data: edges } = await sb
  .from("trigger_edges")
  .select("to_node_id,branch_label")
  .eq("flow_id", run.flow_id)
  .eq("from_node_id", run.current_node_id);

const next =
  (edges || []).find((e) => e.branch_label == null || e.branch_label === "") ||
  (edges || [])[0];

if (!next?.to_node_id) {
  console.error("No out-edge from parked node");
  process.exit(1);
}

const { data: productNode } = await sb
  .from("trigger_nodes")
  .select("id,node_type,config")
  .eq("id", next.to_node_id)
  .maybeSingle();

const productText = String(productNode?.config?.text || "").trim();
const buttons = Array.isArray(productNode?.config?.buttons)
  ? productNode.config.buttons
  : [];

const { data: contact } = await sb
  .from("contacts")
  .select("wa_id")
  .eq("id", CONTACT_ID)
  .single();

if (productText && contact?.wa_id && token) {
  // 4 options → list message
  const rows = buttons.slice(0, 10).map((b, i) => ({
    id: `opt_${i}`,
    title: String(b.label || b).slice(0, 24),
  }));
  const body =
    rows.length > 3
      ? {
          messaging_product: "whatsapp",
          to: contact.wa_id,
          type: "interactive",
          interactive: {
            type: "list",
            body: { text: productText },
            action: {
              button: "See options",
              sections: [{ title: "Options", rows }],
            },
          },
        }
      : {
          messaging_product: "whatsapp",
          to: contact.wa_id,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: productText },
            action: {
              buttons: rows.slice(0, 3).map((r) => ({
                type: "reply",
                reply: { id: r.id, title: r.title.slice(0, 20) },
              })),
            },
          },
        };

  const sendRes = await fetch(
    `https://graph.facebook.com/${apiVersion}/${BPID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  console.log("send product", sendRes.status, (await sendRes.text()).slice(0, 250));

  await sb
    .from("trigger_runs")
    .update({
      current_node_id: next.to_node_id,
      status: "waiting",
      updated_at: new Date().toISOString(),
    })
    .eq("id", run.id);

  // Store outbound in messages so inbox shows it
  const wamid = null;
  await sb.from("messages").insert({
    contact_id: CONTACT_ID,
    business_phone_number_id: BPID,
    wa_id: contact.wa_id,
    direction: "outbound",
    type: "text",
    content: productText,
    status: "sent",
    timestamp: new Date().toISOString(),
  });
}

console.log(JSON.stringify({ ok: true, transcript, next: next.to_node_id }, null, 2));
