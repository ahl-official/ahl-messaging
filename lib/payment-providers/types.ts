// Provider-agnostic payment-link contract.
//
// All gateways (Razorpay, PayU, ...) implement this same shape so the
// /api/payments routes don't have to special-case any single vendor.
// Adapter modules live alongside this file (razorpay.ts, payu.ts).

export type ProviderId = "razorpay" | "payu";

export interface CreateLinkInput {
  /** Amount in minor units — paise for INR. */
  amountMinor: number;
  currency?: string;
  description?: string;
  customer: {
    name?: string;
    /** E.164 with leading '+', e.g. "+919876543210". */
    contact: string;
    email?: string;
  };
  /** Internal payments-row id — providers stash this in their notes /
   *  udf field so the webhook can correlate back. */
  internalPaymentId: string;
  /** Internal txnid we control. Providers that require a merchant-
   *  side id (PayU) use this verbatim; providers that generate their
   *  own (Razorpay) ignore it. */
  internalTxnId: string;
}

export interface CreateLinkResult {
  /** Gateway's link id — razorpay payment_link.id / PayU invoice URL
   *  fragment. Used to correlate webhook events. */
  providerLinkId: string;
  /** Short URL we share with the client. */
  shortUrl: string;
}

/** A webhook event in normalised form — the per-provider adapter
 *  hides the signature / payload-shape differences and emits one of
 *  these from its `parseWebhookEvent`. */
export interface NormalisedWebhookEvent {
  /** What happened: paid | cancelled | expired | failed | other. */
  kind: "paid" | "cancelled" | "expired" | "failed" | "other";
  /** Provider-side link id (matches CreateLinkResult.providerLinkId). */
  providerLinkId?: string;
  /** Provider's payment id (e.g. PayU mihpayid). Recorded for audit. */
  providerPaymentId?: string;
  /** Hosted receipt URL or short URL to share with the payer. */
  shortUrl?: string;
  /** Echo of `internalPaymentId` we stashed at create time. */
  internalPaymentId?: string;
  /** Echo of `internalTxnId`. */
  internalTxnId?: string;
}

/** Provider-specific credential bag. Each adapter declares which
 *  fields it actually reads — we pass the whole object in and let
 *  the adapter pluck. Mirrors `PaymentCredentials` in
 *  `lib/payment-accounts.ts` (kept duplicated here to avoid a server-
 *  only import landing in the wrong bundle). */
export interface ProviderCredentials {
  // Razorpay
  key_id?: string;
  key_secret?: string;
  webhook_secret?: string;
  // PayU — legacy SMS API kept for back-compat. Modern PayU uses the
  // OAuth2 + payment-links endpoint below.
  merchant_key?: string;
  merchant_salt?: string;
  // PayU modern API (OAuth2): grab client_id / client_secret /
  // merchant_id from the PayU dashboard → API credentials.
  client_id?: string;
  client_secret?: string;
  merchant_id?: string;
  env?: "live" | "test";
}

export interface PaymentProvider {
  id: ProviderId;
  /** True when the supplied credentials are complete enough to mint
   *  a link / verify a webhook. */
  hasCredentials(creds: ProviderCredentials): boolean;
  createPaymentLink(
    input: CreateLinkInput,
    creds: ProviderCredentials,
  ): Promise<CreateLinkResult>;
  /** Verify the webhook signature against the raw body + headers. */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | null>,
    creds: ProviderCredentials,
  ): Promise<boolean>;
  /** Parse the (already-verified) raw body into our normalised shape. */
  parseWebhookEvent(rawBody: string): Promise<NormalisedWebhookEvent>;
}
