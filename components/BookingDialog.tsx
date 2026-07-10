"use client";

import { useEffect, useState } from "react";
import {
  CalendarDays,
  Send,
  Check,
  Copy,
  X,
  Loader2,
  ChevronLeft,
} from "lucide-react";
import { BookingCalendar } from "@/components/BookingCalendar";

function fmtLong(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Google Calendar event colours (colorId → swatch). "" = default calendar colour.
const EVENT_COLORS: { id: string; hex: string; name: string }[] = [
  { id: "11", hex: "#d50000", name: "Tomato" },
  { id: "6", hex: "#f4511e", name: "Tangerine" },
  { id: "5", hex: "#f6bf26", name: "Banana" },
  { id: "10", hex: "#0b8043", name: "Basil" },
  { id: "2", hex: "#33b679", name: "Sage" },
  { id: "7", hex: "#039be5", name: "Peacock" },
  { id: "9", hex: "#3f51b5", name: "Blueberry" },
  { id: "1", hex: "#7986cb", name: "Lavender" },
  { id: "3", hex: "#8e24aa", name: "Grape" },
  { id: "8", hex: "#616161", name: "Graphite" },
];

export function BookingDialog({
  contactId,
  contactName,
  onClose,
}: {
  contactId: string;
  contactName?: string | null;
  onClose: () => void;
}) {
  // Only "Set the date myself" is offered now — the client-link flow was
  // removed, so the dialog opens straight into the calendar.
  const [tab] = useState<"link" | "self">("self");
  const [dates, setDates] = useState<string[]>([]);
  const [load, setLoad] = useState<Record<string, number>>({});
  const [details, setDetails] = useState<Record<string, string[]>>({});
  // A date the agent clicked — opens that day's overview (events + add form).
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [loadingDates, setLoadingDates] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // a date being confirmed, or "link"
  const [link, setLink] = useState<string | null>(null);
  const [linkSent, setLinkSent] = useState(false);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Agent-typed event title + colour for the Google Calendar entry.
  const [title, setTitle] = useState(contactName?.trim() || "");
  const [color, setColor] = useState(""); // colorId "1"–"11", "" = default

  // Load available dates the first time the "self" tab opens.
  useEffect(() => {
    if (tab !== "self" || dates.length > 0 || loadingDates) return;
    setLoadingDates(true);
    fetch("/api/bookings/availability", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        setDates(j.available_dates ?? []);
        setLoad(j.load ?? {});
        setDetails(j.details ?? {});
      })
      .catch(() => setErr("Could not load dates."))
      .finally(() => setLoadingDates(false));
  }, [tab, dates.length, loadingDates]);

  async function shareLink(send: boolean) {
    setBusy("link");
    setErr(null);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contactId, send_link: send }),
      });
      const j = await res.json();
      if (!res.ok) {
        setErr(j.error ?? "Failed.");
        return;
      }
      setLink(j.link ?? null);
      if (send) setLinkSent(true);
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(null);
    }
  }

  async function setDate(date: string) {
    setBusy(date);
    setErr(null);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contactId, date, title, color }),
      });
      const j = await res.json();
      if (!res.ok) {
        setErr(j.error ?? "Could not set the date.");
        return;
      }
      setConfirmed(date);
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <div className="flex items-center gap-2 font-semibold text-gray-900">
            <CalendarDays className="h-4.5 w-4.5 text-primary" />
            Date Align{contactName ? ` — ${contactName}` : ""}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {confirmed ? (
          <div className="px-6 py-10 text-center">
            <div className="text-5xl">✅</div>
            <p className="mt-3 text-lg font-semibold text-gray-900">{fmtLong(confirmed)}</p>
            <p className="mt-1 text-gray-500">Date set and confirmation sent to the client.</p>
            <button
              onClick={onClose}
              className="mt-5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="px-5 py-4">
              {err ? <p className="mb-3 text-sm text-rose-600">{err}</p> : null}

              {tab === "link" ? (
                <div className="space-y-3">
                  <p className="text-sm text-gray-600">
                    The client gets a private link where they choose their own date.
                  </p>
                  <button
                    onClick={() => shareLink(true)}
                    disabled={busy === "link"}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
                  >
                    {busy === "link" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : linkSent ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    {linkSent ? "Link sent" : "Send link on WhatsApp"}
                  </button>

                  {link ? (
                    <div className="flex items-center gap-2 rounded-lg border bg-gray-50 px-3 py-2">
                      <span className="flex-1 truncate text-xs text-gray-500">{link}</span>
                      <button
                        onClick={() => {
                          navigator.clipboard?.writeText(link);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        }}
                        className="flex items-center gap-1 text-xs font-medium text-primary"
                      >
                        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => shareLink(false)}
                      disabled={busy === "link"}
                      className="text-xs text-gray-500 underline"
                    >
                      Create link only (don’t send)
                    </button>
                  )}
                </div>
              ) : selectedDate ? (
                // ── Day overview: what's already booked + add this appointment ──
                <div>
                  <button
                    type="button"
                    onClick={() => setSelectedDate(null)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700"
                  >
                    <ChevronLeft className="h-4 w-4" /> Back to calendar
                  </button>
                  <p className="mt-2 text-sm font-semibold text-gray-900">
                    {fmtLong(selectedDate)}
                  </p>

                  {/* Everything already on this day. */}
                  <div className="mt-3 rounded-xl border bg-gray-50/70 p-3">
                    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                      {(details[selectedDate] ?? []).length === 0
                        ? "Nothing booked yet"
                        : `${(details[selectedDate] ?? []).length} on this day`}
                    </p>
                    {(details[selectedDate] ?? []).length === 0 ? (
                      <p className="text-sm text-gray-400">This date is open.</p>
                    ) : (
                      <ul className="max-h-40 space-y-1 overflow-y-auto">
                        {(details[selectedDate] ?? []).map((t, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-2 text-sm text-gray-700"
                          >
                            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                            <span className="leading-snug">{t}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Add this appointment — title + colour, then confirm. */}
                  <div className="mt-4">
                    <label className="mb-1 block text-[11px] font-semibold text-gray-600">
                      Event title
                    </label>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="e.g. 1(for delhi) 201381-Aashirwad"
                      className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                    <div className="mb-4 mt-2.5 flex items-center gap-1.5">
                      <span className="mr-1 text-[11px] font-semibold text-gray-600">
                        Colour
                      </span>
                      {EVENT_COLORS.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          title={c.name}
                          onClick={() =>
                            setColor((cur) => (cur === c.id ? "" : c.id))
                          }
                          className={
                            "h-5 w-5 rounded-full ring-offset-1 transition " +
                            (color === c.id
                              ? "ring-2 ring-gray-800"
                              : "hover:scale-110")
                          }
                          style={{ backgroundColor: c.hex }}
                        />
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => setDate(selectedDate)}
                      disabled={busy === selectedDate}
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
                    >
                      {busy === selectedDate ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                      Confirm this date
                    </button>
                  </div>
                </div>
              ) : (
                // ── Calendar: pick a date to open its overview ──
                <div>
                  {loadingDates ? (
                    <p className="py-8 text-center text-gray-400">Loading…</p>
                  ) : dates.length === 0 ? (
                    <p className="py-8 text-center text-gray-500">No dates available.</p>
                  ) : (
                    <>
                      <p className="mb-2 text-[11px] text-gray-500">
                        Pick a date to see the day and add an appointment:
                      </p>
                      <BookingCalendar
                        availableDates={dates}
                        onPick={(d) => {
                          // Fresh form per date — don't carry edits from a
                          // previously viewed date.
                          setTitle(contactName?.trim() || "");
                          setColor("");
                          setSelectedDate(d);
                        }}
                        busyDate={busy}
                        load={load}
                        details={details}
                      />
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
