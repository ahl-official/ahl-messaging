"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Bell,
  Bold,
  ChevronDown,
  Code,
  Copy,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Info,
  Italic,
  Key,
  Layers,
  LayoutGrid,
  List,
  ListOrdered,
  Loader2,
  Megaphone,
  Phone,
  Plus,
  Quote,
  ShoppingBag,
  Strikethrough,
  Terminal,
  Trash2,
  Video,
  Video as VideoIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { renderWhatsAppMarkdown } from "@/lib/whatsapp-markdown";
import { Input } from "@/components/ui/input";

export interface InitialTemplate {
  id: string;
  name: string;
  language: string;
  category: Category;
  status: string;
  /** Optional cached header preview URL — pulled from template_assets on
   *  the edit page so the user sees their existing media instead of an
   *  empty upload box. */
  header_url?: string | null;
  components: Array<{
    type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
    format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
    text?: string;
    buttons?: Array<{
      type: string;
      text: string;
      url?: string;
      phone_number?: string;
      example?: string | string[];
    }>;
  }>;
}

interface Props {
  businessName: string;
  /** When set, the form runs in edit mode — name + language locked, submit
   *  hits the per-template PATCH endpoint instead of POST /api/templates. */
  initialTemplate?: InitialTemplate;
}

type Category = "MARKETING" | "UTILITY" | "AUTHENTICATION";
type TemplateType = "buttons" | "simple" | "carousel" | "catalog" | "form";
type HeaderKind = "none" | "text" | "image" | "video" | "document";

type ButtonKind = "quick_reply" | "url" | "phone" | "copy_code";
interface BuilderButton {
  id: string;
  kind: ButtonKind;
  text: string;
  url?: string;
  phone?: string;
  code?: string;
}

interface CarouselCard {
  id: string;
  handle: string | null;       // Meta resumable-upload handle for the card media
  previewUrl: string | null;
  uploading: boolean;
  body: string;
  buttons: BuilderButton[];     // quick_reply / url, max 2
}

const CATEGORIES: { value: Category; label: string; icon: typeof Megaphone }[] = [
  { value: "MARKETING", label: "Marketing", icon: Megaphone },
  { value: "UTILITY", label: "Utility", icon: Bell },
  { value: "AUTHENTICATION", label: "Authentication", icon: Key },
];

const TYPES: {
  value: TemplateType;
  label: string;
  desc: string;
  icon: typeof Copy;
  enabled: boolean;
}[] = [
  {
    value: "buttons",
    label: "Template with Buttons (Quick Reply, URL, Copy Code etc)",
    desc: "Send a message with customised buttons to engage customers",
    icon: Copy,
    enabled: true,
  },
  {
    value: "simple",
    label: "Simple template (No buttons / Carousels)",
    desc: "Send a message only having a header / body / footer",
    icon: List,
    enabled: true,
  },
  {
    value: "carousel",
    label: "Carousel",
    desc: "Send a carousel of images / videos showcasing your products",
    icon: LayoutGrid,
    enabled: true,
  },
  {
    value: "catalog",
    label: "Catalog",
    desc: "Send messages that drive sales by connecting your product catalog",
    icon: ShoppingBag,
    enabled: true,
  },
  {
    value: "form",
    label: "Template with Form",
    desc: "Send a form to capture customer interests, appointment requests or surveys",
    icon: Layers,
    enabled: false,
  },
];

const LANGUAGES = [
  { code: "en_US", label: "English (US)" },
  { code: "en_GB", label: "English (UK)" },
  { code: "hi", label: "Hindi" },
  { code: "en", label: "English" },
];

