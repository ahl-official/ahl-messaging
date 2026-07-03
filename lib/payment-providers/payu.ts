// PayU India adapter — modern OAuth2 + /payment-links API.
//
// The legacy SMS / postservice.php?form=2 invoice API was rejecting
// even PayU's own documented sample payload ("Invalid customer name"
// for "Aamir"), which signalled the merchant's account no longer had
// access to that route. PayU's current recommended path is:
//   1. POST {accountsHost}/oauth/token (client_credentials grant) →
//      access_token with scope=create_payment_links.
//   2. POST {oneapiHost}/payment-links with the token in
//      Authorization: Bearer … and merchantId header.
//
// Required credentials (Settings → Payments → PayU):
//   client_id, client_secret, merchant_id
// Legacy merchant_key / merchant_salt are still accepted for the
// webhook hash check (PayU's S2S notification keeps the old SHA-512
// scheme even on the new API).

import crypto from "node:crypto";
import type {
  CreateLinkInput,
  CreateLinkResult,
  NormalisedWebhookEvent,
  PaymentProvider,
  ProviderCredentials,
} from "@/lib/payment-providers/types";

function oauthHost(env: string | undefined): string {
  return env === "test"
    ? "https://uat-accounts.payu.in"
    : "https://accounts.payu.in";
}
function oneapiHost(env: string | undefined): string {
  return env === "test"
    ? "https://uatoneapi.payu.in"
    : "https://oneapi.payu.in";
}

function sha512Hex(input: string): string {
  return crypto.createHash("sha512").update(input).digest("hex");
}

// In-memory token cache, keyed by client_id + env. PayU access tokens
// last for ~1 hour; we refresh 60s before expiry so a long send burst
// doesn't race with a stale token.
interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

async function getAccessToken(creds: ProviderCredentials): Promise<string> {
  if (!creds.client_id || !creds.client_secret) {
    throw new Error(
      "PayU account missing client_id / client_secret. Add them under Settings → Payments → PayU (get from PayU Dashboard → Settings → API credentials).",
    );
  }
  const env = creds.env ?? "live";
  const cacheKey = `${creds.client_id}::${env}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    scope: "create_payment_links",
  });

  const url = `${oauthHost(env)}/oauth/token`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    cache: "no-store",
  });
  const text = await res.text();
  console.log(`[payu] OAuth POST ${url} HTTP ${res.status} body=${text.slice(0, 500)}`);
  let json: {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`PayU OAuth returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || !json.access_token) {
    throw new Error(
      `PayU OAuth failed (HTTP ${res.status}): ${json.error_description ?? json.error ?? text.slice(0, 200)}`,
    );
  }
  const expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
  tokenCache.set(cacheKey, { token: json.access_token, expiresAt });
  return json.access_token;
}

interface CreatePaymentLinkResponse {
  status?: number;
  message?: string;
  result?: {
    paymentLink?: string;
    invoiceNumber?: string;
  };
  errorCode?: string | null;
  guid?: string | null;
}

