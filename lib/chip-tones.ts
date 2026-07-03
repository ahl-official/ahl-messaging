// Deterministic colour mapping for the inbox chat-card chips.
//
// Both the CRM stage pill and the WhatsApp-number pill used to render
// in the same violet tone, which made the row a wall of identical
// chips when an operator scrolled. Each label now gets its own
// distinct tone — same input always picks the same colour, so the
// operator can spot a stage / number visually without reading the
// text.
//
// We pre-curate the most common pipeline stages so they land on
// well-known colours (e.g. "Surgery date awaited" → emerald). Anything
// outside the map falls back to a stable hash of the string.

export interface ChipTone {
  bg: string;       // tailwind class for chip background
  text: string;     // tailwind class for chip foreground
  ring: string;     // tailwind class for inset ring
  dot: string;      // tailwind class for the small accent dot
}

// Palette — keep these in sync with the rest of the dashboard's
// emerald/sky/violet/amber/rose/teal/indigo/orange family so nothing
// looks out of place.
export const CHIP_TONE_KEYS = [
  "emerald",
  "sky",
  "violet",
  "amber",
  "rose",
  "teal",
  "indigo",
  "orange",
  "lime",
  "fuchsia",
  "cyan",
  "slate",
] as const;
export type ChipToneKey = (typeof CHIP_TONE_KEYS)[number];

export const CHIP_TONES: Record<ChipToneKey, ChipTone> = {
  emerald: {
    bg: "bg-emerald-50",
    text: "text-emerald-800",
    ring: "ring-emerald-200",
    dot: "bg-emerald-500",
  },
  sky: {
    bg: "bg-sky-50",
    text: "text-sky-800",
    ring: "ring-sky-200",
    dot: "bg-sky-500",
  },
  violet: {
    bg: "bg-violet-50",
    text: "text-violet-800",
    ring: "ring-violet-200",
    dot: "bg-violet-500",
  },
  amber: {
    bg: "bg-amber-50",
    text: "text-amber-800",
    ring: "ring-amber-200",
    dot: "bg-amber-500",
  },
  rose: {
    bg: "bg-rose-50",
    text: "text-rose-800",
    ring: "ring-rose-200",
    dot: "bg-rose-500",
  },
  teal: {
    bg: "bg-teal-50",
    text: "text-teal-800",
    ring: "ring-teal-200",
    dot: "bg-teal-500",
  },
  indigo: {
    bg: "bg-indigo-50",
    text: "text-indigo-800",
    ring: "ring-indigo-200",
    dot: "bg-indigo-500",
  },
  orange: {
    bg: "bg-orange-50",
    text: "text-orange-800",
    ring: "ring-orange-200",
    dot: "bg-orange-500",
  },
  lime: {
    bg: "bg-lime-50",
    text: "text-lime-800",
    ring: "ring-lime-200",
    dot: "bg-lime-500",
  },
  fuchsia: {
    bg: "bg-fuchsia-50",
    text: "text-fuchsia-800",
    ring: "ring-fuchsia-200",
    dot: "bg-fuchsia-500",
  },
  cyan: {
    bg: "bg-cyan-50",
    text: "text-cyan-800",
    ring: "ring-cyan-200",
    dot: "bg-cyan-500",
  },
  slate: {
    bg: "bg-slate-100",
    text: "text-slate-700",
    ring: "ring-slate-200",
    dot: "bg-slate-500",
  },
};

