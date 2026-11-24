/**
 * One-off: re-download a voice note that landed without media_url,
 * upload with normalized mime, Whisper, resume parked V3 ask_text.
 *
 * Usage: node scripts/recover-voice-note.mjs <message_id>
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

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

const messageId = (process.argv[2] || "33a1a719-87db-45ea-8025-ac7512d7ff15").trim();
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

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
  return String(
    process.env.WHATSAPP_ACCESS_TOKEN ||
      process.env.META_ACCESS_TOKEN ||
      "",
  ).trim();
}

const { data: msg, error } = await sb
  .from("messages")
  .select("*")
  .eq("id", messageId)
  .single();
if (error || !msg) {
  console.error("message not found", error?.message);
  process.exit(1);
}

const raw = msg.raw_payload || {};
const mediaId = raw.audio?.id;
const payloadUrl = raw.audio?.url;
const bpid = msg.business_phone_number_id;
let mime = normalizeMime(msg.media_mime_type || raw.audio?.mime_type || "audio/ogg");

console.log({ messageId, mediaId, hasPayloadUrl: !!payloadUrl, bpid, mime, hasMedia: !!msg.media_url });

const token = await resolveToken(bpid);
if (!token) {
  console.error("No WhatsApp access token");
  process.exit(1);
}

const apiVersion = process.env.WHATSAPP_API_VERSION || "v21.0";
let downloadUrl = "";
const metaRes = await fetch(
  `https://graph.facebook.com/${apiVersion}/${mediaId}?fields=url,mime_type`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const metaText = await metaRes.text();
console.log("graph status", metaRes.status, metaText.slice(0, 200));
if (metaRes.ok) {
  const meta = JSON.parse(metaText);
  downloadUrl = meta.url || "";
  if (meta.mime_type) mime = normalizeMime(meta.mime_type);
}
if (!downloadUrl && payloadUrl) downloadUrl = payloadUrl;
if (!downloadUrl) {
  console.error("No download URL — media likely expired. Ask user to resend voice note.");
  process.exit(2);
}

const dl = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
console.log("download", dl.status, dl.headers.get("content-type"));
if (!dl.ok) {
  console.error("download failed", await dl.text());
  process.exit(2);
}
const bytes = Buffer.from(await dl.arrayBuffer());
console.log("bytes", bytes.length);

const BUCKET = "whatsapp-media";
const { data: buckets } = await sb.storage.listBuckets();
const bucketNames = (buckets || []).map((b) => b.name);
console.log("buckets", bucketNames);
if (!bucketNames.includes(BUCKET)) {
  const { error: createErr } = await sb.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: 50 * 1024 * 1024,
  });
  console.log("createBucket", createErr?.message || "ok");
}
const path = `inbound/${randomUUID()}-${mediaId}.ogg`;
let mediaUrl = null;
const { error: upErr } = await sb.storage.from(BUCKET).upload(path, bytes, {
  contentType: mime || "audio/ogg",
  upsert: false,
});
if (upErr) {
  console.warn("upload failed (continuing with Whisper only):", upErr.message);
} else {
  const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
  mediaUrl = pub.publicUrl;
  console.log("mediaUrl", mediaUrl);
  await sb
    .from("messages")
    .update({ media_url: mediaUrl, media_mime_type: mime || "audio/ogg" })
    .eq("id", messageId);
}

// Whisper
function openaiKeyFromEnv() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  // Portfolios / credentials often stash as OPENAI_API_KEY in .env.local
  for (const [k, v] of Object.entries(process.env)) {
    if (/openai.*key/i.test(k) && v) return String(v).trim();
  }
  return "";
}

const openaiKey = openaiKeyFromEnv();
if (!openaiKey) {
  console.error("No OpenAI key — media may be saved; cannot Whisper");
  process.exit(1);
}

const form = new FormData();
form.append("file", new Blob([bytes], { type: mime || "audio/ogg" }), `${mediaId}.ogg`);
form.append("model", "whisper-1");
const wh = await fetch("https://api.openai.com/v1/audio/transcriptions", {
  method: "POST",
  headers: { Authorization: `Bearer ${openaiKey}` },
  body: form,
});
const whRaw = await wh.text();
console.log("whisper", wh.status, whRaw.slice(0, 300));
if (!wh.ok) process.exit(1);
const transcript = (JSON.parse(whRaw).text || "").trim();
const content = `[voice note] ${transcript}`;
await sb
  .from("messages")
  .update({ transcript, content })
  .eq("id", messageId);

const { data: contact } = await sb
  .from("contacts")
  .select("id, wa_id, business_phone_number_id")
  .eq("id", msg.contact_id)
  .single();

console.log({ transcript, contact: contact?.wa_id });

// Persist concern on the waiting V3 run + point at product ask so the next
// inbound isn't stuck. Then send the product question via Graph.
const { data: run } = await sb
  .from("trigger_runs")
  .select("id, flow_id, current_node_id, status")
  .eq("contact_id", msg.contact_id)
  .eq("status", "waiting")
  .order("started_at", { ascending: false })
  .limit(1)
  .maybeSingle();

if (run && transcript) {
  await sb.from("trigger_run_vars").upsert(
    [
      { run_id: run.id, key: "concern", value: transcript },
      { run_id: run.id, key: "concern_mode", value: "Send a voice note" },
    ],
    { onConflict: "run_id,key" },
  );

  const { data: edges } = await sb
    .from("trigger_edges")
    .select("to_node_id, branch_label")
    .eq("flow_id", run.flow_id)
    .eq("from_node_id", run.current_node_id);
  const next =
    (edges || []).find((e) => e.branch_label == null || e.branch_label === "") ||
    (edges || [])[0];
  if (next?.to_node_id) {
    const { data: productNode } = await sb
      .from("trigger_nodes")
      .select("id, node_type, config")
      .eq("id", next.to_node_id)
      .maybeSingle();

    // Park on product ask — send its prompt, then wait for reply
    const productText = String(productNode?.config?.text || "").trim();
    const buttons = Array.isArray(productNode?.config?.buttons)
      ? productNode.config.buttons
      : [];

    if (productText && contact?.wa_id) {
      const apiVersion = process.env.WHATSAPP_API_VERSION || "v21.0";
      const body =
        buttons.length > 0
          ? {
              messaging_product: "whatsapp",
              to: contact.wa_id,
              type: "interactive",
              interactive: {
                type: "button",
                body: { text: productText },
                action: {
                  buttons: buttons.slice(0, 3).map((b, i) => ({
                    type: "reply",
                    reply: {
                      id: `btn_${i}`,
                      title: String(b.label || b).slice(0, 20),
                    },
                  })),
                },
              },
            }
          : {
              messaging_product: "whatsapp",
              to: contact.wa_id,
              type: "text",
              text: { body: productText },
            };
      const sendRes = await fetch(
        `https://graph.facebook.com/${apiVersion}/${bpid}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      console.log("send product", sendRes.status, (await sendRes.text()).slice(0, 200));

      await sb
        .from("trigger_runs")
        .update({
          current_node_id: next.to_node_id,
          status: "waiting",
          updated_at: new Date().toISOString(),
        })
        .eq("id", run.id);
    }
  }
}

console.log(
  JSON.stringify({ ok: true, transcript, mediaUrl, resumedRun: run?.id || null }, null, 2),
);
