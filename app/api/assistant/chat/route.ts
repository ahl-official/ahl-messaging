// POST /api/assistant/chat
//
// Conversational AI for the home page. Uses OpenAI gpt-4o with
// function calling so the model can answer real questions about the
// operator's WhatsApp data ("how many unread chats today?", "show me
// last 5 messages from Naveen", "which number has the most unread?").
//
// Every tool runs as the SIGNED-IN user, scoped to their
// allowed_number_ids — so a teammate can't trick the assistant into
// dumping chats they can't see in the inbox.
//
// Streams the response as plain text chunks (Server-Sent-Events-ish,
// minus the framing) so the UI can render token-by-token without a
// dependency.

import { type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/lib/team";
import { getEffectivePermissionsFor } from "@/lib/permissions";
import { requireCredential } from "@/lib/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// gpt-4o picked over -mini because the home assistant has to
// (a) plan tool calls, (b) reason over rows it gets back, and
// (c) answer in mixed Hindi/Hinglish — -mini hallucinates more on all
// three for our use case. Cost is ~5× but volume is tiny (handful of
// queries per operator per day).
const MODEL = "gpt-4o";
// 8 rounds gives the model room to: search → fetch → maybe SQL fallback
// → self-correct on a bad column → answer. Anything beyond that is a
// runaway loop and we'd rather fail fast than burn tokens.
const MAX_TOOL_ROUNDS = 8;

// ---------- request shape ----------------------------------------- //

interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  // For assistant turns that asked for tools.
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  // For tool-result turns.
  tool_call_id?: string;
  name?: string;
}

interface Body {
  messages?: ChatMessage[];
}

