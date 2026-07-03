// In-memory demo store for previewing the dashboard without Supabase.
// Toggle with NEXT_PUBLIC_DEMO_MODE=1 in .env.local.

import type { Contact, Message } from "@/lib/types";

export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "1";
export const DEMO_USER_EMAIL = "demo@americanhairline.com";

// ----- Seed --------------------------------------------------------------
const now = Date.now();
const minutes = (n: number) => new Date(now - n * 60_000).toISOString();
const days = (n: number) => new Date(now - n * 24 * 60 * 60_000).toISOString();

const seedContacts: Contact[] = [
  {
    id: "c1",
    wa_id: "919876543210",
    name: null,
    profile_name: "Aarav Sharma",
    last_message_at: minutes(2),
    last_message_preview: "Thank you, see you tomorrow at 4pm!",
    unread_count: 2,
    created_at: days(7),
  },
  {
    id: "c2",
    wa_id: "919988776655",
    name: "Priya Patel",
    profile_name: "Priya P.",
    last_message_at: minutes(45),
    last_message_preview: "Yes please reschedule to Saturday",
    unread_count: 0,
    created_at: days(14),
  },
  {
    id: "c3",
    wa_id: "919123456789",
    name: null,
    profile_name: "Rohan Mehta",
    last_message_at: minutes(180),
    last_message_preview: "📷 Photo",
    unread_count: 1,
    created_at: days(3),
  },
  {
    id: "c4",
    wa_id: "919012345678",
    name: "Sara Khan",
    profile_name: null,
    last_message_at: days(1),
    last_message_preview: "Sounds good. Thanks for the info.",
    unread_count: 0,
    created_at: days(30),
  },
  {
    id: "c5",
    wa_id: "919000000000",
    name: "Test Number",
    profile_name: null,
    last_message_at: days(5),
    last_message_preview: "—",
    unread_count: 0,
    created_at: days(5),
  },
];

const seedMessages: Record<string, Message[]> = {
  c1: [
    msg("c1", "in",  "Hi, I had a question about the hair treatment consultation", days(1)),
    msg("c1", "out", "Hello Aarav! Sure, happy to help. What would you like to know?", minutes(60 * 23)),
    msg("c1", "in",  "Is the consultation free? And how long does it take?", minutes(60 * 22)),
    msg("c1", "out", "Yes, the first consultation is complimentary. It usually takes 30–45 minutes.", minutes(60 * 22), "read"),
    msg("c1", "in",  "Perfect. Can I book one for tomorrow afternoon?", minutes(60 * 5)),
    msg("c1", "out", "Absolutely. We have a 4:00 PM slot available. Should I confirm?", minutes(60 * 4), "read"),
    msg("c1", "in",  "Yes please confirm 4 PM works for me.", minutes(15)),
    msg("c1", "in",  "Thank you, see you tomorrow at 4pm!", minutes(2)),
  ],
  c2: [
    msg("c2", "in",  "Hi I need to reschedule my appointment", minutes(120)),
    msg("c2", "out", "Of course Priya. Which date works better for you?", minutes(110), "read"),
    msg("c2", "in",  "Yes please reschedule to Saturday", minutes(45)),
  ],
  c3: [
    msg("c3", "in",  "Hello, I wanted to share my reports", minutes(60 * 5)),
    msg("c3", "in",  "📷 Photo", minutes(60 * 4), "delivered", "image"),
    msg("c3", "out", "Thanks! Our doctor will review and get back to you within a day.", minutes(60 * 3.5), "delivered"),
    msg("c3", "in",  "📷 Photo", minutes(180), "delivered", "image"),
  ],
  c4: [
    msg("c4", "out", "Hi Sara, just confirming your appointment for next Monday at 11 AM.", days(2), "read"),
    msg("c4", "in",  "Yes confirmed.", days(1.5)),
    msg("c4", "out", "Great. Please arrive 10 minutes early to fill paperwork.", days(1.2), "read"),
    msg("c4", "in",  "Sounds good. Thanks for the info.", days(1)),
  ],
  c5: [],
};

function msg(
  contactId: string,
  dir: "in" | "out",
  text: string,
  iso: string,
  status: Message["status"] = "delivered",
  type = "text",
): Message {
  return {
    id: `${contactId}-${Math.random().toString(36).slice(2, 8)}`,
    contact_id: contactId,
    wa_message_id: dir === "out" ? `wamid.demo.${Math.random().toString(36).slice(2, 10)}` : null,
    direction: dir === "in" ? "inbound" : "outbound",
    type,
    content: text,
    media_url: null,
    media_mime_type: null,
    status: dir === "in" ? "delivered" : status,
    error_message: null,
    timestamp: iso,
  };
}

