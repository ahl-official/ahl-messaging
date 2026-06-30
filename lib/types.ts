import { formatPhone, formatPhoneMasked } from "@/lib/phone";

export interface BusinessNumber {
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  /** Operator-set display label — overrides verified_name everywhere
   *  the number is shown (chat-card chip, pickers, etc.). */
  nickname?: string | null;
  created_at?: string;
}

export interface Contact {
  id: string;
  wa_id: string;
  name: string | null;
  profile_name: string | null;
  last_message_at: string | null;
  /** Timestamp of the patient's most-recent INBOUND message — drives the
   *  real-time 24h customer-service window (open until 24h after this).
   *  Nullable: older rows may not have it; the inbox falls back to
   *  last_message_at when the last message was inbound, else `status`. */
  last_inbound_at?: string | null;
  last_message_preview: string | null;
  /** Direction of the most-recent message — drives the contact card's
   *  inline tick / "Reply" CTA. Populated by webhook + send routes. */
  last_message_direction?: "inbound" | "outbound" | null;
  /** Delivery status of the most-recent message. Inbound messages get the
   *  synthetic value "received"; outbound walks sent → delivered → read
   *  (or "failed"). Used to render emerald ✓✓ when read, gray when not. */
  last_message_status?:
    | "sent"
    | "delivered"
    | "read"
    | "failed"
    | "received"
    | null;
  unread_count: number;
  business_phone_number_id?: string | null;
  tags?: string[] | null;
  /** Workspace-defined labels (max 3). UUIDs that reference
   *  contact_labels rows; order matters — chip strip honours it. */
  label_ids?: string[] | null;
  status?: "open" | "closed" | null;
  assigned_to?: string | null;
  assigned_to_email?: string | null;
  assigned_at?: string | null;
  /** Set when the AI bot auto-blocked this chat for repeated off-topic /
   *  personal messages. Bot stays silent; a human can still reply. */
  bot_blocked_at?: string | null;
  bot_blocked_reason?: string | null;
  /** Patient's chosen reply language (set by the bot). The bot replies in
   *  this language on every turn; also pushed to LSQ mx_Religion. */
  preferred_language?: string | null;
  /** LSQ ProspectStage cached locally so the contact list can render
   *  the badge without a per-row API call. Populated by /api/lsq/lead
   *  the first time the contact is opened, refreshed on each visit. */
  lsq_stage?: string | null;
  lsq_lead_number?: string | null;
  lsq_owner_name?: string | null;
  lsq_owner_email?: string | null;
  lsq_prospect_id?: string | null;
  lsq_synced_at?: string | null;
  /** LSQ source fields cached locally (for the CRM-style lead table view). */
  lsq_source?: string | null;
  lsq_sub_source?: string | null;
  utm_source?: string | null;
  utm_params?: Record<string, unknown> | null;
  /** Per-contact LSQ sync diagnostic (populated by ensure-lead). */
  lsq_last_sync_at?: string | null;
  lsq_last_sync_status?: "created" | "linked" | "skipped" | "error" | null;
  lsq_last_sync_error?: string | null;
  lsq_last_sync_fields?: string[] | null;
  /** Operator-uploaded photo (Supabase Storage public URL). Falls
   *  back to the avatar initials when null. Stored as a public URL so
   *  the contact list can render it without a per-row signed-URL fetch. */
  avatar_url?: string | null;
  /** True when this "contact" is actually a WhatsApp group. Groups are
   *  read-only and surface under the inbox "Groups" filter. */
  is_group?: boolean | null;
  /** True when the contact came in via the chat-import tool — a
   *  historical export, not a live thread. Inbox marks it "Past chat". */
  imported?: boolean | null;
  /** How many contact rows share this wa_id (one per business number).
   *  Stamped by the Contact Hub query when deduping so the table can
   *  show "× N numbers" without re-querying. Absent on inbox/dashboard
   *  rows where each bpid keeps its own row. */
  linked_numbers_count?: number;
  created_at: string;
}

export interface ContactNote {
  id: string;
  contact_id: string;
  body: string;
  created_by: string | null;
  created_by_email: string | null;
  created_at: string;
}

export interface TemplateButton {
  type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER" | "COPY_CODE";
  text?: string;
  url?: string;
  phone_number?: string;
  example?: string | string[];
}

export interface Message {
  id: string;
  contact_id: string;
  wa_message_id: string | null;
  direction: "inbound" | "outbound";
  type: string;
  content: string | null;
  media_url: string | null;
  media_mime_type: string | null;
  status: "sent" | "delivered" | "read" | "failed";
  error_message: string | null;
  business_phone_number_id?: string | null;
  timestamp: string;
  // Template-specific metadata (only set for type='template' outbound rows)
  template_footer?: string | null;
  template_buttons?: TemplateButton[] | null;
  // Audit — which agent sent this message (outbound only)
  sent_by_user_id?: string | null;
  sent_by_email?: string | null;
  /** Quoted-reply pointer — set when this message is a reply to a
   *  specific earlier message (WhatsApp swipe-reply). */
  reply_to_wa_message_id?: string | null;
  /** Cached snippet of the quoted message body. */
  reply_to_content?: string | null;
  /** Direction of the quoted message (drives the quote-header label). */
  reply_to_direction?: "inbound" | "outbound" | null;
  /** Non-null when the message was edited via Meta's edit API. */
  edited_at?: string | null;
  /** Non-null when the message was "deleted for everyone" via Meta —
   *  the row stays as a tombstone so chat order is preserved. */
  deleted_at?: string | null;
  /** Pre-edit copy, kept for audit. NULL when never edited. */
  original_content?: string | null;
  /** For group messages — the participant who sent it. NULL for 1:1
   *  (where the contact itself is the sender). */
  sender_name?: string | null;
}

export function businessNumberLabel(b?: BusinessNumber | null): string {
  if (!b) return "";
  const name = b.nickname?.trim() || b.verified_name?.trim() || "";
  if (name && b.display_phone_number) return `${name} · ${b.display_phone_number}`;
  return name || b.display_phone_number || b.phone_number_id;
}

export function contactDisplayName(c: Contact): string {
  return c.name?.trim() || c.profile_name?.trim() || formatPhone(c.wa_id);
}

/** Like contactDisplayName, but masks the phone-number fallback when
 *  the viewer's effective permissions ask for phone masking. The real
 *  name (if set) is kept as-is — masking only hides PII the viewer
 *  doesn't already have. */
export function contactDisplayNameMasked(c: Contact, maskPhone: boolean): string {
  const named = c.name?.trim() || c.profile_name?.trim();
  if (named) return named;
  return maskPhone ? formatPhoneMasked(c.wa_id) : formatPhone(c.wa_id);
}

export function contactInitials(c: Contact): string {
  const name = contactDisplayName(c);
  const cleaned = name.replace(/^\+/, "");
  const parts = cleaned.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}
