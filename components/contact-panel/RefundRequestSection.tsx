"use client";

// Refund-request form mounted under "QHT AI" in the contact-details panel.
// Pre-fills agent (from session) + lead / client (from LSQ) so the
// operator only types the package + amount fields and uploads a payment
// screenshot. Submission inserts a row in refund_requests + uploads the
// screenshot to the private `refund-screenshots` bucket.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Upload, X, CheckCircle2, AlertCircle, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { createBrowserClient } from "@/lib/supabase/client";
import { useLsqLead } from "@/components/contact-panel/useLsqLead";
import { useMemberNameByUserId } from "@/components/MembersContext";

const REASONS: Array<{ value: string; label: string }> = [
  { value: "cancelled_by_patient", label: "Cancelled by client" },
  { value: "medical_reasons", label: "Medical reasons" },
  { value: "surgery_rescheduled", label: "Surgery rescheduled" },
  { value: "duplicate_payment", label: "Duplicate payment" },
  { value: "service_not_delivered", label: "Service not delivered" },
  { value: "other", label: "Other" },
];

const REFUND_BUCKET = "refund-screenshots";

export function RefundRequestSection({
  contactId,
  waId,
  currentUserId,
  contactName,
  contactLeadNumber,
}: {
  contactId: string;
  waId: string | null;
  currentUserId: string | null;
  contactName: string | null;
  contactLeadNumber: string | null;
}) {
  const [open, setOpen] = useState(false);
  const agentName = useMemberNameByUserId(currentUserId);
  const lsq = useLsqLead(open ? waId : null);

  // Client name + Lead ID are EDITABLE — pre-filled from LSQ when the
  // lookup finds a match, else from the contact's stored fields, else
  // empty so the operator can type. Auto-fill only overwrites empty
  // values so we don't clobber whatever the operator just typed.
  const [leadId, setLeadId] = useState(contactLeadNumber ?? "");
  const [patientName, setPatientName] = useState(contactName ?? "");
  const [bookingDate, setBookingDate] = useState("");
  const [perGraft, setPerGraft] = useState("");
  const [estGrafts, setEstGrafts] = useState("");
  const [bookingAmount, setBookingAmount] = useState("");
  const [refundable, setRefundable] = useState("");
  const [reason, setReason] = useState("");
  const [reasonOther, setReasonOther] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [autofilling, setAutofilling] = useState(false);
  const [autofillNote, setAutofillNote] = useState<string | null>(null);

  // GPT auto-fill — pulls structured refund fields from the LSQ package
  // fields when the client has a "Package Shared" lead. Falls back
  // gracefully when there's no lead / no package data.
  async function handleAutofill() {
    if (autofilling) return;
    const pid = lsq.lead?.prospect_id;
    if (!pid) {
      setAutofillNote("No CRM lead found for this contact — type the values manually.");
      return;
    }
    setAutofilling(true);
    setAutofillNote(null);
    try {
      const res = await fetch("/api/refund-requests/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prospect_id: pid }),
      });
      const j = (await res.json()) as {
        extracted?: {
          booking_date: string | null;
          per_graft_rate: number | null;
          estimated_grafts: number | null;
          booking_amount: number | null;
          refundable_amount: number | null;
        };
        source?: string;
        error?: string;
      };
      if (!res.ok || !j.extracted) {
        setAutofillNote(j.error ?? "Auto-fill failed — type manually.");
        return;
      }
      const e = j.extracted;
      // Only overwrite empty fields — don't clobber what the operator typed.
      if (e.booking_date && !bookingDate) setBookingDate(e.booking_date);
      if (e.per_graft_rate !== null && !perGraft) setPerGraft(String(e.per_graft_rate));
      if (e.estimated_grafts !== null && !estGrafts) setEstGrafts(String(e.estimated_grafts));
      if (e.booking_amount !== null && !bookingAmount) setBookingAmount(String(e.booking_amount));
      if (e.refundable_amount !== null && !refundable) setRefundable(String(e.refundable_amount));
      const any =
        e.booking_date ||
        e.per_graft_rate !== null ||
        e.estimated_grafts !== null ||
        e.booking_amount !== null ||
        e.refundable_amount !== null;
      setAutofillNote(
        any
          ? "Filled from LSQ package — check before submitting."
          : "LSQ has no booking data for this lead yet.",
      );
    } catch (err) {
      setAutofillNote(err instanceof Error ? err.message : "Auto-fill failed");
    } finally {
      setAutofilling(false);
    }
  }

  function reset() {
    setLeadId(contactLeadNumber ?? "");
    setPatientName(contactName ?? "");
    setBookingDate("");
    setPerGraft("");
    setEstGrafts("");
    setBookingAmount("");
    setRefundable("");
    setReason("");
    setReasonOther("");
    setFile(null);
    setError(null);
    setSubmitted(false);
  }

  // Reset on contact switch
  useEffect(() => {
    reset();
    setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  // When LSQ resolves, replace the lead ID + client name with LSQ's
  // canonical values (overrides the contact-side fallback which is
  // often the ugly auto-generated label like "88958_Sonu_31Dec25").
  // We only do this once per contact so a subsequent operator edit
  // isn't clobbered by a re-fetch.
  const lsqFilledRef = useRef(false);
  useEffect(() => {
    lsqFilledRef.current = false;
  }, [contactId]);
  useEffect(() => {
    if (!lsq.lead || lsqFilledRef.current) return;
    if (lsq.lead.lead_number) setLeadId(lsq.lead.lead_number);
    if (lsq.lead.full_name) setPatientName(lsq.lead.full_name);
    lsqFilledRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lsq.lead]);

  async function handleSubmit() {
    if (submitting) return;
    setError(null);

    if (!reason) {
      setError("Pick a reason for refund.");
      return;
    }
    if (reason === "other" && !reasonOther.trim()) {
      setError("Describe the reason in the 'Other' box.");
      return;
    }
    if (!file) {
      setError("Upload the client's payment screenshot.");
      return;
    }

    setSubmitting(true);
    try {
      // 1) Upload the screenshot to the private bucket. Path scoped by
      //    contact so an admin can find files for one chat at a glance.
      const supabase = createBrowserClient();
      const ext = (file.name.split(".").pop() || "png").toLowerCase().slice(0, 6);
      const path = `${contactId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from(REFUND_BUCKET)
        .upload(path, file, {
          cacheControl: "3600",
          upsert: false,
          contentType: file.type || "image/png",
        });
      if (upErr) throw new Error(upErr.message);

      // 2) Stamp the metadata row.
      const res = await fetch("/api/refund-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: contactId,
          lsq_lead_number: leadId.trim() || null,
          lsq_prospect_id: lsq.lead?.prospect_id ?? null,
          patient_name: patientName.trim() || null,
          booking_date: bookingDate || null,
          per_graft_rate: perGraft || null,
          estimated_grafts: estGrafts || null,
          booking_amount: bookingAmount || null,
          refundable_amount: refundable || null,
          reason_code: reason,
          reason_other: reason === "other" ? reasonOther.trim() : null,
          payment_screenshot_path: path,
        }),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);

      setSubmitted(true);
      setFile(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="border-b">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-rose-100 text-[10px] font-bold text-rose-700">
          ₹
        </span>
        <span className="text-sm font-semibold tracking-tight">Service Refund Request</span>
        <ChevronDown
          className={cn(
            "ml-auto h-4 w-4 text-muted-foreground transition-transform",
            open ? "rotate-0" : "-rotate-90",
          )}
        />
      </button>

      {open ? (
        <div className="px-4 pb-4">
          {submitted ? (
            <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-[12px] text-emerald-900">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
                <div className="flex-1">
                  <div className="font-semibold">Refund request submitted</div>
                  <div className="mt-0.5 text-emerald-800/80">
                    Admin will review and update the status.
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={reset}
                className="rounded-md border border-emerald-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100"
              >
                Submit another
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Agent — read-only, from session. */}
              <ReadField label="Agent name" value={agentName || "—"} />

              {/* Lead ID + Client name — editable, pre-filled from LSQ
                  when available, else from the contact's stored fields. */}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Field label={lsq.phase === "loading" ? "Lead ID (looking up…)" : "Lead ID"}>
                  <input
                    type="text"
                    value={leadId}
                    onChange={(e) => setLeadId(e.target.value)}
                    placeholder="e.g. 432029"
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  />
                </Field>
                <Field label="Client name">
                  <input
                    type="text"
                    value={patientName}
                    onChange={(e) => setPatientName(e.target.value)}
                    placeholder="Client's full name"
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  />
                </Field>
              </div>

              {/* AI auto-fill from LSQ package fields */}
              <button
                type="button"
                onClick={handleAutofill}
                disabled={autofilling || !lsq.lead}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-[11px] font-semibold text-violet-700 hover:bg-violet-100 disabled:opacity-60"
                title={
                  lsq.lead
                    ? "Pull booking date / units / amounts from CRM via AI"
                    : "Connect an CRM lead first"
                }
              >
                {autofilling ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {autofilling ? "Reading LSQ…" : "Auto-fill from LSQ"}
              </button>
              {autofillNote ? (
                <div className="text-[10px] text-muted-foreground">{autofillNote}</div>
              ) : null}

              {/* Operator-entered fields */}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Field label="Booking date">
                  <input
                    type="date"
                    value={bookingDate}
                    onChange={(e) => setBookingDate(e.target.value)}
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  />
                </Field>
                <Field label="Per unit (₹)">
                  <input
                    type="number"
                    inputMode="decimal"
                    value={perGraft}
                    onChange={(e) => setPerGraft(e.target.value)}
                    placeholder="e.g. 35"
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  />
                </Field>
                <Field label="Estimated units">
                  <input
                    type="number"
                    inputMode="numeric"
                    value={estGrafts}
                    onChange={(e) => setEstGrafts(e.target.value)}
                    placeholder="e.g. 2500"
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  />
                </Field>
                <Field label="Booking amount (₹)">
                  <input
                    type="number"
                    inputMode="decimal"
                    value={bookingAmount}
                    onChange={(e) => setBookingAmount(e.target.value)}
                    placeholder="e.g. 11000"
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  />
                </Field>
                <Field label="Refundable amount (₹)" className="sm:col-span-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    value={refundable}
                    onChange={(e) => setRefundable(e.target.value)}
                    placeholder="e.g. 9000"
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  />
                </Field>
              </div>

              <Field label="Reason for refund">
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                >
                  <option value="">Select reason…</option>
                  {REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Field>

              {reason === "other" ? (
                <Field label="Describe">
                  <textarea
                    value={reasonOther}
                    onChange={(e) => setReasonOther(e.target.value)}
                    rows={2}
                    placeholder="What's the actual reason?"
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  />
                </Field>
              ) : null}

              <Field label="Payment screenshot (booking)">
                {file ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border bg-background px-2 py-1.5 text-[12px]">
                    <span className="truncate">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => setFile(null)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Remove file"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed bg-background px-2 py-2 text-[12px] text-muted-foreground hover:bg-secondary">
                    <Upload className="h-3.5 w-3.5" />
                    <span>Upload image (≤ 5 MB)</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        if (f.size > 5 * 1024 * 1024) {
                          setError("File too large — max 5 MB.");
                          return;
                        }
                        setError(null);
                        setFile(f);
                      }}
                    />
                  </label>
                )}
              </Field>

              {error ? (
                <div className="flex items-start gap-2 rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-800">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{error}</span>
                </div>
              ) : null}

              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-rose-600 px-3 py-2 text-[12px] font-semibold text-white shadow-sm hover:bg-rose-700 disabled:opacity-60"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Submitting…
                  </>
                ) : (
                  "Submit refund request"
                )}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function ReadField({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 rounded-md border bg-secondary/40 px-2 py-1.5 text-[12px] text-foreground/90">
        {value}
      </div>
    </div>
  );
}