function slugifyName(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

const HEADER_ACCEPT: Record<HeaderKind, string> = {
  none: "",
  text: "",
  image: "image/jpeg,image/png",
  video: "video/mp4,video/3gp",
  document: "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const HEADER_FORMAT_API: Record<Exclude<HeaderKind, "none" | "text">, string> = {
  image: "IMAGE",
  video: "VIDEO",
  document: "DOCUMENT",
};

export function TemplateCreate({ businessName, initialTemplate }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Pin every request (create / edit / sample upload) to the selected
  // number so it lands on the same Meta WABA the list was read from.
  const portfolioKey = searchParams.get("portfolio_key")?.trim() ?? null;
  const phoneNumberId = searchParams.get("phone_number_id")?.trim() ?? null;
  const portfolioQs = (() => {
    const p = new URLSearchParams();
    if (portfolioKey) p.set("portfolio_key", portfolioKey);
    if (phoneNumberId) p.set("phone_number_id", phoneNumberId);
    const s = p.toString();
    return s ? `?${s}` : "";
  })();
  const isEdit = !!initialTemplate;

  // Pre-extract components for initial state when editing.
  const initBody = initialTemplate?.components.find((c) => c.type === "BODY");
  const initHeader = initialTemplate?.components.find((c) => c.type === "HEADER");
  const initFooter = initialTemplate?.components.find((c) => c.type === "FOOTER");
  const initButtons = initialTemplate?.components.find((c) => c.type === "BUTTONS");

  const initialButtons: BuilderButton[] = (initButtons?.buttons ?? []).map((b, i) => {
    const id = `btn-${i}`;
    if (b.type === "URL")
      return { id, kind: "url", text: b.text ?? "", url: b.url ?? "" };
    if (b.type === "PHONE_NUMBER")
      return { id, kind: "phone", text: b.text ?? "", phone: b.phone_number ?? "" };
    if (b.type === "COPY_CODE")
      return { id, kind: "copy_code", text: b.text ?? "Copy code", code: typeof b.example === "string" ? b.example : "" };
    return { id, kind: "quick_reply", text: b.text ?? "" };
  });

  const initialHeaderKind: HeaderKind =
    initHeader?.format === "TEXT"
      ? "text"
      : initHeader?.format === "IMAGE"
        ? "image"
        : initHeader?.format === "VIDEO"
          ? "video"
          : initHeader?.format === "DOCUMENT"
            ? "document"
            : "none";

  const [step1Open, setStep1Open] = useState(!isEdit);
  const [step2Open, setStep2Open] = useState(true);

  const [category, setCategory] = useState<Category>(initialTemplate?.category ?? "MARKETING");
  const [type, setType] = useState<TemplateType>(initialButtons.length > 0 ? "buttons" : "simple");

  const [name, setName] = useState(initialTemplate?.name ?? "");
  const [language, setLanguage] = useState(initialTemplate?.language ?? "en_US");
  const [headerKind, setHeaderKind] = useState<HeaderKind>(initialHeaderKind);
  const [headerText, setHeaderText] = useState(
    initHeader?.format === "TEXT" ? (initHeader.text ?? "") : "",
  );
  const [headerFile, setHeaderFile] = useState<File | null>(null);
  // Note: header handle is per-upload session — Meta doesn't return existing
  // handles, so when editing a media header you re-upload to replace.
  const [headerHandle, setHeaderHandle] = useState<string | null>(null);
  // Edit mode: prefill with the cached preview URL so the user sees their
  // existing media instead of a blank upload box. They can still re-upload
  // to actually change the file (Meta requires a fresh handle).
  const [headerPreviewUrl, setHeaderPreviewUrl] = useState<string | null>(
    initialTemplate?.header_url ?? null,
  );
  const [uploadingSample, setUploadingSample] = useState(false);
  const [body, setBody] = useState(initBody?.text ?? "");
  const [footer, setFooter] = useState(initFooter?.text ?? "");
  const [buttons, setButtons] = useState<BuilderButton[]>(initialButtons);

  // Carousel — one shared media format across all cards (Meta requirement),
  // then 2–10 cards each with their own media + optional body + buttons.
  const [carouselFormat, setCarouselFormat] = useState<"IMAGE" | "VIDEO">("IMAGE");
  const [cards, setCards] = useState<CarouselCard[]>([
    { id: "c1", handle: null, previewUrl: null, uploading: false, body: "", buttons: [] },
    { id: "c2", handle: null, previewUrl: null, uploading: false, body: "", buttons: [] },
  ]);

  // Catalog template — a single "View catalog" button (needs a catalog
  // connected to the WABA). Just a body + this button label + optional footer.
  const [catalogButtonText, setCatalogButtonText] = useState("View catalog");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const urlCount = buttons.filter((b) => b.kind === "url").length;
  const phoneCount = buttons.filter((b) => b.kind === "phone").length;
  const copyCount = buttons.filter((b) => b.kind === "copy_code").length;
  // Body textarea ref — needed so the format toolbar / Ctrl+B keyboard
  // shortcuts can wrap the current selection with WhatsApp's markdown
  // markers (*bold*, _italic_, ~strike~, ```mono```, lists, > quote).
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const needsSampleUpload = headerKind === "image" || headerKind === "video" || headerKind === "document";
  const hasSample = !needsSampleUpload || !!headerHandle;

  const cardBtnValid = (b: BuilderButton) =>
    !!b.text.trim() &&
    !(b.kind === "url" && !b.url?.trim()) &&
    !(b.kind === "phone" && !b.phone?.trim());
  // Carousel: 2–10 cards, every card uploaded + (any) buttons complete.
  const carouselValid =
    cards.length >= 2 &&
    cards.length <= 10 &&
    cards.every((c) => !!c.handle && !c.uploading && c.buttons.every(cardBtnValid));

  const canSubmit =
    !!name.trim() &&
    /^[a-z0-9_]{1,80}$/.test(name) &&
    !!body.trim() &&
    body.length <= 1024 &&
    (!headerText || headerText.length <= 60) &&
    (!footer || footer.length <= 60) &&
    !submitting &&
    (type === "carousel" ? carouselValid : type === "catalog" ? !!catalogButtonText.trim() : hasSample) &&
    buttons.every((b) => {
      if (!b.text.trim()) return false;
      if (b.kind === "url" && !b.url?.trim()) return false;
      if (b.kind === "phone" && !b.phone?.trim()) return false;
      if (b.kind === "copy_code" && !b.code?.trim()) return false;
      return true;
    });

  async function uploadSample(file: File) {
    if (!needsSampleUpload) return;
    setUploadingSample(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("format", HEADER_FORMAT_API[headerKind as "image" | "video" | "document"]);
      const res = await fetch(`/api/templates/upload-sample${portfolioQs}`, { method: "POST", body: fd });
      const j = (await res.json()) as { handle?: string; preview_url?: string | null; error?: string };
      if (!res.ok || !j.handle) throw new Error(j.error ?? `HTTP ${res.status}`);
      setHeaderHandle(j.handle);
      // Use the Storage URL when available so the preview survives reload
      // and we can persist it for list/picker rendering.
      if (j.preview_url) {
        if (headerPreviewUrl) URL.revokeObjectURL(headerPreviewUrl);
        setHeaderPreviewUrl(j.preview_url);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
      setHeaderFile(null);
      setHeaderHandle(null);
      setHeaderPreviewUrl(null);
    } finally {
      setUploadingSample(false);
    }
  }

  function onFilePicked(file: File) {
    setHeaderFile(file);
    setHeaderHandle(null);
    if (headerPreviewUrl) URL.revokeObjectURL(headerPreviewUrl);
    setHeaderPreviewUrl(file.type.startsWith("image") || file.type.startsWith("video") ? URL.createObjectURL(file) : null);
    uploadSample(file);
  }

  function setHeaderMode(k: HeaderKind) {
    setHeaderKind(k);
    setHeaderFile(null);
    setHeaderHandle(null);
    if (headerPreviewUrl) URL.revokeObjectURL(headerPreviewUrl);
    setHeaderPreviewUrl(null);
  }

  async function onSubmit() {
    setError(null);
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const payloadButtons = buttons.map(toApiButton);

      const isCarousel = type === "carousel";
      const headerFormatApi = isCarousel
        ? null
        : headerKind === "text"
          ? "TEXT"
          : headerKind === "none"
            ? null
            : HEADER_FORMAT_API[headerKind as "image" | "video" | "document"];

      // Edit mode → PATCH to per-template endpoint (Meta puts it back to
      // PENDING for re-review). Create mode → POST to /api/templates.
      const url = isEdit
        ? `/api/templates/${encodeURIComponent(initialTemplate!.id)}${portfolioQs}`
        : `/api/templates${portfolioQs}`;
      const method = isEdit ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Name + language are immutable in edit mode — server ignores them.
          name,
          category,
          language,
          header_format: headerFormatApi,
          header_text: headerKind === "text" ? headerText.trim() || null : null,
          header_handle: headerHandle ?? null,
          // Public Supabase Storage URL — server stashes it in template_assets
          // so list / picker / edit pages can render the same preview Meta shows.
          header_preview_url: needsSampleUpload ? headerPreviewUrl : null,
          body,
          footer: footer.trim() || null,
          buttons:
            type === "catalog"
              ? [{ type: "CATALOG", text: catalogButtonText.trim() || "View catalog" }]
              : type === "buttons" && payloadButtons.length > 0
                ? payloadButtons
                : undefined,
          carousel: isCarousel
            ? {
                cards: cards.map((c) => ({
                  header_format: carouselFormat,
                  header_handle: c.handle,
                  body: c.body.trim() || undefined,
                  buttons: c.buttons.map(toApiButton),
                })),
              }
            : undefined,
        }),
      });
      const j = (await res.json()) as { id?: string; status?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      router.push("/templates");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  }

  function addButton(kind: ButtonKind) {
    if (buttons.length >= 10) return;
    if (kind === "url" && urlCount >= 2) return;
    if (kind === "phone" && phoneCount >= 1) return;
    if (kind === "copy_code" && copyCount >= 1) return;
    setButtons((prev) => [
      ...prev,
      { id: crypto.randomUUID(), kind, text: "", url: kind === "url" ? "" : undefined, phone: kind === "phone" ? "" : undefined, code: kind === "copy_code" ? "" : undefined },
    ]);
  }

  function patchButton(id: string, patch: Partial<BuilderButton>) {
    setButtons((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }

  function insertVariable() {
    const next = (body.match(/\{\{(\d+)\}\}/g)?.length ?? 0) + 1;
    setBody((b) => b + ` {{${next}}}`);
  }

  // --- Carousel cards ---
  function addCard() {
    if (cards.length >= 10) return;
    setCards((p) => [...p, { id: crypto.randomUUID(), handle: null, previewUrl: null, uploading: false, body: "", buttons: [] }]);
  }
  function removeCard(id: string) {
    setCards((p) => (p.length <= 2 ? p : p.filter((c) => c.id !== id)));
  }
  function patchCard(id: string, patch: Partial<CarouselCard>) {
    setCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }
  async function uploadCardMedia(id: string, file: File) {
    patchCard(id, { uploading: true, handle: null, previewUrl: file.type.startsWith("image") || file.type.startsWith("video") ? URL.createObjectURL(file) : null });
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("format", carouselFormat);
      const res = await fetch(`/api/templates/upload-sample${portfolioQs}`, { method: "POST", body: fd });
      const j = (await res.json()) as { handle?: string; preview_url?: string | null; error?: string };
      if (!res.ok || !j.handle) throw new Error(j.error ?? `HTTP ${res.status}`);
      patchCard(id, { handle: j.handle, uploading: false, previewUrl: j.preview_url ?? null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
      patchCard(id, { uploading: false, handle: null, previewUrl: null });
    }
  }
  function addCardButton(cardId: string, kind: ButtonKind) {
    setCards((p) =>
      p.map((c) =>
        c.id === cardId && c.buttons.length < 2
          ? { ...c, buttons: [...c.buttons, { id: crypto.randomUUID(), kind, text: "", url: kind === "url" ? "" : undefined, phone: kind === "phone" ? "" : undefined }] }
          : c,
      ),
    );
  }
  function patchCardButton(cardId: string, btnId: string, patch: Partial<BuilderButton>) {
    setCards((p) => p.map((c) => (c.id === cardId ? { ...c, buttons: c.buttons.map((b) => (b.id === btnId ? { ...b, ...patch } : b)) } : c)));
  }
  function removeCardButton(cardId: string, btnId: string) {
    setCards((p) => p.map((c) => (c.id === cardId ? { ...c, buttons: c.buttons.filter((b) => b.id !== btnId) } : c)));
  }
  function toApiButton(b: BuilderButton) {
    if (b.kind === "url") return { type: "URL", text: b.text.trim(), url: (b.url ?? "").trim() };
    if (b.kind === "phone") return { type: "PHONE_NUMBER", text: b.text.trim(), phone_number: (b.phone ?? "").trim() };
    if (b.kind === "copy_code") return { type: "COPY_CODE", example: (b.code ?? "").trim() };
    return { type: "QUICK_REPLY", text: b.text.trim() };
  }

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b bg-card px-6 py-3">
        <div className="flex items-center gap-3">
          <Link
            href="/templates"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {isEdit ? "Edit Template" : "Create New Template"}
          </Link>
          {isEdit ? (
            initialTemplate?.status === "REJECTED" ||
            initialTemplate?.status === "PAUSED" ? (
              <span className="hidden sm:inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 ring-1 ring-amber-200">
                Re-submits to Meta for review
              </span>
            ) : initialTemplate?.status === "APPROVED" ? (
              <span className="hidden sm:inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800 ring-1 ring-emerald-200">
                Changes will be resubmitted for review
              </span>
            ) : initialTemplate?.status === "PENDING" ? (
              <span className="hidden sm:inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-800 ring-1 ring-sky-200">
                Pending Meta review
              </span>
            ) : null
          ) : null}
          <span className="h-5 w-px bg-border" />
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white text-[10px] font-bold">W</span>
            WhatsApp
          </span>
        </div>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting
            ? isEdit
              ? "Saving…"
              : "Submitting…"
            : isEdit
              ? "Save & Resubmit"
              : "Submit"}
        </button>
      </div>

      {error ? (
        <div className="border-b bg-red-50 px-6 py-2 text-sm text-red-800">
          <strong>Error:</strong> {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Form */}
        <div className="flex-1 overflow-auto p-6">
          <div className="mx-auto max-w-3xl space-y-4">
            {/* STEP 1 */}
            <section className="rounded-lg border bg-card shadow-sm">
              <button
                type="button"
                onClick={() => setStep1Open((v) => !v)}
                className="flex w-full items-center justify-between px-5 py-4"
              >
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-muted-foreground">1</span>
                  <span className="text-sm font-semibold">Choose Template Category & Type</span>
                </div>
                <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition", !step1Open && "-rotate-90")} />
              </button>
              {step1Open ? (
                <div className="space-y-4 border-t px-5 py-4">
                  <div>
                    <label className="mb-2 block text-xs font-semibold">Template Category</label>
                    <div className="flex flex-wrap gap-2">
                      {CATEGORIES.map((c) => {
                        const Icon = c.icon;
                        const active = c.value === category;
                        return (
                          <button
                            key={c.value}
                            type="button"
                            onClick={() => setCategory(c.value)}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                              active ? "border-primary bg-primary/5 text-primary" : "border-input bg-background text-foreground hover:bg-secondary",
                            )}
                          >
                            <Icon className="h-3.5 w-3.5" />
                            {c.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="mb-2 block text-xs font-semibold">Template Type</label>
                    <div className="space-y-2">
                      {TYPES.map((t) => {
                        const Icon = t.icon;
                        const active = t.value === type;
                        return (
                          <button
                            key={t.value}
                            type="button"
                            disabled={!t.enabled}
                            onClick={() => t.enabled && setType(t.value)}
                            className={cn(
                              "flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left transition",
                              active ? "border-primary bg-primary/5" : "border-input bg-background",
                              t.enabled ? "hover:bg-secondary cursor-pointer" : "opacity-60 cursor-not-allowed",
                            )}
                          >
                            <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-semibold">
                                {t.label}
                                {!t.enabled ? (
                                  <span className="ml-2 rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-bold uppercase text-muted-foreground">Coming soon</span>
                                ) : null}
                              </div>
                              <div className="text-xs text-muted-foreground">{t.desc}</div>
                            </div>
                            <span className={cn("h-4 w-4 shrink-0 rounded-full border-2", active ? "border-primary bg-primary" : "border-input")} />
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        setStep1Open(false);
                        setStep2Open(true);
                      }}
                      className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            {/* STEP 2 */}
            <section className="rounded-lg border bg-card shadow-sm">
              <button
                type="button"
                onClick={() => setStep2Open((v) => !v)}
                className="flex w-full items-center justify-between px-5 py-4"
              >
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-muted-foreground">2</span>
                  <span className="text-sm font-semibold">Draft your Template</span>
                </div>
                <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition", !step2Open && "-rotate-90")} />
              </button>

              {step2Open ? (
                <div className="space-y-5 border-t px-5 py-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-semibold">
                        Template Name
                        {isEdit ? (
                          <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                            (locked — cannot be changed)
                          </span>
                        ) : null}
                      </label>
                      <Input
                        value={name}
                        onChange={(e) => setName(slugifyName(e.target.value))}
                        placeholder="enter_template_name"
                        className="h-9 text-sm"
                        readOnly={isEdit}
                        disabled={isEdit}
                      />
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        Lowercase letters, numbers and underscores only.
                      </p>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold">
                        Language
                        {isEdit ? (
                          <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                            (locked)
                          </span>
                        ) : null}
                      </label>
                      <select
                        value={language}
                        onChange={(e) => setLanguage(e.target.value)}
                        disabled={isEdit}
                        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
                      >
                        {LANGUAGES.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Header — hidden for carousel (cards carry their own media)
                      and catalog (catalog button only). */}
                  {type !== "carousel" && type !== "catalog" ? (
                  <div className="rounded-md border bg-secondary/40 p-4">
                    <div className="mb-1 text-sm font-semibold">Header (Optional)</div>
                    <p className="mb-3 text-xs text-muted-foreground">
                      Add a title, or select the media type you want to get approved for this template&apos;s header
                    </p>
                    <div className="flex flex-wrap gap-4">
                      {(["none", "text", "image", "video", "document"] as HeaderKind[]).map((k) => (
                        <label key={k} className="inline-flex items-center gap-1.5 text-xs">
                          <input
                            type="radio"
                            checked={headerKind === k}
                            onChange={() => setHeaderMode(k)}
                          />
                          <span className="capitalize">{k}</span>
                        </label>
                      ))}
                    </div>

                    {headerKind === "text" ? (
                      <div className="mt-3">
                        <Input
                          value={headerText}
                          onChange={(e) => setHeaderText(e.target.value)}
                          placeholder="Header text"
                          maxLength={60}
                          className="h-9 text-sm"
                        />
                        <div className="mt-1 text-right text-[10px] text-muted-foreground">{headerText.length}/60</div>
                      </div>
                    ) : null}

                    {needsSampleUpload ? (
                      <div className="mt-3">
                        <input
                          ref={fileInput}
                          type="file"
                          accept={HEADER_ACCEPT[headerKind]}
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) onFilePicked(f);
                            e.currentTarget.value = "";
                          }}
                        />
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => fileInput.current?.click()}
                            disabled={uploadingSample}
                            className="inline-flex h-24 w-32 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-input bg-background text-xs font-medium text-primary hover:bg-secondary disabled:opacity-50"
                          >
                            {uploadingSample ? (
                              <Loader2 className="h-5 w-5 animate-spin" />
                            ) : headerKind === "image" ? (
                              <ImageIcon className="h-5 w-5 text-muted-foreground" />
                            ) : headerKind === "video" ? (
                              <VideoIcon className="h-5 w-5 text-muted-foreground" />
                            ) : (
                              <FileText className="h-5 w-5 text-muted-foreground" />
                            )}
                            <span className="underline">
                              {uploadingSample ? "Uploading…" : headerFile ? "Replace" : `Upload ${headerKind}`}
                            </span>
                          </button>
                          <div className="text-xs text-muted-foreground">
                            {headerKind === "image"
                              ? "Image size should not exceed 5MB. JPG or PNG."
                              : headerKind === "video"
                                ? "Video size should not exceed 16MB. MP4."
                                : "PDF or Word doc, max 100MB."}
                            {headerHandle ? (
                              <div className="mt-1 inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                                ✓ Uploaded
                              </div>
                            ) : null}
                          </div>
                        </div>
                        {headerPreviewUrl ? (
                          headerKind === "image" ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={headerPreviewUrl} alt="Header preview" className="mt-2 max-h-40 rounded-md border" />
                          ) : (
                            <video src={headerPreviewUrl} className="mt-2 max-h-40 rounded-md border" controls />
                          )
                        ) : null}
                        <p className="mt-2 text-[10px] text-muted-foreground">
                          This media file will be sent as a sample to WhatsApp for approval. At the time of sending the template you can change the media file if required.
                        </p>
                      </div>
                    ) : null}
                  </div>
                  ) : null}

                  {/* Body */}
                  <div className="rounded-md border bg-secondary/40 p-4">
                    <div className="mb-1 text-sm font-semibold">Body</div>
                    <p className="mb-3 text-xs text-muted-foreground">The WhatsApp message in the language you have selected.</p>
                    <FormatToolbar
                      onFormat={(kind) => applyWhatsAppFormat(bodyRef.current, kind, setBody)}
                    />
                    <textarea
                      ref={bodyRef}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      onKeyDown={(e) => handleFormatShortcut(e, bodyRef.current, setBody)}
                      rows={6}
                      maxLength={1024}
                      placeholder="Hi {{1}}, your order {{2}} is confirmed…"
                      className="w-full rounded-b-md border border-t-0 border-input bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <div className="mt-2 flex items-center justify-between">
                      <button
                        type="button"
                        onClick={insertVariable}
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        <Plus className="h-3 w-3" />
                        Add variable
                        <Info className="h-3 w-3 text-muted-foreground" />
                      </button>
                      <span className="text-[10px] text-muted-foreground">{body.length}/1024</span>
                    </div>
                  </div>

                  {/* Footer — not allowed on carousel templates. */}
                  {type !== "carousel" ? (
                  <div className="rounded-md border bg-secondary/40 p-4">
                    <div className="mb-1 text-sm font-semibold">Footer (Optional)</div>
                    <p className="mb-3 text-xs text-muted-foreground">Short line of text at the bottom of the template.</p>
                    <Input
                      value={footer}
                      onChange={(e) => setFooter(e.target.value)}
                      placeholder=""
                      maxLength={60}
                      className="h-9 text-sm"
                    />
                    <div className="mt-1 text-right text-[10px] text-muted-foreground">{footer.length}/60</div>
                  </div>
                  ) : null}

                  {/* Carousel cards */}
                  {type === "carousel" ? (
                    <div className="rounded-md border bg-secondary/40 p-4">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-sm font-semibold">Carousel cards</span>
                        <span className="text-[11px] font-semibold text-muted-foreground">{cards.length}/10</span>
                      </div>
                      <p className="mb-3 text-xs text-muted-foreground">
                        2–10 cards. Har card ka apna media (sabhi same type), optional text + max 2 buttons. Upar wala Body message bubble me dikhta hai.
                      </p>

                      <div className="mb-3 flex items-center gap-4">
                        <span className="text-xs font-medium text-muted-foreground">Card media type:</span>
                        {(["IMAGE", "VIDEO"] as const).map((f) => (
                          <label key={f} className="inline-flex items-center gap-1.5 text-xs">
                            <input
                              type="radio"
                              checked={carouselFormat === f}
                              onChange={() => {
                                setCarouselFormat(f);
                                setCards((p) => p.map((c) => ({ ...c, handle: null, previewUrl: null })));
                              }}
                            />
                            <span className="capitalize">{f.toLowerCase()}</span>
                          </label>
                        ))}
                      </div>

                      <div className="space-y-3">
                        {cards.map((c, i) => (
                          <div key={c.id} className="rounded-lg border bg-background p-3">
                            <div className="mb-2 flex items-center justify-between">
                              <span className="text-xs font-semibold">Card {i + 1}</span>
                              {cards.length > 2 ? (
                                <button type="button" onClick={() => removeCard(c.id)} className="text-muted-foreground hover:text-destructive">
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              ) : null}
                            </div>
                            <div className="flex gap-3">
                              <div className="shrink-0">
                                <label className="grid h-24 w-32 cursor-pointer place-items-center overflow-hidden rounded-lg border-2 border-dashed border-input text-[11px] font-medium text-primary hover:bg-secondary">
                                  <input
                                    type="file"
                                    accept={carouselFormat === "IMAGE" ? "image/jpeg,image/png" : "video/mp4"}
                                    className="hidden"
                                    onChange={(e) => {
                                      const f = e.target.files?.[0];
                                      if (f) uploadCardMedia(c.id, f);
                                      e.currentTarget.value = "";
                                    }}
                                  />
                                  {c.uploading ? (
                                    <Loader2 className="h-5 w-5 animate-spin" />
                                  ) : c.previewUrl ? (
                                    carouselFormat === "IMAGE" ? (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img src={c.previewUrl} alt="" className="h-full w-full object-cover" />
                                    ) : (
                                      <video src={c.previewUrl} className="h-full w-full object-cover" />
                                    )
                                  ) : (
                                    <span className="underline">Upload {carouselFormat.toLowerCase()}</span>
                                  )}
                                </label>
                                {c.handle ? <div className="mt-1 text-center text-[10px] font-semibold text-emerald-700">✓ Uploaded</div> : null}
                              </div>
                              <div className="min-w-0 flex-1 space-y-2">
                                <textarea
                                  value={c.body}
                                  onChange={(e) => patchCard(c.id, { body: e.target.value })}
                                  rows={2}
                                  maxLength={160}
                                  placeholder="Card text (optional)"
                                  className="w-full rounded-md border border-input bg-background p-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                                />
                                <div className="flex flex-wrap gap-1.5">
                                  <button type="button" onClick={() => addCardButton(c.id, "quick_reply")} disabled={c.buttons.length >= 2} className="rounded border px-2 py-1 text-[11px] font-semibold hover:bg-secondary disabled:opacity-40">+ Quick Reply</button>
                                  <button type="button" onClick={() => addCardButton(c.id, "url")} disabled={c.buttons.length >= 2} className="rounded border px-2 py-1 text-[11px] font-semibold hover:bg-secondary disabled:opacity-40">+ URL</button>
                                  <button type="button" onClick={() => addCardButton(c.id, "phone")} disabled={c.buttons.length >= 2} className="rounded border px-2 py-1 text-[11px] font-semibold hover:bg-secondary disabled:opacity-40">+ Phone</button>
                                </div>
                                {c.buttons.map((b) => (
                                  <div key={b.id} className="flex items-center gap-1.5">
                                    <input
                                      value={b.text}
                                      onChange={(e) => patchCardButton(c.id, b.id, { text: e.target.value })}
                                      placeholder={b.kind === "quick_reply" ? "Quick reply" : b.kind === "url" ? "Button text" : "Call button"}
                                      maxLength={25}
                                      className="w-28 shrink-0 rounded-md border border-input bg-background px-2 py-1 text-[11px]"
                                    />
                                    {b.kind === "url" ? (
                                      <input value={b.url ?? ""} onChange={(e) => patchCardButton(c.id, b.id, { url: e.target.value })} placeholder="https://…" className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-[11px]" />
                                    ) : null}
                                    {b.kind === "phone" ? (
                                      <input value={b.phone ?? ""} onChange={(e) => patchCardButton(c.id, b.id, { phone: e.target.value })} placeholder="+91…" className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-[11px]" />
                                    ) : null}
                                    <button type="button" onClick={() => removeCardButton(c.id, b.id)} className="text-muted-foreground hover:text-destructive">
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>

                      <button type="button" onClick={addCard} disabled={cards.length >= 10} className="mt-3 inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-semibold hover:bg-secondary disabled:opacity-40">
                        <Plus className="h-3.5 w-3.5" /> Add card
                      </button>
                    </div>
                  ) : null}

                  {/* Catalog */}
                  {type === "catalog" ? (
                    <div className="rounded-md border bg-secondary/40 p-4">
                      <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                        <ShoppingBag className="h-4 w-4 text-muted-foreground" />
                        Catalog button
                      </div>
                      <p className="mb-3 text-xs text-muted-foreground">
                        Ye button tap karne pe aapka poora WhatsApp catalog khulta hai. WABA pe ek catalog connected hona chahiye (Meta Commerce Manager) — warna Meta reject karega.
                      </p>
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Button label</label>
                      <Input
                        value={catalogButtonText}
                        onChange={(e) => setCatalogButtonText(e.target.value)}
                        placeholder="View catalog"
                        maxLength={25}
                        className="mt-1 h-9 text-sm"
                      />
                      <div className="mt-1 text-right text-[10px] text-muted-foreground">{catalogButtonText.length}/25</div>
                    </div>
                  ) : null}

                  {/* Buttons */}
                  {type === "buttons" ? (
                    <div className="rounded-md border bg-secondary/40 p-4">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-sm font-semibold">Template with Buttons</span>
                        <span className="text-[11px] font-semibold text-muted-foreground">{buttons.length}/10</span>
                      </div>
                      <p className="mb-3 text-xs text-muted-foreground">
                        Create buttons that let customers respond to your message or take action. Total across all types ≤ 10.
                      </p>

                      {/* Add menu */}
                      <div className="mb-3 flex flex-wrap gap-2">
                        <AddChip label="Quick Reply" icon={Copy} onAdd={() => addButton("quick_reply")} disabled={buttons.length >= 10} />
                        <AddChip label="Website URL" icon={ExternalLink} onAdd={() => addButton("url")} disabled={urlCount >= 2 || buttons.length >= 10} hint={urlCount >= 2 ? "max 2" : undefined} />
                        <AddChip label="Phone Number" icon={Phone} onAdd={() => addButton("phone")} disabled={phoneCount >= 1 || buttons.length >= 10} hint={phoneCount >= 1 ? "max 1" : undefined} />
                        <AddChip label="Copy Code" icon={Copy} onAdd={() => addButton("copy_code")} disabled={copyCount >= 1 || buttons.length >= 10} hint={copyCount >= 1 ? "max 1" : undefined} />
                      </div>

                      {buttons.length === 0 ? (
                        <p className="text-xs italic text-muted-foreground">No buttons yet. Add one from above.</p>
                      ) : (
                        <ul className="space-y-3">
                          {buttons.map((b, idx) => (
                            <li key={b.id} className="rounded-md border bg-background p-3">
                              <div className="mb-2 flex items-center justify-between">
                                <span className="text-[11px] font-semibold uppercase text-muted-foreground">
                                  {idx + 1} · {b.kind.replace("_", " ")}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setButtons((prev) => prev.filter((x) => x.id !== b.id))}
                                  className="text-muted-foreground hover:text-destructive"
                                  aria-label="Remove button"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                              <div className="grid gap-2 sm:grid-cols-2">
                                <div>
                                  <label className="mb-1 block text-[10px] font-semibold text-muted-foreground">Button text</label>
                                  <Input
                                    value={b.text}
                                    onChange={(e) => patchButton(b.id, { text: e.target.value })}
                                    maxLength={25}
                                    placeholder="Button label"
                                    className="h-8 text-sm"
                                  />
                                  <div className="mt-0.5 text-right text-[9px] text-muted-foreground">{b.text.length}/25</div>
                                </div>
                                {b.kind === "url" ? (
                                  <div>
                                    <label className="mb-1 block text-[10px] font-semibold text-muted-foreground">URL</label>
                                    <Input
                                      value={b.url ?? ""}
                                      onChange={(e) => patchButton(b.id, { url: e.target.value })}
                                      placeholder="https://example.com"
                                      className="h-8 text-sm"
                                    />
                                  </div>
                                ) : null}
                                {b.kind === "phone" ? (
                                  <div>
                                    <label className="mb-1 block text-[10px] font-semibold text-muted-foreground">Phone (E.164)</label>
                                    <Input
                                      value={b.phone ?? ""}
                                      onChange={(e) => patchButton(b.id, { phone: e.target.value })}
                                      placeholder="+919876543210"
                                      className="h-8 text-sm"
                                    />
                                  </div>
                                ) : null}
                                {b.kind === "copy_code" ? (
                                  <div>
                                    <label className="mb-1 block text-[10px] font-semibold text-muted-foreground">Code to copy</label>
                                    <Input
                                      value={b.code ?? ""}
                                      onChange={(e) => patchButton(b.id, { code: e.target.value })}
                                      placeholder="SUMMER20"
                                      className="h-8 text-sm"
                                    />
                                  </div>
                                ) : null}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          </div>
        </div>

        {/* Preview */}
        <aside className="hidden w-[340px] shrink-0 border-l bg-emerald-50/50 p-4 lg:block">
          <div className="sticky top-4">
            <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
              Actual Preview
            </div>
            <WhatsAppPhonePreview
              businessName={businessName}
              headerKind={headerKind}
              headerText={headerKind === "text" ? headerText : ""}
              headerPreviewUrl={headerPreviewUrl}
              body={body}
              footer={footer}
              buttons={type === "buttons" ? buttons.filter((b) => b.text.trim()) : []}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

function AddChip({
  label,
  icon: Icon,
  onAdd,
  disabled,
  hint,
}: {
  label: string;
  icon: typeof Copy;
  onAdd: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onAdd}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition",
        disabled
          ? "cursor-not-allowed border-input bg-secondary text-muted-foreground opacity-60"
          : "border-primary text-primary hover:bg-primary/5",
      )}
      title={hint}
    >
      <Plus className="h-3 w-3" />
      <Icon className="h-3 w-3" />
      {label}
      {hint ? <span className="ml-0.5 text-[9px] text-muted-foreground">({hint})</span> : null}
    </button>
  );
}


// ---------------------------------------------------------------------------
// WhatsApp body formatting — toolbar + Ctrl+B/I shortcuts. WhatsApp
// renders these markers natively on the user's phone:
//   *bold*  _italic_  ~strike~  ```mono```  > quote   `code`
//   * bullet (per line)    1. number (per line)
// ---------------------------------------------------------------------------
type FormatKind =
  | "bold"
  | "italic"
  | "strike"
  | "mono"
  | "code"
  | "quote"
  | "bullet"
  | "number";

const WRAP_MARKERS: Partial<Record<FormatKind, string>> = {
  bold: "*",
  italic: "_",
  strike: "~",
  mono: "```",
  code: "`",
};

function applyWhatsAppFormat(
  ta: HTMLTextAreaElement | null,
  kind: FormatKind,
  setBody: (next: string) => void,
) {
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const value = ta.value;
  const selected = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);

  const wrap = WRAP_MARKERS[kind];
  if (wrap) {
    // Toggle: if the selection is already wrapped, strip the markers.
    if (
      selected.startsWith(wrap) &&
      selected.endsWith(wrap) &&
      selected.length >= wrap.length * 2
    ) {
      const stripped = selected.slice(wrap.length, selected.length - wrap.length);
      const next = before + stripped + after;
      setBody(next);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(start, start + stripped.length);
      });
      return;
    }
    const inserted = `${wrap}${selected || "text"}${wrap}`;
    const next = before + inserted + after;
    setBody(next);
    requestAnimationFrame(() => {
      ta.focus();
      const innerStart = start + wrap.length;
      const innerEnd = innerStart + (selected.length || 4);
      ta.setSelectionRange(innerStart, innerEnd);
    });
    return;
  }

  // Line-prefix kinds: quote, bullet, number. Apply to every line in the
  // selection (or the current line if nothing selected).
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEnd = after.indexOf("\n");
  const blockStart = selected ? start : lineStart;
  const blockEnd = selected ? end : (lineEnd === -1 ? value.length : end + lineEnd);
  const block = value.slice(blockStart, blockEnd);
  const lines = block.split("\n");
  const transformed = lines
    .map((ln, i) => {
      if (kind === "quote") return ln.startsWith("> ") ? ln : `> ${ln}`;
      if (kind === "bullet") return ln.startsWith("* ") ? ln : `* ${ln}`;
      return /^\d+\.\s/.test(ln) ? ln : `${i + 1}. ${ln}`;
    })
    .join("\n");
  const next = value.slice(0, blockStart) + transformed + value.slice(blockEnd);
  setBody(next);
  requestAnimationFrame(() => {
    ta.focus();
    ta.setSelectionRange(blockStart, blockStart + transformed.length);
  });
}

function handleFormatShortcut(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  ta: HTMLTextAreaElement | null,
  setBody: (next: string) => void,
) {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  let kind: FormatKind | null = null;
  if (key === "b") kind = "bold";
  else if (key === "i") kind = "italic";
  else if (e.shiftKey && key === "x") kind = "strike";
  else if (e.shiftKey && key === "m") kind = "mono";
  if (!kind) return;
  e.preventDefault();
  applyWhatsAppFormat(ta, kind, setBody);
}

function FormatToolbar({ onFormat }: { onFormat: (k: FormatKind) => void }) {
  const items: Array<{ kind: FormatKind; icon: typeof Bold; title: string }> = [
    { kind: "bold", icon: Bold, title: "Bold (Ctrl+B)" },
    { kind: "italic", icon: Italic, title: "Italic (Ctrl+I)" },
    { kind: "strike", icon: Strikethrough, title: "Strikethrough (Ctrl+Shift+X)" },
    { kind: "mono", icon: Terminal, title: "Monospace (Ctrl+Shift+M)" },
    { kind: "code", icon: Code, title: "Inline code" },
    { kind: "quote", icon: Quote, title: "Block quote" },
    { kind: "bullet", icon: List, title: "Bulleted list" },
    { kind: "number", icon: ListOrdered, title: "Numbered list" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-0.5 rounded-t-md border border-b-0 border-input bg-card px-1.5 py-1">
      {items.map((it) => (
        <button
          key={it.kind}
          type="button"
          onClick={() => onFormat(it.kind)}
          title={it.title}
          aria-label={it.title}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <it.icon className="h-3.5 w-3.5" />
        </button>
      ))}
      <span className="ml-auto pr-1 text-[9px] text-muted-foreground">
        WhatsApp formatting
      </span>
    </div>
  );
}

function WhatsAppPhonePreview({
  businessName,
  headerKind,
  headerText,
  headerPreviewUrl,
  body,
  footer,
  buttons,
}: {
  businessName: string;
  headerKind: HeaderKind;
  headerText: string;
  headerPreviewUrl: string | null;
  body: string;
  footer: string;
  buttons: BuilderButton[];
}) {
  const time = useMemo(() => {
    const d = new Date();
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }, []);

  const hasBubble = headerKind !== "none" || body || footer;

  return (
    <div
      className="mx-auto w-[284px] rounded-[40px] border-[12px] border-gray-950 shadow-[0_20px_60px_-12px_rgba(0,0,0,.45),0_8px_18px_-6px_rgba(0,0,0,.25)] ring-1 ring-black/40"
      style={{
        background:
          "linear-gradient(145deg, #1f2937 0%, #111827 50%, #0b1220 100%)",
      }}
    >
      {/* notch */}
      <div className="relative">
        <div className="absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-[2px] h-[14px] w-[78px] rounded-b-2xl bg-gray-950" />
      </div>
      <div className="overflow-hidden rounded-[26px] bg-[#efe7dd]">
        {/* iOS-style status bar */}
        <div className="flex items-center justify-between bg-emerald-700 px-3 py-[2px] text-[9px] font-medium text-white/90">
          <span className="tabular-nums">{time}</span>
          <span className="opacity-80">●●● 5G</span>
        </div>
        {/* Chat header: brand DP + name + subtitle */}
        <div
          className="flex items-center gap-2.5 px-3 py-2 text-white shadow-sm"
          style={{
            background:
              "linear-gradient(135deg, #128c7e 0%, #075e54 100%)",
          }}
        >
          <div className="relative h-8 w-8 shrink-0 overflow-hidden rounded-full bg-white ring-2 ring-white/40 shadow-md">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.png"
              alt={businessName}
              className="h-full w-full object-cover"
            />
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[12px] font-semibold">{businessName}</div>
            <div className="text-[9px] text-emerald-100/85">online</div>
          </div>
          <div className="flex items-center gap-2 text-white/85">
            <Phone className="h-3.5 w-3.5" />
            <Video className="h-3.5 w-3.5" />
          </div>
        </div>
        {/* Chat body */}
        <div
          className="min-h-[360px] bg-[#efe7dd] px-3 py-3"
          style={{
            backgroundImage:
              "radial-gradient(circle at 22% 18%, rgba(255,255,255,.38) 0, transparent 42%), radial-gradient(circle at 80% 80%, rgba(0,0,0,.06) 0, transparent 42%)",
          }}
        >
          <div className="mb-2 text-center">
            <span className="rounded-md bg-white/80 px-2 py-0.5 text-[9px] font-semibold text-gray-600 shadow-sm">
              TODAY
            </span>
          </div>
          {hasBubble ? (
            <div className="relative max-w-[230px] rounded-[10px] bg-white p-1.5 shadow-[0_1px_1px_rgba(0,0,0,.08)]">
              {/* tail */}
              <span
                aria-hidden
                className="absolute -left-1.5 top-0 h-3 w-3 bg-white"
                style={{ clipPath: "polygon(0 0, 100% 0, 100% 100%)" }}
              />
              {headerKind === "image" && headerPreviewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={headerPreviewUrl} alt="" className="mb-1 rounded-[6px]" />
              ) : null}
              {headerKind === "video" && headerPreviewUrl ? (
                <video src={headerPreviewUrl} className="mb-1 rounded-[6px]" muted />
              ) : null}
              {headerKind === "document" ? (
                <div className="mb-1 flex items-center gap-1.5 rounded-md bg-gray-100 p-2">
                  <FileText className="h-4 w-4 text-gray-500" />
                  <span className="text-[10px] text-gray-700">Document.pdf</span>
                </div>
              ) : null}
              {headerKind === "text" && headerText ? (
                <div className="mb-1 px-1 text-[11px] font-bold text-gray-900">
                  {headerText}
                </div>
              ) : null}
              {body ? (
                <div
                  className="whitespace-pre-wrap break-words px-1 text-[11.5px] leading-snug text-gray-900"
                  dangerouslySetInnerHTML={{ __html: renderWhatsAppMarkdown(body) }}
                />
              ) : (
                <div className="px-1 text-[11px] italic text-gray-400">
                  Body preview will appear here…
                </div>
              )}
              {footer ? (
                <div className="mt-1 px-1 text-[9.5px] text-gray-500">{footer}</div>
              ) : null}
              <div className="mt-0.5 flex items-center justify-end gap-0.5 px-1 text-[9px] text-gray-400">
                <span>{time}</span>
              </div>
            </div>
          ) : (
            <div className="mt-10 text-center text-[11px] italic text-gray-500">
              Start typing the body to see a preview…
            </div>
          )}
          {buttons.length > 0 ? (
            <div className="mt-1.5 max-w-[230px] space-y-[3px]">
              {buttons.map((b) => (
                <div
                  key={b.id}
                  className="flex items-center justify-center gap-1.5 rounded-[10px] bg-white py-1.5 text-center text-[11px] font-semibold text-[#075e54] shadow-[0_1px_1px_rgba(0,0,0,.08)]"
                >
                  {b.kind === "url" ? <ExternalLink className="h-3 w-3" /> : null}
                  {b.kind === "phone" ? <Phone className="h-3 w-3" /> : null}
                  {b.kind === "copy_code" ? <Copy className="h-3 w-3" /> : null}
                  {b.kind === "quick_reply" ? <Quote className="h-3 w-3 rotate-180" /> : null}
                  {b.text || "Button"}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 border-t border-gray-200 bg-[#f7f3ec] px-2 py-1.5 text-[10px] text-gray-400">
          <span>🙂</span>
          <span className="flex-1 rounded-full bg-white px-2 py-0.5 shadow-inner">
            Message
          </span>
          <span className="text-emerald-700">🎙</span>
        </div>
      </div>
    </div>
  );
}

