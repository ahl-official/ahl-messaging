"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  AtSign,
  Cake,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Globe,
  Hash,
  Loader2,
  MapPin,
  Mail,
  Pencil,
  Phone,
  Play,
  RefreshCcw,
  UserCheck,
  X,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  contactDisplayNameMasked,
  contactInitials,
  type BusinessNumber,
  type Contact,
  type ContactNote,
} from "@/lib/types";
import { DEMO_MODE } from "@/lib/demo";
import { PanelWidgets } from "@/components/contact-panel/PanelWidgets";
import { NameEditor } from "@/components/contact-panel/NameEditor";
import dynamic from "next/dynamic";
import { useLsqLead } from "@/components/contact-panel/useLsqLead";
import { ContactAvatarUploader } from "@/components/contact-panel/ContactAvatarUploader";
import { LeadNumberField } from "@/components/contact-panel/LeadNumberField";
import { PhotosRow } from "@/components/contact-panel/PhotosRow";
import { PackageSharedContent } from "@/components/contact-panel/PackageSharedSection";
import { PaymentsSection } from "@/components/contact-panel/PaymentsSection";
import { usePermissions } from "@/components/PermissionsContext";
import { maskEmail } from "@/lib/mask";
import { cn } from "@/lib/utils";
import { toneForStage } from "@/lib/chip-tones";

// Lazy — the location editor pulls the 7.7MB country-state-city dataset,
// which we don't want in the always-loaded inbox bundle. It only mounts
// when an operator actually opens the location field.
const CascadingLocationEditor = dynamic(
  () =>
    import("@/components/contact-panel/CascadingLocationEditor").then(
      (m) => m.CascadingLocationEditor,
    ),
  { ssr: false },
);

interface Props {
  contact: Contact | null;
  businessNumber?: BusinessNumber | null;
  currentUserId: string | null;
  onClose?: () => void;
  /** Tablet/mobile — when true the panel slides in as a drawer. On lg+
   *  the panel is always docked and this is ignored. */
  mobileOpen?: boolean;
}

