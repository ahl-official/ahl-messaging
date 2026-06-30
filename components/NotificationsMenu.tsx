"use client";

// Notification controls — in-app sound + desktop OS notifications.
// These used to live behind their own TopBar bell; they now render as
// a section inside the UserMenu dropdown (the bell was folded into the
// avatar menu). Exported as `NotificationControls` so the UserMenu can
// drop it straight in.

import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import {
  isSoundMuted,
  playMessagePing,
  setSoundMuted,
} from "@/lib/notification";
import {
  desktopNotificationPermission,
  desktopNotificationsSupported,
  requestDesktopNotificationPermission,
} from "@/lib/desktop-notifications";

export function NotificationControls() {
  const [muted, setMuted] = useState(false);
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >("default");

  useEffect(() => {
    setMuted(isSoundMuted());
    setPermission(desktopNotificationPermission());
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") {
        setPermission(desktopNotificationPermission());
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  function toggleSound() {
    const next = !muted;
    setMuted(next);
    setSoundMuted(next);
    if (!next) setTimeout(() => playMessagePing(), 0);
  }

  async function enableDesktop() {
    const next = await requestDesktopNotificationPermission();
    setPermission(next);
  }

  const desktopGranted = permission === "granted";
  const desktopDenied = permission === "denied";
  const desktopSupported = desktopNotificationsSupported();

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {/* Sound row */}
      <button
        type="button"
        onClick={toggleSound}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm transition hover:bg-secondary"
      >
        <div>
          <p className="text-[13px] font-semibold text-foreground">
            In-app sound
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Chime when a new message lands.
          </p>
        </div>
        <Switch on={!muted} />
      </button>

      {/* Desktop row */}
      <button
        type="button"
        onClick={() => {
          if (desktopGranted || !desktopSupported) return;
          if (desktopDenied) return;
          void enableDesktop();
        }}
        disabled={desktopGranted || desktopDenied || !desktopSupported}
        className="flex w-full items-center justify-between gap-3 border-t px-3 py-2.5 text-left text-sm transition hover:bg-secondary disabled:cursor-default disabled:hover:bg-transparent"
      >
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-foreground">
            Desktop notifications
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {!desktopSupported
              ? "Your browser doesn't support this."
              : desktopGranted
                ? "On — pings show even when the tab is in the background."
                : desktopDenied
                  ? "Blocked. Enable from browser site settings."
                  : "Click to enable. WhatsApp Web-style alerts."}
          </p>
        </div>
        {desktopGranted ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
            <Check className="h-2.5 w-2.5" /> On
          </span>
        ) : desktopDenied ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700 ring-1 ring-inset ring-rose-200">
            <X className="h-2.5 w-2.5" /> Blocked
          </span>
        ) : desktopSupported ? (
          <span className="shrink-0 rounded-md bg-sky-600 px-2 py-1 text-[10px] font-semibold text-white shadow-sm">
            Enable
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">N/A</span>
        )}
      </button>

      {desktopDenied ? (
        <div className="border-t bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground">
          <p className="font-semibold text-foreground">How to unblock</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4">
            <li>Click the lock / info icon left of the URL.</li>
            <li>
              Find <strong>Notifications</strong> in site settings.
            </li>
            <li>
              Set it to <strong>Allow</strong>, then reload.
            </li>
          </ol>
        </div>
      ) : null}
    </div>
  );
}

// Tiny iOS-style switch. Pure visual — toggling is the parent's job.
function Switch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${
        on ? "bg-emerald-500" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition ${
          on ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </span>
  );
}
