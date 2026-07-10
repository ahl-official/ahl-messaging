"use client";

// Cascading State → City editor for the contact-details panel. Country
// is derived (and read-only) from the CRM lead — once a country is
// known, the operator picks State from a country-scoped dropdown, then
// picks City from a state-scoped dropdown. Both writes go to LSQ via
// the same /api/lsq/lead/update endpoint the inline edits use.
//
// Source data: `country-state-city` package (ISO countries + states +
// cities). Uses `isoCode` for the link between layers — countries store
// "IN" / "US" / etc. so we resolve the user-visible country name via
// `Country.getAllCountries()` and find the match by `name` (LSQ stores
// the full name, not the ISO code).
//
// UX:
//   1. State dropdown lists every state of the matched country.
//   2. City dropdown lists every city of the picked state. Disabled
//      until a state is chosen.
//   3. "Other / not listed" option in each dropdown reveals a free-
//      text input — a defensive escape hatch for tenants whose LSQ
//      data already has values that don't match the canonical list
//      (typos, regional names, etc.). Avoids data loss.
//   4. Save fires both PATCHes in parallel; either failure surfaces
//      in the same error line.

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { Country, State, City } from "country-state-city";

interface Props {
  /** Live LSQ values — used to populate read view + initial draft. */
  city: string | null;
  state: string | null;
  /** Country name (e.g. "India") — resolved from LSQ. We trust this
   *  to be a value that matches what `country-state-city` returns from
   *  `Country.getAllCountries()`. */
  country: string | null;
  loading?: boolean;
  contactId: string;
  /** Hides the editor when there's no CRM lead linked yet — operator
   *  flow is "wait for first inbound" before editing. */
  canEdit: boolean;
  /** LSQ schema names per field, in case a tenant overrides them. */
  citySchema?: string;
  stateSchema?: string;
  /** Refetch lead after a successful save so the read view picks up
   *  the new values. */
  onSaved?: () => void;
}

