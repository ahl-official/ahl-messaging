// Module-level state machine for the "post status to N numbers" bulk
// upload. Lives outside React so:
//   1. The modal can unmount (operator clicks "Run in background" or
//      closes the dialog) while the actual POSTs keep firing.
//   2. A separate floating progress widget can read the same state and
//      show "Posting 3/4…" anywhere on the dashboard.
//
// Only ONE bulk task can run at a time — `start()` rejects while one is
// in flight. That's intentional: the operator's mental model is "I
// pressed Post once" and we don't want a second click to silently
// kick off a parallel run.
//
// Throughput + resilience (why this isn't a plain sequential loop):
//   • A bounded worker pool runs several numbers at once. Video stays
//     serial (parallel video uploads make Evolution's proxy return the
//     HTML 502 page that produced the old "Unexpected token '<'" toast);
//     text/image fan out 2–3 wide for a big speed-up.
//   • Each POST has a hard per-request timeout. Without it, ONE hung
//     Evolution instance froze the entire run — the operator just saw
//     "0/47" forever. Now a stuck number is aborted, recorded as a
//     failure, and the pool moves on.
//   • Stop: the operator can cancel mid-run. Remaining numbers are
//     skipped and the in-flight requests are aborted.

import {
  pushNotification,
  type PersistentNotification,
} from "@/lib/notifications-store";

export interface BulkOutcome {
  id: string;
  label: string;
  ok: boolean;
  error?: string;
}

export interface BulkTaskState {
  /** Stable id — useful for click-through / dedupe. */
  taskId: string;
  running: boolean;
  /** Distinguishes a normal finish from an operator-cancelled run so the
   *  widget can say "Stopped at 3/47" instead of "3 posted · 44 failed". */
  status: "running" | "stopped" | "finished";
  total: number;
  done: number;
  outcomes: BulkOutcome[];
  /** Snapshot of the payload kind so the floating widget can render
   *  "Posting Birjul Saini · video" etc. */
  kind: "text" | "image" | "video";
  startedAt: string;
  finishedAt: string | null;
}

interface Target {
  id: string; // phone_number_id
  label: string;
}

type Listener = (state: BulkTaskState | null) => void;

let state: BulkTaskState | null = null;
const listeners = new Set<Listener>();
// Cancellation: the flag short-circuits the worker pool; the controller
// aborts the in-flight fetches. Both are reset on each fresh start().
let stopRequested = false;
let abortController: AbortController | null = null;

// How many numbers to POST at once, per kind. Video stays serial — the
// Evolution proxy 502s on parallel video uploads. Text/image are light
// enough to fan out without tripping it.
const CONCURRENCY: Record<"text" | "image" | "video", number> = {
  text: 3,
  image: 2,
  video: 1,
};

// Hard wall per POST. A healthy status post (even broadcast to all
// contacts) returns in a few seconds; anything past this is a hung
// instance, so we abort it and let the pool continue.
const PER_POST_TIMEOUT_MS = 50_000;

function emit(): void {
  for (const fn of listeners) fn(state);
}

export function getBulkTaskSnapshot(): BulkTaskState | null {
  return state;
}

export function subscribeBulkTask(fn: Listener): () => void {
  listeners.add(fn);
  fn(state);
  return () => {
    listeners.delete(fn);
  };
}

/** Clear a finished task from the store. No-op while running so the
 *  floating widget can't be hidden mid-upload by accident. */
export function dismissBulkTask(): void {
  if (state?.running) return;
  state = null;
  emit();
}

/** Cancel an in-flight run. Skips the remaining numbers and aborts the
 *  requests currently in flight; already-posted numbers are kept. The
 *  worker pool finalizes the task as "stopped". No-op when idle. */
export function stopBulkStatus(): void {
  if (!state || !state.running) return;
  stopRequested = true;
  abortController?.abort();
}

interface StartOpts {
  kind: "text" | "image" | "video";
  /** Whatever the server-side /api/evolution/status endpoint expects
   *  on top of `phone_number_id`. */
  payloadBase: Record<string, unknown>;
  targets: Target[];
}

/** Kicks off a bulk-post run (bounded concurrency, per-post timeout,
 *  cancellable). Returns the task id so the caller can wait via
 *  subscribeBulkTask if it wants to. */