export const payuProvider: PaymentProvider = {
  id: "payu",

  hasCredentials(creds) {
    return Boolean(creds.client_id && creds.client_secret && creds.merchant_id);
  },

  async createPaymentLink(input: CreateLinkInput, creds): Promise<CreateLinkResult> {
    if (!creds.merchant_id) {
      throw new Error(
        "PayU account missing merchant_id. Add it under Settings → Payments → PayU.",
      );
    }
    const env = creds.env ?? "live";
    const merchantId = creds.merchant_id;

    // Modern API takes subAmount as an INTEGER (rupees) — minimum 1.
    // We round to nearest rupee here; UI prevents sub-rupee amounts.
    const subAmount = Math.max(1, Math.round(input.amountMinor / 100));

    // Phone: PayU expects exactly 10 IN digits. Skip when we can't
    // produce a clean 10-digit string (better "missing" than malformed).
    const phoneDigits = input.customer.contact.replace(/\D/g, "");
    const phone =
      phoneDigits.length === 10
        ? phoneDigits
        : phoneDigits.length > 10
          ? phoneDigits.slice(-10)
          : undefined;

    // Customer name: letters + spaces only. Fallback "Customer".
    const customerName = (() => {
      const raw = (input.customer.name ?? "").trim();
      const cleaned = raw.replace(/[^A-Za-z\s]/g, " ").replace(/\s+/g, " ").trim();
      return (cleaned || "Customer").slice(0, 100);
    })();

    // Email: synthesise a placeholder when missing (PayU only checks
    // format, not deliverability).
    const email = (() => {
      const raw = (input.customer.email ?? "").trim();
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
      if (ok) return raw.slice(0, 100);
      const digits = phoneDigits.slice(-10) || "client";
      return `${digits}@qhtclinic.in`;
    })();

    // Description: strip pipes (some PayU validators reject), collapse
    // whitespace, cap at 255.
    const description = ((input.description ?? "QHT Salon payment")
      .replace(/\|/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "QHT Salon payment").slice(0, 255);

    // invoiceNumber: PayU caps at 16 chars (error [137]). Build a short
    // unique id: base36 timestamp (~8 chars) + 4 random base36 chars
    // = ~12 chars, well under the limit and unique enough per send.
    const invoiceNumber = (
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 6)
    ).slice(0, 16);

    // udf1 carries the internal payment id back to us on the webhook.
    const udf1 = String(input.internalPaymentId).replace(/\|/g, "").slice(0, 255);

    const payload: Record<string, unknown> = {
      subAmount,
      description,
      source: "API",
      isPartialPaymentAllowed: false,
      currency: "INR",
      invoiceNumber,
      customer: {
        name: customerName,
        email,
        ...(phone ? { phone } : {}),
      },
      udf: { udf1 },
      viaEmail: false,
      viaSms: false,
    };

    const accessToken = await getAccessToken(creds);
    const endpoint = `${oneapiHost(env)}/payment-links`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        merchantId,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const text = await res.text();
    console.log(
      `[payu] POST ${endpoint} HTTP ${res.status} env=${env} merchantId=${merchantId} txnid=${input.internalTxnId}`,
    );
    console.log(`[payu] payload: ${JSON.stringify(payload)}`);
    console.log(`[payu] response body: ${text.slice(0, 1500)}`);

    let json: CreatePaymentLinkResponse | null = null;
    try {
      json = JSON.parse(text) as CreatePaymentLinkResponse;
    } catch {
      throw new Error(
        `PayU returned a non-JSON body (HTTP ${res.status}): ${text.slice(0, 200)}`,
      );
    }
    // PayU's "status: 0" + "message: paymentLink generated" = success.
    // Anything else (status -1 / 1 / 2 / etc.) is a failure.
    if (!res.ok || json.status !== 0 || !json.result?.paymentLink) {
      throw new Error(
        `PayU payment-link failed: ${json.message ?? `HTTP ${res.status}`}${json.errorCode ? ` [${json.errorCode}]` : ""}`,
      );
    }
    return {
      providerLinkId: json.result.invoiceNumber ?? json.result.paymentLink,
      shortUrl: json.result.paymentLink,
    };
  },

  async verifyWebhook(rawBody, _headers, creds): Promise<boolean> {
    if (!creds.merchant_salt) return false;
    const salt = creds.merchant_salt;
    const params = new URLSearchParams(rawBody);
    const incomingHash = params.get("hash") ?? "";
    if (!incomingHash) return false;
    const key = params.get("key") ?? "";
    const txnid = params.get("txnid") ?? "";
    const amount = params.get("amount") ?? "";
    const productinfo = params.get("productinfo") ?? "";
    const firstname = params.get("firstname") ?? "";
    const email = params.get("email") ?? "";
    const status = params.get("status") ?? "";
    const udf1 = params.get("udf1") ?? "";
    const udf2 = params.get("udf2") ?? "";
    const udf3 = params.get("udf3") ?? "";
    const udf4 = params.get("udf4") ?? "";
    const udf5 = params.get("udf5") ?? "";

    const hashSource = [
      salt,
      status,
      "", "", "", "", "",
      udf5,
      udf4,
      udf3,
      udf2,
      udf1,
      email,
      firstname,
      productinfo,
      amount,
      txnid,
      key,
    ].join("|");
    const expected = sha512Hex(hashSource);
    if (expected.length !== incomingHash.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(incomingHash.toLowerCase()),
    );
  },

  async parseWebhookEvent(rawBody): Promise<NormalisedWebhookEvent> {
    const params = new URLSearchParams(rawBody);
    const status = (params.get("status") ?? "").toLowerCase();
    const mihpayid = params.get("mihpayid") ?? undefined;
    const txnid = params.get("txnid") ?? undefined;
    const udf1 = params.get("udf1") ?? undefined;
    let kind: NormalisedWebhookEvent["kind"] = "other";
    if (status === "success") kind = "paid";
    else if (status === "failure" || status === "failed") kind = "failed";
    else if (status === "cancel" || status === "cancelled") kind = "cancelled";
    return {
      kind,
      providerLinkId: undefined,
      providerPaymentId: mihpayid,
      shortUrl: undefined,
      internalPaymentId: udf1,
      internalTxnId: txnid,
    };
  },
};

