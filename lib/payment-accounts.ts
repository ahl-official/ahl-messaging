// Payment account storage helpers. One record per (clinic, provider,
// account) — each clinic (American Hairline, Alchemane) can have many Razorpay accounts
// + many PayU accounts side by side, with exactly ONE marked active
// per clinic.
//
// Also exposes virtual ".env.local" accounts (assigned to American Hairline) when env
// vars are set but no DB row exists — so existing installs keep working
// until the operator clicks "Save as account" or adds a new one.

import { createServiceRoleClient } from "@/lib/supabase/server";
import type { ProviderId } from "@/lib/payment-providers/types";

export type Clinic = "americanhairline" | "alchemane";
export const CLINICS: Clinic[] = ["americanhairline", "alchemane"];

export interface PaymentCredentials {
  // Razorpay
  key_id?: string;
  key_secret?: string;
  webhook_secret?: string;
  // PayU
  merchant_key?: string;
  merchant_salt?: string;
  // PayU modern OAuth
  client_id?: string;
  client_secret?: string;
  merchant_id?: string;
  env?: "live" | "test";
}

export interface PaymentAccount {
  id: string;            // 'env:razorpay' / 'env:payu' for the virtual rows
  clinic: Clinic;
  provider: ProviderId;
  label: string;
  credentials: PaymentCredentials;
  is_active: boolean;
  is_env_fallback: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS =
  "id, clinic, provider, label, credentials, is_active, created_by, created_at, updated_at";

// ---------------------------------------------------------------- //
// Read paths
// ---------------------------------------------------------------- //

/** All stored accounts + any env-only virtual accounts. The UI lists
 *  these grouped by clinic then provider. */
export async function listPaymentAccounts(): Promise<PaymentAccount[]> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("payment_accounts")
    .select(SELECT_COLS)
    .order("clinic", { ascending: true })
    .order("created_at", { ascending: true });
  const rows = (data ?? []) as Array<Omit<PaymentAccount, "is_env_fallback">>;
  const out: PaymentAccount[] = rows.map((r) => ({
    ...r,
    is_env_fallback: false,
  }));
  for (const v of envFallbackAccounts(out)) out.push(v);
  return out;
}

/** The active account for a clinic, or null if none. Falls back to the
 *  env account (American Hairline-only) when no DB row is active for that clinic. */
export async function getActiveAccountForClinic(
  clinic: Clinic,
): Promise<PaymentAccount | null> {
  const admin = createServiceRoleClient();
  const { data: row } = await admin
    .from("payment_accounts")
    .select(SELECT_COLS)
    .eq("clinic", clinic)
    .eq("is_active", true)
    .maybeSingle();
  if (row) {
    return { ...row, is_env_fallback: false } as PaymentAccount;
  }
  if (clinic !== "americanhairline") return null;
  const env = envFallbackAccounts([]);
  if (env.length === 0) return null;
  const rzp = env.find((a) => a.provider === "razorpay");
  if (rzp) return { ...rzp, is_active: true };
  return { ...env[0], is_active: true };
}

/** Look up a specific stored account by id (DB only — env rows are
 *  not returned because the webhook uses ?account=<uuid> which only
 *  matches DB rows). */
export async function getAccountById(
  id: string,
): Promise<PaymentAccount | null> {
  if (id.startsWith("env:")) {
    const env = envFallbackAccounts([]).find((v) => v.id === id);
    return env ?? null;
  }
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("payment_accounts")
    .select(SELECT_COLS)
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  return { ...data, is_env_fallback: false } as PaymentAccount;
}

// ---------------------------------------------------------------- //
// Write paths
// ---------------------------------------------------------------- //

