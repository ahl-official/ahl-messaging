"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Building2, Copy, Loader2, Pencil, Plus, Trash2, Upload, X, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export interface QuickReply {
  id: string;
  shortcut: string;
  body: string;
  /** Empty = "all numbers" (workspace-global). Non-empty = list of
   *  phone_number_id values this snippet shows up under. */
  business_phone_number_ids: string[];
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
  // Optional rich content — sent as a WhatsApp interactive cta_url message.
  media_url?: string | null;
  media_kind?: "image" | "video" | null;
  button_text?: string | null;
  button_url?: string | null;
  buttons?: Array<{ type: "quick_reply" | "url"; text: string; url?: string }> | null;
}

interface NumberOption {
  phone_number_id: string;
  nickname: string | null;
  display_phone_number: string | null;
  verified_name?: string | null;
  portfolio?: { key: string; name: string } | null;
}

interface ApiResponse {
  quick_replies?: QuickReply[];
  quick_reply?: QuickReply;
  error?: string;
}

export function QuickRepliesManager({
  activePhoneId = null,
  numbers = [],
}: {
  /** Currently-selected business number in the templates page. When set,
   *  the list is scoped to snippets that target this number (or are
   *  global) and the create form defaults to selecting this number. */
  activePhoneId?: string | null;
  /** All connected business numbers — used to render the number-picker
   *  checkboxes inside the create/edit forms and the badge strip. */
  numbers?: NumberOption[];
} = {}) {
  const [items, setItems] = useState<QuickReply[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline create form state.
  const [creating, setCreating] = useState(false);
  // Copy-to-numbers modal.
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyQrIds, setCopyQrIds] = useState<Set<string>>(new Set());
  const [copyNumIds, setCopyNumIds] = useState<Set<string>>(new Set());
  const [copying, setCopying] = useState(false);
  const [copyDone, setCopyDone] = useState<string | null>(null);

  async function runCopy() {
    if (copyQrIds.size === 0 || copyNumIds.size === 0) return;
    setCopying(true);
    setCopyDone(null);
    try {
      const res = await fetch("/api/quick-replies/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quick_reply_ids: [...copyQrIds], target_phone_number_ids: [...copyNumIds] }),
      });
      const j = (await res.json()) as { updated?: number; error?: string };
      if (!res.ok) throw new Error(j.error ?? "Copy failed");
      setCopyDone(`${j.updated ?? 0} quick reply ${copyNumIds.size} number(s) par copy ho gaye.`);
      setCopyQrIds(new Set());
      setCopyNumIds(new Set());
    } catch (e) {
      setCopyDone(e instanceof Error ? e.message : "Copy failed");
    } finally {
      setCopying(false);
    }
  }

  const [newShortcut, setNewShortcut] = useState("");
  const [newBody, setNewBody] = useState("");
  // Optional rich content (image/video header + URL button).
  const [newMediaUrl, setNewMediaUrl] = useState("");
  const [newMediaKind, setNewMediaKind] = useState<"image" | "video">("image");
  const [newButtons, setNewButtons] = useState<Array<{ type: "quick_reply" | "url"; text: string; url: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(file: File) {
    if (!activePhoneId) {
      setError("Pehle upar se ek number select karo.");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/upload-media?phone_number_id=${encodeURIComponent(activePhoneId)}&storage_only=1`, {
        method: "POST",
        body: fd,
      });
      const j = (await res.json()) as { media_url?: string; kind?: string; error?: string };
      if (!res.ok || !j.media_url) throw new Error(j.error ?? "Upload failed");
      setNewMediaUrl(j.media_url);
      setNewMediaKind(j.kind === "video" ? "video" : "image");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }
  const [newBpids, setNewBpids] = useState<string[]>(
    activePhoneId ? [activePhoneId] : [],
  );
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const url = activePhoneId
        ? `/api/quick-replies?phone_number_id=${encodeURIComponent(activePhoneId)}`
        : "/api/quick-replies";
      const res = await fetch(url, { cache: "no-store" });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setItems(json.quick_replies ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhoneId]);

  // Default the create form's number selection to the active tab so the
  // operator doesn't have to re-tick the same number each time they add.
  useEffect(() => {
    if (activePhoneId && newBpids.length === 0) {
      setNewBpids([activePhoneId]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhoneId]);

  async function handleCreate() {
    if (submitting) return;
    setError(null);
    const sc = newShortcut.trim().replace(/^\/+/, "");
    if (!sc || !newBody.trim()) {
      setError("Both shortcut and message are required.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/quick-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shortcut: sc,
          body: newBody.trim(),
          // Always scope to the number selected at the top.
          business_phone_number_ids: activePhoneId ? [activePhoneId] : newBpids,
          media_url: newMediaUrl.trim() || null,
          media_kind: newMediaUrl.trim() ? newMediaKind : null,
          buttons: newButtons.filter((b) => b.text.trim() && (b.type !== "url" || b.url.trim())),
        }),
      });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.quick_reply) {
        setItems((prev) => [...(prev ?? []), json.quick_reply!].sort((a, b) =>
          a.shortcut.localeCompare(b.shortcut),
        ));
      }
      setNewShortcut("");
      setNewBody("");
      setNewMediaUrl("");
      setNewMediaKind("image");
      setNewButtons([]);
      setNewBpids(activePhoneId ? [activePhoneId] : []);
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/quick-replies/${id}`, { method: "DELETE" });
      const j = (await res.json().catch(() => ({}))) as ApiResponse;
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setItems((prev) => (prev ?? []).filter((x) => x.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  async function handleUpdate(id: string, patch: Partial<Pick<QuickReply, "shortcut" | "body">>) {
    setError(null);
    try {
      const res = await fetch(`/api/quick-replies/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = (await res.json()) as ApiResponse;
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (j.quick_reply) {
        setItems((prev) =>
          (prev ?? [])
            .map((x) => (x.id === id ? j.quick_reply! : x))
            .sort((a, b) => a.shortcut.localeCompare(b.shortcut)),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update");
    }
  }

  const activeNumber = activePhoneId
    ? numbers.find((n) => n.phone_number_id === activePhoneId) ?? null
    : null;
  const activeLabel = activeNumber
    ? activeNumber.nickname?.trim() ||
      activeNumber.display_phone_number ||
      activeNumber.phone_number_id
    : null;

  // Group the copy-target numbers by portfolio (like the profile dropdown).
  const numberGroups = useMemo(() => {
    const m = new Map<string, { name: string; rows: NumberOption[] }>();
    for (const n of numbers) {
      const key = n.portfolio?.key ?? "__other__";
      const name = n.portfolio?.name ?? "Other";
      if (!m.has(key)) m.set(key, { name, rows: [] });
      m.get(key)!.rows.push(n);
    }
    return Array.from(m.values()).sort((a, b) => (a.name === "Other" ? 1 : b.name === "Other" ? -1 : a.name.localeCompare(b.name)));
  }, [numbers]);

  return (
    <div className="space-y-6">
      {/* Intro card — surfaces which number the operator is acting on
          so a snippet created here doesn't quietly land on the wrong
          tab. The number-chip strip above this view is the source of
          truth; this line just makes the binding explicit. */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20">
            <Zap className="h-4 w-4" />
          </span>
          <div className="text-sm flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Quick Replies</span>
              {activeLabel ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700 ring-1 ring-sky-100"
                  title={activeNumber?.phone_number_id ?? undefined}
                >
                  Adding to: {activeLabel}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-100">
                  Pick a number above
                </span>
              )}
            </div>
            <p className="mt-0.5 text-muted-foreground">
              Save canned text snippets your team can insert in chat by typing
              <code className="mx-1 rounded bg-secondary px-1 py-0.5 text-[11px] font-mono">/shortcut</code>
              followed by space or Enter. Each snippet is scoped to the
              business numbers you tick — it won&apos;t show under any
              other number.
            </p>
          </div>
        </div>
      </div>

      {/* Create button or inline form */}
      {!creating ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            New Quick Reply
          </button>
          {(items?.length ?? 0) > 0 ? (
            <button
              type="button"
              onClick={() => { setCopyOpen(true); setCopyDone(null); }}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary"
            >
              <Copy className="h-3.5 w-3.5" />
              Copy to numbers
            </button>
          ) : null}
        </div>
      ) : (
        <div className="rounded-lg border bg-card p-4">
          <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Shortcut
              </label>
              <div className="mt-1 flex items-center rounded-md border bg-background focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/10">
                <span className="pl-2.5 text-sm text-muted-foreground">/</span>
                <input
                  type="text"
                  value={newShortcut}
                  onChange={(e) => setNewShortcut(e.target.value.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_-]/g, ""))}
                  placeholder="hours"
                  maxLength={40}
                  className="w-full rounded-md bg-transparent px-1.5 py-1.5 text-sm outline-none"
                  autoFocus
                />
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                lowercase, numbers, _ or - (space → _), up to 40
              </div>
            </div>
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Message
              </label>
              <textarea
                value={newBody}
                onChange={(e) => setNewBody(e.target.value.slice(0, 10000))}
                placeholder="We're open Mon–Sat, 10am–7pm. Closed on Sundays."
                rows={3}
                maxLength={10000}
                className="mt-1 w-full rounded-md border bg-background px-2.5 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
              <div className="mt-1 text-right text-[10px] text-muted-foreground">
                {newBody.length} / 10000
              </div>
            </div>
          </div>

          {/* Optional rich content — media header + a URL button. Sent as a
              WhatsApp interactive message. Leave blank for a plain text reply. */}
          <div className="mt-3 rounded-lg border border-dashed bg-secondary/20 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Rich content (optional)</div>
            {newMediaUrl ? (
              // Uploaded → show a preview (no raw link) + remove to change.
              <div className="mt-2 flex items-start gap-3">
                {newMediaKind === "video" ? (
                  <video src={newMediaUrl} controls className="h-28 rounded-md border bg-black/5" />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={newMediaUrl} alt="" className="h-28 rounded-md border object-cover" />
                )}
                <button
                  type="button"
                  onClick={() => setNewMediaUrl("")}
                  className="inline-flex items-center gap-1 rounded-md border bg-white px-2.5 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50"
                >
                  <X className="h-3.5 w-3.5" /> Remove
                </button>
              </div>
            ) : (
              // Nothing yet → upload an image or a video.
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={uploading}
                  className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border bg-white px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-50"
                >
                  {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  Upload image
                </button>
                <button
                  type="button"
                  onClick={() => videoInputRef.current?.click()}
                  disabled={uploading}
                  className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border bg-white px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-50"
                >
                  {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  Upload video
                </button>
                {uploading ? <span className="text-[11px] text-muted-foreground">Uploading…</span> : null}
              </div>
            )}
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUpload(f);
                e.target.value = "";
              }}
            />
            <input
              ref={videoInputRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUpload(f);
                e.target.value = "";
              }}
            />
            {/* Buttons — Quick Reply (reply, max 3) OR one Website URL. */}
            <div className="mt-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Buttons (optional)</div>
              {newButtons.map((b, i) => (
                <div key={i} className="mt-1.5 flex flex-wrap items-center gap-2">
                  <span className={"rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 " + (b.type === "url" ? "bg-sky-50 text-sky-700 ring-sky-200" : "bg-primary/10 text-primary ring-primary/25")}>
                    {b.type === "url" ? "Website URL" : "Quick Reply"}
                  </span>
                  <input
                    value={b.text}
                    onChange={(e) => setNewButtons((p) => p.map((x, j) => (j === i ? { ...x, text: e.target.value.slice(0, 20) } : x)))}
                    placeholder="Button label — max 20"
                    maxLength={20}
                    className="min-w-[140px] flex-1 rounded-md border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary"
                  />
                  {b.type === "url" ? (
                    <input
                      value={b.url}
                      onChange={(e) => setNewButtons((p) => p.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                      placeholder="https://… (koi bhi URL)"
                      className="min-w-[180px] flex-1 rounded-md border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary"
                    />
                  ) : null}
                  <button type="button" onClick={() => setNewButtons((p) => p.filter((_, j) => j !== i))} className="rounded p-1 text-muted-foreground hover:text-destructive">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={newButtons.filter((b) => b.type === "quick_reply").length >= 3}
                  onClick={() => setNewButtons((p) => [...p, { type: "quick_reply", text: "", url: "" }])}
                  className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold text-primary hover:bg-primary/10 disabled:opacity-40"
                >
                  <Plus className="h-3 w-3" /> Quick Reply
                </button>
                <button
                  type="button"
                  disabled={newButtons.some((b) => b.type === "url")}
                  onClick={() => setNewButtons((p) => [...p, { type: "url", text: "", url: "" }])}
                  className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold text-sky-700 hover:bg-sky-50 disabled:opacity-40"
                >
                  <Plus className="h-3 w-3" /> Website URL
                </button>
              </div>
            </div>
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              <b>Quick Reply</b> buttons (max 3) real tappable buttons bante hain. <b>Website URL</b> akela ho to button banta hai; agar Quick Reply ke saath ho to URL message me <b>link</b> ban ke jata hai (WhatsApp free-form ek message me reply-buttons + URL-button saath nahi bhejne deta). <b>Phone Number / Copy Code</b> sirf approved <b>templates</b> me milte hain.
            </p>
          </div>

          {/* Scoped to the number selected at the top — no manual picker. */}
          {activeNumber ? (
            <div className="mt-3 text-[11px] text-muted-foreground">
              Ye quick reply <span className="font-semibold text-foreground">{activeNumber.nickname?.trim() || activeNumber.display_phone_number || activeNumber.phone_number_id}</span> par save hoga.
            </div>
          ) : null}

          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setNewShortcut("");
                setNewBody("");
                setError(null);
              }}
              disabled={submitting}
              className="rounded-md border bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </button>
          </div>
        </div>
      )}

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {/* List */}
      {loading && !items ? (
        <div className="grid h-32 place-items-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : (items?.length ?? 0) === 0 ? (
        <div className="grid h-32 place-items-center rounded-lg border-2 border-dashed bg-card/50 p-6 text-center text-sm text-muted-foreground">
          No quick replies yet. Create one to save time on common messages.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(items ?? []).map((q) => (
            <QuickReplyCard
              key={q.id}
              item={q}
              numbers={numbers}
              onDelete={() => handleDelete(q.id)}
              onUpdate={(patch) => handleUpdate(q.id, patch)}
            />
          ))}
        </div>
      )}

      {/* Copy-to-numbers modal */}
      {copyOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCopyOpen(false)}>
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <header className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="text-sm font-bold">Copy quick replies to other numbers</h3>
              <button type="button" onClick={() => setCopyOpen(false)} className="rounded p-1 text-muted-foreground hover:bg-secondary">
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="grid min-h-0 flex-1 sm:grid-cols-2">
              {/* Quick replies */}
              <div className="flex min-h-0 flex-col border-b sm:border-b-0 sm:border-r">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Quick replies ({copyQrIds.size})</span>
                  <button type="button" onClick={() => setCopyQrIds(copyQrIds.size === (items?.length ?? 0) ? new Set() : new Set((items ?? []).map((q) => q.id)))} className="text-[11px] font-semibold text-primary hover:underline">
                    {copyQrIds.size === (items?.length ?? 0) ? "Clear" : "Select all"}
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {(items ?? []).map((q) => (
                    <label key={q.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-secondary/50">
                      <input
                        type="checkbox"
                        checked={copyQrIds.has(q.id)}
                        onChange={() => setCopyQrIds((p) => { const n = new Set(p); n.has(q.id) ? n.delete(q.id) : n.add(q.id); return n; })}
                      />
                      <code className="rounded bg-primary/10 px-1 text-[10px] font-semibold text-primary">/{q.shortcut}</code>
                      <span className="truncate text-muted-foreground">{q.body}</span>
                    </label>
                  ))}
                </div>
              </div>
              {/* Numbers */}
              <div className="flex min-h-0 flex-col">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Copy to numbers ({copyNumIds.size})</span>
                  <button type="button" onClick={() => setCopyNumIds(copyNumIds.size === numbers.length ? new Set() : new Set(numbers.map((n) => n.phone_number_id)))} className="text-[11px] font-semibold text-primary hover:underline">
                    {copyNumIds.size === numbers.length ? "Clear" : "Select all"}
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {numberGroups.map((g) => {
                    const groupIds = g.rows.map((n) => n.phone_number_id);
                    const allOn = groupIds.every((id) => copyNumIds.has(id));
                    return (
                      <div key={g.name} className="mb-1">
                        <div className="flex items-center justify-between rounded bg-secondary/40 px-2 py-1">
                          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                            <Building2 className="h-3 w-3" /> {g.name}
                          </span>
                          <button
                            type="button"
                            onClick={() => setCopyNumIds((p) => { const s = new Set(p); allOn ? groupIds.forEach((id) => s.delete(id)) : groupIds.forEach((id) => s.add(id)); return s; })}
                            className="text-[10px] font-semibold text-primary hover:underline"
                          >
                            {allOn ? "Clear" : "All"}
                          </button>
                        </div>
                        {g.rows.map((n) => (
                          <label key={n.phone_number_id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-secondary/50">
                            <input
                              type="checkbox"
                              checked={copyNumIds.has(n.phone_number_id)}
                              onChange={() => setCopyNumIds((p) => { const s = new Set(p); s.has(n.phone_number_id) ? s.delete(n.phone_number_id) : s.add(n.phone_number_id); return s; })}
                            />
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-secondary text-[9px] font-bold text-muted-foreground">
                              {(n.nickname?.trim() || n.verified_name?.trim() || "#")[0]?.toUpperCase()}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{n.nickname?.trim() || n.verified_name?.trim() || n.display_phone_number || n.phone_number_id}</span>
                              <span className="block truncate font-mono text-[10px] text-muted-foreground">{n.display_phone_number ?? n.phone_number_id}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <footer className="flex items-center justify-between gap-3 border-t px-4 py-3">
              <span className={"text-[11px] " + (copyDone ? "font-semibold text-primary" : "text-muted-foreground")}>
                {copyDone ?? `${copyQrIds.size} reply → ${copyNumIds.size} number`}
              </span>
              <div className="flex gap-2">
                <button type="button" onClick={() => setCopyOpen(false)} className="rounded-md border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary">Close</button>
                <button
                  type="button"
                  onClick={runCopy}
                  disabled={copying || copyQrIds.size === 0 || copyNumIds.size === 0}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
                >
                  {copying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
                  {copying ? "Copying…" : "Copy"}
                </button>
              </div>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function QuickReplyCard({
  item,
  numbers,
  onDelete,
  onUpdate,
}: {
  item: QuickReply;
  numbers: NumberOption[];
  onDelete: () => Promise<void>;
  onUpdate: (
    patch: Partial<Pick<QuickReply, "shortcut" | "body" | "business_phone_number_ids">>,
  ) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [shortcut, setShortcut] = useState(item.shortcut);
  const [body, setBody] = useState(item.body);
  const [bpids, setBpids] = useState<string[]>(item.business_phone_number_ids ?? []);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      await onUpdate({
        shortcut: shortcut.trim(),
        body: body.trim(),
        business_phone_number_ids: bpids,
      });
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  const labelByBpid = new Map<string, string>(
    numbers.map((n) => [
      n.phone_number_id,
      n.nickname?.trim() || n.display_phone_number || n.phone_number_id,
    ]),
  );

  async function confirmDelete() {
    if (busy) return;
    setBusy(true);
    try {
      await onDelete();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="flex h-full flex-col rounded-xl border bg-card p-3 shadow-sm transition hover:shadow-md hover:border-brand-100">
      {editing ? (
        <>
          <div className="mb-2 flex items-center gap-1.5">
            <span className="text-sm text-muted-foreground">/</span>
            <input
              type="text"
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value)}
              maxLength={40}
              className="flex-1 rounded-md border bg-background px-2 py-1 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, 10000))}
            rows={4}
            maxLength={10000}
            className="flex-1 rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          />
          <div className="mt-1 text-right text-[10px] text-muted-foreground">
            {body.length} / 10000
          </div>
          <div className="mt-2 flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setShortcut(item.shortcut);
                setBody(item.body);
                setBpids(item.business_phone_number_ids ?? []);
              }}
              disabled={busy}
              className="rounded-md border bg-background px-2 py-1 text-[10px] font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Save
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between gap-2">
            <code className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary ring-1 ring-primary/20">
              /{item.shortcut}
            </code>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex items-center justify-center rounded-md border bg-background p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                title="Edit"
                aria-label="Edit"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="inline-flex items-center justify-center rounded-md border bg-background p-1 text-muted-foreground transition hover:bg-rose-50 hover:border-rose-200 hover:text-rose-700"
                title="Delete"
                aria-label="Delete"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          </div>
          {(item.business_phone_number_ids ?? []).length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1">
              {item.business_phone_number_ids.map((bp) => (
                <span
                  key={bp}
                  className="inline-flex items-center rounded-full bg-sky-50 px-1.5 py-0.5 text-[9px] font-semibold text-sky-700 ring-1 ring-sky-100"
                  title={bp}
                >
                  {labelByBpid.get(bp) ?? bp}
                </span>
              ))}
            </div>
          ) : (
            <div className="mb-2">
              <span className="inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 ring-1 ring-amber-100">
                No number — edit to assign
              </span>
            </div>
          )}
          <p className="flex-1 whitespace-pre-wrap text-xs leading-snug text-foreground/85 line-clamp-6">
            {item.body}
          </p>
          {confirming ? (
            <div className="mt-2 flex items-center justify-end gap-1 border-t pt-2">
              <span className="mr-auto text-[10px] font-medium text-rose-700">
                Delete this quick reply?
              </span>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className={cn(
                  "rounded-md border bg-background px-2 py-1 text-[10px] font-semibold text-muted-foreground",
                  "hover:bg-secondary hover:text-foreground disabled:opacity-60",
                )}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2 py-1 text-[10px] font-semibold text-white shadow-sm hover:bg-rose-700 disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Yes, delete
              </button>
            </div>
          ) : null}
          {item.created_by_email ? (
            <div className="mt-2 truncate text-[9px] text-muted-foreground" title={item.created_by_email}>
              by {item.created_by_email}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
