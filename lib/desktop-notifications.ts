"use client";

// Desktop / OS-level Web Notifications wrapper.
//
// WhatsApp Web's pattern: ask once for permission, then fire a system
// notification on every inbound when the tab isn't focused. Click the
// notification → tab focuses + the right chat opens. Identical UX
// here — same icon (the QHT favicon), same "tag" reuse so multiple
// pings from one contact collapse into one OS notification instead
// of flooding the dock/tray.

const STORAGE_KEY = "qht:desktop-notify:permission-asked";

/** Browser supports the Notifications API at all. */
export function desktopNotificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Current permission state, or "unsupported" when the API is absent. */
export function desktopNotificationPermission():
  | NotificationPermission
  | "unsupported" {
  if (!desktopNotificationsSupported()) return "unsupported";
  return Notification.permission;
}

/** Ask the browser for permission. No-op when already granted/denied,
 *  or when we've asked once and been denied (silent — don't pester). */
export async function requestDesktopNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!desktopNotificationsSupported()) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    const result = await Notification.requestPermission();
    window.localStorage.setItem(STORAGE_KEY, "1");
    return result;
  } catch {
    return Notification.permission;
  }
}

/** Have we ever asked the user? Used to gate the "Enable notifications"
 *  banner so it only shows up the first time, not every page load. */
export function hasAskedForDesktopPermission(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STORAGE_KEY) === "1";
}

interface NotifyOpts {
  title: string;
  body?: string;
  /** Used as the Notification's tag, so repeated pings from the same
   *  contact collapse into one OS notification instead of stacking. */
  tag?: string;
  /** Optional click target — usually contact id. The caller wires up
   *  what to do on click (focus + open chat). */
  onClick?: () => void;
  /** WhatsApp Web doesn't auto-close its inbound notifications; we
   *  match by leaving requireInteraction off (= browser default fade). */
}

/** Fire a desktop notification. Silently no-ops when permission isn't
 *  granted or the tab is currently visible (no point notifying the user
 *  about a chat they're already looking at). */
export function notifyDesktop(opts: NotifyOpts): void {
  if (!desktopNotificationsSupported()) return;
  if (Notification.permission !== "granted") return;
  // Skip when the operator is actively looking at the tab — the
  // in-app toast covers that case and a desktop notify would feel
  // noisy. Use document.visibilityState which is reliable across
  // browsers (document.hidden alone misses background-but-visible).
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    return;
  }
  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      // /logo.png is the only static image we ship in /public; using
      // it as icon + badge gives the OS something to render. If the
      // file is missing the browser silently falls back to the site
      // favicon, which is still a valid icon source.
      icon: "/logo.png",
      badge: "/logo.png",
      silent: false,
    });
    // eslint-disable-next-line no-console
    console.log("[notify] desktop notification fired:", opts.title);
    if (opts.onClick) {
      n.onclick = () => {
        try {
          window.focus();
        } catch {
          /* some browsers reject programmatic focus from a notification */
        }
        opts.onClick?.();
        n.close();
      };
    }
  } catch (e) {
    // iOS Safari sometimes throws on `new Notification()` even when
    // permission is granted — swallow so the in-app toast still renders.
    // eslint-disable-next-line no-console
    console.warn("[notify] desktop notification failed:", e);
  }
}
