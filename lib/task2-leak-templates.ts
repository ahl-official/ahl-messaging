/**
 * AHL Task 2 — Meta marketing templates for Vinitt’s three funnel goals:
 *   1) Qualified but didn’t book  (Leak 3)
 *   2) Booked but didn’t come     (no-show)
 *   3) Visited but didn’t order
 *
 * Cadence: Day 1 → A · Day 3 → B · Day 7 → B2 · Day 14 → D
 * Submit via GET /api/admin/seed-task2-templates
 */

export type Task2QuickReply = { type: "QUICK_REPLY"; text: string };

export interface Task2TemplateDef {
  /** Meta template name — lowercase + underscores only. */
  name: string;
  /** Human label for dashboards / seed responses. */
  label: string;
  /** Task 2 stage bucket. */
  group: "leak3" | "booked_noshow" | "visited_noorder";
  body: string;
  /** Sample values for {{1}}, {{2}}, … (Meta example payload). */
  examples: string[];
  buttons: Task2QuickReply[];
  language?: string;
  category?: "MARKETING" | "UTILITY";
}

const qr = (...labels: string[]): Task2QuickReply[] =>
  labels.map((text) => ({ type: "QUICK_REPLY" as const, text: text.slice(0, 25) }));

/** The 12 Task 2 templates to create on AHL Messaging WABA. */
export const TASK2_LEAK_TEMPLATES: Task2TemplateDef[] = [
  // ─── 1) Qualified but didn’t book (Leak 3) ───────────────────────────
  {
    name: "ahl_leak3_d1_a_book",
    label: "L3 Day1 — Ask to book",
    group: "leak3",
    body: "Hi {{1}}, based on our discussion you are a good fit. Shall we book your consultation? Please share 2 preferred slots with day and time.",
    examples: ["Rahul"],
    buttons: qr("Book", "Share slots", "Not now"),
  },
  {
    name: "ahl_leak3_d3_b_reminder",
    label: "L3 Day3 — Slot urgency",
    group: "leak3",
    body: "{{1}}, consult slots fill up for in-person and online. Reply BOOK and {{2}} will confirm a time that works for you.",
    examples: ["Rahul", "Mehjabeen"],
    buttons: qr("BOOK", "Call me", "STOP"),
  },
  {
    name: "ahl_leak3_d7_b2_objection",
    label: "L3 Day7 — Objection",
    group: "leak3",
    body: "Hi {{1}}, if price, family approval or travel is holding the booking, tell us which one and we will help with options. Reply PRICE, FAMILY or TRAVEL.",
    examples: ["Rahul"],
    buttons: qr("PRICE", "FAMILY", "TRAVEL"),
  },
  {
    name: "ahl_leak3_d14_d_final",
    label: "L3 Day14 — Final",
    group: "leak3",
    body: "{{1}}, last follow-up on your consultation. Reply YES to book, or LATER with a date and we will wait till then.",
    examples: ["Rahul"],
    buttons: qr("YES", "LATER", "STOP"),
  },

  // ─── 2) Booked but didn’t come (no-show) ─────────────────────────────
  {
    name: "ahl_noshow_d1_a_reschedule",
    label: "No-show Day1 — Reschedule",
    group: "booked_noshow",
    body: "Hi {{1}}, we missed you at your American Hairline consultation. Shall we reschedule? Reply with 2 preferred slots and {{2}} will confirm.",
    examples: ["Rahul", "Mehjabeen"],
    buttons: qr("Reschedule", "Call me", "Not now"),
  },
  {
    name: "ahl_noshow_d3_b_reminder",
    label: "No-show Day3 — Reminder",
    group: "booked_noshow",
    body: "{{1}}, your consult slot is still open. Reply YES to lock a new time, or share a day that works better for you.",
    examples: ["Rahul"],
    buttons: qr("YES", "Share day", "STOP"),
  },
  {
    name: "ahl_noshow_d7_b2_urgency",
    label: "No-show Day7 — Urgency",
    group: "booked_noshow",
    body: "Hi {{1}}, just checking in — are you still planning to visit American Hairline? Reply BOOK for a fresh slot or CALL for a quick chat.",
    examples: ["Rahul"],
    buttons: qr("BOOK", "CALL", "STOP"),
  },
  {
    name: "ahl_noshow_d14_d_final",
    label: "No-show Day14 — Final",
    group: "booked_noshow",
    body: "{{1}}, last note on your missed consultation. Reply READY when you want to rebook, or STOP and we will pause messages.",
    examples: ["Rahul"],
    buttons: qr("READY", "STOP"),
  },

  // ─── 3) Visited but didn’t order ─────────────────────────────────────
  {
    name: "ahl_visited_d1_a_followup",
    label: "Visited Day1 — Follow-up",
    group: "visited_noorder",
    body: "Hi {{1}}, thank you for visiting American Hairline. This is {{2}}. Any questions on the options we showed? Happy to help you decide.",
    examples: ["Rahul", "Mehjabeen"],
    buttons: qr("Ask question", "Call me", "Not now"),
  },
  {
    name: "ahl_visited_d3_b_reminder",
    label: "Visited Day3 — Reminder",
    group: "visited_noorder",
    body: "{{1}}, many clients take a day or two after the visit. Reply YES if you want a quick callback to finalise, or share what is holding you back.",
    examples: ["Rahul"],
    buttons: qr("YES", "Share concern", "STOP"),
  },
  {
    name: "ahl_visited_d7_b2_objection",
    label: "Visited Day7 — Objection",
    group: "visited_noorder",
    body: "Hi {{1}}, if price, timing or look is the concern after your visit, tell us which one and we will share clear options. Reply PRICE, TIMING or LOOK.",
    examples: ["Rahul"],
    buttons: qr("PRICE", "TIMING", "LOOK"),
  },
  {
    name: "ahl_visited_d14_d_final",
    label: "Visited Day14 — Final",
    group: "visited_noorder",
    body: "{{1}}, last follow-up after your visit. Reply READY when you want to proceed, or STOP to end messages from us.",
    examples: ["Rahul"],
    buttons: qr("READY", "STOP"),
  },
];

/** Template names that need {{1}}=name and {{2}}=agent when sending. */
export const TASK2_TWO_VAR_TEMPLATE_NAMES: ReadonlySet<string> = new Set(
  TASK2_LEAK_TEMPLATES.filter((t) => t.examples.length >= 2).map((t) => t.name),
);

export function task2TemplatesByGroup(
  group?: Task2TemplateDef["group"] | "all",
): Task2TemplateDef[] {
  if (!group || group === "all") return TASK2_LEAK_TEMPLATES;
  return TASK2_LEAK_TEMPLATES.filter((t) => t.group === group);
}