export async function createPaymentAccount(input: {
  clinic: Clinic;
  provider: ProviderId;
  label: string;
  credentials: PaymentCredentials;
  created_by: string | null;
  set_active?: boolean;
}): Promise<PaymentAccount> {
  const admin = createServiceRoleClient();
  if (input.set_active) {
    await admin
      .from("payment_accounts")
      .update({ is_active: false })
      .eq("clinic", input.clinic)
      .eq("is_active", true);
  }
  const { data, error } = await admin
    .from("payment_accounts")
    .insert({
      clinic: input.clinic,
      provider: input.provider,
      label: input.label,
      credentials: input.credentials,
      is_active: !!input.set_active,
      created_by: input.created_by,
    })
    .select(SELECT_COLS)
    .single();
  if (error || !data) throw new Error(error?.message ?? "insert failed");
  return { ...data, is_env_fallback: false } as PaymentAccount;
}

export async function updatePaymentAccount(
  id: string,
  patch: { label?: string; credentials?: PaymentCredentials },
): Promise<void> {
  const admin = createServiceRoleClient();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.label !== undefined) update.label = patch.label;
  if (patch.credentials !== undefined) update.credentials = patch.credentials;
  await admin.from("payment_accounts").update(update).eq("id", id);
}

export async function deletePaymentAccount(id: string): Promise<void> {
  const admin = createServiceRoleClient();
  await admin.from("payment_accounts").delete().eq("id", id);
}

export async function setActiveAccount(id: string): Promise<void> {
  const admin = createServiceRoleClient();
  if (id.startsWith("env:")) {
    // Env virtual rows belong to American Hairline — clear any active row so the
    // env binding wins via the fallback.
    await admin
      .from("payment_accounts")
      .update({ is_active: false })
      .eq("clinic", "americanhairline")
      .eq("is_active", true);
    return;
  }
  const { data: target } = await admin
    .from("payment_accounts")
    .select("clinic")
    .eq("id", id)
    .maybeSingle();
  if (!target?.clinic) return;
  // 2-step swap scoped to the row's clinic — partial unique index on
  // (clinic) where is_active=true would block a single UPDATE flipping
  // two rows simultaneously.
  await admin
    .from("payment_accounts")
    .update({ is_active: false })
    .eq("clinic", target.clinic)
    .eq("is_active", true);
  await admin
    .from("payment_accounts")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq("id", id);
}

// ---------------------------------------------------------------- //
// .env.local virtual accounts (assigned to American Hairline)
// ---------------------------------------------------------------- //

function envFallbackAccounts(
  existing: Array<{ clinic?: Clinic; provider: ProviderId }>,
): PaymentAccount[] {
  // Only surface env entries when American Hairline doesn't already have a DB row
  // for that provider — keeps the list clean after migration.
  const primaryRows = existing.filter((a) => (a.clinic ?? "americanhairline") === "americanhairline");
  const hasDbRzp = primaryRows.some((a) => a.provider === "razorpay");
  const hasDbPayu = primaryRows.some((a) => a.provider === "payu");
  const out: PaymentAccount[] = [];
  if (
    !hasDbRzp &&
    process.env.RAZORPAY_KEY_ID &&
    process.env.RAZORPAY_KEY_SECRET
  ) {
    out.push({
      id: "env:razorpay",
      clinic: "americanhairline",
      provider: "razorpay",
      label: "Default (from .env.local)",
      credentials: {
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
        webhook_secret: process.env.RAZORPAY_WEBHOOK_SECRET,
      },
      is_active: false,
      is_env_fallback: true,
      created_by: null,
      created_at: "1970-01-01T00:00:00Z",
      updated_at: "1970-01-01T00:00:00Z",
    });
  }
  if (
    !hasDbPayu &&
    process.env.PAYU_MERCHANT_KEY &&
    process.env.PAYU_MERCHANT_SALT
  ) {
    out.push({
      id: "env:payu",
      clinic: "americanhairline",
      provider: "payu",
      label: "Default (from .env.local)",
      credentials: {
        merchant_key: process.env.PAYU_MERCHANT_KEY,
        merchant_salt: process.env.PAYU_MERCHANT_SALT,
        env: (process.env.PAYU_ENV as "live" | "test") ?? "live",
      },
      is_active: false,
      is_env_fallback: true,
      created_by: null,
      created_at: "1970-01-01T00:00:00Z",
      updated_at: "1970-01-01T00:00:00Z",
    });
  }
  return out;
}
