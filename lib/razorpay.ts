// Razorpay client — thin wrapper around the Payment Links API + webhook
// signature verification. Now takes credentials as explicit arguments
// instead of reading env, so the multi-account workflow can pass in
// whichever stored account the operator picked.
//
// Server-only; do NOT import from client code.

import crypto from "node:crypto";

const BASE_URL = "https://api.razorpay.com/v1";

export interface RazorpayCreds {
  key_id: string;
  key_secret: string;
  webhook_secret?: string;
}

interface RazorpayError {
  error?: { description?: string; code?: string };
}

async function call<T>(
  path: string,
  init: { method: string; body?: unknown },
  creds: RazorpayCreds,
): Promise<T> {
  const auth = Buffer.from(`${creds.key_id}:${creds.key_secret}`).toString(
    "base64",
  );
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const e = json as RazorpayError | null;
    const msg =
      e?.error?.description ?? text.slice(0, 200) ?? `HTTP ${res.status}`;
    throw new Error(`Razorpay ${path} failed: ${msg}`);
  }
  return json as T;
}

export interface CreatePaymentLinkInput {
  amountMinor: number;
  currency?: string;
  description?: string;
  customer: {
    name?: string;
    contact: string;
    email?: string;
  };
  reminderEnable?: boolean;
  notes?: Record<string, string>;
  expireBy?: number;
  callbackUrl?: string;
}

export interface RazorpayPaymentLink {
  id: string;
  short_url: string;
  status: string;
  amount: number;
  currency: string;
  reference_id?: string;
  notes?: Record<string, string>;
}

export async function createPaymentLink(
  input: CreatePaymentLinkInput,
  creds: RazorpayCreds,
): Promise<RazorpayPaymentLink> {
  const body: Record<string, unknown> = {
    amount: input.amountMinor,
    currency: input.currency ?? "INR",
    accept_partial: false,
    description: input.description?.slice(0, 2048) ?? undefined,
    customer: {
      name: input.customer.name?.slice(0, 100),
      contact: input.customer.contact,
      email: input.customer.email,
    },
    notify: { sms: false, email: !!input.customer.email },
    reminder_enable: input.reminderEnable ?? true,
    notes: input.notes,
  };
  if (input.expireBy) body.expire_by = Math.floor(input.expireBy / 1000);
  if (input.callbackUrl) {
    body.callback_url = input.callbackUrl;
    body.callback_method = "get";
  }
  return await call<RazorpayPaymentLink>(
    "/payment_links",
    { method: "POST", body },
    creds,
  );
}

export async function fetchPaymentLink(
  id: string,
  creds: RazorpayCreds,
): Promise<
  RazorpayPaymentLink & {
    payments?: Array<{ payment_id: string; status: string; amount: number }>;
  }
> {
  return await call(
    `/payment_links/${encodeURIComponent(id)}`,
    { method: "GET" },
    creds,
  );
}

/** Verify webhook signature using the supplied account's secret. */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
): boolean {
  if (!signatureHeader || !webhookSecret) return false;
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");
  if (expected.length !== signatureHeader.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signatureHeader),
  );
}