export function ContactDetailsPanel({
  contact,
  businessNumber,
  currentUserId,
  onClose,
  mobileOpen = false,
}: Props) {
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [loading, setLoading] = useState(false);
  // Lead details starts collapsed by default — operators usually only
  // need it when triaging or filling missing fields, not on every chat
  // open. Choice persists per-tab via the same hook pattern as the
  // LSQ-in-chat toggle.
  // Package Shared / Lead Details share one tab row — at most one open.
  const [openSection, setOpenSection] = useState<"package" | "lead" | null>(
    null,
  );
  // Which CRM the Lead Details section is showing (the two branch
  // buttons switch this). Only meaningful when a secondary CRM exists.
  const [activeCrm, setActiveCrm] = useState<"primary" | "secondary">(
    "primary",
  );
  // Surfaced from NameEditor so the status pills can slide out of the
  // way while the name input takes the row's full width — otherwise
  // the pills overlap the input on narrow panels.
  const [editingName, setEditingName] = useState(false);

  // (Close/Reopen chat toggle moved to ChatWindow header — keeping
  // the local status mirror + toggle here would duplicate the action.)

  // Fetch notes for the current contact
  useEffect(() => {
    if (!contact || DEMO_MODE) {
      setNotes([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const supabase = createBrowserClient();
    supabase
      .from("contact_notes")
      .select("*")
      .eq("contact_id", contact.id)
      .order("created_at", { ascending: false })
      .limit(100)
      .then(({ data }) => {
        if (cancelled) return;
        setNotes((data ?? []) as ContactNote[]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // ID-only dep — see the matching note in ChatWindow. Depending on
    // the whole `contact` object made this effect re-fire on every
    // realtime update (lsq_stage / avatar / etc.), kicking the notes
    // panel through a loading→loaded flash on every webhook tick.
  }, [contact?.id]);

  // Campaign attribution captured from the lead's first inbound (set by the
  // webhook — wa.me text UTM or Click-to-WhatsApp `referral`). Fetched
  // directly so we don't thread it through the whole contact type + every
  // chat-list query.
  const [utm, setUtm] = useState<{
    source: string | null;
    params: Record<string, string> | null;
  }>({ source: null, params: null });
  useEffect(() => {
    if (!contact || DEMO_MODE) {
      setUtm({ source: null, params: null });
      return;
    }
    let cancelled = false;
    createBrowserClient()
      .from("contacts")
      .select("utm_source, utm_params")
      .eq("id", contact.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setUtm({
          source: (data?.utm_source as string | null) ?? null,
          params: (data?.utm_params as Record<string, string> | null) ?? null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [contact?.id]);

  // Click-to-WhatsApp ad attribution — resolve the referral source_id into
  // campaign / ad set / ad NAMES via the Meta Marketing API. Lazy: only when
  // the lead actually has a numeric source_id (a real ad id).
  const [adAttr, setAdAttr] = useState<{
    campaign_id: string | null;
    campaign_name: string | null;
    adset_name: string | null;
    ad_name: string | null;
  } | null>(null);
  const adSourceId = utm.params?.source_id;
  const adResolved = utm.params?._ad_resolved;
  const storedCampaign = utm.params?.campaign_name;
  useEffect(() => {
    setAdAttr(null);
    if (!contact || DEMO_MODE || !adSourceId || !/^\d+$/.test(adSourceId)) return;
    // Already resolved + stored on the contact → read straight from the table,
    // no Meta round-trip.
    if (adResolved) {
      setAdAttr({
        campaign_id: utm.params?.campaign_id ?? null,
        campaign_name: storedCampaign ?? null,
        adset_name: utm.params?.adset_name ?? null,
        ad_name: utm.params?.ad_name ?? null,
      });
      return;
    }
    // Not resolved yet → fetch once (the endpoint persists it for next time).
    let cancelled = false;
    fetch(`/api/contacts/${contact.id}/ad-attribution`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { attribution?: { campaign_id: string | null; campaign_name: string | null; adset_name: string | null; ad_name: string | null } | null }) => {
        if (!cancelled && j.attribution) setAdAttr(j.attribution);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact?.id, adSourceId, adResolved]);

  // LSQ lead — fetched inline so the contact-details panel reads as one
  // unified source of truth (CRM + WhatsApp). The hook returns null
  // while loading and on misses, which the Field rows below treat as "—".
  const lsq = useLsqLead(DEMO_MODE ? null : contact?.wa_id ?? null);
  // Secondary (read-only) LSQ account. The card renders only when the
  // LSQ2_* env vars are set — otherwise the hook reports not-configured.
  const lsq2 = useLsqLead(
    DEMO_MODE ? null : contact?.wa_id ?? null,
    "secondary",
  );
  // Secondary CRM is set up once its lookup resolves to anything other
  // than "not-configured". Only then do the two branch buttons appear.
  const secondaryConfigured =
    lsq2.phase === "found" || lsq2.phase === "configured-no-match";
  const showCrmToggle = !DEMO_MODE && secondaryConfigured;
  // The CRM the section header's open-in-LSQ + refresh act on.
  const activeLsq =
    showCrmToggle && activeCrm === "secondary" ? lsq2 : lsq;

  const perms = usePermissions();
  const maskPhoneIfNeeded = perms.mask_phone_numbers;
  const maskEmailIfNeeded = perms.mask_emails;
  const maskSourceIfNeeded = perms.mask_source_subsource;

  if (!contact) {
    return (
      <aside className="hidden lg:flex h-full w-[300px] xl:w-[340px] 2xl:w-[380px] shrink-0 flex-col border-l bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Contact Details</h2>
        </div>
        <div className="grid flex-1 place-items-center px-6 text-center text-sm text-muted-foreground">
          Select a conversation to see contact details.
        </div>
      </aside>
    );
  }

  const fallbackName = contactDisplayNameMasked(
    { ...contact, name: null } as Contact,
    maskPhoneIfNeeded,
  );

  return (
    <>
      {/* Mobile/tablet drawer backdrop */}
      {mobileOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      ) : null}
      <aside
        className={cn(
          "h-full flex-col border-l bg-card overflow-y-auto",
          // Docked column on large screens.
          "lg:flex lg:static lg:z-auto lg:w-[300px] xl:w-[340px] 2xl:w-[380px] lg:max-w-none lg:shrink-0 lg:shadow-none",
          // Slide-over drawer on tablet/mobile.
          mobileOpen
            ? "flex fixed inset-y-0 right-0 z-50 w-[88vw] max-w-sm shadow-2xl"
            : "hidden",
        )}
      >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3 sticky top-0 bg-card/95 backdrop-blur z-10">
        <h2 className="text-sm font-semibold tracking-tight">Contact details</h2>
        <div className="flex items-center gap-1.5">
          {/* Close chat button removed — ChatWindow header has it. */}
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground lg:hidden"
              aria-label="Close panel"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Profile card — two-block stack now:
            1. Identity row: avatar (left) | name + alias (centre) |
                             stage + source pills (right, stacked)
            2. Handles row : phone + email
          Pills moved into the identity row so the avatar block reads
          tighter; the secondary handles row sits below as a clean
          contact strip. */}
      <div className="border-b bg-gradient-to-b from-brand-50/40 to-transparent">
        <div className="flex items-start gap-3 px-4 pt-4 pb-3">
          <ContactAvatarUploader
            contactId={contact.id}
            avatarUrl={contact.avatar_url ?? null}
            initials={contactInitials(contact)}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                {DEMO_MODE ? (
                  <div className="truncate text-[15px] font-semibold tracking-tight">
                    {contactDisplayNameMasked(contact, maskPhoneIfNeeded)}
                  </div>
                ) : (
                  <NameEditor
                    contactId={contact.id}
                    currentName={contact.name}
                    fallbackName={fallbackName}
                    onEditingChange={setEditingName}
                  />
                )}
                {contact.profile_name && contact.name ? (
                  <div className="mt-0.5 truncate text-[11px] italic text-muted-foreground">
                    aka {contact.profile_name}
                  </div>
                ) : null}
                <InlineEmailEditor
                  email={lsq.lead?.email ?? null}
                  contactId={contact.id}
                  loading={lsq.phase === "loading"}
                  canEdit={!!lsq.lead?.prospect_id && !maskEmailIfNeeded}
                  maskEmail={maskEmailIfNeeded}
                  onSaved={lsq.refresh}
                />
              </div>
              {lsq.lead?.status ||
              (!maskSourceIfNeeded && (lsq.lead?.source || lsq.lead?.sub_source)) ? (
                <div
                  className={
                    "flex shrink-0 flex-col items-end gap-1 transition-all duration-200 " +
                    (editingName
                      ? // Slide right + fade so the name input gets
                        // the full row. `pointer-events-none` while
                        // hidden so a stray click can't hit a pill.
                        "translate-x-6 opacity-0 pointer-events-none"
                      : "translate-x-0 opacity-100")
                  }
                  aria-hidden={editingName}
                >
                  {lsq.lead.status ? (
                    <span
                      className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-200"
                      title={lsq.lead.status}
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                      <span className="truncate">{lsq.lead.status}</span>
                    </span>
                  ) : null}
                  {!maskSourceIfNeeded && lsq.lead.source ? (
                    <span
                      className="inline-flex max-w-full truncate rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-inset ring-border"
                      title={lsq.lead.source}
                    >
                      <span className="truncate">{lsq.lead.source}</span>
                    </span>
                  ) : null}
                  {!maskSourceIfNeeded && lsq.lead.sub_source ? (
                    <span
                      className="inline-flex max-w-full truncate rounded-full bg-secondary/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/80 ring-1 ring-inset ring-border"
                      title={`Sub-source: ${lsq.lead.sub_source}`}
                    >
                      <span className="truncate">{lsq.lead.sub_source}</span>
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>

      </div>

      {/* Package Shared + Lead Details — one tab row, one open at a
          time. Package Shared pulls the quoted package from LSQ notes;
          Lead Details shows the CRM record + editable patient info. */}
      <div className="space-y-3 border-b p-4">
        <div className="flex items-center gap-3">
          {!DEMO_MODE ? (
            <button
              type="button"
              onClick={() =>
                setOpenSection((s) => (s === "package" ? null : "package"))
              }
              className={
                "group inline-flex items-center gap-1 rounded text-[10px] font-semibold uppercase tracking-wider transition " +
                (openSection === "package"
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground")
              }
              aria-expanded={openSection === "package"}
            >
              <ChevronDown
                className={
                  "h-3.5 w-3.5 transition-transform " +
                  (openSection === "package" ? "rotate-0" : "-rotate-90")
                }
              />
              Package Shared
            </button>
          ) : null}
          <button
            type="button"
            onClick={() =>
              setOpenSection((s) => (s === "lead" ? null : "lead"))
            }
            className={
              "group inline-flex items-center gap-1 rounded text-[10px] font-semibold uppercase tracking-wider transition " +
              (openSection === "lead"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground")
            }
            aria-expanded={openSection === "lead"}
          >
            <ChevronDown
              className={
                "h-3.5 w-3.5 transition-transform " +
                (openSection === "lead" ? "rotate-0" : "-rotate-90")
              }
            />
            Lead Details
          </button>
          {!DEMO_MODE ? (
            <div className="ml-auto flex items-center gap-1">
              {activeLsq.phase === "found" && activeLsq.lead?.lead_url ? (
                <a
                  href={activeLsq.lead.lead_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
                  aria-label="Open in LSQ"
                  title="Open in LeadSquared"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  lsq.refresh();
                  lsq2.refresh();
                }}
                disabled={lsq.phase === "loading" || lsq2.phase === "loading"}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
                aria-label="Refresh from CRM"
                title="Refresh from CRM"
              >
                {lsq.phase === "loading" || lsq2.phase === "loading" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCcw className="h-3 w-3" />
                )}
              </button>
            </div>
          ) : null}
        </div>

        {openSection === "package" && !DEMO_MODE ? (
          <PackageSharedContent
            lsq={lsq}
            lsq2={lsq2}
            showSecondary={showCrmToggle}
          />
        ) : null}

        {/* LSQ sync status banner — visible at a glance whether the
            last ensure-lead attempt succeeded, plus a retry button. */}
        {openSection === "lead" ? (
          <LsqSyncStatus contact={contact} onRetry={lsq.refresh} />
        ) : null}

        {openSection === "lead" ? (
          <div className="animate-in fade-in slide-in-from-top-1 space-y-2.5 duration-200">
            {/* Branch switch — two buttons carrying the CRM names.
                Shown only when a secondary CRM is configured; styled
                like the QHT AI tool switch for a consistent panel. */}
            {showCrmToggle ? (
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-secondary p-1">
                {(
                  [
                    {
                      key: "primary" as const,
                      label: lsq.label || "Haridwar/Delhi",
                      dot: "bg-emerald-400",
                    },
                    {
                      key: "secondary" as const,
                      label: lsq2.label || "Hyderabad/Gurgaon",
                      dot: "bg-violet-400",
                    },
                  ]
                ).map((t) => {
                  const active = activeCrm === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setActiveCrm(t.key)}
                      className={cn(
                        "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-semibold transition",
                        active
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          t.dot,
                        )}
                      />
                      <span className="truncate">{t.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

        {/* Primary CRM — editable Patient info on top, read-only CRM
            record below, split by a hairline. */}
        {activeCrm === "primary" || !showCrmToggle ? (
        <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm">
          <div className="flex items-center gap-2 px-3.5 pt-3 pb-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
              Patient info
            </span>
          </div>
          <div className="space-y-0.5 px-2 pb-2">
            <EditableField
              icon={Cake}
              label="Age"
              value={lsq.lead?.age != null ? String(lsq.lead.age) : null}
              displaySuffix={lsq.lead?.age != null ? " yrs" : ""}
              loading={lsq.phase === "loading"}
              contactId={contact.id}
              schema="mx_Patient_Age"
              inputType="number"
              onSaved={lsq.refresh}
            />
            <EditableField
              icon={Globe}
              label="Country"
              value={lsq.lead?.country ?? null}
              loading={lsq.phase === "loading"}
              contactId={contact.id}
              schema="mx_Country"
              onSaved={lsq.refresh}
            />
            <CascadingLocationEditor
              city={lsq.lead?.city ?? null}
              state={lsq.lead?.state ?? null}
              country={lsq.lead?.country ?? null}
              loading={lsq.phase === "loading"}
              contactId={contact.id}
              canEdit={!!lsq.lead?.prospect_id}
              onSaved={lsq.refresh}
            />
            {/* Preferred language — from OUR DB (set by the bot), not LSQ. */}
            <Field
              icon={Globe}
              label="Preferred Language"
              value={contact.preferred_language ?? null}
            />
          </div>
          <div className="mt-1 flex items-center gap-2 border-t border-border/60 px-3.5 pt-2.5 pb-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
              CRM record
            </span>
          </div>
          <div className="space-y-0.5 px-2 pb-2.5 pt-0.5">
            <Field
              icon={Calendar}
              label="Lead Created"
              value={formatDate(lsq.lead?.created_on)}
              loading={lsq.phase === "loading"}
            />
            <LeadNumberField
              leadNumber={lsq.lead?.lead_number ?? null}
              leadUrl={lsq.lead?.lead_url ?? null}
              loading={lsq.phase === "loading"}
            />
            <Field
              icon={UserCheck}
              label="Lead Assigned"
              value={lsq.lead?.owner_name ?? null}
              loading={lsq.phase === "loading"}
            />
            {businessNumber ? (
              <Field
                icon={Activity}
                label="Via"
                value={
                  businessNumber.verified_name && businessNumber.display_phone_number
                    ? `${businessNumber.verified_name} · ${businessNumber.display_phone_number}`
                    : businessNumber.verified_name ||
                      businessNumber.display_phone_number ||
                      businessNumber.phone_number_id
                }
              />
            ) : null}
            <Field icon={Hash} label="Campaign Source" value={utm.source} />
            {utm.params?.source_id ? (
              <Field
                icon={Hash}
                label="Source ID"
                value={utm.params.source_id}
                copyable
              />
            ) : null}
            {utm.params?.source_url ? (
              <SourceUrlField url={utm.params.source_url} />
            ) : null}
            {utm.params?.ctwa_clid ? (
              <Field
                icon={Hash}
                label="Ad Click ID"
                value={utm.params.ctwa_clid.slice(0, 18) + "…"}
                copyable
                copyValue={utm.params.ctwa_clid}
              />
            ) : null}
            {adAttr?.campaign_id ? (
              <Field icon={Hash} label="Campaign ID" value={adAttr.campaign_id} copyable />
            ) : null}
            {adAttr?.campaign_name ? (
              <Field icon={Hash} label="Campaign" value={adAttr.campaign_name} copyable />
            ) : null}
            {adAttr?.adset_name ? (
              <Field icon={Hash} label="Ad set" value={adAttr.adset_name} copyable />
            ) : null}
            {adAttr?.ad_name ? (
              <Field icon={Hash} label="Ad" value={adAttr.ad_name} copyable />
            ) : null}
          </div>
        </div>
        ) : null}

        {/* Secondary (read-only) CRM — shown when its branch button is
            active. Only exists when the LSQ2_* env vars are set. */}
        {showCrmToggle && activeCrm === "secondary" ? (
          <SecondaryCrmCard lsq2={lsq2} />
        ) : null}

        {lsq.phase === "not-configured" && !DEMO_MODE ? (
          <div className="rounded-md border border-dashed bg-secondary/40 px-2 py-1.5 text-[10px] text-muted-foreground">
            CRM not connected. Lead-side fields stay empty until <span className="font-mono">/integrations/lsq</span> is configured.
          </div>
        ) : null}
          </div>
        ) : null}
      </div>

      {/* Inbound-photos strip — sits right below Lead Details so the
          operator scans CRM context first, then sees the photo
          evidence. Click any thumb → fullscreen lightbox with ←/→
          nav and a "Set as profile" action. */}
      {!DEMO_MODE ? <PhotosRow contactId={contact.id} /> : null}

      {/* Payments — links sent + paid status + manual "Send receipt"
          button. Polls every 10s so Razorpay-webhook-driven status
          changes show up without a manual refresh. */}
      {!DEMO_MODE ? (
        <div className="border-b px-4 py-3">
          <PaymentsSection contactId={contact.id} />
        </div>
      ) : null}

      {/* Tags · Notes · AI Summary — compact collapsible widget strip. */}
      {DEMO_MODE ? (
        <>
          <DemoSection title="Tags" text="Tags editor disabled in demo mode." />
          <DemoSection title="Notes" text="Notes disabled in demo mode." />
        </>
      ) : loading ? (
        <div className="border-b px-4 py-3 text-[11px] text-muted-foreground">
          Loading…
        </div>
      ) : (
        <PanelWidgets
          key={contact.id}
          contactId={contact.id}
          waId={contact.wa_id ?? null}
          contactName={contact.name ?? contact.profile_name ?? null}
          contactLeadNumber={contact.lsq_lead_number ?? null}
          initialTags={contact.tags ?? []}
          initialNotes={notes}
          currentUserId={currentUserId}
        />
      )}

      </aside>
    </>
  );
}

/** Static contact-handle row for the profile card's identity strip
 *  (phone / WhatsApp alias / etc.). Icon + value + optional caption,
 *  click-to-copy on hover, optional `href` for tel: / mailto: handoff
 *  to the OS dialler / mail client. The mono variant is for phone
 *  numbers so the digits align across rows. */
function ContactHandleRow({
  icon: Icon,
  value,
  caption,
  href,
  mono,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  caption?: string;
  href?: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API can be blocked (insecure context, browser lock).
      // Silent fail — the operator can select + ctrl-c the visible text.
    }
  };
  const Body = (
    <div className="flex min-w-0 items-center gap-2">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div
          className={
            "truncate text-xs " +
            (mono ? "font-mono tabular-nums " : "") +
            "text-foreground/90"
          }
        >
          {value}
        </div>
        {caption ? (
          <div className="truncate text-[10px] text-muted-foreground">
            {caption}
          </div>
        ) : null}
      </div>
    </div>
  );
  return (
    <div className="group flex items-center gap-2 px-3 py-2">
      {href ? (
        <a
          href={href}
          className="min-w-0 flex-1 hover:opacity-80"
          title={`Open in dialler: ${value}`}
        >
          {Body}
        </a>
      ) : (
        <div className="min-w-0 flex-1">{Body}</div>
      )}
      <button
        type="button"
        onClick={copy}
        className="shrink-0 text-[10px] font-medium text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus:opacity-100"
        title={`Copy ${value}`}
        aria-label={`Copy ${value}`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Compact inline email editor that lives in the profile-card strip
 *  (under the name + phone). Same save semantics as `EditableField`
 *  but rendered as a single-line affordance — no icon column, no
 *  uppercase label, just the value with a hover pencil. The "no email
 *  yet" placeholder still triggers the editor on click for fast first-
 *  capture. Disabled until the LSQ lead exists (canEdit). */
function InlineEmailEditor({
  email,
  contactId,
  loading,
  canEdit,
  maskEmail: shouldMask,
  onSaved,
}: {
  email: string | null;
  contactId: string;
  loading?: boolean;
  canEdit: boolean;
  maskEmail?: boolean;
  onSaved?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(email ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(email ?? "");
  }, [email, editing]);

  const startEdit = () => {
    if (!canEdit) return;
    setError(null);
    setDraft(email ?? "");
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setError(null);
    setDraft(email ?? "");
  };
  const save = async () => {
    if (saving) return;
    if (draft.trim() === (email ?? "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/lsq/lead/update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: contactId,
          fields: { EmailAddress: draft.trim() },
        }),
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

  if (editing) {
    return (
      <div className="mt-0.5 space-y-1">
        <div className="flex items-center gap-1">
          <input
            type="email"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
            disabled={saving}
            autoFocus
            placeholder="email@example.com"
            className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-xs focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
            aria-label="Save email"
          >
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={saving}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-secondary disabled:opacity-50"
            aria-label="Cancel"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        {error ? (
          <div className="text-[10px] text-destructive">{error}</div>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      disabled={!canEdit || loading}
      className="group mt-0.5 flex w-full items-center gap-1 truncate text-left text-xs text-foreground/80 disabled:cursor-default"
      title={canEdit ? "Click to edit email" : "LSQ lead not linked yet"}
    >
      <span className="truncate">
        {email ? (
          shouldMask ? maskEmail(email) : email
        ) : (
          <span className="text-muted-foreground">
            {loading ? "loading…" : "no email yet"}
          </span>
        )}
      </span>
      {canEdit ? (
        <Pencil className="h-2.5 w-2.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      ) : null}
    </button>
  );
}

/** Premium card wrapper for a logical group of lead fields. Subtle
 *  border + soft shadow + tiny inset header label — matches the look
 *  the operator sees in the rest of the dashboard's "section card"
 *  pattern, so the panel reads as deliberate UI rather than a
 *  flat list of fields. */
/** Operator-editable mirror of `Field` for LSQ lead attributes. Click
 *  the row → inline input → Save (Enter or check button) PATCHes the
 *  LSQ lead via /api/lsq/lead/update, then triggers `onSaved` so the
 *  panel refetches the lead and renders the new value. Empty input is
 *  allowed (clears the field on LSQ). Esc / X cancels. */
function EditableField({
  icon: Icon,
  label,
  value,
  loading,
  contactId,
  schema,
  inputType = "text",
  displaySuffix = "",
  onSaved,
  fullWidth = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null;
  loading?: boolean;
  contactId: string;
  /** LSQ schema name we PATCH (e.g. `EmailAddress`, `mx_Lead_City`). */
  schema: string;
  inputType?: "text" | "email" | "number";
  /** Text appended to the displayed value (e.g. " yrs" for Age) — not
   *  sent to LSQ, purely cosmetic. */
  displaySuffix?: string;
  /** Called after a successful save so the panel can refetch fresh data. */
  onSaved?: () => void;
  /** Span both columns of the parent 2-col grid — used for the odd-
   *  one-out field (e.g. Country) so it doesn't sit alone in a half-
   *  row looking lonely. */
  fullWidth?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(value ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync draft from prop when value changes (e.g. LSQ refetched and
  // returned a new value after a save). Skip while editing so we don't
  // clobber what the operator is typing.
  useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  const startEdit = () => {
    setError(null);
    setDraft(value ?? "");
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setError(null);
    setDraft(value ?? "");
  };
  const save = async () => {
    if (saving) return;
    if ((draft.trim() === "" ? "" : draft.trim()) === (value ?? "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/lsq/lead/update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: contactId,
          fields: { [schema]: draft.trim() },
        }),
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

  // Editing → full-width expanded block so the input + Save/Cancel
  // buttons get real room. Read state is a single compact line.
  if (editing) {
    return (
      <div className="col-span-2 flex items-start gap-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
          <div className="mt-1 space-y-1">
            <div className="flex items-center gap-1">
              <input
                type={inputType}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void save();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancel();
                  }
                }}
                disabled={saving}
                autoFocus
                className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                aria-label="Save"
                title="Save (Enter)"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={cancel}
                disabled={saving}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-secondary disabled:opacity-50"
                aria-label="Cancel"
                title="Cancel (Esc)"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {error ? (
              <div className="text-[11px] text-destructive">{error}</div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        "group flex items-center justify-between gap-3 rounded-md px-1.5 py-[5px] transition-colors hover:bg-secondary/60 " +
        (fullWidth ? "col-span-2" : "")
      }
    >
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
            title={value ? `${value}${displaySuffix}` : undefined}
          >
            {value ? `${value}${displaySuffix}` : "—"}
          </span>
        )}
        {!loading ? (
          <button
            type="button"
            onClick={startEdit}
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

// Read-only card body for the second LSQ account — display-only, no
// editing. Which CRM shows is driven by the branch buttons above; this
// card just renders the secondary lead (or its lookup error).
function SecondaryCrmCard({
  lsq2,
}: {
  lsq2: ReturnType<typeof useLsqLead>;
}) {
  if (lsq2.phase === "not-configured") return null;
  const lead = lsq2.lead;
  const cityState =
    [lead?.city, lead?.state].filter((p) => p && p.trim()).join(", ") || null;
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm">
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
          CRM record
        </span>
      </div>
      <div className="px-2 pb-2">
        {lsq2.phase === "loading" ? (
          <div className="px-1.5 py-1.5 text-[11px] text-muted-foreground">
            Loading…
          </div>
        ) : !lead ? (
          lsq2.error ? (
            <div className="mx-0.5 break-words rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">
              Lookup failed: {lsq2.error}
            </div>
          ) : (
            <div className="px-1.5 py-1.5 text-[11px] text-muted-foreground">
              No lead found in this CRM for this number.
            </div>
          )
        ) : (
          <div className="space-y-0.5">
            {lead.status ? (
              <div className="px-1.5 pb-1 pt-0.5">
                {(() => {
                  const tone = toneForStage(lead.status);
                  return (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
                        tone.bg,
                        tone.text,
                        tone.ring,
                      )}
                    >
                      <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} />
                      {lead.status}
                    </span>
                  );
                })()}
              </div>
            ) : null}
            <Field
              icon={Calendar}
              label="Lead #"
              value={lead.lead_number ? `#${lead.lead_number}` : null}
              mono
            />
            <Field icon={Calendar} label="Name" value={lead.full_name} />
            <Field icon={Calendar} label="Email" value={lead.email} />
            <Field
              icon={Calendar}
              label="Age"
              value={lead.age != null ? `${lead.age} yrs` : null}
            />
            <Field icon={Calendar} label="City & State" value={cityState} />
            <Field icon={Calendar} label="Country" value={lead.country} />
            <Field
              icon={Calendar}
              label="Lead created"
              value={formatDate(lead.created_on)}
            />
            <Field icon={Calendar} label="Lead owner" value={lead.owner_name} />
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  loading,
  mono,
  copyable,
  copyValue,
}: {
  /** Kept for call-site compatibility; rows render iconless now. */
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null;
  loading?: boolean;
  mono?: boolean;
  /** When true the value becomes a click-to-copy button. */
  copyable?: boolean;
  /** What actually gets put on the clipboard. Defaults to `value`. */
  copyValue?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    const toCopy = (copyValue ?? value ?? "").trim();
    if (!toCopy) return;
    try {
      await navigator.clipboard.writeText(toCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* Clipboard can be blocked — value is still visible. */
    }
  };
  return (
    <div className="group flex items-center justify-between gap-3 rounded-md px-1.5 py-[5px] transition-colors hover:bg-secondary/60">
      <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      {loading && !value ? (
        <span className="h-3 w-20 animate-pulse rounded bg-secondary" />
      ) : copyable && value ? (
        <button
          type="button"
          onClick={onCopy}
          title={copied ? "Copied" : `Click to copy: ${copyValue ?? value}`}
          className={
            "flex min-w-0 items-center gap-1 truncate transition-colors hover:text-emerald-700 " +
            (mono ? "font-mono text-[12px] " : "text-[12.5px] font-medium ") +
            "text-foreground"
          }
        >
          <span className="truncate">{value}</span>
          <span
            className={
              "shrink-0 text-[9px] font-medium transition-opacity " +
              (copied
                ? "text-emerald-700 opacity-100"
                : "text-muted-foreground opacity-0 group-hover:opacity-100")
            }
          >
            {copied ? "✓" : "Copy"}
          </span>
        </button>
      ) : (
        <span
          className={
            "min-w-0 truncate text-right " +
            (mono ? "font-mono text-[12px] " : "text-[12.5px] ") +
            (value ? "font-medium text-foreground" : "text-muted-foreground/40")
          }
          title={value ?? undefined}
        >
          {value ?? "—"}
        </span>
      )}
    </div>
  );
}

/** Turn a Click-to-WhatsApp Source URL (an Instagram or Facebook reel /
 *  post the lead tapped) into an embeddable player src. Returns null for
 *  URLs we can't embed (so we just show the link). */
function reelEmbed(rawUrl: string): { src: string } | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (host.includes("instagram.com")) {
    const m = u.pathname.match(/\/(reels?|p|tv)\/([A-Za-z0-9_-]+)/);
    if (!m) return null;
    const kind = m[1] === "reels" ? "reel" : m[1];
    return { src: `https://www.instagram.com/${kind}/${m[2]}/embed` };
  }
  if (
    host.includes("facebook.com") ||
    host.includes("fb.watch") ||
    host === "fb.me" ||
    host === "fb.gg"
  ) {
    return {
      src: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(
        rawUrl,
      )}&show_text=false&height=640`,
    };
  }
  return null;
}

/** Source URL row with an inline reel player. Instagram + Facebook reels
 *  both flow into the CTWA referral, so a ▶ opens the embed in a modal
 *  instead of bouncing the operator out to the app. */
function SourceUrlField({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const embed = reelEmbed(url);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard can be blocked */
    }
  };
  return (
    <div className="group flex items-center justify-between gap-3 rounded-md px-1.5 py-[5px] transition-colors hover:bg-secondary/60">
      <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
        Source URL
      </span>
      <div className="flex min-w-0 items-center justify-end gap-1.5">
        {embed ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            title="Play reel"
            aria-label="Play reel"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white shadow-sm transition hover:bg-emerald-700"
          >
            <Play className="h-3 w-3 fill-current" />
          </button>
        ) : null}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          title={url}
          className="truncate text-[12.5px] font-medium text-foreground hover:text-emerald-700"
        >
          {url}
        </a>
        <button
          type="button"
          onClick={copy}
          title={copied ? "Copied" : "Copy"}
          aria-label="Copy source URL"
          className={
            "shrink-0 text-[9px] font-medium transition-opacity " +
            (copied
              ? "text-emerald-700 opacity-100"
              : "text-muted-foreground opacity-0 group-hover:opacity-100")
          }
        >
          {copied ? "✓" : "Copy"}
        </button>
      </div>
      {open && embed ? (
        <ReelPlayerModal src={embed.src} url={url} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}

function ReelPlayerModal({
  src,
  url,
  onClose,
}: {
  src: string;
  url: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute -right-3 -top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-white text-foreground shadow-lg hover:bg-secondary"
        >
          <X className="h-4 w-4" />
        </button>
        <iframe
          src={src}
          title="Reel"
          className="h-[640px] max-h-[85vh] w-[360px] max-w-[92vw] rounded-xl border-0 bg-black"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 block text-center text-[11px] text-white/80 hover:text-white"
        >
          Open original ↗
        </a>
      </div>
    </div>,
    document.body,
  );
}

function DemoSection({ title, text }: { title: string; text: string }) {
  return (
    <div className="border-b p-4">
      <div className="text-sm font-semibold">{title}</div>
      <p className="mt-1 text-xs text-muted-foreground italic">{text}</p>
    </div>
  );
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  // LSQ returns "2026-04-24 06:55:17.000" — Date.parse handles it on V8.
  const d = new Date(iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// LSQ sync status — surfaces the outcome of the last ensure-lead call
// for this contact and provides a "Retry" button when something went
// wrong (or when the operator wants to re-attempt for any reason).
function LsqSyncStatus({
  contact,
  onRetry,
}: {
  contact: Contact;
  onRetry: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryMsg, setRetryMsg] = useState<string | null>(null);
  const [repushing, setRepushing] = useState(false);
  const [secsLeft, setSecsLeft] = useState<number | null>(null); // auto-retry countdown
  const attemptRef = useRef(0);

  const status = contact.lsq_last_sync_status ?? null;
  const error = contact.lsq_last_sync_error ?? null;
  const fields = contact.lsq_last_sync_fields ?? [];
  const at = contact.lsq_last_sync_at ?? null;

  // Auto-retry ONLY for a transient LSQ rate-limit — that's the one case where
  // the fields didn't land but WILL on a later attempt. Permanent failures
  // (wrong schema name / dropped-unknown-attr) won't self-heal, so they don't
  // auto-retry; the operator fixes the config and re-pushes manually.
  const isRateLimited = !!error && /rate|limit|exceeded/i.test(error);
  const pushFailed = !!error && /re_attribute_failed/i.test(error);
  const needsRetry = isRateLimited;

  // Reset the attempt counter when the operator opens a different contact.
  useEffect(() => {
    attemptRef.current = 0;
  }, [contact.id]);

  if (!status) {
    // Never attempted yet — keep the panel clean.
    return null;
  }

  async function retry() {
    setRetrying(true);
    setRetryMsg(null);
    try {
      const res = await fetch("/api/lsq/ensure-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contact.id }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setRetryMsg(json.error ?? `HTTP ${res.status}`);
      } else {
        setRetryMsg("Sync retried — refresh the lead details to see changes.");
        onRetry();
      }
    } catch (e) {
      setRetryMsg(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  }

  // Force re-push: re-stamp Source / fb-ad / default fields onto the LSQ lead
  // even when the "update existing" toggle is off (and ignoring the age gate).
  // For when an earlier sync dropped fields due to an LSQ rate-limit.
  async function repush() {
    setRepushing(true);
    setRetryMsg(null);
    try {
      const res = await fetch("/api/lsq/ensure-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contact.id, force: true }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; fields_pushed?: string[] };
      if (!res.ok || !json.ok) {
        setRetryMsg(json.error ?? `HTTP ${res.status}`);
      } else {
        const pushed = json.fields_pushed ?? [];
        setRetryMsg(
          pushed.length
            ? `Re-pushed: ${pushed.join(", ")}`
            : "Re-push done — no fields to update.",
        );
        onRetry();
      }
    } catch (e) {
      setRetryMsg(e instanceof Error ? e.message : "Re-push failed");
    } finally {
      setRepushing(false);
    }
  }

  // Auto-retry: when a push didn't land all fields, re-push after 2 min, then
  // 5 min (max 2 auto attempts). Keyed on the last-sync timestamp so each
  // completed attempt re-evaluates and schedules the next only if still
  // incomplete. Counter resets per contact (above). Operator can still
  // re-push manually any time.
  const AUTO_DELAYS = [120, 300]; // seconds: 2 min, then 5 min
  useEffect(() => {
    if (!needsRetry || attemptRef.current >= AUTO_DELAYS.length || repushing || retrying) {
      setSecsLeft(null);
      return;
    }
    const delay = AUTO_DELAYS[attemptRef.current];
    setSecsLeft(delay);
    const iv = setInterval(() => setSecsLeft((s) => (s != null && s > 1 ? s - 1 : 0)), 1000);
    const to = setTimeout(() => {
      clearInterval(iv);
      attemptRef.current += 1;
      void repush();
    }, delay * 1000);
    return () => {
      clearInterval(iv);
      clearTimeout(to);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsRetry, at]);

  const palette: Record<string, { bg: string; ring: string; text: string; label: string }> = {
    created: {
      bg: "bg-emerald-50",
      ring: "ring-emerald-200",
      text: "text-emerald-900",
      label: "Lead created in LSQ",
    },
    linked: {
      bg: "bg-sky-50",
      ring: "ring-sky-200",
      text: "text-sky-900",
      label: "Linked to existing lead",
    },
    skipped: {
      bg: "bg-slate-50",
      ring: "ring-slate-200",
      text: "text-slate-800",
      label: "Sync skipped",
    },
    error: {
      bg: "bg-rose-50",
      ring: "ring-rose-200",
      text: "text-rose-900",
      label: "Sync error",
    },
  };
  const p = palette[status] ?? palette.skipped;
  const when = at
    ? new Date(at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div
      className={
        "rounded-md px-2.5 py-2 text-[11px] ring-1 ring-inset " + p.bg + " " + p.ring + " " + p.text
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{p.label}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={repush}
            disabled={repushing || retrying}
            title="Source / campaign fields ko LSQ lead pe force re-push karo"
            className="inline-flex items-center gap-1 rounded-md border bg-white px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-secondary disabled:opacity-50"
          >
            {repushing ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <RefreshCcw className="h-2.5 w-2.5" />}
            {repushing ? "Re-pushing…" : "Re-push fields"}
          </button>
          <button
            type="button"
            onClick={retry}
            disabled={retrying || repushing}
            className="inline-flex items-center gap-1 rounded-md border bg-white px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-secondary disabled:opacity-50"
          >
            {retrying ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <RefreshCcw className="h-2.5 w-2.5" />}
            {retrying ? "Retrying…" : "Retry sync"}
          </button>
        </div>
      </div>
      {error ? (
        <p className="mt-1 break-words text-[10px] opacity-90">{error}</p>
      ) : null}
      {fields.length > 0 && (status === "created" || status === "linked") && !pushFailed ? (
        <p className="mt-1 text-[10px] opacity-80">
          Fields pushed: <span className="font-mono">{fields.join(", ")}</span>
        </p>
      ) : null}
      {pushFailed && fields.length > 0 ? (
        <p className="mt-1 text-[10px] opacity-80">
          Pending (rate-limit se push nahi hue): <span className="font-mono">{fields.join(", ")}</span>
        </p>
      ) : null}
      {when ? <p className="mt-1 text-[10px] opacity-60">{when}</p> : null}
      {secsLeft != null ? (
        <p className="mt-1 text-[10px] font-semibold opacity-90">
          Sabhi fields push nahi hue — auto-retry in {Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, "0")} (attempt {attemptRef.current + 1}/{AUTO_DELAYS.length})
        </p>
      ) : null}
      {retryMsg ? (
        <p className="mt-1.5 rounded border-t border-current/10 pt-1 text-[10px]">
          {retryMsg}
        </p>
      ) : null}
    </div>
  );
}

