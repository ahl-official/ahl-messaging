"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCheck,
  ClipboardList,
  Download,
  FileText,
  History,
  Loader2,
  MapPin,
  Pencil,
  PhoneCall,
  Reply,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isEphemeralWhatsAppMedia } from "@/lib/media-url";
import type { Message } from "@/lib/types";
import { renderWhatsAppMarkdown } from "@/lib/whatsapp-markdown";
import { interaktTemplatePreview } from "@/lib/interakt-format";
import { MediaLightbox } from "@/components/MediaLightbox";
import { AudioBubble } from "@/components/AudioBubble";
import { useMemberName, useMembers } from "@/components/MembersContext";

/** Parse any provider's "📍 <label> (lat,lng)" location content into pieces
 *  for a clickable map link. Returns null when there are no trailing coords
 *  (e.g. a location with no shared point, or an unrelated text message). */
function parseLocation(
  content: string | null | undefined,
): { lat: string; lng: string; label: string } | null {
  if (!content) return null;
  const m = content.match(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)\s*$/);
  if (!m) return null;
  const label = content
    .slice(0, m.index ?? 0)
    .replace(/^\s*📍\s*/, "")
    .replace(/\s*[—-]\s*$/, "")
    .trim();
  return { lat: m[1], lng: m[2], label };
}

/** Static map thumbnail for a lat/lng. Google Static Maps when a key is set
 *  (best quality, like WhatsApp); else a free OpenStreetMap static map — no
 *  key, works out of the box. Returns null when neither can build a URL. */
function staticMapUrl(lat: string, lng: string): string {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_STATIC_KEY;
  if (key) {
    return (
      `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}` +
      `&zoom=15&size=300x150&scale=2&markers=color:red%7C${lat},${lng}&key=${key}`
    );
  }
  return (
    `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}` +
    `&zoom=15&size=300x150&markers=${lat},${lng},red-pushpin`
  );
}

/** A shared location rendered like WhatsApp — a map preview thumbnail with a
 *  pin; tapping opens the full location in Google Maps. Falls back to a text
 *  card if the static-map image fails to load. */
