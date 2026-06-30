// Reversible secret encryption for values we must store in the DB but should
// never keep as plaintext (e.g. an operator's Click-2-Call API key).
//
// AES-256-GCM with a key derived from a server-only secret. A true one-way
// hash can't be used here — the API key has to be replayed to the operator on
// every call, so it must be decryptable. Storage form is `enc:v1:<base64>`.
//
// Key material precedence: TELEPHONY_SECRET (set this to pin it), else the
// service-role key (always present server-side). If the source secret rotates,
// old ciphertext won't decrypt — re-enter the key. Server-only.

import crypto from "crypto";

const PREFIX = "enc:v1:";

function keyMaterial(): Buffer {
  const src =
    process.env.TELEPHONY_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.NEXTAUTH_SECRET ||
    "qht-telephony-fallback-key";
  return crypto.createHash("sha256").update(src).digest(); // 32 bytes
}

export function isEncrypted(s: string | null | undefined): boolean {
  return typeof s === "string" && s.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  if (isEncrypted(plain)) return plain; // already encrypted — don't double-wrap
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyMaterial(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(blob: string | null | undefined): string {
  if (!blob) return "";
  if (!isEncrypted(blob)) return blob; // legacy plaintext — pass through
  try {
    const raw = Buffer.from(blob.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const d = crypto.createDecipheriv("aes-256-gcm", keyMaterial(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}

/** Display form — keeps the first/last 4 chars so the operator can recognise
 *  the key without exposing it. Uses U+2022 bullets (the • marker the config
 *  route relies on to detect an unchanged value). */
export function maskSecret(plain: string): string {
  if (!plain) return "";
  if (plain.length <= 8) return "••••";
  return plain.slice(0, 4) + "••••" + plain.slice(-4);
}
