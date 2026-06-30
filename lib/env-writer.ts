// Tiny helper to safely append a phone_number_id to a portfolio's
// PHONE_IDS env var inside .env.local (dev only) and also mutate
// process.env so the running server picks up the change immediately —
// no restart required.
//
// In production (Vercel/Railway/etc.) the .env.local file doesn't exist
// — set PORTFOLIO_<key>_PHONE_IDS via your hosting platform's env-var
// dashboard and redeploy. The route that calls this helper will
// detect read-only filesystems and fall back to an in-memory-only update
// with a warning.
//
// Server-only.

import fs from "node:fs/promises";
import path from "node:path";

const ENV_PATH = path.join(process.cwd(), ".env.local");

export interface EnvAppendResult {
  ok: boolean;
  persisted: boolean;
  /** Final comma-separated value of the env var after appending. */
  value: string;
  message?: string;
}

/**
 * Append a phone_number_id to PORTFOLIO_<key>_PHONE_IDS. Idempotent — does
 * nothing if the ID is already present. Updates process.env regardless of
 * whether the file write succeeds (so the running server reflects the
 * change), but reports `persisted: false` when the file write fails.
 */
export async function appendPhoneIdToPortfolio(
  portfolioKey: string,
  phoneNumberId: string,
): Promise<EnvAppendResult> {
  const envName = `PORTFOLIO_${portfolioKey}_PHONE_IDS`;
  const existing = (process.env[envName] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (existing.includes(phoneNumberId)) {
    return {
      ok: true,
      persisted: true,
      value: existing.join(","),
      message: "Already assigned",
    };
  }

  const next = [...existing, phoneNumberId];
  const nextValue = next.join(",");

  // 1. Mutate process.env immediately so the running server picks up
  //    the change without a restart.
  process.env[envName] = nextValue;

  // 2. Try to persist to .env.local for the next restart.
  try {
    const file = await fs.readFile(ENV_PATH, "utf8");
    const lines = file.split(/\r?\n/);
    let found = false;
    const updated = lines.map((line) => {
      const m = line.match(/^([A-Z0-9_]+)\s*=/);
      if (m && m[1] === envName) {
        found = true;
        return `${envName}=${nextValue}`;
      }
      return line;
    });
    if (!found) {
      // Variable not yet defined in the file — append it.
      updated.push(`${envName}=${nextValue}`);
    }
    await fs.writeFile(ENV_PATH, updated.join("\n"), "utf8");
    return { ok: true, persisted: true, value: nextValue };
  } catch (e) {
    return {
      ok: true,
      persisted: false,
      value: nextValue,
      message:
        e instanceof Error
          ? `In-memory only (file write failed: ${e.message}). Update your hosting env vars manually.`
          : "In-memory only. Update your hosting env vars manually.",
    };
  }
}

// ---------------------------------------------------------------------------
// Portfolio block writer — used by Settings → Portfolios "Add portfolio" UI.
// Writes a complete PORTFOLIO_<key>_* block + appends the key to
// PORTFOLIO_KEYS, both in .env.local (dev) and process.env (live).
// ---------------------------------------------------------------------------

export interface PortfolioBlock {
  key: string;
  name: string;
  access_token: string;
  app_id?: string | null;
  business_account_id?: string | null;
  verify_token: string;
  phone_number_ids?: string[];
  display_name?: string | null;
  is_active?: boolean;
  /** 'meta' (default) or 'interakt'. Interakt portfolios carry only an
   *  account id — no Meta tokens. */
  provider?: string | null;
}

/** Uppercase alphanumeric + underscore. Throws on invalid. */
export function sanitizePortfolioKey(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!cleaned || !/^[A-Z][A-Z0-9_]*$/.test(cleaned)) {
    throw new Error(
      "Portfolio key must start with a letter and contain only A-Z, 0-9, _ (e.g. UROOTS, QHT_CLINIC).",
    );
  }
  return cleaned;
}