function LocationCard({
  lat,
  lng,
  label,
  isOut,
}: {
  lat: string;
  lng: string;
  label: string;
  isOut: boolean;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const href = `https://www.google.com/maps?q=${lat},${lng}`;
  const mapUrl = staticMapUrl(lat, lng);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-[260px] max-w-full overflow-hidden rounded-lg transition hover:opacity-95"
    >
      {!imgFailed ? (
        <img
          src={mapUrl}
          alt="Shared location"
          loading="lazy"
          width={300}
          height={150}
          onError={() => setImgFailed(true)}
          className="block h-[130px] w-full object-cover"
        />
      ) : null}
      <div className="flex items-start gap-2 px-1.5 py-1.5">
        <span
          className={cn(
            "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            isOut ? "bg-emerald-200 text-emerald-700" : "bg-rose-100 text-rose-600",
          )}
        >
          <MapPin className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0">
          <span className="block font-medium leading-snug">{label || "Location"}</span>
          <span className="block text-[11px] text-muted-foreground">
            {lat}, {lng} · <span className="underline">Open in Maps</span>
          </span>
        </span>
      </div>
    </a>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  // Invalid/missing timestamp must not throw (WebKit throws on toLocale*).
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function StatusTicks({ status, failed }: { status: Message["status"]; failed?: boolean }) {
  if (failed || status === "failed") {
    return <AlertTriangle className="h-3.5 w-3.5 text-rose-700" aria-label="Failed" />;
  }
  // Read = WhatsApp's signature sky blue. Slate-tinted base for sent/delivered
  // so they remain visible on the new lighter mint→emerald bubble.
  if (status === "read") {
    return (
      <CheckCheck
        className="h-3.5 w-3.5 text-sky-600"
        aria-label="Read"
        strokeWidth={2.8}
      />
    );
  }
  if (status === "delivered") {
    return (
      <CheckCheck className="h-3.5 w-3.5 text-emerald-900/55" aria-label="Delivered" strokeWidth={2.4} />
    );
  }
  return <Check className="h-3.5 w-3.5 text-emerald-900/45" aria-label="Sent" strokeWidth={2.4} />;
}

// Resolve the URL we should actually feed to <img> / <audio> / <video>.
// Evolution-sourced messages store WhatsApp's encrypted CDN URL in
// media_url — the browser can't decrypt it, so we route through our
// own proxy (/api/evolution/media/<wamid>) which calls Evolution's
// getBase64FromMediaMessage on the server. Meta-sourced messages
// already have a downloadable URL on our side, so we leave them alone.
function resolveDisplayableMediaUrl(message: Message): string | null {
  const stored = message.media_url ?? null;
  // Heuristic: any Evolution bpid is prefixed "evo:" in business_numbers.
  // If the message has one AND a wa_message_id, the proxy is the safe
  // bet — even if `stored` looks like a URL, it's the encrypted one.
  const isEvolution =
    typeof message.business_phone_number_id === "string" &&
    message.business_phone_number_id.startsWith("evo:");
  // Legacy Evolution rows hold the encrypted CDN url → live decrypt
  // proxy. New rows already hold a permanent Supabase Storage url.
  if (isEvolution && message.wa_message_id && isEphemeralWhatsAppMedia(stored)) {
    return `/api/evolution/media/${encodeURIComponent(message.wa_message_id)}`;
  }
  return stored;
}

function MediaContent({
  message,
  onPreview,
}: {
  message: Message;
  onPreview: () => void;
}) {
  const url = resolveDisplayableMediaUrl(message);
  const mime = message.media_mime_type ?? "";
  const caption = message.content;

  if (!url) {
    // `unsupported` is Meta's way of saying it couldn't classify the
    // customer's message (failed media upload, encryption miss,
    // unknown sticker, etc.). Image type with no URL means our
    // download from Meta failed even after 3× retry. Either way the
    // useful operator action is the same — ask the client to
    // resend — so we render one friendly placeholder instead of the
    // literal type tag.
    if (message.type === "unsupported" || message.type === "image") {
      return (
        <p className="whitespace-pre-wrap break-words italic text-muted-foreground/80">
          Photo couldn&apos;t be downloaded — ask the client to resend.
        </p>
      );
    }
    return <p className="whitespace-pre-wrap break-words italic opacity-80">[{message.type}]</p>;
  }

  // MIME-first dispatch — `message.type` is what Meta sent us at
  // ingest time, but mime is what the bytes actually are. We saw a
  // video saved with type="image" because Meta misclassified the
  // upload; mime ("video/mp4") was correct. Trusting mime first
  // means the right player renders no matter how Meta tagged it.
  if (mime.startsWith("video/") || message.type === "video") {
    return (
      <div className="space-y-1">
        <video
          src={url}
          controls
          preload="metadata"
          className="max-h-72 w-full rounded-md"
        />
        {caption ? (
          <p
            className="whatsapp-md whitespace-pre-wrap break-words text-sm"
            dangerouslySetInnerHTML={{ __html: renderWhatsAppMarkdown(caption) }}
          />
        ) : null}
      </div>
    );
  }

  if (mime.startsWith("audio/") || message.type === "audio") {
    return <AudioBubble url={url} messageId={message.id} caption={caption} />;
  }

  if (mime.startsWith("image/") || message.type === "image") {
    return (
      <div className="space-y-1">
        <button type="button" onClick={onPreview} className="block w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={caption ?? "image"}
            className="max-h-72 w-full rounded-md object-cover hover:opacity-95 transition"
            loading="lazy"
          />
        </button>
        {caption ? (
          <p
            className="whatsapp-md whitespace-pre-wrap break-words text-sm"
            dangerouslySetInnerHTML={{ __html: renderWhatsAppMarkdown(caption) }}
          />
        ) : null}
      </div>
    );
  }

  // Stickers — webp / animated webp. Render small (~140px) on a
  // transparent background, no rounded corners (the sticker has its
  // own shape). No caption ever; nothing more to render.
  if (message.type === "sticker") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt="sticker"
        className="block h-auto w-[140px] max-w-full object-contain"
        loading="lazy"
      />
    );
  }

  // Document / fallback — open in lightbox (PDF iframes inline)
  const filename = caption || "document";
  return (
    <button
      type="button"
      onClick={onPreview}
      className="flex w-full items-center gap-2 rounded-md bg-black/10 px-2.5 py-2 hover:bg-black/15 text-left"
    >
      <FileText className="h-5 w-5 shrink-0" />
      <span className="flex-1 truncate text-sm font-medium">{filename}</span>
      <Download className="h-4 w-4 opacity-70" />
    </button>
  );
}

