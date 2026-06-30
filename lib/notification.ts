// Lightweight client-side notification helpers — no audio files, no deps.
// Generates a soft two-note chime via Web Audio. Mute preference is persisted
// in localStorage so it survives reloads.

const MUTE_KEY = "qht-sound-muted";
const MIN_INTERVAL_MS = 1200; // de-dupe rapid pings (ContactList + ChatWindow can both fire)

let lastPlayedAt = 0;

// Browsers require a user gesture before AudioContext can play. We lazily
// create the context on first ping; if the page hasn't been interacted with
// it'll throw silently which is fine (most modern browsers allow it after
// any click/keypress, and the user has clicked through login/contact already).
let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (audioCtx) return audioCtx;
  try {
    const Ctor = window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
    return audioCtx;
  } catch {
    return null;
  }
}

export function isSoundMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSoundMuted(muted: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    /* ignore quota errors */
  }
}

/**
 * Play the new-message chime. Respects mute, dedupes if called within 1.2s of
 * the previous ping, and silently no-ops if Web Audio isn't available.
 */
export function playMessagePing(): void {
  if (isSoundMuted()) return;
  const now = Date.now();
  if (now - lastPlayedAt < MIN_INTERVAL_MS) return;
  lastPlayedAt = now;

  const ctx = getCtx();
  if (!ctx) return;

  // Some browsers create the context in a "suspended" state until a user
  // gesture has occurred. Try to resume — best-effort, ignore failures.
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  const t0 = ctx.currentTime;
  // Two-note chime: B5 → E6 (clean, friendly, not alarming).
  [
    { freq: 987.77, start: 0,    dur: 0.16 },
    { freq: 1318.5, start: 0.07, dur: 0.22 },
  ].forEach((tone) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = tone.freq;
    const start = t0 + tone.start;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.18, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, start + tone.dur);
    osc.start(start);
    osc.stop(start + tone.dur + 0.02);
  });
}