// Vivid, solid fills — same hue family as CHIP_TONES but saturated,
// for surfaces that should pop (the inbox lead-stage funnel). Text is
// hand-picked per tone for contrast: white on dark fills, near-black
// on the bright amber/lime where white would wash out.
export interface SolidTone {
  bg: string;
  text: string;
}
// `bg` is a vertical gradient (light top → deep bottom) so a flat
// chevron reads as a moulded, 3-D segment.
export const SOLID_TONES: Record<ChipToneKey, SolidTone> = {
  emerald: { bg: "bg-gradient-to-b from-emerald-400 to-emerald-600", text: "text-white" },
  sky: { bg: "bg-gradient-to-b from-sky-400 to-sky-600", text: "text-white" },
  violet: { bg: "bg-gradient-to-b from-violet-400 to-violet-600", text: "text-white" },
  amber: { bg: "bg-gradient-to-b from-amber-300 to-amber-500", text: "text-amber-950" },
  rose: { bg: "bg-gradient-to-b from-rose-400 to-rose-600", text: "text-white" },
  teal: { bg: "bg-gradient-to-b from-teal-400 to-teal-600", text: "text-white" },
  indigo: { bg: "bg-gradient-to-b from-indigo-400 to-indigo-600", text: "text-white" },
  orange: { bg: "bg-gradient-to-b from-orange-400 to-orange-600", text: "text-white" },
  lime: { bg: "bg-gradient-to-b from-lime-300 to-lime-500", text: "text-lime-950" },
  fuchsia: { bg: "bg-gradient-to-b from-fuchsia-400 to-fuchsia-600", text: "text-white" },
  cyan: { bg: "bg-gradient-to-b from-cyan-400 to-cyan-600", text: "text-white" },
  slate: { bg: "bg-gradient-to-b from-slate-400 to-slate-600", text: "text-white" },
};

// Curated mapping of common LSQ pipeline stages → tones. Anything
// outside falls through to the hash. Lowercase + collapsed-whitespace
// keys so user-entered casing/spacing variants still hit.
const STAGE_TONE_OVERRIDES: Record<string, ChipToneKey> = {
  new: "sky",
  open: "sky",
  contacted: "sky",
  qualified: "indigo",
  "follow up": "amber",
  "follow-up": "amber",
  followup: "amber",
  "ht care follow up": "amber",
  "consultation scheduled": "violet",
  "consultation done": "violet",
  "photos received": "violet",
  "surgery date awaited": "emerald",
  "surgery scheduled": "emerald",
  "surgery done": "teal",
  "ht done": "teal",
  closed: "slate",
  lost: "rose",
  dnp: "rose",
  unqualified: "rose",
  "not interested": "rose",
  "rate revealed": "fuchsia",
  "price quoted": "fuchsia",
};

// FNV-1a — small, fast, well-distributed for short strings.
function hashKey(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}

/** Pick a stable tone for an arbitrary string. */
export function toneForKey(input: string | null | undefined): ChipTone {
  if (!input) return CHIP_TONES.slate;
  const idx = hashKey(input) % CHIP_TONE_KEYS.length;
  return CHIP_TONES[CHIP_TONE_KEYS[idx]];
}

/** The tone KEY for an CRM stage — curated override first, else hash.
 *  Shared by the pastel `toneForStage` and the vivid `solidToneForStage`
 *  so a stage keeps the same hue in both. */
export function stageToneKey(stage: string | null | undefined): ChipToneKey {
  if (!stage) return "slate";
  const norm = stage.toLowerCase().trim().replace(/\s+/g, " ");
  const override = STAGE_TONE_OVERRIDES[norm];
  if (override) return override;
  return CHIP_TONE_KEYS[hashKey(stage) % CHIP_TONE_KEYS.length];
}

/** Pick a tone for an CRM stage. Uses the curated overrides first,
 *  falls back to the hash. */
export function toneForStage(stage: string | null | undefined): ChipTone {
  return CHIP_TONES[stageToneKey(stage)];
}

/** Vivid solid fill for an CRM stage — same hue as `toneForStage`. */
export function solidToneForStage(stage: string | null | undefined): SolidTone {
  return SOLID_TONES[stageToneKey(stage)];
}

/** Solid fill for the Nth pipeline stage. Index-based (not hashed) so
 *  adjacent funnel segments always land on different hues — the hash
 *  picker clustered too many stages onto the same green. */
export function solidToneByIndex(i: number): SolidTone {
  const n = CHIP_TONE_KEYS.length;
  return SOLID_TONES[CHIP_TONE_KEYS[((i % n) + n) % n]];
}

/** Pick a tone for a WhatsApp number — keyed on the immutable
 *  phone_number_id so it stays consistent even if the nickname /
 *  verified name changes. */
export function toneForNumber(phoneNumberId: string | null | undefined): ChipTone {
  return toneForKey(phoneNumberId);
}
