"use client";

// Global notice banner that lives where the TopBar's search input used
// to. Pulls config from /api/system-settings and renders a tone-tinted
// pill the entire team can see at a glance — for things like "system
// maintenance tonight 9pm" or "do not assign new leads during the
// audit". Edit lives in Settings → Notice (admin+).
//
// When the text overflows the pill width, we switch from static-truncate
// to a horizontal marquee so the whole message gets read eventually.
// Detection is purely measurement-based (scrollWidth vs clientWidth)
// so short messages stay still and long ones scroll automatically.

import { useEffect, useRef, useState } from "react";
import { Megaphone } from "lucide-react";

interface Settings {
  notice_banner_text: string | null;
  notice_banner_enabled: boolean;
  notice_banner_tone: "info" | "success" | "warning" | "danger";
}

const TONE_STYLES: Record<Settings["notice_banner_tone"], string> = {
  info: "border-sky-200 bg-sky-50 text-sky-800",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-rose-200 bg-rose-50 text-rose-800",
};

export function NoticeBanner() {
  const [settings, setSettings] = useState<Settings | null>(null);

  // Re-read every time the window regains focus so an edit on a
  // different tab is picked up without a hard refresh. Cheap (one
  // small JSON GET).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/system-settings", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as Settings;
        if (!cancelled) setSettings(json);
      } catch {
        // Silent — banner is optional surface.
      }
    }
    void load();
    function onFocus() {
      void load();
    }
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!settings || !settings.notice_banner_enabled) return null;
  const text = (settings.notice_banner_text ?? "").trim();
  if (!text) return null;

  return (
    <div className="hidden w-full max-w-2xl md:flex">
      <div
        className={
          "flex h-9 w-full items-center gap-2 rounded-full border px-3 text-[13px] font-medium overflow-hidden " +
          TONE_STYLES[settings.notice_banner_tone]
        }
      >
        <Megaphone className="h-3.5 w-3.5 shrink-0" />
        <NoticeMarquee text={text} />
      </div>
    </div>
  );
}

/** Renders the notice text. If it fits the available width, stays
 *  put; if it overflows, scrolls right-to-left with a duplicate
 *  trailing copy for a seamless loop. Pause-on-hover so the operator
 *  can stop a passing message to read it carefully. */
function NoticeMarquee({ text }: { text: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [shouldScroll, setShouldScroll] = useState(false);
  const [durationSec, setDurationSec] = useState(20);

  // Measure on mount + on resize. ResizeObserver catches the case
  // where the topbar pill itself reflows (sidebar collapse, panel
  // open/close) without a window resize event.
  useEffect(() => {
    function measure() {
      const container = containerRef.current;
      const meas = measureRef.current;
      if (!container || !meas) return;
      const visible = container.clientWidth;
      const natural = meas.scrollWidth;
      const overflow = natural > visible + 1; // tiny tolerance for sub-px rounding
      setShouldScroll(overflow);
      if (overflow) {
        // ~60 px per second feels readable without being slow. Add a
        // floor so very short overflows don't whip across in 1s.
        // Track length when scrolling = 2 × natural (two copies),
        // so duration scales with one copy's width.
        setDurationSec(Math.max(8, Math.round(natural / 60)));
      }
    }
    measure();
    window.addEventListener("resize", measure);
    let ro: ResizeObserver | null = null;
    if (containerRef.current && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(containerRef.current);
    }
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [text]);

  return (
    <div
      ref={containerRef}
      className="relative min-w-0 flex-1 overflow-hidden"
      title={text}
    >
      {shouldScroll ? (
        <div
          className="flex w-max animate-marquee whitespace-nowrap [animation-play-state:running] hover:[animation-play-state:paused]"
          style={{ animationDuration: `${durationSec}s` }}
        >
          {/* Two copies with right-padding inside each one — the
              padding lives WITH the text so a -50% translate lands
              the second copy exactly where the first started. */}
          <span ref={measureRef} className="pr-16">
            {text}
          </span>
          <span aria-hidden className="pr-16">
            {text}
          </span>
        </div>
      ) : (
        // Non-scrolling branch still mounts measureRef so the
        // overflow check above can run on the first paint.
        <span ref={measureRef} className="block truncate">
          {text}
        </span>
      )}
    </div>
  );
}
