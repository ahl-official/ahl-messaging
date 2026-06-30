"use client";

// Settings → Embed. Owner manages which CRM origins may frame /embed (the
// iframe inbox). The runtime CSP reads this list, so adding a domain takes
// effect within ~1 min with NO rebuild.

import { useCallback, useEffect, useState } from "react";
import { AppWindow, Loader2, Plus, Trash2 } from "lucide-react";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";

export function EmbedSettingsView() {
  const [origins, setOrigins] = useState<string[] | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [cookieDomain, setCookieDomain] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/embed", { cache: "no-store" });
      const j = (await res.json()) as {
        origins?: string[];
        cookie_domain?: string | null;
        error?: string;
      };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      const list = j.origins ?? [];
      setOrigins(list);
      setSaved(list);
      setCookieDomain(j.cookie_domain ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty =
    origins !== null && JSON.stringify(origins) !== JSON.stringify(saved);

  async function save() {
    if (!origins) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/embed", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origins: origins.map((o) => o.trim()).filter(Boolean) }),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        origins?: string[];
        error?: string;
      };
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      const list = j.origins ?? [];
      setOrigins(list);
      setSaved(list);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SettingsPageHeader
        icon={AppWindow}
        title="Embed"
        subtitle="CRM sites allowed to embed the inbox in an iframe."
        tone="violet"
      />

      <div className="mx-auto max-w-5xl px-6 py-6">
        {loading ? (
          <div className="grid h-40 place-items-center text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </span>
          </div>
        ) : error && !origins ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        ) : origins ? (
          <div className="space-y-5">
            <div className="rounded-2xl border bg-card shadow-sm">
              <div className="border-b px-5 py-3.5">
                <h2 className="text-sm font-semibold">Allowed CRM domains</h2>
                <p className="mt-0.5 max-w-2xl text-[11px] text-muted-foreground">
                  Full origins, e.g. <code>https://crm.hairmedindia.com</code>.
                  Only these sites can load <code>/embed/inbox</code> in an
                  iframe. Changes apply within ~1 minute — no redeploy. (Your
                  own site and <code>http://localhost:3001</code> are always
                  allowed.)
                </p>
              </div>
              <div className="space-y-3 p-5">
                {origins.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No CRM domains added — only your own site can embed it.
                  </p>
                ) : (
                  origins.map((o, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        value={o}
                        onChange={(e) =>
                          setOrigins((cur) =>
                            cur
                              ? cur.map((v, k) => (k === i ? e.target.value : v))
                              : cur,
                          )
                        }
                        placeholder="https://crm.example.com"
                        className="flex-1 rounded-lg border px-3 py-2 font-mono text-xs outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200/40"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setOrigins((cur) =>
                            cur ? cur.filter((_, k) => k !== i) : cur,
                          )
                        }
                        aria-label="Remove domain"
                        className="inline-flex items-center justify-center rounded-lg border border-rose-200 px-2 py-2 text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))
                )}
                <button
                  type="button"
                  onClick={() => setOrigins((cur) => [...(cur ?? []), ""])}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-dashed px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-secondary"
                >
                  <Plus className="h-3.5 w-3.5" /> Add domain
                </button>
              </div>
            </div>

            {/* Reference info — not editable here. */}
            <div className="rounded-2xl border bg-card px-5 py-4 text-[11px] text-muted-foreground shadow-sm">
              <p>
                <span className="font-semibold text-foreground">iframe URL:</span>{" "}
                <code>https://&lt;this site&gt;/embed/inbox?wa=&lt;number&gt;</code>
              </p>
              <p className="mt-1.5">
                <span className="font-semibold text-foreground">
                  Shared cookie domain:
                </span>{" "}
                {cookieDomain ? (
                  <code>{cookieDomain}</code>
                ) : (
                  <span className="italic">not set</span>
                )}{" "}
                — the no-login session only works when the CRM sits under this
                same parent domain (browsers block third-party iframe cookies).
                This is a build-time env (<code>NEXT_PUBLIC_COOKIE_DOMAIN</code>).
              </p>
            </div>

            <div className="flex items-center justify-end gap-3">
              {error ? (
                <span className="text-xs text-rose-600">{error}</span>
              ) : savedAt && !dirty ? (
                <span className="text-xs text-emerald-600">Saved</span>
              ) : null}
              <button
                type="button"
                onClick={save}
                disabled={saving || !dirty}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Save
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
