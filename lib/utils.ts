import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Pulls the first image out of a paste/drop DataTransfer, or null if there
// isn't one. Used by the composer + Magic Message dialog so a copied
// screenshot can be pasted straight in instead of going through a file
// picker. Checks `files` first (most browsers), then scans `items`.
export function imageFromClipboard(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  for (const f of Array.from(dt.files)) {
    if (f.type.startsWith("image/")) return f;
  }
  for (const it of Array.from(dt.items)) {
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

// Long-form relative time labels — matches the WhatsApp-style chat list
// reference: "16 mins", "4 hrs", "1 day". Singular/plural handled
// explicitly so we never end up with "1 mins".
export function formatRelativeTime(date: Date | string | null): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin === 1) return "1 min";
  if (diffMin < 60) return `${diffMin} mins`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr === 1) return "1 hr";
  if (diffHr < 24) return `${diffHr} hrs`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays === 1) return "1 day";
  if (diffDays < 7) return `${diffDays} days`;
  return d.toLocaleDateString();
}