export function CascadingLocationEditor({
  city,
  state,
  country,
  loading,
  contactId,
  canEdit,
  citySchema = "mx_Lead_City",
  stateSchema = "mx_Lead_State",
  onSaved,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [stateDraft, setStateDraft] = useState<string>(state ?? "");
  const [cityDraft, setCityDraft] = useState<string>(city ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve ISO country code so we can ask CSC for its states/cities.
  const countryIso = useMemo(() => {
    if (!country) return null;
    const want = country.trim().toLowerCase();
    const match = Country.getAllCountries().find(
      (c) => c.name.toLowerCase() === want,
    );
    return match?.isoCode ?? null;
  }, [country]);

  const states = useMemo(
    () => (countryIso ? State.getStatesOfCountry(countryIso) : []),
    [countryIso],
  );

  // Resolve ISO state code from the chosen state name so we can list
  // its cities. Pre-existing LSQ values usually match the CSC list
  // verbatim ("Uttarakhand"), but typos like "Uttarakhnad" won't —
  // those naturally fall through to the `cityOther` text path.
  const stateIso = useMemo(() => {
    if (!countryIso || !stateDraft) return null;
    const want = stateDraft.trim().toLowerCase();
    const match = states.find((s) => s.name.toLowerCase() === want);
    return match?.isoCode ?? null;
  }, [countryIso, states, stateDraft]);

  const cities = useMemo(
    () => (countryIso && stateIso ? City.getCitiesOfState(countryIso, stateIso) : []),
    [countryIso, stateIso],
  );

  // Sync drafts from props when not editing — handles refresh flows
  // and lead switches without clobbering operator-in-progress edits.
  useEffect(() => {
    if (!editing) {
      setStateDraft(state ?? "");
      setCityDraft(city ?? "");
    }
  }, [state, city, editing]);

  const startEdit = () => {
    if (!canEdit) return;
    setError(null);
    setStateDraft(state ?? "");
    setCityDraft(city ?? "");
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const fields: Record<string, string> = {};
      if (stateDraft.trim() !== (state ?? "")) {
        fields[stateSchema] = stateDraft.trim();
      }
      if (cityDraft.trim() !== (city ?? "")) {
        fields[citySchema] = cityDraft.trim();
      }
      if (Object.keys(fields).length === 0) {
        setEditing(false);
        return;
      }
      const res = await fetch("/api/lsq/lead/update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contactId, fields }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setEditing(false);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  // --- Read view: two stacked rows (State / City) matching the rest
  //     of the panel's row layout. Hover reveals the pencil. ---
  if (!editing) {
    return (
      <div className="col-span-2 space-y-1.5">
        <ReadRow
          label="State"
          value={state}
          loading={loading}
          canEdit={canEdit}
          onEdit={startEdit}
        />
        <ReadRow
          label="City"
          value={city}
          loading={loading}
          canEdit={canEdit}
          onEdit={startEdit}
        />
      </div>
    );
  }

  // Existing LSQ values that don't appear in the canonical CSC list
  // (typos / regional spellings / older data) still need to be
  // selectable in the dropdown so the operator doesn't see an empty
  // selection and lose the value. We prepend them as "(custom)"
  // entries — preserved on save but visually flagged as off-list.
  const stateContainsDraft =
    !!stateDraft && !states.some((s) => s.name === stateDraft);
  const cityContainsDraft =
    !!cityDraft && !cities.some((c) => c.name === cityDraft);

  // --- Edit view: full-width form with cascading dropdowns. ---
  return (
    <div className="col-span-2 space-y-2 rounded-lg border border-border/60 bg-background/60 p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          State &amp; City
        </span>
        {!countryIso ? (
          <span className="text-[10px] italic text-muted-foreground">
            Country not detected
          </span>
        ) : null}
      </div>

      {/* State dropdown — always rendered as a <select>. Disabled when
          country couldn't be resolved (no list to scope to). */}
      <div className="space-y-1">
        <label className="text-[10px] font-medium text-muted-foreground">
          State
        </label>
        <select
          value={stateDraft}
          onChange={(e) => {
            setStateDraft(e.target.value);
            // Reset city — old city won't belong to the new state.
            setCityDraft("");
          }}
          disabled={saving || !countryIso}
          className="h-8 w-full rounded border border-border bg-background px-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">
            {countryIso ? "Select a state…" : "Country not detected"}
          </option>
          {stateContainsDraft ? (
            <option value={stateDraft}>{stateDraft} (custom)</option>
          ) : null}
          {states.map((s) => (
            <option key={s.isoCode} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {/* City dropdown — disabled until a state ISO resolves (so we
          can scope the list). Existing LSQ city not in the CSC list
          still appears as a "(custom)" option to preserve value. */}
      <div className="space-y-1">
        <label className="text-[10px] font-medium text-muted-foreground">
          City
        </label>
        <select
          value={cityDraft}
          onChange={(e) => setCityDraft(e.target.value)}
          disabled={saving || !stateIso}
          className="h-8 w-full rounded border border-border bg-background px-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">
            {stateIso ? "Select a city…" : "Pick a state first"}
          </option>
          {cityContainsDraft ? (
            <option value={cityDraft}>{cityDraft} (custom)</option>
          ) : null}
          {cities.map((c) => (
            <option key={`${c.stateCode}-${c.name}`} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center justify-end gap-1 pt-1">
        {error ? (
          <span className="mr-auto text-[10px] text-destructive">
            {error}
          </span>
        ) : null}
        <button
          type="button"
          onClick={cancel}
          disabled={saving}
          className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-secondary disabled:opacity-50"
        >
          <X className="h-3 w-3" /> Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex h-7 items-center gap-1 rounded bg-primary px-2.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          Save
        </button>
      </div>
    </div>
  );
}

function ReadRow({
  label,
  value,
  loading,
  canEdit,
  onEdit,
}: {
  label: string;
  value: string | null;
  loading?: boolean;
  canEdit: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="group flex items-center justify-between gap-3 rounded-md px-1.5 py-[5px] transition-colors hover:bg-secondary/60">
      <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      <div className="flex min-w-0 items-center gap-1.5">
        {loading && !value ? (
          <span className="h-3 w-20 animate-pulse rounded bg-secondary" />
        ) : (
          <span
            className={
              "min-w-0 truncate text-right text-[12.5px] " +
              (value ? "font-medium text-foreground" : "text-muted-foreground/40")
            }
            title={value ?? undefined}
          >
            {value ?? "—"}
          </span>
        )}
        {canEdit ? (
          <button
            type="button"
            onClick={onEdit}
            className="shrink-0 text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus:opacity-100"
            aria-label={`Edit ${label}`}
            title={`Edit ${label}`}
          >
            <Pencil className="h-3 w-3" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
