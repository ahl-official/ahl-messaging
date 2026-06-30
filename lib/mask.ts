// Privacy masking for phone numbers + emails. Used when a member's
// effective permissions have mask_phone_numbers or mask_emails = true.
// Helpers are pure / safe to import from client components.

/**
 * Mask a phone number — keep country code prefix (first 2-3 digits)
 * and last 2 digits, replace middle with • dots.
 *   "+91 90847 23091"   → "+91 •••••• 91"
 *   "+919084723091"     → "+91 ••••••91"
 *   "9084723091"        → "•••••••• 91"
 *   "wa_id 9876543210"  → "•••••••• 10"
 */
export function maskPhone(value: string | null | undefined): string {
  if (!value) return "";
  const raw = value.trim();
  if (!raw) return "";

  // Pull just the digits to figure out how to mask.
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return "•".repeat(raw.length || 4);

  // Prefer keeping a leading +CC if present, else just last 2 digits.
  const last = digits.slice(-2);
  const plusMatch = raw.match(/^\+(\d{1,3})/);
  const prefix = plusMatch ? `+${plusMatch[1]} ` : "";
  const middleLen = Math.max(4, digits.length - (plusMatch ? plusMatch[1].length : 0) - 2);
  return `${prefix}${"•".repeat(middleLen)} ${last}`;
}

/**
 * Mask an email — keep first char of local + domain.
 *   "khushnaseeb@qhtclinic.com" → "k••••••@qhtclinic.com"
 *   "ab@x.io"                  → "a•@x.io"
 */
export function maskEmail(value: string | null | undefined): string {
  if (!value) return "";
  const raw = value.trim();
  if (!raw.includes("@")) return raw;
  const [local, domain] = raw.split("@");
  if (!local) return `@${domain}`;
  const visible = local.slice(0, 1);
  const hidden = "•".repeat(Math.max(1, local.length - 1));
  return `${visible}${hidden}@${domain}`;
}

/** Convenience — choose masker by feature flag. */
export function maybeMaskPhone(value: string | null | undefined, mask: boolean): string {
  return mask ? maskPhone(value) : (value ?? "");
}

/**
 * Mask a "name OR phone number" display field — used where a contact's
 * label is their real name when set, else falls back to the raw number.
 * Real names (anything containing a letter) pass through untouched so
 * we only ever hide the bare-number fallback.
 */
export function maskNameOrPhone(value: string | null | undefined, mask: boolean): string {
  if (!mask) return value ?? "";
  if (!value) return "";
  if (/[a-zA-Z]/.test(value)) return value;
  return maskPhone(value);
}
export function maybeMaskEmail(value: string | null | undefined, mask: boolean): string {
  return mask ? maskEmail(value) : (value ?? "");
}