function quoteIfNeeded(value: string): string {
  // Wrap in double quotes when there's whitespace or special chars; escape
  // existing double quotes. Plain alphanumeric / common token chars are
  // left bare to match how the existing .env.local looks.
  if (value === "") return "";
  if (/^[A-Za-z0-9_\-+./:%,]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function blockLines(b: PortfolioBlock): Array<[string, string]> {
  const k = b.key;
  const out: Array<[string, string]> = [
    [`PORTFOLIO_${k}_NAME`, b.name],
    [`PORTFOLIO_${k}_ACCESS_TOKEN`, b.access_token],
    [`PORTFOLIO_${k}_APP_ID`, b.app_id ?? ""],
    [`PORTFOLIO_${k}_BUSINESS_ACCOUNT_ID`, b.business_account_id ?? ""],
    [`PORTFOLIO_${k}_VERIFY_TOKEN`, b.verify_token],
    [`PORTFOLIO_${k}_PHONE_IDS`, (b.phone_number_ids ?? []).join(",")],
    [`PORTFOLIO_${k}_DISPLAY_NAME`, b.display_name ?? ""],
  ];
  // Only emit PROVIDER for non-meta portfolios (default = meta).
  if (b.provider && b.provider !== "meta") {
    out.push([`PORTFOLIO_${k}_PROVIDER`, b.provider]);
  }
  // Only emit ACTIVE when explicitly false — default behaviour (no var) = active.
  if (b.is_active === false) out.push([`PORTFOLIO_${k}_ACTIVE`, "false"]);
  return out;
}

/** Add a new portfolio block. Errors if the key already exists. */
export async function addPortfolioBlock(b: PortfolioBlock): Promise<EnvAppendResult> {
  const key = b.key;
  const keysVar = "PORTFOLIO_KEYS";
  const existingKeys = (process.env[keysVar] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (existingKeys.includes(key)) {
    throw new Error(`Portfolio "${key}" already exists.`);
  }
  const nextKeys = [...existingKeys, key];

  // 1. Mutate process.env so the running server picks up the new portfolio.
  process.env[keysVar] = nextKeys.join(",");
  for (const [name, value] of blockLines(b)) {
    process.env[name] = value;
  }

  // 2. Persist to .env.local (best effort).
  try {
    let file = "";
    try {
      file = await fs.readFile(ENV_PATH, "utf8");
    } catch {
      // No .env.local on disk — start fresh.
      file = "";
    }
    const lines = file.split(/\r?\n/);

    // Update or insert PORTFOLIO_KEYS.
    let foundKeys = false;
    const updated = lines.map((line) => {
      const m = line.match(/^([A-Z0-9_]+)\s*=/);
      if (m && m[1] === keysVar) {
        foundKeys = true;
        return `${keysVar}=${nextKeys.join(",")}`;
      }
      return line;
    });
    if (!foundKeys) updated.push(`${keysVar}=${nextKeys.join(",")}`);

    // Append the new portfolio block at the end with a divider comment.
    updated.push("", `# ---------- ${b.name || key} ----------`);
    for (const [name, value] of blockLines(b)) {
      updated.push(`${name}=${quoteIfNeeded(value)}`);
    }

    await fs.writeFile(ENV_PATH, updated.join("\n"), "utf8");
    return { ok: true, persisted: true, value: key };
  } catch (e) {
    return {
      ok: true,
      persisted: false,
      value: key,
      message:
        e instanceof Error
          ? `In-memory only (file write failed: ${e.message}). Set PORTFOLIO_${key}_* in your hosting env vars before next deploy.`
          : "In-memory only — set in hosting env vars before next deploy.",
    };
  }
}

/** Remove a portfolio block + drop the key from PORTFOLIO_KEYS. */
export async function removePortfolioBlock(key: string): Promise<EnvAppendResult> {
  const keysVar = "PORTFOLIO_KEYS";
  const existingKeys = (process.env[keysVar] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!existingKeys.includes(key)) {
    throw new Error(`Portfolio "${key}" not found.`);
  }
  const nextKeys = existingKeys.filter((k) => k !== key);
  process.env[keysVar] = nextKeys.join(",");
  // Strip every PORTFOLIO_<key>_* var from process.env.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(`PORTFOLIO_${key}_`)) delete process.env[name];
  }

  try {
    const file = await fs.readFile(ENV_PATH, "utf8");
    const lines = file.split(/\r?\n/);
    const filtered = lines.filter((line) => {
      const m = line.match(/^([A-Z0-9_]+)\s*=/);
      if (!m) return true;
      if (m[1] === keysVar) return false; // we'll re-add below
      if (m[1].startsWith(`PORTFOLIO_${key}_`)) return false;
      return true;
    });
    filtered.push(`${keysVar}=${nextKeys.join(",")}`);
    await fs.writeFile(ENV_PATH, filtered.join("\n"), "utf8");
    return { ok: true, persisted: true, value: key };
  } catch (e) {
    return {
      ok: true,
      persisted: false,
      value: key,
      message:
        e instanceof Error
          ? `In-memory only (file write failed: ${e.message}). Remove PORTFOLIO_${key}_* from hosting env vars manually.`
          : "In-memory only — remove from hosting env vars manually.",
    };
  }
}
