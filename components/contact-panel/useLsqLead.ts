"use client";

// Tiny hook the contact-details panel uses to fetch the LSQ lead that
// matches a given wa_id. Returns the lead payload (or null), a loading
// flag, and refresh helper. State machine kept intentionally simple —
// any failure becomes "no lead", rather than putting an error pill in
// the user's face for a non-critical sidebar enrichment.
//
// Pass `crm: "secondary"` to read the second LSQ account (read-only).

import { useCallback, useEffect, useState } from "react";

export interface LsqLeadView {
  prospect_id: string;
  lead_number: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  age: number | null;
  dob: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  created_on: string | null;
  owner_name: string | null;
  source: string | null;
  sub_source: string | null;
  status: string | null;
  lead_url: string | null;
}

export type LsqLeadPhase = "loading" | "configured-no-match" | "not-configured" | "found";

export type LsqCrm = "primary" | "secondary";

interface State {
  phase: LsqLeadPhase;
  lead: LsqLeadView | null;
  /** CRM display label from the server (e.g. "Delhi/Haridwar"). */
  label: string;
  /** LSQ-side error when the lookup call itself failed (bad host /
   *  keys / rate-limit) — distinct from a clean "0 matches". */
  error: string | null;
}

interface ApiResponse {
  configured?: boolean;
  ok?: boolean;
  found?: boolean;
  lead?: LsqLeadView | null;
  label?: string;
  error?: string;
}

export function useLsqLead(waId: string | null, crm: LsqCrm = "primary") {
  const [state, setState] = useState<State>({
    phase: "loading",
    lead: null,
    label: "",
    error: null,
  });

  const refresh = useCallback(async () => {
    if (!waId) {
      setState({ phase: "loading", lead: null, label: "", error: null });
      return;
    }
    setState((s) => ({
      phase: "loading",
      lead: s.lead,
      label: s.label,
      error: null,
    }));
    try {
      const qs = new URLSearchParams({ mobile: waId });
      if (crm === "secondary") qs.set("crm", "secondary");
      const res = await fetch(`/api/lsq/lead?${qs.toString()}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as ApiResponse;
      const label = json.label ?? "";
      if (!res.ok || !json.configured) {
        setState({ phase: "not-configured", lead: null, label, error: null });
        return;
      }
      if (json.found && json.lead) {
        setState({ phase: "found", lead: json.lead, label, error: null });
      } else {
        // ok=false → the LSQ call itself failed; surface that error so
        // a bad host/key doesn't masquerade as "no lead found".
        setState({
          phase: "configured-no-match",
          lead: null,
          label,
          error: json.ok === false ? json.error ?? "LSQ lookup failed" : null,
        });
      }
    } catch {
      // Network error → treat as no match (sidebar shouldn't block the chat).
      setState({
        phase: "configured-no-match",
        lead: null,
        label: "",
        error: "Network error",
      });
    }
  }, [waId, crm]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...state, refresh };
}
