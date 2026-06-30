// Pure media-url helpers — safe to import from client or server (no
// server-only deps).

/** True when the url is a raw WhatsApp CDN link (encrypted + expiring)
 *  rather than something we've already persisted to our own Storage. */
export function isEphemeralWhatsAppMedia(
  url: string | null | undefined,
): boolean {
  if (!url) return false;
  return /whatsapp\.net/i.test(url) || /\.enc(\?|$)/i.test(url);
}
