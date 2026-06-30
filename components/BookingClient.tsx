"use client";

import { useEffect, useState } from "react";
import { BookingCalendar } from "@/components/BookingCalendar";

interface BookingData {
  status: "pending" | "confirmed" | "cancelled" | "expired";
  patient_name?: string | null;
  clinic?: string | null;
  booking_date?: string | null;
  available_dates?: string[];
}

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

export function BookingClient({ token }: { token: string }) {
  const [data, setData] = useState<BookingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/book/${token}`, { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) setErr(json.error ?? "This link is not valid.");
        else setData(json as BookingData);
      } catch {
        if (!cancelled) setErr("Something went wrong. Please try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function pick(date: string) {
    setSubmitting(date);
    setErr(null);
    try {
      const res = await fetch(`/api/book/${token}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json.error ?? "Could not confirm. Please try another date.");
        setSubmitting(null);
        return;
      }
      setData((d) => ({ ...(d ?? { status: "confirmed" }), status: "confirmed", booking_date: date }));
    } catch {
      setErr("Network error. Please try again.");
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="min-h-screen bg-[#0de531]/10 px-4 py-8 flex justify-center">
      <div className="w-full max-w-md">
        <div className="rounded-3xl bg-white shadow-lg ring-1 ring-black/5 overflow-hidden">
          <div className="bg-[#0de531] px-6 py-7 text-white">
            <div className="text-sm/5 opacity-90">{data?.clinic ?? "American Hairline"}</div>
            <h1 className="mt-1 text-2xl font-bold">
              {data?.status === "confirmed" ? "Date Confirmed" : "Choose your date"}
            </h1>
          </div>

          <div className="px-6 py-6">
            {loading ? (
              <p className="text-center text-gray-500 py-10">Loading…</p>
            ) : err && !data ? (
              <p className="text-center text-rose-600 py-10">{err}</p>
            ) : data?.status === "confirmed" ? (
              <div className="py-8 text-center">
                <div className="text-5xl">✅</div>
                <p className="mt-4 text-lg font-semibold text-gray-900">
                  {data.booking_date ? fmtLong(data.booking_date) : "Your date is confirmed"}
                </p>
                <p className="mt-2 text-gray-500">
                  Thank you{data.patient_name ? `, ${data.patient_name}` : ""}! We’ll see you then.
                </p>
              </div>
            ) : data?.status === "expired" ? (
              <p className="text-center text-gray-600 py-10">
                This link has expired. Please ask our team for a fresh one.
              </p>
            ) : data?.status === "cancelled" ? (
              <p className="text-center text-gray-600 py-10">This booking was cancelled.</p>
            ) : (data?.available_dates?.length ?? 0) === 0 ? (
              <p className="text-center text-gray-600 py-10">
                No dates are open right now. Please check back shortly.
              </p>
            ) : (
              <>
                {data?.patient_name ? (
                  <p className="mb-4 text-gray-700">
                    Hi <span className="font-semibold">{data.patient_name}</span>, please pick a
                    convenient date:
                  </p>
                ) : null}
                {err ? <p className="mb-3 text-sm text-rose-600">{err}</p> : null}
                <BookingCalendar
                  availableDates={data?.available_dates ?? []}
                  onPick={pick}
                  busyDate={submitting}
                />
              </>
            )}
          </div>
        </div>
        <p className="mt-4 text-center text-xs text-gray-400">Powered by American Hairline</p>
      </div>
    </div>
  );
}
