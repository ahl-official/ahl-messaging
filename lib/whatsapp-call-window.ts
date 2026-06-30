// WhatsApp Business Calling — the "calling window".
//
// The 24h customer-service MESSAGING window (lib/whatsapp-window.ts) is a
// separate thing from being allowed to CALL. Business-initiated WhatsApp
// calls are gated by an explicit *call permission* the user grants by
// tapping "Allow" on a Call Permission Request (CPR). Meta keeps that
// permission valid for ~7 DAYS — it ships the exact expiry as
// `expiration_timestamp` on the reply, which we persist as
// whatsapp_call_permissions.expires_at and treat as the authoritative gate.
//
//   • Messaging window = 24 hours   (reopens on every inbound message)
//   • Calling window   = ~7 days    (from when the user taps Allow)
//
// Other Meta limits worth knowing (not enforced here — Meta enforces them):
//   • ~72h to place the FIRST call after a fresh grant.
//   • 1 permission request / 24h, max 2 per 7 days (resets on a connected
//     call); up to 5 call attempts in the first 24h of a grant.

export const WHATSAPP_CALL_PERMISSION_DAYS = 7;
export const WHATSAPP_CALL_PERMISSION_MS =
  WHATSAPP_CALL_PERMISSION_DAYS * 24 * 60 * 60 * 1000;

export interface CallPermissionLike {
  /** 'granted' | 'pending' | 'denied' | 'error' | null */
  state: string | null;
  granted_at?: string | null;
  expires_at?: string | null;
}

export interface CallWindowState {
  /** True when a business-initiated WhatsApp call can be placed right now. */
  canCall: boolean;
  state: "granted" | "pending" | "denied" | "expired" | "none";
  expiresAt: string | null;
  msRemaining: number;
  hoursRemaining: number;
  daysRemaining: number;
}

export function getCallWindowState(p: CallPermissionLike | null): CallWindowState {
  const empty = {
    expiresAt: null,
    msRemaining: 0,
    hoursRemaining: 0,
    daysRemaining: 0,
  };
  if (!p || !p.state) {
    return { canCall: false, state: "none", ...empty };
  }
  if (p.state === "denied") {
    return { canCall: false, state: "denied", expiresAt: p.expires_at ?? null, msRemaining: 0, hoursRemaining: 0, daysRemaining: 0 };
  }
  if (p.state === "granted") {
    const expiresAt = p.expires_at ?? null;
    // No expiry on file → Meta said we can call; treat as open for the
    // standard 7-day budget. Otherwise gate on the real expiry.
    const ms = expiresAt
      ? new Date(expiresAt).getTime() - Date.now()
      : WHATSAPP_CALL_PERMISSION_MS;
    if (ms > 0) {
      return {
        canCall: true,
        state: "granted",
        expiresAt,
        msRemaining: ms,
        hoursRemaining: ms / 3_600_000,
        daysRemaining: ms / 86_400_000,
      };
    }
    return { canCall: false, state: "expired", expiresAt, msRemaining: 0, hoursRemaining: 0, daysRemaining: 0 };
  }
  // pending / error → not callable yet (a CPR is out or failed).
  return { canCall: false, state: "pending", expiresAt: p.expires_at ?? null, msRemaining: 0, hoursRemaining: 0, daysRemaining: 0 };
}

/** Compact remaining-time label for an open calling window: "6d left",
 *  "18h left". Empty string when the window isn't open. */
export function formatCallWindowLeft(s: CallWindowState): string {
  if (!s.canCall) return "";
  if (s.daysRemaining >= 1) {
    const d = Math.floor(s.daysRemaining);
    return `${d}d left`;
  }
  const h = Math.max(1, Math.floor(s.hoursRemaining));
  return `${h}h left`;
}
