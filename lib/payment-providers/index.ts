// Active-provider + active-account resolver. /api/payments/create-link
// asks "who's minting for clinic X today?" and gets back the provider
// + the keys it should use. Webhook routes look up adapters by id +
// account id directly.

import {
  getActiveAccountForClinic,
  getAccountById,
  type Clinic,
} from "@/lib/payment-accounts";
import type {
  PaymentProvider,
  ProviderCredentials,
  ProviderId,
} from "@/lib/payment-providers/types";
import { razorpayProvider } from "@/lib/payment-providers/razorpay";
import { payuProvider } from "@/lib/payment-providers/payu";

const PROVIDERS: Record<ProviderId, PaymentProvider> = {
  razorpay: razorpayProvider,
  payu: payuProvider,
};

export function getProvider(id: ProviderId): PaymentProvider {
  return PROVIDERS[id];
}

/** Resolves the active account + provider for a given clinic. */
export async function getActiveProviderBinding(
  clinic: Clinic = "americanhairline",
): Promise<{
  provider: PaymentProvider;
  credentials: ProviderCredentials;
  accountId: string;
  accountLabel: string;
  clinic: Clinic;
}> {
  const acc = await getActiveAccountForClinic(clinic);
  if (!acc) {
    throw new Error(
      `No payment account configured for ${clinic.toUpperCase()}. Add one under Settings → Payments → ${clinic.toUpperCase()}.`,
    );
  }
  const provider = PROVIDERS[acc.provider];
  if (!provider.hasCredentials(acc.credentials)) {
    throw new Error(
      `Active ${clinic.toUpperCase()} account "${acc.label}" is missing credentials.`,
    );
  }
  return {
    provider,
    credentials: acc.credentials,
    accountId: acc.id,
    accountLabel: acc.label,
    clinic: acc.clinic,
  };
}

/** Webhook helper — given a provider + account id, returns the
 *  credentials bag the verify call needs. Account id comes from the
 *  ?account=<uuid> URL param the operator configured in the gateway
 *  dashboard. Falls back to the American Hairline clinic's active account for that
 *  provider when the param is absent (one-account installs). */
export async function getProviderBindingForWebhook(
  providerId: ProviderId,
  accountIdParam: string | null,
): Promise<{
  provider: PaymentProvider;
  credentials: ProviderCredentials;
  clinic: Clinic;
} | null> {
  const provider = PROVIDERS[providerId];
  if (!provider) return null;
  if (accountIdParam) {
    const acc = await getAccountById(accountIdParam);
    if (!acc || acc.provider !== providerId) return null;
    if (!provider.hasCredentials(acc.credentials)) return null;
    return { provider, credentials: acc.credentials, clinic: acc.clinic };
  }
  // Fallback: American Hairline's active account for this provider.
  const active = await getActiveAccountForClinic("americanhairline");
  if (active && active.provider === providerId) {
    return { provider, credentials: active.credentials, clinic: active.clinic };
  }
  return null;
}
