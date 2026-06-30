// Credential helper — reads from process.env only. All secrets live in
// .env.local (locally) or hosting env vars (in production). No DB lookup,
// no cache, no UI — single source of truth is the env file.
//
// Server-only — never import from a client component.

const ENV_MAP: Record<string, string> = {
  openai_api_key:                "OPENAI_API_KEY",
  whatsapp_access_token:         "WHATSAPP_ACCESS_TOKEN",
  whatsapp_phone_number_id:      "WHATSAPP_PHONE_NUMBER_ID",
  whatsapp_business_account_id:  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  // Meta Marketing API token (ads_read) — resolves a CTWA lead's
  // ad → ad set → campaign names from the referral source_id.
  meta_ads_token:                "META_ADS_TOKEN",
  whatsapp_app_id:               "WHATSAPP_APP_ID",
  whatsapp_verify_token:         "WHATSAPP_VERIFY_TOKEN",
  whatsapp_api_version:          "WHATSAPP_API_VERSION",
  webhook_internal_token:        "WEBHOOK_INTERNAL_TOKEN",
  magic_message_image_api_url:   "MAGIC_MESSAGE_IMAGE_API_URL",
  // ElevenLabs powers the home assistant's voice (input via Scribe STT,
  // output via multilingual TTS). The voice id picks WHICH voice the
  // TTS endpoint speaks in — separate so it's swappable without
  // rotating the API key.
  elevenlabs_api_key:            "ELEVENLABS_API_KEY",
  elevenlabs_voice_id:           "ELEVENLABS_VOICE_ID",
  // Razorpay drives the Payment Links feature in the chat composer.
  // key_id + key_secret are issued in the Razorpay dashboard. webhook
  // secret is set on the webhook config and is what we verify the
  // signature with.
  razorpay_key_id:               "RAZORPAY_KEY_ID",
  razorpay_key_secret:           "RAZORPAY_KEY_SECRET",
  razorpay_webhook_secret:       "RAZORPAY_WEBHOOK_SECRET",
  // PayU Invoice API. Merchant Key + Salt from PayU dashboard
  // (Settings → My Account → Profile). Env picks live vs test:
  // PAYU_ENV = "live" | "test" (default "live").
  payu_merchant_key:             "PAYU_MERCHANT_KEY",
  payu_merchant_salt:            "PAYU_MERCHANT_SALT",
  payu_env:                      "PAYU_ENV",
};

export async function getCredential(key: string): Promise<string | null> {
  const envName = ENV_MAP[key];
  if (!envName) return null;
  const value = process.env[envName];
  return value && value.trim().length > 0 ? value : null;
}

/** Throwing variant for code paths where a missing credential is fatal. */
export async function requireCredential(
  key: string,
  hintLabel?: string,
): Promise<string> {
  const value = await getCredential(key);
  if (!value) {
    const envName = ENV_MAP[key] ?? key.toUpperCase();
    throw new Error(
      `Missing credential "${hintLabel ?? key}". Set ${envName} in .env.local (or your hosting env vars).`,
    );
  }
  return value;
}