export function MessageBubble({
  message,
  onReply,
  contactImported,
  businessNumberName,
}: {
  message: Message;
  /** Optional — when set, a Reply hover-action appears on the bubble.
   *  Edit + Delete were removed: WhatsApp Cloud API supports neither
   *  (edit was silently treated as a new send → client saw duplicates;
   *  delete always errored). */
  onReply?: (msg: Message) => void;
  /** True when the whole conversation came in via chat-import. Inbound
   *  bubbles then get a history-icon avatar so the operator can see at
   *  a glance these are past (imported) messages, not a live thread. */
  contactImported?: boolean;
  /** Friendly nickname of the business number this thread belongs to.
   *  Used in the "WA" badge tooltip for messages typed on the linked
   *  phone — surfaces e.g. "Birjul Saini" instead of the generic
   *  "WhatsApp app on the linked phone". */
  businessNumberName?: string | null;
}) {
  const [previewing, setPreviewing] = useState(false);
  const isOut = message.direction === "outbound";
  // Resolve operator email → team-member display name. Used in both the
  // badge tooltip and the small "— Name" line under outbound bubbles so
  // reviewers see who actually sent the message.
  //
  // Mount-gated: the MembersProvider's data only populates on the client
  // (it fetches /api/team in an effect), so on SSR the resolved name
  // differs from what the client eventually shows. Gating on `mounted`
  // keeps the first client render byte-identical to the server output
  // and avoids a hydration mismatch when this label appears/disappears.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const resolvedSenderName = useMemberName(message.sent_by_email ?? null);
  const senderName = mounted ? resolvedSenderName : "";
  // For API-sent messages we also stamp the human who generated the token
  // (messages.sent_by_user_id), so the chat can show "by <person>".
  const { byUserId } = useMembers();
  const apiCreatorName = message.sent_by_user_id
    ? byUserId.get(message.sent_by_user_id)?.full_name ||
      byUserId.get(message.sent_by_user_id)?.email ||
      null
    : null;

  // ---------- Deleted tombstone ----------
  // Legacy rows from when "delete for everyone" was wired up. The row
  // stays in the DB so chronological order is preserved.
  if (message.deleted_at) {
    return (
      <div
        className={cn(
          "flex w-full items-end gap-2",
          isOut ? "justify-end" : "justify-start",
        )}
      >
        <div
          className={cn(
            "max-w-[75%] rounded-2xl border border-dashed bg-secondary/40 px-3.5 py-1.5 text-[11px] italic text-muted-foreground",
            isOut ? "rounded-br-sm" : "rounded-bl-sm",
          )}
        >
          🗑 Removed from dashboard
        </div>
      </div>
    );
  }

  const isMedia = ["image", "video", "audio", "document", "sticker"].includes(message.type);
  const isSticker = message.type === "sticker";
  const isTemplate = message.type === "template";
  // Customer button taps (Quick Reply on a template, or interactive button
  // replies on richer messages) arrive as type "button" / "interactive".
  // Treat them as plain-text bubbles since the webhook stores the visible
  // label (e.g. "Reply Now") in `content`.
  const isButtonReply = message.type === "button" || message.type === "interactive";
  const isText = message.type === "text" || isButtonReply;
  const isReaction = message.type === "reaction";
  const isLocation = message.type === "location";
  // Coords parsed from any provider's "📍 … (lat,lng)" content. Legacy
  // Evolution location rows are type "text" but carry the same 📍 string —
  // upgrade them to the clickable map card too.
  const loc = parseLocation(
    isLocation || (message.content ?? "").trimStart().startsWith("📍")
      ? message.content
      : null,
  );
  const failed = message.status === "failed";

  // Sender avatar — shown on every outbound message. Special markers
  // ("ai-assistant" / "api") render labeled chips instead of email
  // initials so the operator can tell automation/API sends apart.
  // Outbound rows with no sent_by_email come from MESSAGES_UPSERT
  // events fired by Evolution when the operator types directly into
  // WhatsApp on the linked phone — surface those with a "PHONE" chip so
  // dashboard reviewers know who actually wrote them.
  const senderEmail = message.sent_by_email ?? null;
  // Templates with no sent_by_email are virtually always API-driven
  // (external integrators like n8n hit the v1 endpoint without a
  // dashboard auth context, so they can't stamp a user). Treat that as
  // a stronger "API" signal than the "WA" (= typed on the linked phone)
  // fallback we use for plain text without an email.
  const senderKind: "human" | "ai" | "api" | "phone" | null = !isOut
    ? null
    : senderEmail === "ai-assistant"
      ? "ai"
      : senderEmail === "api" || senderEmail?.startsWith("api:")
        ? "api"
        : senderEmail
          ? "human"
          : isTemplate
            ? "api"
            : "phone";
  // Per-message check — only THIS specific message is from the CSV
  // backfill, not "every inbound message on an imported contact".
  // /api/import/chats/batch synthesises wamids with the literal
  // `import:` prefix so we can pick them out cleanly. Live webhook
  // messages get real wamids and won't trigger the marker even when
  // the contact itself has imported history.
  const isImportedMessage =
    !isOut &&
    typeof message.wa_message_id === "string" &&
    message.wa_message_id.startsWith("import:");

  const senderAvatar = !isOut ? (
    // Inbound (customer) side. Past-chat marker only fires for the
    // imported rows themselves — live inbound from the same contact
    // shows clean (no icon) so the operator sees at a glance which
    // bubble came from the live thread vs. backfill.
    isImportedMessage ? (
      <div
        title="Imported chat history — past conversation"
        className="shrink-0 self-end"
      >
        <div className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-slate-500 shadow-sm ring-2 ring-white">
          <History className="h-3 w-3" />
        </div>
      </div>
    ) : null
  ) : senderKind === "ai" ? (
      <SenderBadge
        label="AUTO"
        tooltipTitle="Sent by"
        tooltipBody="Automation"
        tone="violet"
      />
    ) : senderKind === "api" ? (
      <SenderBadge
        label="API"
        tooltipTitle="Sent via API"
        tooltipBody={
          (senderEmail && senderEmail.startsWith("api:")
            ? senderEmail.slice(4)
            : "API integration") +
          (apiCreatorName ? ` · by ${apiCreatorName}` : "")
        }
        tone="sky"
      />
    ) : senderKind === "human" && senderEmail ? (
      <SenderBadge
        label={senderInitialsOf(senderEmail)}
        tooltipTitle="Sent by"
        tooltipBody={senderName || senderEmail}
        tone="emerald"
      />
    ) : senderKind === "phone" ? (
      <SenderBadge
        label="WA"
        tooltipTitle="Sent from"
        tooltipBody={businessNumberName?.trim() || "WhatsApp app on the linked phone"}
        tone="amber"
      />
    ) : null;

  // ---------- Template messages: dedicated card layout ----------
  // Faithful reproduction of what the customer sees on WhatsApp — header
  // image (with brand frame), body, footer line, action buttons. Outbound
  // also shows a sender avatar with hover tooltip on the side.
  if (isTemplate) {
    const buttons = message.template_buttons ?? null;

    const card = (
      <div
        className={cn(
          "max-w-[78%] overflow-hidden rounded-2xl bg-white shadow-sm ring-1",
          isOut ? "ring-emerald-300 rounded-br-sm" : "ring-border rounded-bl-sm",
          failed && "ring-rose-300",
        )}
      >
        {/* Header media wrapped in a soft emerald frame. The image always
            fills the bubble width and height auto-scales — no cropping, no
            letterbox padding, regardless of source aspect ratio. Photos
            render as natural rectangles, square logos render as a full-width
            square. Matches the format the user wants in the chat thread. */}
        {message.media_url ? (
          <div className="p-2">
            {(message.media_mime_type ?? "").startsWith("video/") ? (
              <video
                src={message.media_url}
                controls
                className="block w-full max-h-96 overflow-hidden rounded-lg object-contain ring-2 ring-emerald-400/80"
              />
            ) : (message.media_mime_type ?? "").startsWith("application/") ? (
              <a
                href={message.media_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-lg ring-2 ring-emerald-400/80 bg-white px-3 py-2 text-xs font-medium text-emerald-800 transition hover:ring-emerald-500"
              >
                📄 Open document
              </a>
            ) : (
              <button
                type="button"
                onClick={() => setPreviewing(true)}
                className="block w-full overflow-hidden rounded-lg ring-2 ring-emerald-400/80 bg-white transition hover:ring-emerald-500"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={message.media_url}
                  alt="Template header"
                  className="block w-full max-h-96 object-cover"
                  loading="lazy"
                />
              </button>
            )}
          </div>
        ) : null}

        {/* Body */}
        <div className="px-3.5 py-2.5">
          {/* Group messages — show who in the group sent it. */}
          {!isOut && message.sender_name ? (
            <p className="mb-0.5 text-[11px] font-semibold text-emerald-700">
              {message.sender_name}
            </p>
          ) : null}
          <p
            className="whatsapp-md whitespace-pre-wrap break-words text-[13px] leading-relaxed text-gray-900"
            dangerouslySetInnerHTML={{
              __html: renderWhatsAppMarkdown(interaktTemplatePreview(message.content) || ""),
            }}
          />
        </div>

        {/* Template footer line (small print: "Type STOP to Unsubscribe", etc.) */}
        {message.template_footer ? (
          <div className="px-3.5 pb-2 text-[10px] italic text-gray-500">
            {message.template_footer}
          </div>
        ) : null}

        {/* Action buttons — Reply Now / URL / Phone / Copy code */}
        {buttons && buttons.length > 0 ? (
          <div className="border-t border-gray-100">
            {buttons.map((b, idx) => (
              <TemplateButton key={`${b.type}-${idx}`} button={b} />
            ))}
          </div>
        ) : null}

        {/* Status strip — template badge + time + ticks */}
        <div
          className={cn(
            "flex items-center justify-between gap-2 border-t px-3 py-1.5 text-[10px]",
            isOut
              ? "border-emerald-100/80 bg-emerald-50/60"
              : "border-border/60 bg-secondary/40",
          )}
        >
          <span className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide text-emerald-700">
            <ClipboardList className="h-3 w-3" />
            Template
          </span>
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <span>{formatTime(message.timestamp)}</span>
            {isOut ? <StatusTicks status={message.status} failed={failed} /> : null}
            {isOut && senderName ? <span className="ml-0.5">· {senderName}</span> : null}
          </span>
        </div>

        {/* Failed inline error */}
        {failed && message.error_message ? (
          <div className="flex items-start gap-1.5 border-t border-rose-200 bg-rose-50 px-3 py-2 text-[10px] text-rose-900">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="leading-snug">{message.error_message}</span>
          </div>
        ) : null}
      </div>
    );

    return (
      <>
        <div className={cn("flex w-full items-end gap-2", isOut ? "justify-end" : "justify-start")}>
          {card}
          {senderAvatar}
        </div>

        {previewing && resolveDisplayableMediaUrl(message) ? (
          <MediaLightbox
            url={resolveDisplayableMediaUrl(message)!}
            mime={message.media_mime_type ?? "image/*"}
            filename={message.content ?? undefined}
            onClose={() => setPreviewing(false)}
          />
        ) : null}
      </>
    );
  }

  // ---------- Call Permission Request bubble ----------
  // Outbound rows we synthesize when the operator clicks "WhatsApp
  // Call". Mirrors the look of WhatsApp's own permission card but
  // with our copy — the user's phone is what actually shows the
  // tappable Allow button.
  if (message.type === "call_permission_request") {
    const card = (
      <div
        className={cn(
          "max-w-[80%] overflow-hidden rounded-2xl border bg-card text-sm shadow-sm",
          isOut ? "rounded-br-sm" : "rounded-bl-sm",
        )}
      >
        <div className="flex items-center gap-2.5 border-b bg-gradient-to-br from-emerald-500 to-emerald-600 px-3.5 py-2.5 text-white">
          <PhoneCall className="h-4 w-4" />
          <div className="text-[11px] font-semibold uppercase tracking-wider">
            Call permission request
          </div>
        </div>
        <div className="px-3.5 py-3">
          <p className="whitespace-pre-wrap break-words leading-relaxed text-foreground">
            {message.content || "WhatsApp call permission requested."}
          </p>
          <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-800">
            The client sees an &quot;Allow&quot; button on their WhatsApp. Once they tap it, the call rings on this device.
          </div>
        </div>
        <div
          className={cn(
            "flex items-center justify-end gap-1 border-t bg-secondary/40 px-3 py-1 text-[10px]",
            "text-muted-foreground",
          )}
        >
          <span>{formatTime(message.timestamp)}</span>
          {isOut ? <StatusTicks status={message.status} failed={failed} /> : null}
          {isOut && senderName ? <span className="ml-0.5">· {senderName}</span> : null}
        </div>
        {failed && message.error_message ? (
          <div className="flex items-start gap-1.5 border-t border-rose-200 bg-rose-50 px-3 py-2 text-[10px] text-rose-900">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="leading-snug">{message.error_message}</span>
          </div>
        ) : null}
      </div>
    );
    return (
      <div className={cn("flex w-full items-end gap-2", isOut ? "justify-end" : "justify-start")}>
        {card}
        {senderAvatar}
      </div>
    );
  }

  // ---------- Call Permission Reply bubble ----------
  // Inbound row the webhook synthesizes when the client taps "Allow"
  // (or "Decline") on a WhatsApp Call Permission Request. Mirrors the
  // request bubble but accept = green, reject = rose.
  if (message.type === "call_permission_reply") {
    const granted = !message.content?.startsWith("🚫");
    const card = (
      <div
        className={cn(
          "max-w-[80%] overflow-hidden rounded-2xl border bg-card text-sm shadow-sm",
          isOut ? "rounded-br-sm" : "rounded-bl-sm",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-2.5 border-b px-3.5 py-2.5 text-white",
            granted
              ? "bg-gradient-to-br from-emerald-500 to-emerald-600"
              : "bg-gradient-to-br from-rose-500 to-rose-600",
          )}
        >
          <PhoneCall className="h-4 w-4" />
          <div className="text-[11px] font-semibold uppercase tracking-wider">
            {granted ? "Permission granted" : "Permission denied"}
          </div>
        </div>
        <div className="px-3.5 py-3">
          <p className="whitespace-pre-wrap break-words leading-relaxed text-foreground">
            {message.content ||
              (granted
                ? "Client granted call permission."
                : "Client denied call permission.")}
          </p>
        </div>
        <div className="flex items-center justify-end gap-1 border-t bg-secondary/40 px-3 py-1 text-[10px] text-muted-foreground">
          <span>{formatTime(message.timestamp)}</span>
        </div>
      </div>
    );
    return (
      <div className={cn("flex w-full items-end gap-2", isOut ? "justify-end" : "justify-start")}>
        {card}
        {senderAvatar}
      </div>
    );
  }

  // ---------- Regular text + media bubbles ----------
  // Quoted-reply header + "edited" footer live INSIDE the bubble so the
  // bubble sizes naturally to its widest content. Putting them in an
  // outer wrapper with max-w confused the flex sizing and made short
  // bubbles wrap to one character per line.
  // `position: relative` so the hover-action overlay can absolute-
  // position to the bubble's corner. `max-w-[75%]` here works because
  // the bubble is a direct child of the flex row (which has a definite
  // width). An earlier attempt wrapped this in another `relative` div
  // and broke that resolution — bubble's max-w became indeterminate
  // and short text collapsed to one character per line.
  const regularBubble = (
    <div
      className={cn(
        "relative max-w-[75%] rounded-2xl text-sm leading-relaxed",
        isSticker
          ? "bg-transparent !shadow-none !ring-0 !border-0 !p-0"
          : isOut
            ? failed
              ? "bubble-failed text-rose-900 rounded-br-sm px-3.5 py-2"
              : "bubble-out text-emerald-950 rounded-br-sm px-3.5 py-2"
            : "bubble-in bg-card text-foreground border border-slate-300 rounded-bl-sm px-3.5 py-2",
        isMedia && !isSticker && "px-2 py-2",
        // Location map card hugs the bubble edge (WhatsApp-style). No
        // overflow-hidden here — the LocationCard clips its own rounded
        // corners, and clipping at the bubble level would also cut off
        // the Reply hover-action anchored at -top-3 (it sits outside the
        // bubble's top edge).
        loc && "p-1",
      )}
    >
      {/* Hover-action overlay — absolute, anchored to the bubble's
          top corner. Outbound = top-right (outside the bubble's right
          edge); inbound = top-left. Reveals on parent group hover. */}
      {onReply ? (
        <BubbleActions
          message={message}
          isOut={isOut}
          onReply={onReply}
        />
      ) : null}
      {message.reply_to_wa_message_id ? (
        <QuotedReplyInline
          content={message.reply_to_content}
          direction={message.reply_to_direction ?? null}
          parentIsOut={isOut}
        />
      ) : null}
      {loc ? (
        <LocationCard lat={loc.lat} lng={loc.lng} label={loc.label} isOut={isOut} />
      ) : isLocation ? (
        <p className="whitespace-pre-wrap break-words">{message.content || "📍 Location"}</p>
      ) : isText ? (
        message.content ? (
          <p
            className="whatsapp-md whitespace-pre-wrap break-words"
            dangerouslySetInnerHTML={{
              __html: renderWhatsAppMarkdown(interaktTemplatePreview(message.content)),
            }}
          />
        ) : (
          <p className="whitespace-pre-wrap break-words italic opacity-80">
            [{message.type}]
          </p>
        )
      ) : isMedia ? (
        <MediaContent message={message} onPreview={() => setPreviewing(true)} />
      ) : isReaction ? (
        message.content ? (
          <p className="flex items-center gap-1.5 break-words">
            <span className="text-2xl leading-none">{message.content}</span>
            <span className="text-[11px] italic opacity-60">Reacted</span>
          </p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-xs italic opacity-60">Reaction</p>
        )
      ) : (
        <p className="whitespace-pre-wrap break-words italic opacity-80">[{message.type}]</p>
      )}
      <div
        className={cn(
          "mt-1 flex items-center justify-end gap-1 text-[10px] px-1.5",
          isOut ? (failed ? "text-rose-800" : "text-emerald-900/70") : "text-muted-foreground",
        )}
      >
        <span>{formatTime(message.timestamp)}</span>
        {isOut ? <StatusTicks status={message.status} failed={failed} /> : null}
        {isOut && senderName ? <span className="ml-0.5">· {senderName}</span> : null}
      </div>
      {failed && message.error_message ? (
        <div className="mt-1.5 flex items-start gap-1.5 rounded-md border border-rose-300/60 bg-white/60 px-2 py-1 text-[10px] text-rose-900">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="leading-snug">{message.error_message}</span>
        </div>
      ) : null}
      {/* Interactive reply buttons (non-template sends) — show the same
          tappable-button look the client received on WhatsApp. */}
      {!isTemplate && message.template_buttons && message.template_buttons.length > 0 ? (
        <div className="mt-1.5 space-y-1 border-t border-emerald-100/70 pt-1.5">
          {message.template_buttons.map((b, idx) => (
            <div
              key={`${b.text ?? "btn"}-${idx}`}
              className="flex items-center justify-center gap-1.5 rounded-md bg-white/70 px-2 py-1 text-[12px] font-medium text-emerald-700"
            >
              <Reply className="h-3 w-3" />
              {b.text || `Button ${idx + 1}`}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );

  // Outer flex row owns alignment + the hover `group`. Bubble sits
  // inline next to senderAvatar.
  return (
    <>
      <div
        className={cn(
          "group flex w-full items-end gap-2",
          isOut ? "justify-end" : "justify-start",
        )}
      >
        {/* Inbound avatar sits on the outer (left) edge; outbound on
            the right — matches the WhatsApp layout. */}
        {!isOut ? senderAvatar : null}
        {regularBubble}
        {isOut ? senderAvatar : null}
      </div>

      {previewing && resolveDisplayableMediaUrl(message) ? (
        <MediaLightbox
          url={resolveDisplayableMediaUrl(message)!}
          // Mime can be empty (Evolution media). Fall back to the message
          // type so the lightbox still picks the image/video renderer
          // instead of the white-box <iframe> fallback.
          mime={
            message.media_mime_type ||
            (message.type === "image"
              ? "image/*"
              : message.type === "video"
                ? "video/*"
                : message.type === "sticker"
                  ? "image/*"
                  : "")
          }
          filename={message.content ?? undefined}
          onClose={() => setPreviewing(false)}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Quoted-reply snippet rendered INSIDE the bubble at the top — looks
// exactly like WhatsApp's quote rendering (left-tinted border + dimmed
// sender label + snippet).
// ---------------------------------------------------------------------------
function QuotedReplyInline({
  content,
  direction,
  parentIsOut,
}: {
  content: string | null | undefined;
  direction: "inbound" | "outbound" | null;
  parentIsOut: boolean;
}) {
  const label =
    direction === "outbound" ? "You" : direction === "inbound" ? "Customer" : "Message";
  return (
    <div
      className={cn(
        "mb-1 overflow-hidden rounded-md border-l-4 px-2 py-1 text-[11px]",
        direction === "outbound" ? "border-emerald-500" : "border-sky-500",
        parentIsOut ? "bg-emerald-100/60" : "bg-secondary/70",
      )}
    >
      <div className="font-semibold text-foreground/80">{label}</div>
      <div className="line-clamp-2 whitespace-pre-wrap break-words text-foreground/65">
        {content?.trim() || <span className="italic">[no preview]</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Floating hover-actions bar — single Reply button anchored just
// outside the bubble's TOP corner. Reveals on bubble hover via
// group-hover. Edit/Delete removed: Cloud API supports neither.
// ---------------------------------------------------------------------------
function BubbleActions({
  message,
  isOut,
  onReply,
}: {
  message: Message;
  isOut: boolean;
  onReply: (msg: Message) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Edit / Delete only make sense for our own (outbound) sends. WhatsApp
  // Cloud API doesn't support either reliably, but Baileys (Evolution)
  // does — so we gate the buttons by checking the synthetic `evo:` prefix
  // on business_phone_number_id. Edit additionally requires text type +
  // not yet deleted + within the 15-min WhatsApp window.
  const isEvolutionMsg =
    typeof message.business_phone_number_id === "string" &&
    message.business_phone_number_id.startsWith("evo:");
  const ageMin = (Date.now() - new Date(message.timestamp).getTime()) / 60_000;
  const canEdit =
    isOut &&
    isEvolutionMsg &&
    message.type === "text" &&
    !message.deleted_at &&
    message.status !== "failed" &&
    ageMin < 15;
  const canDelete =
    isOut && isEvolutionMsg && !message.deleted_at && message.status !== "failed";

  return (
    <>
      <div
        className={cn(
          "pointer-events-none absolute -top-3 z-10 inline-flex items-center gap-0.5 rounded-full border bg-card px-1 py-0.5 opacity-0 shadow-md ring-1 ring-black/5 transition group-hover:pointer-events-auto group-hover:opacity-100",
          isOut ? "right-2" : "left-2",
        )}
      >
        <button
          type="button"
          onClick={() => onReply(message)}
          title="Reply"
          aria-label="Reply"
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <Reply className="h-3 w-3" />
        </button>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="Edit (within 15 min)"
            aria-label="Edit"
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <Pencil className="h-3 w-3" />
          </button>
        ) : null}
        {canDelete ? (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            title="Delete for everyone"
            aria-label="Delete"
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition hover:bg-rose-50 hover:text-rose-700"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      {editing ? (
        <EditMessageDialog
          message={message}
          onClose={() => setEditing(false)}
        />
      ) : null}
      {confirmingDelete ? (
        <DeleteConfirmChip
          message={message}
          isOut={isOut}
          onClose={() => setConfirmingDelete(false)}
        />
      ) : null}
    </>
  );
}

// Inline edit dialog — pops up over the bubble. Calls the existing
// /api/messages/[id]/edit route which is provider-aware (routes through
// Baileys for Evolution numbers, Meta Cloud for others).
function EditMessageDialog({
  message,
  onClose,
}: {
  message: Message;
  onClose: () => void;
}) {
  const [text, setText] = useState(message.content ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const trimmed = text.trim();
    if (!trimmed) {
      setErr("Message can't be empty");
      return;
    }
    if (trimmed === (message.content ?? "")) {
      onClose();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/messages/${message.id}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Edit failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="absolute right-0 top-full z-20 mt-1 w-72 rounded-lg border bg-card p-2.5 shadow-xl ring-1 ring-black/5"
    >
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Edit message
      </p>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={4096}
        disabled={busy}
        className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          if (e.key === "Escape") onClose();
        }}
      />
      {err ? (
        <p className="mt-1 text-[10px] text-rose-700">{err}</p>
      ) : null}
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="rounded-md border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-secondary"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Save
        </button>
      </div>
    </div>
  );
}

// Delete-for-everyone confirm chip — anchored to the bubble. Calls the
// existing DELETE /api/messages/[id] which routes through Baileys for
// Evolution messages.
function DeleteConfirmChip({
  message,
  isOut,
  onClose,
}: {
  message: Message;
  isOut: boolean;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/messages/${message.id}`, {
        method: "DELETE",
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className={cn(
        "absolute top-full z-20 mt-1 inline-flex items-center gap-1.5 rounded-full border bg-card px-2 py-1 text-[11px] shadow-xl ring-1 ring-black/5",
        isOut ? "right-0" : "left-0",
      )}
    >
      <span className="text-muted-foreground">Delete for everyone?</span>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded-full bg-rose-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
        Delete
      </button>
      <button
        type="button"
        onClick={onClose}
        disabled={busy}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary"
        aria-label="Cancel"
      >
        <X className="h-3 w-3" />
      </button>
      {err ? (
        <span className="ml-1 text-rose-700">{err}</span>
      ) : null}
    </div>
  );
}

/** Renders a single template button as it would appear in WhatsApp — full
 *  width, centered, emerald-tinted text on white. Display-only — these are
 *  what the customer sees and can tap; the dashboard view is read-only. */
function TemplateButton({
  button,
}: {
  button: { type: string; text?: string; url?: string; phone_number?: string; example?: unknown };
}) {
  let label = button.text ?? "";
  if (button.type === "URL") label = button.text ?? "Open link";
  else if (button.type === "PHONE_NUMBER") label = button.text ?? "Call";
  else if (button.type === "COPY_CODE") label = button.text ?? "Copy code";
  else if (button.type === "QUICK_REPLY") label = button.text ?? "Reply";
  return (
    <div className="border-t border-gray-100 px-3 py-2 text-center text-[12px] font-semibold text-emerald-700">
      {button.type === "URL" ? (
        <span className="inline-flex items-center gap-1">
          <span className="text-base">↗</span>
          {label}
        </span>
      ) : button.type === "PHONE_NUMBER" ? (
        <span className="inline-flex items-center gap-1">
          <span className="text-base">📞</span>
          {label}
        </span>
      ) : button.type === "COPY_CODE" ? (
        <span className="inline-flex items-center gap-1">
          <span className="text-base">⧉</span>
          {label}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1">
          <span className="text-base">↩</span>
          {label}
        </span>
      )}
    </div>
  );
}

function SenderBadge({
  label,
  tooltipTitle,
  tooltipBody,
  tone,
}: {
  label: string;
  tooltipTitle: string;
  tooltipBody: string;
  tone: "emerald" | "violet" | "sky" | "amber";
}) {
  const palette: Record<typeof tone, string> = {
    emerald:
      "bg-gradient-to-br from-emerald-100 to-emerald-200 text-emerald-800",
    violet:
      "bg-gradient-to-br from-violet-100 to-violet-200 text-violet-800",
    sky: "bg-gradient-to-br from-sky-100 to-sky-200 text-sky-800",
    amber:
      "bg-gradient-to-br from-amber-100 to-amber-200 text-amber-900",
  };
  return (
    <div className="group/sender relative shrink-0 self-end">
      <div
        className={cn(
          "inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold shadow-sm ring-2 ring-white",
          palette[tone],
        )}
      >
        {label}
      </div>
      <span
        className={cn(
          "pointer-events-none absolute bottom-full right-0 mb-2 z-50",
          "hidden whitespace-nowrap rounded-lg bg-card px-2.5 py-1.5 text-[10px] font-medium text-foreground/80",
          "shadow-lg ring-1 ring-border",
          "group-hover/sender:block",
        )}
      >
        <span className="block text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          {tooltipTitle}
        </span>
        {tooltipBody}
        <span
          aria-hidden
          className="absolute right-2 top-full -mt-px inline-block h-1.5 w-1.5 rotate-45 border-b border-r border-border bg-card"
        />
      </span>
    </div>
  );
}

function senderInitialsOf(emailOrName: string | null | undefined): string {
  if (!emailOrName) return "··";
  const local = emailOrName.replace(/@.*$/, "");
  const parts = local.replace(/[._]/g, " ").trim().split(/\s+/);
  if (parts.length >= 2 && parts[0][0] && parts[1][0]) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