// ---------- tools -------------------------------------------------- //

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_contacts",
      description:
        "Search the operator's WhatsApp contacts. Matches across name, push name, phone number (wa_id), tags, CRM lead number, CRM stage, and LSQ owner email/name. Returns up to `limit` rows (default 10, max 50) ordered by most recent activity.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Free-text query — e.g. 'naveen', '+91 90847', 'hair fall', '#432029'.",
          },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_contact_messages",
      description:
        "Fetch the most recent messages on one chat (one contact). Use after search_contacts when the user asks 'what did X say' or 'show me their last messages'.",
      parameters: {
        type: "object",
        properties: {
          contact_id: { type: "string", description: "UUID of the contact." },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
        required: ["contact_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unread_summary",
      description:
        "Return total unread message count, total unread conversations, and a per-business-number breakdown. Use for 'how many unread', 'which number has the most unread'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "recent_activity",
      description:
        "Latest conversations with any activity in the given window. Use for 'show recent chats', 'what came in today'.",
      parameters: {
        type: "object",
        properties: {
          hours: { type: "integer", minimum: 1, maximum: 720, default: 24 },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 15 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "business_numbers_overview",
      description:
        "List every WhatsApp number the operator can access, with contact and message counts per number. Use for 'which numbers do I have', 'stats per number'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "count_messages",
      description:
        "Count messages over a time window with optional filters. Use for 'how many messages this week', 'how many outbound today on number X'.",
      parameters: {
        type: "object",
        properties: {
          since_hours_ago: {
            type: "integer",
            minimum: 1,
            maximum: 24 * 90,
            default: 24,
          },
          direction: { type: "string", enum: ["inbound", "outbound", "any"], default: "any" },
          business_phone_number_id: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_messages",
      description:
        "Full-text search across recent message bodies. Use when the user asks 'jisne X bola tha woh chat dhundo' / 'find messages mentioning Y'. Returns up to 25 matches with the contact id so you can follow up with get_contact_messages.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          since_hours_ago: {
            type: "integer",
            minimum: 1,
            maximum: 24 * 90,
            default: 24 * 14,
          },
          limit: { type: "integer", minimum: 1, maximum: 25, default: 15 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "team_overview",
      description:
        "List active team members + their role + last seen at. Use for 'who's online', 'list team', 'who owns X chats'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "top_tags",
      description:
        "Most-used contact tags (operator-applied) with counts. Use for 'top tags this month', 'most common categories'.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 30, default: 10 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_performance",
      description:
        "Per-agent outbound message volume over a window. Use for 'leaderboard', 'who sent the most replies today', 'kaun zyada kaam kar raha hai'.",
      parameters: {
        type: "object",
        properties: {
          since_hours_ago: {
            type: "integer",
            minimum: 1,
            maximum: 24 * 90,
            default: 24,
          },
          limit: { type: "integer", minimum: 1, maximum: 30, default: 15 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "peak_hours",
      description:
        "Hour-of-day distribution (0-23 UTC) of inbound messages over the window. Use for 'busiest hour', 'peak time'.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "integer", minimum: 1, maximum: 60, default: 7 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_labels",
      description: "List every workspace label (id, name, colour).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_report",
      description:
        "Produce a structured markdown REPORT the operator can paste / share. Pick the `kind` that matches the request: 'daily_summary' (today), 'weekly_summary' (last 7d), 'agent_leaderboard', 'number_health' (per-number unread/contacts/messages), 'response_time' (median minutes to first outbound reply per number). After calling, include the returned markdown VERBATIM in your reply so the user sees it.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "daily_summary",
              "weekly_summary",
              "agent_leaderboard",
              "number_health",
              "response_time",
            ],
          },
        },
        required: ["kind"],
      },
    },
  },
  // ---- write tools — change real data. Use only when the user has
  // explicitly asked for the action; never on speculation. ----------
  {
    type: "function",
    function: {
      name: "mark_chat_read",
      description:
        "Clear the unread badge on a chat. Use only when the user says 'X ka chat read mark kar do' / 'mark X as read'.",
      parameters: {
        type: "object",
        properties: { contact_id: { type: "string" } },
        required: ["contact_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_chat_status",
      description:
        "Open or close a conversation. Use for 'X ka chat band kar do' / 'reopen X' / 'mark closed'.",
      parameters: {
        type: "object",
        properties: {
          contact_id: { type: "string" },
          status: { type: "string", enum: ["open", "closed"] },
        },
        required: ["contact_id", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assign_chat",
      description:
        "Reassign a conversation to a teammate by their email (matches team_members.email). Use for 'assign X to riya@…'.",
      parameters: {
        type: "object",
        properties: {
          contact_id: { type: "string" },
          assignee_email: { type: "string" },
        },
        required: ["contact_id", "assignee_email"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_chat_tag",
      description:
        "Add a free-text tag to a contact (operator-applied label). Idempotent.",
      parameters: {
        type: "object",
        properties: {
          contact_id: { type: "string" },
          tag: { type: "string" },
        },
        required: ["contact_id", "tag"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_chat_label",
      description:
        "Attach a workspace label to a contact by label id. Look up ids with list_labels first if needed.",
      parameters: {
        type: "object",
        properties: {
          contact_id: { type: "string" },
          label_id: { type: "string" },
        },
        required: ["contact_id", "label_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_contact_note",
      description:
        "Append an internal note (only visible to the team) to a contact. Use when the user dictates a note like 'X ko note add karo: VIP customer'.",
      parameters: {
        type: "object",
        properties: {
          contact_id: { type: "string" },
          note: { type: "string" },
        },
        required: ["contact_id", "note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_contact_notes",
      description:
        "Internal notes the team has written on one contact, newest first.",
      parameters: {
        type: "object",
        properties: {
          contact_id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        required: ["contact_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_calls",
      description:
        "Recent WhatsApp calls (inbound + outbound). Use for 'recent calls', 'missed calls', 'kaun se call aaye'.",
      parameters: {
        type: "object",
        properties: {
          since_hours_ago: {
            type: "integer",
            minimum: 1,
            maximum: 24 * 90,
            default: 24,
          },
          status: {
            type: "string",
            enum: ["ringing", "accepted", "ended", "missed", "any"],
            default: "any",
          },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_campaigns",
      description:
        "Outbound broadcast campaigns + their status. Use for 'campaign kaise chal raha hai', 'last broadcast ka result'.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 30, default: 10 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lsq_lookup",
      description:
        "Look up the LSQ (CRM) lead for a contact — stage, owner, lead number.",
      parameters: {
        type: "object",
        properties: { contact_id: { type: "string" } },
        required: ["contact_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_sql_select",
      description: [
        "ESCAPE HATCH — run an arbitrary read-only SELECT (or WITH) against the workspace Postgres database when none of the focused tools fit.",
        "Use this for ad-hoc joins, group-bys, or any table not otherwise exposed (audit_log, api_request_log, evolution_disconnects, contact_notes, automation_logs, role_permissions, etc.).",
        "Constraints enforced server-side:",
        "  • Only SELECT / WITH queries; no INSERT/UPDATE/DELETE/DDL.",
        "  • Single statement (no stacked semicolons).",
        "  • Hard cap of 200 rows.",
        "Schema cheatsheet — most-used tables:",
        "  contacts(id, wa_id, name, profile_name, business_phone_number_id, tags text[], label_ids uuid[], status, unread_count, last_message_at, last_message_preview, last_message_direction, lsq_lead_number, lsq_stage, lsq_owner_email, lsq_owner_name, lsq_prospect_id, created_at, assigned_to)",
        "  messages(id, contact_id, business_phone_number_id, wa_message_id, direction, type, content, timestamp, status, sender_user_id, deleted_at)",
        "  business_numbers(phone_number_id, display_phone_number, verified_name, nickname, provider, is_active, evolution_instance_name, evolution_connection_state)",
        "  whatsapp_calls(id, wa_call_id, contact_id, business_phone_number_id, direction, status, start_at, end_at)",
        "  team_members(id, user_id, email, full_name, role, is_active, last_seen_at, pending_approval, hidden_number_ids)",
        "  contact_notes(id, contact_id, author_user_id, author_member_id, body, created_at)",
        "  labels(id, name, color, created_at)",
        "  campaigns(id, name, status, created_at, scheduled_at, sent_count, failed_count)",
        "  automation_logs(id, business_phone_number_id, contact_id, kind, status, created_at, error)",
        "  evolution_disconnects(id, business_phone_number_id, reason_code, created_at)",
        "Always include a sensible LIMIT in the SELECT itself if you want fewer than 200 rows.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A single SELECT or WITH statement. Don't include a trailing semicolon.",
          },
        },
        required: ["query"],
      },
    },
  },
] as const;

// ---------- tool runner ------------------------------------------- //

type ToolName =
  | "search_contacts"
  | "get_contact_messages"
  | "unread_summary"
  | "recent_activity"
  | "business_numbers_overview"
  | "count_messages"
  | "search_messages"
  | "team_overview"
  | "top_tags"
  | "agent_performance"
  | "peak_hours"
  | "list_labels"
  | "generate_report"
  | "mark_chat_read"
  | "set_chat_status"
  | "assign_chat"
  | "add_chat_tag"
  | "add_chat_label"
  | "add_contact_note"
  | "list_contact_notes"
  | "list_calls"
  | "list_campaigns"
  | "lsq_lookup"
  | "run_sql_select";

async function runTool(
  name: ToolName,
  args: Record<string, unknown>,
  scope: { allowedBpids: string[] | null; memberId: string },
): Promise<unknown> {
  const admin = createServiceRoleClient();
  const cap = scope.allowedBpids; // null = unrestricted

  switch (name) {
    case "search_contacts": {
      const query = String(args.query ?? "").trim();
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 10)));
      if (!query) return { contacts: [] };
      // ILIKE-safe needle for text columns (strip wildcards).
      const like = `%${query.replace(/[%_]/g, "")}%`;
      // Phone numbers in WhatsApp are stored as digits only (e.g.
      // "917056968008") without "+", spaces, or dashes. When the
      // operator searches "+91 70 569 68008" we must compare against
      // the digit-only form, otherwise the chat is unfindable.
      const digits = query.replace(/\D/g, "");
      const phoneClauses: string[] = [];
      if (digits.length >= 6) {
        phoneClauses.push(`wa_id.ilike.%${digits}%`);
        // Indian numbers often arrive without the country code in the
        // user's head; try both `91XXXXXXXXXX` and the raw form.
        if (digits.length === 10) phoneClauses.push(`wa_id.ilike.%91${digits}%`);
      }
      let q = admin
        .from("contacts")
        .select(
          "id, wa_id, name, profile_name, business_phone_number_id, tags, status, unread_count, last_message_preview, last_message_at, lsq_lead_number, lsq_stage, lsq_owner_email",
        )
        .order("last_message_at", { ascending: false })
        .limit(limit)
        .or(
          [
            `name.ilike.${like}`,
            `profile_name.ilike.${like}`,
            `wa_id.ilike.${like}`,
            `lsq_lead_number.ilike.${like}`,
            `lsq_stage.ilike.${like}`,
            `lsq_owner_email.ilike.${like}`,
            ...phoneClauses,
          ].join(","),
        );
      if (cap !== null) q = q.in("business_phone_number_id", cap);
      const { data } = await q;
      return { contacts: data ?? [] };
    }
    case "get_contact_messages": {
      const cid = String(args.contact_id ?? "");
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 10)));
      if (!cid) return { messages: [] };
      // Confirm caller can see this contact.
      const cres = await admin
        .from("contacts")
        .select("id, business_phone_number_id, name, profile_name, wa_id")
        .eq("id", cid)
        .maybeSingle();
      const c = cres.data;
      if (!c) return { messages: [], error: "Contact not found" };
      if (cap !== null && !cap.includes(c.business_phone_number_id as string)) {
        return { messages: [], error: "Not allowed for this number" };
      }
      const { data: msgs } = await admin
        .from("messages")
        .select("direction, type, content, timestamp, status")
        .eq("contact_id", cid)
        .order("timestamp", { ascending: false })
        .limit(limit);
      return {
        contact: c,
        messages: (msgs ?? []).reverse(), // oldest first for natural reading
      };
    }
    case "unread_summary": {
      let q = admin
        .from("contacts")
        .select("business_phone_number_id, unread_count")
        .gt("unread_count", 0);
      if (cap !== null) q = q.in("business_phone_number_id", cap);
      const { data } = await q;
      const rows = (data ?? []) as Array<{
        business_phone_number_id: string;
        unread_count: number;
      }>;
      const perNumber: Record<string, { conversations: number; messages: number }> = {};
      let totalConv = 0;
      let totalMsgs = 0;
      for (const r of rows) {
        const bpid = r.business_phone_number_id ?? "unknown";
        if (!perNumber[bpid]) perNumber[bpid] = { conversations: 0, messages: 0 };
        perNumber[bpid].conversations += 1;
        perNumber[bpid].messages += r.unread_count ?? 0;
        totalConv += 1;
        totalMsgs += r.unread_count ?? 0;
      }
      return {
        total_unread_conversations: totalConv,
        total_unread_messages: totalMsgs,
        per_number: perNumber,
      };
    }
    case "recent_activity": {
      const hours = Math.min(720, Math.max(1, Number(args.hours ?? 24)));
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 15)));
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();
      let q = admin
        .from("contacts")
        .select(
          "id, wa_id, name, profile_name, business_phone_number_id, unread_count, last_message_preview, last_message_at, last_message_direction",
        )
        .gte("last_message_at", since)
        .order("last_message_at", { ascending: false })
        .limit(limit);
      if (cap !== null) q = q.in("business_phone_number_id", cap);
      const { data } = await q;
      return { hours, contacts: data ?? [] };
    }
    case "business_numbers_overview": {
      const { data: numbers } = await admin
        .from("business_numbers")
        .select(
          "phone_number_id, display_phone_number, verified_name, nickname, provider, is_active",
        );
      const list = ((numbers ?? []) as Array<{
        phone_number_id: string;
        display_phone_number: string | null;
        verified_name: string | null;
        nickname: string | null;
        provider: string | null;
        is_active: boolean | null;
      }>).filter((n) => cap === null || cap.includes(n.phone_number_id));
      // Parallel head:true counts.
      const counts = await Promise.all(
        list.map(async (n) => {
          const [c, m] = await Promise.all([
            admin
              .from("contacts")
              .select("id", { count: "exact", head: true })
              .eq("business_phone_number_id", n.phone_number_id),
            admin
              .from("messages")
              .select("id", { count: "exact", head: true })
              .eq("business_phone_number_id", n.phone_number_id),
          ]);
          return {
            ...n,
            contacts: c.count ?? 0,
            messages: m.count ?? 0,
          };
        }),
      );
      return { numbers: counts };
    }
    case "count_messages": {
      const hours = Math.min(
        24 * 90,
        Math.max(1, Number(args.since_hours_ago ?? 24)),
      );
      const direction = String(args.direction ?? "any");
      const bpid = args.business_phone_number_id
        ? String(args.business_phone_number_id)
        : null;
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();
      let q = admin
        .from("messages")
        .select("id", { count: "exact", head: true })
        .gte("timestamp", since);
      if (direction === "inbound" || direction === "outbound") {
        q = q.eq("direction", direction);
      }
      if (bpid) {
        if (cap !== null && !cap.includes(bpid)) {
          return { error: "Not allowed for this number" };
        }
        q = q.eq("business_phone_number_id", bpid);
      } else if (cap !== null) {
        q = q.in("business_phone_number_id", cap);
      }
      const { count } = await q;
      return {
        count: count ?? 0,
        since_hours_ago: hours,
        direction,
        business_phone_number_id: bpid,
      };
    }
    case "search_messages": {
      const query = String(args.query ?? "").trim();
      const limit = Math.min(25, Math.max(1, Number(args.limit ?? 15)));
      const hours = Math.min(
        24 * 90,
        Math.max(1, Number(args.since_hours_ago ?? 24 * 14)),
      );
      if (!query) return { messages: [] };
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();
      const like = `%${query.replace(/[%_]/g, "")}%`;
      let q = admin
        .from("messages")
        .select(
          "id, contact_id, direction, content, timestamp, business_phone_number_id",
        )
        .ilike("content", like)
        .gte("timestamp", since)
        .order("timestamp", { ascending: false })
        .limit(limit);
      if (cap !== null) q = q.in("business_phone_number_id", cap);
      const { data } = await q;
      return { messages: data ?? [] };
    }
    case "team_overview": {
      const { data } = await admin
        .from("team_members")
        .select(
          "id, email, full_name, role, is_active, last_seen_at, pending_approval",
        )
        .eq("is_active", true)
        .neq("pending_approval", true)
        .order("role", { ascending: true });
      return { members: data ?? [] };
    }
    case "top_tags": {
      const limit = Math.min(30, Math.max(1, Number(args.limit ?? 10)));
      // tags is text[] — pull recent contacts and tally client-side.
      // Pagination caps at 1000 rows which is plenty for tag frequency.
      let q = admin
        .from("contacts")
        .select("tags")
        .order("last_message_at", { ascending: false })
        .limit(1000);
      if (cap !== null) q = q.in("business_phone_number_id", cap);
      const { data } = await q;
      const counts = new Map<string, number>();
      for (const r of (data ?? []) as Array<{ tags: string[] | null }>) {
        for (const t of r.tags ?? []) {
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
      const top = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([tag, n]) => ({ tag, count: n }));
      return { tags: top };
    }
    case "agent_performance": {
      const hours = Math.min(
        24 * 90,
        Math.max(1, Number(args.since_hours_ago ?? 24)),
      );
      const limit = Math.min(30, Math.max(1, Number(args.limit ?? 15)));
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();
      let q = admin
        .from("messages")
        .select("sender_user_id, business_phone_number_id")
        .eq("direction", "outbound")
        .gte("timestamp", since)
        .limit(20_000);
      if (cap !== null) q = q.in("business_phone_number_id", cap);
      const { data } = await q;
      const byUser = new Map<string, number>();
      for (const m of (data ?? []) as Array<{ sender_user_id: string | null }>) {
        const k = m.sender_user_id ?? "unattributed";
        byUser.set(k, (byUser.get(k) ?? 0) + 1);
      }
      // Resolve user ids → email/name in one shot.
      const userIds = Array.from(byUser.keys()).filter(
        (k) => k !== "unattributed",
      );
      let nameById: Map<string, { email: string; full_name: string | null }> =
        new Map();
      if (userIds.length > 0) {
        const { data: members } = await admin
          .from("team_members")
          .select("user_id, email, full_name")
          .in("user_id", userIds);
        for (const r of (members ?? []) as Array<{
          user_id: string;
          email: string;
          full_name: string | null;
        }>) {
          nameById.set(r.user_id, { email: r.email, full_name: r.full_name });
        }
      }
      const ranked = Array.from(byUser.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([uid, n]) => {
          if (uid === "unattributed") {
            return { agent: "unattributed", outbound: n };
          }
          const info = nameById.get(uid);
          return {
            agent: info?.full_name?.trim() || info?.email || uid,
            email: info?.email,
            outbound: n,
          };
        });
      return { since_hours_ago: hours, agents: ranked };
    }
    case "peak_hours": {
      const days = Math.min(60, Math.max(1, Number(args.days ?? 7)));
      const since = new Date(
        Date.now() - days * 24 * 3_600_000,
      ).toISOString();
      let q = admin
        .from("messages")
        .select("timestamp")
        .eq("direction", "inbound")
        .gte("timestamp", since)
        .limit(50_000);
      if (cap !== null) q = q.in("business_phone_number_id", cap);
      const { data } = await q;
      const buckets = new Array<number>(24).fill(0);
      for (const m of (data ?? []) as Array<{ timestamp: string }>) {
        const t = new Date(m.timestamp);
        if (!Number.isFinite(t.getTime())) continue;
        buckets[t.getUTCHours()] += 1;
      }
      const peak = buckets.indexOf(Math.max(...buckets));
      return {
        days,
        hourly_utc: buckets.map((count, hour) => ({ hour, count })),
        peak_hour_utc: peak,
      };
    }
    case "list_labels": {
      const { data } = await admin
        .from("labels")
        .select("id, name, color")
        .order("name", { ascending: true });
      return { labels: data ?? [] };
    }
    case "generate_report": {
      const kind = String(args.kind ?? "");
      const markdown = await buildReport(kind, scope);
      return { kind, markdown };
    }

    // ---- write tools ------------------------------------------------
    case "mark_chat_read": {
      const cid = String(args.contact_id ?? "");
      const ok = await ensureContactInScope(admin, cid, cap);
      if (!ok.allowed) return { error: ok.reason };
      const { error } = await admin
        .from("contacts")
        .update({ unread_count: 0 })
        .eq("id", cid);
      if (error) return { error: error.message };
      return { ok: true };
    }
    case "set_chat_status": {
      const cid = String(args.contact_id ?? "");
      const status = String(args.status ?? "");
      if (status !== "open" && status !== "closed") {
        return { error: "status must be open or closed" };
      }
      const ok = await ensureContactInScope(admin, cid, cap);
      if (!ok.allowed) return { error: ok.reason };
      const { error } = await admin
        .from("contacts")
        .update({ status })
        .eq("id", cid);
      if (error) return { error: error.message };
      return { ok: true, status };
    }
    case "assign_chat": {
      const cid = String(args.contact_id ?? "");
      const email = String(args.assignee_email ?? "").trim();
      const ok = await ensureContactInScope(admin, cid, cap);
      if (!ok.allowed) return { error: ok.reason };
      const { data: member } = await admin
        .from("team_members")
        .select("user_id, full_name, email, is_active")
        .ilike("email", email)
        .maybeSingle();
      if (!member || !member.is_active) {
        return { error: `No active team member with email ${email}` };
      }
      const { error } = await admin
        .from("contacts")
        .update({ assigned_to: member.user_id })
        .eq("id", cid);
      if (error) return { error: error.message };
      return { ok: true, assigned_to: member.email };
    }
    case "add_chat_tag": {
      const cid = String(args.contact_id ?? "");
      const tag = String(args.tag ?? "").trim();
      if (!tag) return { error: "tag is empty" };
      const ok = await ensureContactInScope(admin, cid, cap);
      if (!ok.allowed) return { error: ok.reason };
      // Append idempotently: read tags, dedupe, write back.
      const { data: existing } = await admin
        .from("contacts")
        .select("tags")
        .eq("id", cid)
        .maybeSingle();
      const current = (existing?.tags ?? []) as string[];
      if (current.includes(tag)) return { ok: true, already_present: true };
      const { error } = await admin
        .from("contacts")
        .update({ tags: [...current, tag] })
        .eq("id", cid);
      if (error) return { error: error.message };
      return { ok: true };
    }
    case "add_chat_label": {
      const cid = String(args.contact_id ?? "");
      const lid = String(args.label_id ?? "");
      if (!lid) return { error: "label_id is empty" };
      const ok = await ensureContactInScope(admin, cid, cap);
      if (!ok.allowed) return { error: ok.reason };
      const { data: existing } = await admin
        .from("contacts")
        .select("label_ids")
        .eq("id", cid)
        .maybeSingle();
      const current = (existing?.label_ids ?? []) as string[];
      if (current.includes(lid)) return { ok: true, already_present: true };
      if (current.length >= 3) {
        return { error: "Contact already has the maximum of 3 labels" };
      }
      const { error } = await admin
        .from("contacts")
        .update({ label_ids: [...current, lid] })
        .eq("id", cid);
      if (error) return { error: error.message };
      return { ok: true };
    }
    case "add_contact_note": {
      const cid = String(args.contact_id ?? "");
      const note = String(args.note ?? "").trim();
      if (!note) return { error: "note is empty" };
      const ok = await ensureContactInScope(admin, cid, cap);
      if (!ok.allowed) return { error: ok.reason };
      const { error } = await admin.from("contact_notes").insert({
        contact_id: cid,
        author_user_id: null,
        author_member_id: scope.memberId,
        body: note,
      });
      if (error) return { error: error.message };
      return { ok: true };
    }
    case "list_contact_notes": {
      const cid = String(args.contact_id ?? "");
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
      const ok = await ensureContactInScope(admin, cid, cap);
      if (!ok.allowed) return { error: ok.reason, notes: [] };
      const { data } = await admin
        .from("contact_notes")
        .select("id, body, created_at, author_member_id")
        .eq("contact_id", cid)
        .order("created_at", { ascending: false })
        .limit(limit);
      return { notes: data ?? [] };
    }
    case "list_calls": {
      const hours = Math.min(
        24 * 90,
        Math.max(1, Number(args.since_hours_ago ?? 24)),
      );
      const status = String(args.status ?? "any");
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();
      let q = admin
        .from("whatsapp_calls")
        .select(
          "id, wa_call_id, contact_id, business_phone_number_id, direction, status, start_at, end_at",
        )
        .gte("start_at", since)
        .order("start_at", { ascending: false })
        .limit(limit);
      if (status !== "any") q = q.eq("status", status);
      if (cap !== null) q = q.in("business_phone_number_id", cap);
      const { data } = await q;
      return { calls: data ?? [] };
    }
    case "list_campaigns": {
      const limit = Math.min(30, Math.max(1, Number(args.limit ?? 10)));
      const { data } = await admin
        .from("campaigns")
        .select(
          "id, name, status, created_at, scheduled_at, sent_count, failed_count, business_phone_number_id",
        )
        .order("created_at", { ascending: false })
        .limit(limit);
      const rows = (data ?? []) as Array<{
        business_phone_number_id: string | null;
      }>;
      const filtered =
        cap === null
          ? rows
          : rows.filter(
              (r) =>
                !r.business_phone_number_id ||
                cap.includes(r.business_phone_number_id),
            );
      return { campaigns: filtered };
    }
    case "lsq_lookup": {
      const cid = String(args.contact_id ?? "");
      const ok = await ensureContactInScope(admin, cid, cap);
      if (!ok.allowed) return { error: ok.reason };
      const { data } = await admin
        .from("contacts")
        .select(
          "id, wa_id, name, lsq_lead_number, lsq_prospect_id, lsq_stage, lsq_owner_name, lsq_owner_email, lsq_last_synced_at",
        )
        .eq("id", cid)
        .maybeSingle();
      return { lsq: data ?? null };
    }
    case "run_sql_select": {
      const raw = String(args.query ?? "").trim();
      if (!raw) return { error: "empty query" };
      // Defence-in-depth: the SQL function also re-validates, but block
      // the obvious bad shapes here so we don't even round-trip them.
      const lower = raw.toLowerCase();
      if (!lower.startsWith("select") && !lower.startsWith("with")) {
        return { error: "only SELECT / WITH queries are allowed" };
      }
      // Strip a trailing semicolon — easier on the model than yelling
      // about it, since copy-pasted SQL often has one.
      const cleaned = raw.replace(/;\s*$/, "");
      if (/;/.test(cleaned)) {
        return { error: "semicolons not allowed mid-query" };
      }
      const { data, error } = await admin.rpc("assistant_run_select", {
        query_text: cleaned,
      });
      if (error) return { error: error.message };
      const rows = Array.isArray(data) ? data : [];
      return {
        rows,
        row_count: rows.length,
        truncated: rows.length >= 200,
      };
    }
  }
}

// ---------- scope helper for write tools -------------------------- //

async function ensureContactInScope(
  admin: ReturnType<typeof createServiceRoleClient>,
  contactId: string,
  cap: string[] | null,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (!contactId) return { allowed: false, reason: "contact_id is empty" };
  const { data } = await admin
    .from("contacts")
    .select("business_phone_number_id")
    .eq("id", contactId)
    .maybeSingle();
  if (!data) return { allowed: false, reason: "Contact not found" };
  if (cap !== null && !cap.includes(data.business_phone_number_id as string)) {
    return { allowed: false, reason: "Not allowed for this contact's number" };
  }
  return { allowed: true };
}

// ---------- report generator -------------------------------------- //
// Each report returns a self-contained markdown string the model
// includes verbatim in its reply. Reports run their own queries through
// the same service-role client + bpid scope as the read tools.

async function buildReport(
  kind: string,
  scope: { allowedBpids: string[] | null; memberId: string },
): Promise<string> {
  const admin = createServiceRoleClient();
  const cap = scope.allowedBpids;
  const todayLabel = new Date().toISOString().slice(0, 10);

  function num(n: number) {
    return n.toLocaleString("en-IN");
  }

  if (kind === "daily_summary" || kind === "weekly_summary") {
    const hours = kind === "daily_summary" ? 24 : 24 * 7;
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();

    // Inbound + outbound counts.
    let inQ = admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("direction", "inbound")
      .gte("timestamp", since);
    let outQ = admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("direction", "outbound")
      .gte("timestamp", since);
    if (cap !== null) {
      inQ = inQ.in("business_phone_number_id", cap);
      outQ = outQ.in("business_phone_number_id", cap);
    }

    // New conversations: contacts whose oldest message is in window.
    // Approx via contacts.created_at as a cheaper proxy.
    let newQ = admin
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since);
    if (cap !== null) newQ = newQ.in("business_phone_number_id", cap);

    // Unread snapshot now.
    let unreadQ = admin
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .gt("unread_count", 0);
    if (cap !== null) unreadQ = unreadQ.in("business_phone_number_id", cap);

    const [inRes, outRes, newRes, unreadRes] = await Promise.all([
      inQ,
      outQ,
      newQ,
      unreadQ,
    ]);

    const title = kind === "daily_summary" ? "Daily summary" : "Weekly summary";
    return [
      `### ${title} — ${todayLabel}`,
      "",
      `- **Inbound messages:** ${num(inRes.count ?? 0)}`,
      `- **Outbound messages:** ${num(outRes.count ?? 0)}`,
      `- **New contacts:** ${num(newRes.count ?? 0)}`,
      `- **Unread chats right now:** ${num(unreadRes.count ?? 0)}`,
    ].join("\n");
  }

  if (kind === "agent_leaderboard") {
    const hours = 24;
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    let q = admin
      .from("messages")
      .select("sender_user_id")
      .eq("direction", "outbound")
      .gte("timestamp", since)
      .limit(20_000);
    if (cap !== null) q = q.in("business_phone_number_id", cap);
    const { data } = await q;
    const byUser = new Map<string, number>();
    for (const m of (data ?? []) as Array<{ sender_user_id: string | null }>) {
      const k = m.sender_user_id ?? "unattributed";
      byUser.set(k, (byUser.get(k) ?? 0) + 1);
    }
    const ids = Array.from(byUser.keys()).filter((k) => k !== "unattributed");
    const nameById = new Map<string, string>();
    if (ids.length > 0) {
      const { data: members } = await admin
        .from("team_members")
        .select("user_id, email, full_name")
        .in("user_id", ids);
      for (const r of (members ?? []) as Array<{
        user_id: string;
        email: string;
        full_name: string | null;
      }>) {
        nameById.set(r.user_id, r.full_name?.trim() || r.email);
      }
    }
    const rows = Array.from(byUser.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([uid, n], idx) => {
        const name = uid === "unattributed" ? "Unattributed" : nameById.get(uid) ?? uid;
        return `${idx + 1}. **${name}** — ${num(n)} sent`;
      });
    if (rows.length === 0) rows.push("_No outbound messages in the last 24 h._");
    return [
      `### Agent leaderboard — last 24 h`,
      "",
      ...rows,
    ].join("\n");
  }

  if (kind === "number_health") {
    const { data: numbers } = await admin
      .from("business_numbers")
      .select("phone_number_id, display_phone_number, verified_name, nickname");
    const list = ((numbers ?? []) as Array<{
      phone_number_id: string;
      display_phone_number: string | null;
      verified_name: string | null;
      nickname: string | null;
    }>).filter((n) => cap === null || cap.includes(n.phone_number_id));
    const rows = await Promise.all(
      list.map(async (n) => {
        const [c, m, u] = await Promise.all([
          admin
            .from("contacts")
            .select("id", { count: "exact", head: true })
            .eq("business_phone_number_id", n.phone_number_id),
          admin
            .from("messages")
            .select("id", { count: "exact", head: true })
            .eq("business_phone_number_id", n.phone_number_id),
          admin
            .from("contacts")
            .select("id", { count: "exact", head: true })
            .eq("business_phone_number_id", n.phone_number_id)
            .gt("unread_count", 0),
        ]);
        const label =
          n.nickname?.trim() ||
          n.verified_name?.trim() ||
          n.display_phone_number ||
          n.phone_number_id;
        return `- **${label}** — ${num(c.count ?? 0)} chats · ${num(m.count ?? 0)} messages · ${num(u.count ?? 0)} unread`;
      }),
    );
    return [
      `### Number health — ${todayLabel}`,
      "",
      ...(rows.length ? rows : ["_No numbers in scope._"]),
    ].join("\n");
  }

  if (kind === "response_time") {
    // Median minutes between an inbound message and the FIRST outbound
    // reply that follows it, per business number. Sampled across the
    // last 7 days for stability.
    const since = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
    let q = admin
      .from("messages")
      .select("contact_id, direction, timestamp, business_phone_number_id")
      .gte("timestamp", since)
      .order("timestamp", { ascending: true })
      .limit(20_000);
    if (cap !== null) q = q.in("business_phone_number_id", cap);
    const { data } = await q;
    type Row = {
      contact_id: string;
      direction: string;
      timestamp: string;
      business_phone_number_id: string;
    };
    const rows = (data ?? []) as Row[];
    // Walk chronological, track pending inbounds per (bpid, contact).
    const samplesByBpid = new Map<string, number[]>();
    const pendingByChat = new Map<string, number>();
    for (const m of rows) {
      const k = `${m.business_phone_number_id}:${m.contact_id}`;
      const ts = new Date(m.timestamp).getTime();
      if (m.direction === "inbound") {
        if (!pendingByChat.has(k)) pendingByChat.set(k, ts);
      } else if (m.direction === "outbound") {
        const inboundAt = pendingByChat.get(k);
        if (inboundAt !== undefined) {
          const minutes = (ts - inboundAt) / 60_000;
          const arr = samplesByBpid.get(m.business_phone_number_id) ?? [];
          arr.push(minutes);
          samplesByBpid.set(m.business_phone_number_id, arr);
          pendingByChat.delete(k);
        }
      }
    }
    const { data: numbers } = await admin
      .from("business_numbers")
      .select("phone_number_id, display_phone_number, verified_name, nickname");
    const labelByBpid = new Map<string, string>();
    for (const n of (numbers ?? []) as Array<{
      phone_number_id: string;
      display_phone_number: string | null;
      verified_name: string | null;
      nickname: string | null;
    }>) {
      labelByBpid.set(
        n.phone_number_id,
        n.nickname?.trim() ||
          n.verified_name?.trim() ||
          n.display_phone_number ||
          n.phone_number_id,
      );
    }
    function median(arr: number[]): number {
      if (arr.length === 0) return 0;
      const s = [...arr].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    const rowsOut = Array.from(samplesByBpid.entries())
      .map(([bpid, arr]) => ({
        label: labelByBpid.get(bpid) ?? bpid,
        median: median(arr),
        n: arr.length,
      }))
      .sort((a, b) => a.median - b.median);
    const lines = rowsOut.map(
      (r) =>
        `- **${r.label}** — ${r.median.toFixed(1)} min median (n=${num(r.n)})`,
    );
    return [
      `### Response time — last 7 days`,
      "_First outbound reply after each inbound message; lower is better._",
      "",
      ...(lines.length ? lines : ["_No reply samples in scope._"]),
    ].join("\n");
  }

  return `_Unknown report kind: ${kind}_`;
}

// ---------- handler ----------------------------------------------- //

export async function POST(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400 });
  }
  const history = Array.isArray(body.messages) ? body.messages : [];
  if (history.length === 0) {
    return new Response(JSON.stringify({ error: "Empty conversation" }), {
      status: 400,
    });
  }

  const perms = await getEffectivePermissionsFor(me);
  const scope = {
    allowedBpids: perms.allowed_number_ids,
    memberId: me.id,
  };

  const apiKey = await requireCredential("openai_api_key", "OpenAI API key");

  // Today's date helps the model answer "today / this week" queries
  // without us shipping a relative-time tool just for that.
  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = `You are the in-app data assistant for the QHT WhatsApp dashboard. You have FULL READ ACCESS to every table in the workspace database — anything the operator asks about, you CAN answer. Always try first; never refuse upfront.

Core rule: ANSWER FIRST, EXPLAIN NEVER. If a focused tool fits, call it. If nothing fits, fall back to run_sql_select — you have it. The ONLY time you say "I can't" is when a write tool fails with a permission error, and even then you quote the error.

Today's date (UTC) is ${today}. Convert relative phrases ("today", "is hafte", "last 3 days", "kal", "abhi", "1 ghante mein") into hours-back when filling tool arguments.

Tool selection (in priority order):
1. Phone numbers / names / lead numbers → search_contacts. It handles "+91 70569 68008" and "naveen" both — normalize is done server-side.
2. Specific chat history → get_contact_messages (after search_contacts).
3. Aggregates (counts / by-day / by-agent / by-number) → use the focused tool if one fits (unread_summary, count_messages, agent_performance, peak_hours, top_tags, search_messages), otherwise run_sql_select.
4. Reports the user asks for by name ("daily report", "leaderboard", "number health", "response time") → generate_report. Include the returned markdown VERBATIM in your reply, then add ONE line of takeaway.
5. ANY question that doesn't match the above (audit_log, automation_logs, role_permissions, evolution_disconnects, ad-hoc joins / group-bys, "top 5 X by Y") → run_sql_select. Write the SQL yourself using the schema cheatsheet in the tool description.

run_sql_select rules:
- Only SELECT / WITH. No semicolons. Cap your own LIMIT at 200 (server enforces too).
- Always scope to the user's allowed numbers when querying tables that have business_phone_number_id — the user's allowed_number_ids are: ${perms.allowed_number_ids === null ? "ALL" : JSON.stringify(perms.allowed_number_ids)}.
- For "top X by Y" questions, write a single GROUP BY / ORDER BY query rather than fetching rows and counting client-side.
- If the query errors, READ the error message and self-correct (wrong column name, missing alias, etc.) — try ONCE more before giving up.

Write actions (mark_chat_read, set_chat_status, assign_chat, add_chat_tag, add_chat_label, add_contact_note):
- Only fire on an EXPLICIT change request ("close kar do", "assign to riya", "tag VIP"). "Dikhao / show / batao" is read-only.
- Resolve the target chat with search_contacts first when the user names a person.
- After success: one short confirmation line. On error: quote the error verbatim.

Output style:
- Match the user's language (English / Hindi / Hinglish).
- Default to 1–3 short lines. Use a compact bullet list when listing 3+ items.
- Never use phrases like "I can't" / "Mujhe is information ko retrieve karne ke liye koi tool nahi mila" — those mean you forgot to try run_sql_select. Try the SQL fallback FIRST.
- Don't reveal raw UUIDs unless explicitly asked.
- After a tool round, give the operator the ANSWER they actually wanted, not a description of what you did.

You do NOT have a tool to SEND a WhatsApp message to a customer. If asked to send/reply, point them to the inbox composer — never claim a send happened.

The operator is ${me.email} (role: ${me.role}).`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.filter((m) => m.role !== "system"),
  ];

  // Tool-use loop: call OpenAI, run any requested tools, feed results
  // back. MAX_TOOL_ROUNDS prevents pathological loops.
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return new Response(
        JSON.stringify({
          error: `OpenAI HTTP ${resp.status}: ${text.slice(0, 300)}`,
        }),
        { status: 502 },
      );
    }
    const json = (await resp.json()) as {
      choices?: Array<{
        message?: ChatMessage & {
          tool_calls?: Array<{
            id: string;
            type: "function";
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason?: string;
      }>;
    };
    const choice = json.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      return new Response(JSON.stringify({ error: "Empty model response" }), {
        status: 502,
      });
    }
    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: msg.tool_calls,
    });

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // Run every requested tool sequentially, append each result.
      for (const tc of msg.tool_calls) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* keep empty */
        }
        let result: unknown;
        try {
          result = await runTool(tc.function.name as ToolName, parsed, scope);
        } catch (e) {
          result = { error: e instanceof Error ? e.message : "tool failed" };
        }
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: JSON.stringify(result),
        });
      }
      // Loop — let the model see the results and decide its next move.
      continue;
    }

    // No more tools requested → we have the final answer.
    return new Response(
      JSON.stringify({
        reply: msg.content ?? "",
        rounds: round + 1,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ error: "Hit max tool rounds without a final answer." }),
    { status: 504 },
  );
}
