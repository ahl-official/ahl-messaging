"use client";

// Avatar with click-to-upload + remove affordances. Renders the
// uploaded photo when present, falls back to initials. Hover surfaces
// a camera badge to make the interaction discoverable. Used in the
// contact-details panel header — mirrors into ContactList rows the
// next time the contact is fetched (avatar_url on the contacts row).

import { memo, useEffect, useRef, useState } from "react";
import { Camera, Loader2, X } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  emitAvatarChanged,
  subscribeAvatarChanged,
} from "@/lib/avatar-events";
import { MediaLightbox } from "@/components/MediaLightbox";

interface Props {
  contactId: string;
  avatarUrl: string | null;
  initials: string;
  /** Visual size of the avatar — tweak only if a parent really needs a
   *  different scale; default is the standard panel-header size. */
  size?: number;
}

function ContactAvatarUploaderImpl({
  contactId,
  avatarUrl,
  initials,
  size = 48,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  // Local override for instant UX — server result lands on the row via
  // router refresh, but we don't want a 1s "loading" stutter.
  const [localUrl, setLocalUrl] = useState<string | null>(avatarUrl);
  const [error, setError] = useState<string | null>(null);
  // Click on the avatar = view full-size; click on the camera badge =
  // change. Operators were accidentally triggering the file picker just
  // by clicking the profile photo, which felt destructive.
  const [previewing, setPreviewing] = useState(false);

  // Re-sync from prop when the parent's avatarUrl changes (realtime
  // update from another tab, an "auto-set first photo" stamp, etc.).
  // Only updates when not in the middle of an upload to avoid clobbering
  // the operator's in-flight intent.
  useEffect(() => {
    if (!busy) setLocalUrl(avatarUrl);
  }, [avatarUrl, busy]);

  const openPicker = () => {
    if (busy) return;
    inputRef.current?.click();
  };
  // Avatar click → open the lightbox when there's a photo to view.
  // When no photo is set yet, fall back to opening the file picker so
  // the empty avatar still surfaces an obvious add-photo affordance.
  const onAvatarClick = () => {
    if (busy) return;
    if (localUrl) setPreviewing(true);
    else openPicker();
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/contacts/${contactId}/avatar`, {
        method: "POST",
        body: fd,
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        avatar_url?: string;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      const next = json.avatar_url ?? null;
      setLocalUrl(next);
      emitAvatarChanged({ contactId, avatarUrl: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    if (!localUrl) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${contactId}/avatar`, {
        method: "DELETE",
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setLocalUrl(null);
      emitAvatarChanged({ contactId, avatarUrl: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  };

  // Pick a deterministic gradient based on the initials so two
  // contacts in the same inbox don't share the exact same avatar tint.
  // Premium SaaS avatars (Linear / Notion) do this — keeps the empty
  // state visually richer than a single uniform colour.
  const seed = (initials || "?").charCodeAt(0) || 0;
  const palettes: Array<[string, string]> = [
    ["from-emerald-400", "to-emerald-700"],
    ["from-sky-400", "to-indigo-700"],
    ["from-fuchsia-400", "to-rose-600"],
    ["from-amber-400", "to-orange-600"],
    ["from-violet-400", "to-purple-700"],
    ["from-teal-400", "to-cyan-700"],
  ];
  const [from, to] = palettes[seed % palettes.length];
  // Larger initials when the avatar size grows; keeps them centred &
  // legible at every size we render.
  const initialFontPx = Math.max(13, Math.round(size * 0.42));
  // Shrink the displayed initials to 2 chars max — "MOH" inside a
  // 48px circle gets cramped; "MO" reads cleaner.
  const displayInitials = (initials || "?").slice(0, 2).toUpperCase();

  return (
    <div className="relative group shrink-0" style={{ width: size, height: size }}>
      {/* Render path forks on `localUrl`. With Radix Avatar the
          fallback occasionally lagged for ~600ms after a Remove click
          (loading-state context hangover), leaving an empty grey
          circle. Doing the fork ourselves means initials render
          instantly on mount and on remove — no flicker. */}
      {localUrl ? (
        <Avatar
          className="ring-2 ring-white shadow-md"
          style={{ width: size, height: size }}
        >
          <AvatarImage src={localUrl} alt="" />
          <AvatarFallback
            className={`bg-gradient-to-br ${from} ${to} font-semibold text-white`}
            style={{ fontSize: initialFontPx }}
          >
            {displayInitials}
          </AvatarFallback>
        </Avatar>
      ) : (
        <div
          className={`relative flex items-center justify-center overflow-hidden rounded-full bg-gradient-to-br ${from} ${to} font-semibold tracking-tight text-white shadow-md ring-2 ring-white`}
          style={{ width: size, height: size, fontSize: initialFontPx }}
          aria-label={`Avatar for ${initials}`}
        >
          {/* Subtle inner highlight — gives the flat gradient circle a
              touch of depth so it reads as a polished UI element
              instead of a coloured dot. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full"
            style={{
              background:
                "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.35), transparent 55%)",
            }}
          />
          <span className="relative">{displayInitials}</span>
        </div>
      )}

      {/* Full-bleed click target → opens lightbox when there's a photo,
          falls back to file picker when empty. */}
      <button
        type="button"
        onClick={onAvatarClick}
        disabled={busy}
        aria-label={localUrl ? "View photo full size" : "Upload photo"}
        title={localUrl ? "View photo" : "Upload photo"}
        className="absolute inset-0 cursor-pointer rounded-full focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:cursor-not-allowed"
      />

      {/* Change-photo badge — clickable camera pill at bottom-right.
          Visible by default at low opacity, pops on hover (and is
          always pointer-events-auto now so it doesn't collide with
          the view-photo click target). Stops propagation so the
          underlying avatar click doesn't also fire. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          openPicker();
        }}
        disabled={busy}
        aria-label={localUrl ? "Change photo" : "Upload photo"}
        title={localUrl ? "Change photo" : "Upload photo"}
        className="absolute -bottom-0.5 -right-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-foreground/85 text-white shadow-sm transition hover:bg-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
        ) : (
          <Camera className="h-2.5 w-2.5" />
        )}
      </button>

      {/* Remove button — only when a photo exists and we're not in a
          mid-upload state. Pinned to top-right. Click → fall back to
          initials immediately (no flicker, see fork above). */}
      {localUrl && !busy ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void remove();
          }}
          aria-label="Remove photo"
          title="Remove photo"
          className="absolute -right-1 -top-1 inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-rose-500 text-white opacity-0 shadow-sm transition-opacity hover:bg-rose-600 group-hover:opacity-100 focus:opacity-100"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      ) : null}

      {previewing && localUrl ? (
        <MediaLightbox
          url={localUrl}
          mime="image/jpeg"
          onClose={() => setPreviewing(false)}
        />
      ) : null}

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
        onChange={onFile}
        className="hidden"
      />

      {error ? (
        <div
          className="absolute left-0 top-full z-10 mt-1 whitespace-nowrap rounded bg-destructive px-2 py-0.5 text-[10px] text-white shadow-sm"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

// Memoised so the realtime contact-update firehose (last_message_at,
// unread_count, etc. all bumping every webhook tick) doesn't trigger
// an avatar re-render. Default shallow-equals on props is enough —
// we only care about contactId / avatarUrl / initials / size, all
// primitives. Stops the camera-badge "blink" the operator was seeing.
export const ContactAvatarUploader = memo(ContactAvatarUploaderImpl);