export function startBulkStatus(opts: StartOpts): string {
  if (state?.running) {
    throw new Error("A bulk status upload is already running.");
  }
  const taskId = `bulk:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  stopRequested = false;
  const controller = new AbortController();
  abortController = controller;
  state = {
    taskId,
    running: true,
    status: "running",
    total: opts.targets.length,
    done: 0,
    outcomes: [],
    kind: opts.kind,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  emit();

  const limit = Math.max(
    1,
    Math.min(CONCURRENCY[opts.kind] ?? 1, opts.targets.length || 1),
  );
  // Shared cursor — each worker grabs the next index. Single-threaded JS
  // makes `cursor++` race-free.
  let cursor = 0;

  const postOne = async (t: Target): Promise<void> => {
    // Combine the shared stop signal with this request's own timeout, so
    // either a Stop click or a hang ends the fetch.
    const signal = anySignal([
      controller.signal,
      AbortSignal.timeout(PER_POST_TIMEOUT_MS),
    ]);
    try {
      const res = await fetch("/api/evolution/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number_id: t.id, ...opts.payloadBase }),
        signal,
      });
      recordOutcome(await readOutcome(res, t));
    } catch (e) {
      const aborted =
        e instanceof DOMException &&
        (e.name === "AbortError" || e.name === "TimeoutError");
      // Aborted by the operator's Stop — not a failure, don't record it.
      if (aborted && stopRequested) return;
      recordOutcome({
        id: t.id,
        label: t.label,
        ok: false,
        error: aborted
          ? "Timed out — Evolution took too long to respond"
          : e instanceof Error
            ? e.message
            : "Network error",
      });
    }
  };

  const worker = async (): Promise<void> => {
    while (!stopRequested) {
      const i = cursor++;
      if (i >= opts.targets.length) return;
      await postOne(opts.targets[i]);
    }
  };

  void (async () => {
    await Promise.all(Array.from({ length: limit }, () => worker()));
    if (state) {
      state.running = false;
      state.status = stopRequested ? "stopped" : "finished";
      state.finishedAt = new Date().toISOString();
      emit();
      maybePingNotification(state);
    }
    stopRequested = false;
    abortController = null;
  })();

  return taskId;
}

function recordOutcome(outcome: BulkOutcome): void {
  if (!state) return;
  state.outcomes = [...state.outcomes, outcome];
  state.done = state.outcomes.length;
  emit();
}

// Merge several abort signals into one — aborts (with the firing
// signal's reason) as soon as any input aborts. Used to OR the run-wide
// Stop controller with each request's timeout. (Avoids relying on the
// newer AbortSignal.any for broader browser support.)
function anySignal(signals: AbortSignal[]): AbortSignal {
  const merged = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      merged.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => merged.abort(s.reason), { once: true });
  }
  return merged.signal;
}

// Read the upstream response body without assuming it's JSON. When the
// proxy times out / errors mid-upload it returns an HTML page; surface
// that as a human-readable status instead of letting `res.json()` throw
// "Unexpected token '<'".
async function readOutcome(res: Response, target: Target): Promise<BulkOutcome> {
  const body = await res.text();
  let parsed: { error?: string } | null = null;
  if (body && body.trim().startsWith("{")) {
    try {
      parsed = JSON.parse(body) as { error?: string };
    } catch {
      /* fall through */
    }
  }
  if (!res.ok) {
    const err =
      parsed?.error ??
      (res.status === 504 || res.status === 502
        ? `Upstream timeout (HTTP ${res.status}) — try again in a moment.`
        : `HTTP ${res.status}`);
    return { id: target.id, label: target.label, ok: false, error: err };
  }
  return { id: target.id, label: target.label, ok: true };
}

// Once a background task finishes, drop a row into the notifications
// store so the operator sees a summary even if they're on a different
// page. Failures get an attention-grabbing line; full success a quiet
// confirmation; a cancelled run says so plainly.
function maybePingNotification(s: BulkTaskState): void {
  const failed = s.outcomes.filter((o) => !o.ok);
  const posted = s.outcomes.length - failed.length;
  const preview =
    s.status === "stopped"
      ? `Stopped at ${s.done}/${s.total} — ${posted} posted`
      : failed.length === 0
        ? `Posted to ${s.outcomes.length} numbers`
        : `${posted}/${s.outcomes.length} posted, ${failed.length} failed`;
  const seed: Omit<PersistentNotification, "id" | "count"> & { id?: string } = {
    id: s.taskId,
    kind: "message",
    contactId: "__bulk_status__", // sentinel — UI suppresses navigation for this
    contactName: `Bulk status (${s.kind})`,
    preview,
    businessPhoneNumberId: null,
    occurredAt: new Date().toISOString(),
  };
  pushNotification(seed);
}