// ----- Tiny pub/sub store -----------------------------------------------
type Listener = () => void;

class DemoStore {
  contacts: Contact[] = seedContacts.slice();
  messages: Map<string, Message[]> = new Map(
    Object.entries(seedMessages).map(([k, v]) => [k, v.slice()]),
  );
  private listeners: Set<Listener> = new Set();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }

  getContacts(): Contact[] {
    return this.contacts.slice().sort(
      (a, b) =>
        new Date(b.last_message_at ?? 0).getTime() - new Date(a.last_message_at ?? 0).getTime(),
    );
  }

  getMessages(contactId: string): Message[] {
    return (this.messages.get(contactId) ?? []).slice();
  }

  clearUnread(contactId: string) {
    const c = this.contacts.find((x) => x.id === contactId);
    if (c && c.unread_count !== 0) {
      c.unread_count = 0;
      this.notify();
    }
  }

  appendOutbound(contactId: string, text: string): Message {
    const message: Message = {
      id: `o-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      contact_id: contactId,
      wa_message_id: `wamid.demo.${Math.random().toString(36).slice(2, 10)}`,
      direction: "outbound",
      type: "text",
      content: text,
      media_url: null,
      media_mime_type: null,
      status: "sent",
      error_message: null,
      timestamp: new Date().toISOString(),
    };
    const list = this.messages.get(contactId) ?? [];
    this.messages.set(contactId, [...list, message]);

    const c = this.contacts.find((x) => x.id === contactId);
    if (c) {
      c.last_message_at = message.timestamp;
      c.last_message_preview = text.slice(0, 120);
    }
    this.notify();

    // Simulate delivered → read ticks
    setTimeout(() => this.updateStatus(message.id, contactId, "delivered"), 700);
    setTimeout(() => this.updateStatus(message.id, contactId, "read"), 2200);

    // Simulate a friendly auto-reply ~2.5s later (only sometimes for variety)
    if (Math.random() > 0.35) {
      setTimeout(() => this.simulateInbound(contactId, autoReply(text)), 2500);
    }
    return message;
  }

  private updateStatus(messageId: string, contactId: string, status: Message["status"]) {
    const list = this.messages.get(contactId) ?? [];
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    list[idx] = { ...list[idx], status };
    this.messages.set(contactId, list);
    this.notify();
  }

  simulateInbound(contactId: string, text: string) {
    const message: Message = {
      id: `i-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      contact_id: contactId,
      wa_message_id: null,
      direction: "inbound",
      type: "text",
      content: text,
      media_url: null,
      media_mime_type: null,
      status: "delivered",
      error_message: null,
      timestamp: new Date().toISOString(),
    };
    const list = this.messages.get(contactId) ?? [];
    this.messages.set(contactId, [...list, message]);

    const c = this.contacts.find((x) => x.id === contactId);
    if (c) {
      c.last_message_at = message.timestamp;
      c.last_message_preview = text.slice(0, 120);
      c.unread_count = (c.unread_count ?? 0) + 1;
    }
    this.notify();
  }
}

function autoReply(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (/price|cost|fee|charge/.test(lower)) return "Sure, our team will share the pricing shortly.";
  if (/appointment|book|schedule/.test(lower)) return "Got it, checking the slot now.";
  if (/thank/.test(lower)) return "You're welcome! 😊";
  if (/\?$/.test(prompt.trim())) return "Yes, that should be possible. Let me confirm and revert.";
  return "Noted, thank you!";
}

// Browser singleton (HMR-safe)
declare global {
  // eslint-disable-next-line no-var
  var __qhtDemoStore: DemoStore | undefined;
}

export const demoStore: DemoStore =
  (typeof globalThis !== "undefined" && globalThis.__qhtDemoStore) ||
  ((globalThis.__qhtDemoStore = new DemoStore()), globalThis.__qhtDemoStore);

export function demoSeedContactsForServer(): Contact[] {
  return seedContacts.slice().sort(
    (a, b) =>
      new Date(b.last_message_at ?? 0).getTime() - new Date(a.last_message_at ?? 0).getTime(),
  );
}
