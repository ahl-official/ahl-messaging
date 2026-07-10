"use client";

// "Connect WhatsApp number" — launches Meta's Embedded Signup popup so an
// operator can onboard a number to our own Cloud API (or coexistence, if
// the Meta config enables it) without going through a BSP.
//
// Multi-app: each portfolio carries its own Meta app (app_id +
// embedded_config_id + server-side app_secret). The operator picks the
// portfolio = the app the number is onboarded under, and the number is
// filed there automatically. Only portfolios with both app_id AND
// embedded_config_id show up; if none are configured the button is hidden.
//
// Optional global: NEXT_PUBLIC_META_EMBEDDED_FEATURE_TYPE (coexistence flavour).

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageCirclePlus } from "lucide-react";

interface FBLoginResponse {
  authResponse?: { code?: string } | null;
  status?: string;
}
interface FBSdk {
  init: (o: { appId: string; autoLogAppEvents?: boolean; xfbml?: boolean; version: string }) => void;
  login: (
    cb: (r: FBLoginResponse) => void,
    opts: {
      config_id: string;
      response_type: string;
      override_default_response_type: boolean;
      extras: Record<string, unknown>;
    },
  ) => void;
}
declare global {
  interface Window {
    FB?: FBSdk;
    fbAsyncInit?: () => void;
  }
}

const FB_VERSION = "v21.0";

// Load the FB JS SDK <script> once per page. Init happens per-app at login
// time (FB.init is re-callable with a different appId for multi-app).
let scriptPromise: Promise<void> | null = null;
function ensureFbScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve) => {
    if (window.FB) {
      resolve();
      return;
    }
    window.fbAsyncInit = () => resolve();
    const s = document.createElement("script");
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    document.body.appendChild(s);
  });
  return scriptPromise;
}

interface PortfolioOpt {
  key: string;
  name: string;
  app_id: string | null;
  embedded_config_id: string | null;
  is_active?: boolean;
}

export function ConnectWhatsAppButton({ onConnected }: { onConnected?: () => void }) {
  const featureType = process.env.NEXT_PUBLIC_META_EMBEDDED_FEATURE_TYPE ?? "";

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [portfolios, setPortfolios] = useState<PortfolioOpt[]>([]);
  const [portfolioKey, setPortfolioKey] = useState("");
  const [ready, setReady] = useState(false);

  // Apps wired for Embedded Signup (server returns real app_id + config_id,
  // filtered to active meta portfolios that have both set).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/whatsapp/embedded-signup", { cache: "no-store" });
        const j = (await res.json()) as { apps?: PortfolioOpt[] };
        if (cancelled) return;
        const eligible = j.apps ?? [];
        setPortfolios(eligible);
        setPortfolioKey((k) => k || eligible[0]?.key || "");
      } catch {
        /* leave empty → button hidden */
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Embedded Signup hands the phone_number_id / waba_id via a window
  // postMessage, while FB.login's callback gives the OAuth code. They can
  // arrive in either order, so stash the session info and read it on submit.
  const sessionRef = useRef<{ phone_number_id?: string; waba_id?: string }>({});

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (
        ev.origin !== "https://www.facebook.com" &&
        ev.origin !== "https://web.facebook.com"
      )
        return;
      try {
        const data = JSON.parse(ev.data) as {
          type?: string;
          data?: { phone_number_id?: string; waba_id?: string };
        };
        if (data.type === "WA_EMBEDDED_SIGNUP" && data.data) {
          sessionRef.current = {
            phone_number_id: data.data.phone_number_id,
            waba_id: data.data.waba_id,
          };
        }
      } catch {
        /* non-JSON postMessage — ignore */
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const finalize = useCallback(
    async (code: string) => {
      const { phone_number_id, waba_id } = sessionRef.current;
      if (!phone_number_id || !waba_id) {
        setError("Signup poora nahi hua (number/WABA nahi mila). Dobara try karo.");
        setBusy(false);
        return;
      }
      try {
        const res = await fetch("/api/whatsapp/embedded-signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, phone_number_id, waba_id, portfolio_key: portfolioKey }),
        });
        const j = (await res.json()) as {
          error?: string;
          platform_type?: string;
          message?: string;
        };
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        setNote(
          j.platform_type
            ? `Connected (${j.platform_type}). ${j.message ?? ""}`.trim()
            : "Connected.",
        );
        sessionRef.current = {};
        onConnected?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed");
      } finally {
        setBusy(false);
      }
    },
    [portfolioKey, onConnected],
  );

  async function launch() {
    setError(null);
    setNote(null);
    const p = portfolios.find((x) => x.key === portfolioKey);
    if (!p?.app_id || !p?.embedded_config_id) {
      setError("Is portfolio ke app ka APP_ID / EMBEDDED_CONFIG_ID set nahi hai.");
      return;
    }
    setBusy(true);
    try {
      await ensureFbScript();
      // Re-init with the selected portfolio's app so the right app owns
      // this signup (supports multiple apps on one page).
      window.FB?.init({ appId: p.app_id, autoLogAppEvents: true, xfbml: false, version: FB_VERSION });
      window.FB?.login(
        (resp) => {
          const code = resp.authResponse?.code;
          if (!code) {
            setError("Signup cancel ho gaya ya code nahi mila.");
            setBusy(false);
            return;
          }
          void finalize(code);
        },
        {
          config_id: p.embedded_config_id,
          response_type: "code",
          override_default_response_type: true,
          extras: {
            setup: {},
            sessionInfoVersion: "3",
            ...(featureType ? { featureType } : {}),
          },
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "SDK load failed");
      setBusy(false);
    }
  }

  // Hidden until at least one portfolio's app is wired for Embedded Signup.
  if (!ready || portfolios.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select
          value={portfolioKey}
          onChange={(e) => setPortfolioKey(e.target.value)}
          className="rounded-md border bg-background px-2 py-2 text-xs outline-none focus:border-primary"
          title="Kis app/portfolio ke neeche number add karna hai"
        >
          {portfolios.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={launch}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <MessageCirclePlus className="h-3.5 w-3.5" />
          )}
          Connect WhatsApp number
        </button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {note ? <p className="text-xs text-primary">{note}</p> : null}
    </div>
  );
}
