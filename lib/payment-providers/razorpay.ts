// Razorpay adapter. Now stateless w.r.t. credentials — caller passes
// the account's keys in.

import {
  createPaymentLink as createRazorpayLink,
  verifyWebhookSignature,
} from "@/lib/razorpay";
import type {
  CreateLinkInput,
  CreateLinkResult,
  NormalisedWebhookEvent,
  PaymentProvider,
  ProviderCredentials,
} from "@/lib/payment-providers/types";

interface RzpEvent {
  event?: string;
  payload?: {
    payment_link?: {
      entity?: {
        id?: string;
        status?: string;
        notes?: Record<string, string>;
        short_url?: string;
      };
    };
    payment?: { entity?: { id?: string } };
  };
}

export const razorpayProvider: PaymentProvider = {
  id: "razorpay",

  hasCredentials(creds) {
    return Boolean(creds.key_id && creds.key_secret);
  },

  async createPaymentLink(input, creds): Promise<CreateLinkResult> {
    if (!creds.key_id || !creds.key_secret) {
      throw new Error("Razorpay account credentials missing (key_id / key_secret)");
    }
    const link = await createRazorpayLink(
      {
        amountMinor: input.amountMinor,
        currency: input.currency,
        description: input.description,
        customer: input.customer,
        reminderEnable: true,
        notes: {
          payment_id: input.internalPaymentId,
          txnid: input.internalTxnId,
        },
      },
      { key_id: creds.key_id, key_secret: creds.key_secret },
    );
    return { providerLinkId: link.id, shortUrl: link.short_url };
  },

  async verifyWebhook(rawBody, headers, creds): Promise<boolean> {
    if (!creds.webhook_secret) return false;
    const sig = headers["x-razorpay-signature"];
    return verifyWebhookSignature(rawBody, sig ?? null, creds.webhook_secret);
  },

  async parseWebhookEvent(rawBody): Promise<NormalisedWebhookEvent> {
    let event: RzpEvent;
    try {
      event = JSON.parse(rawBody) as RzpEvent;
    } catch {
      return { kind: "other" };
    }
    const link = event.payload?.payment_link?.entity;
    const name = event.event ?? "";
    let kind: NormalisedWebhookEvent["kind"] = "other";
    if (name === "payment_link.paid") kind = "paid";
    else if (name === "payment_link.cancelled") kind = "cancelled";
    else if (name === "payment_link.expired") kind = "expired";
    return {
      kind,
      providerLinkId: link?.id,
      providerPaymentId: event.payload?.payment?.entity?.id,
      shortUrl: link?.short_url,
      internalPaymentId: link?.notes?.payment_id,
      internalTxnId: link?.notes?.txnid,
    };
  },

};
