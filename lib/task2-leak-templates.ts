/**
 * AHL Task 2 — Meta marketing templates (CRM-revised wording).
 *
 * Three follow-ups only:
 *   1) Qualified but did not book
 *   2) Booked but did not come
 *   3) Visited but did not order
 *
 * Cadence: Day 1 → Day 3 → Day 7 → Day 14
 * Submit via GET /api/admin/seed-task2-templates
 */

export type Task2QuickReply = { type: "QUICK_REPLY"; text: string };

export interface Task2TemplateDef {
  name: string;
  label: string;
  group: "leak3" | "booked_noshow" | "visited_noorder";
  body: string;
  examples: string[];
  buttons: Task2QuickReply[];
  language?: string;
  category?: "MARKETING" | "UTILITY";
}

const qr = (...labels: string[]): Task2QuickReply[] =>
  labels.map((text) => ({ type: "QUICK_REPLY" as const, text: text.slice(0, 25) }));

/** 12 Task 2 templates — CRM-revised bodies (Elma review). */
export const TASK2_LEAK_TEMPLATES: Task2TemplateDef[] = [
  // ─── 1) Qualified but did not book ───────────────────────────────────
  {
    name: "ahl_leak3_d1_a_book",
    label: "Qualified Day1 — Ask to book",
    group: "leak3",
    body: "Hi {{1}}, thank you for speaking with us. Would you like to schedule your consultation? Please share two preferred slots with the day and time, and our team will help you confirm.",
    examples: ["Rahul"],
    buttons: qr("BOOK", "SHARE SLOTS", "NOT NOW"),
  },
  {
    name: "ahl_leak3_d3_b_reminder",
    label: "Qualified Day3 — Follow-up",
    group: "leak3",
    body: "Hi {{1}}, just following up to check if you would like to schedule your consultation. Reply BOOK and {{2}} will help you confirm a suitable time.",
    examples: ["Rahul", "Mehjabeen"],
    buttons: qr("BOOK", "CALL ME", "STOP"),
  },
  {
    name: "ahl_leak3_d7_b2_objection",
    label: "Qualified Day7 — Objection",
    group: "leak3",
    body: "Hi {{1}}, if price, family approval or travel is holding you back from booking your consultation, please let us know. We will be happy to help with your concerns.",
    examples: ["Rahul"],
    buttons: qr("PRICE", "FAMILY", "TRAVEL"),
  },
  {
    name: "ahl_leak3_d14_d_final",
    label: "Qualified Day14 — Final",
    group: "leak3",
    body: "Hi {{1}}, just one last follow-up regarding your consultation. Reply YES if you would like to book, or LATER with a suitable date if you need more time.",
    examples: ["Rahul"],
    buttons: qr("YES", "LATER", "STOP"),
  },

  // ─── 2) Booked but did not come ──────────────────────────────────────
  {
    name: "ahl_noshow_d1_a_reschedule",
    label: "No-show Day1 — Reschedule",
    group: "booked_noshow",
    body: "Hi {{1}}, we noticed you couldn't attend your scheduled consultation at American Hairline. Would you like to reschedule? Please share two preferred slots, and {{2}} will help you confirm.",
    examples: ["Rahul", "Mehjabeen"],
    buttons: qr("RESCHEDULE", "CALL ME", "NOT NOW"),
  },
  {
    name: "ahl_noshow_d3_b_reminder",
    label: "No-show Day3 — Reminder",
    group: "booked_noshow",
    body: "Hi {{1}}, just checking if you would like to reschedule your missed consultation. Please share your preferred date, and our team will help you arrange a new appointment.",
    examples: ["Rahul"],
    buttons: qr("YES", "PREFERRED DATE", "STOP"),
  },
  {
    name: "ahl_noshow_d7_b2_urgency",
    label: "No-show Day7 — Check-in",
    group: "booked_noshow",
    body: "Hi {{1}}, just checking in to see if you are still planning to visit American Hairline. Reply BOOK to schedule a new consultation or CALL if you would like to speak with our team.",
    examples: ["Rahul"],
    buttons: qr("BOOK", "CALL", "STOP"),
  },
  {
    name: "ahl_noshow_d14_d_final",
    label: "No-show Day14 — Final",
    group: "booked_noshow",
    body: "Hi {{1}}, this is our last follow-up regarding your missed consultation. Reply READY whenever you would like to reschedule, or STOP if you do not wish to receive further messages.",
    examples: ["Rahul"],
    buttons: qr("READY", "STOP"),
  },

  // ─── 3) Visited but did not order ────────────────────────────────────
  {
    name: "ahl_visited_d1_a_followup",
    label: "Visited Day1 — Follow-up",
    group: "visited_noorder",
    body: "Hi {{1}}, thank you for visiting American Hairline. This is {{2}}. We wanted to check if you have any questions about the options discussed during your consultation. We will be happy to assist you.",
    examples: ["Rahul", "Mehjabeen"],
    buttons: qr("ASK QUESTION", "CALL ME", "NOT NOW"),
  },
  {
    name: "ahl_visited_d3_b_reminder",
    label: "Visited Day3 — Callback offer",
    group: "visited_noorder",
    body: "Hi {{1}}, we hope you had a good experience during your visit. Would you like a callback to discuss your options or clarify any concerns?",
    examples: ["Rahul"],
    buttons: qr("YES", "SHARE CONCERN", "STOP"),
  },
  {
    name: "ahl_visited_d7_b2_objection",
    label: "Visited Day7 — Objection",
    group: "visited_noorder",
    body: "Hi {{1}}, if price, timing or the expected look is a concern after your consultation, please let us know. We will be happy to understand your concerns and help you with the available options.",
    examples: ["Rahul"],
    buttons: qr("PRICE", "TIMING", "LOOK"),
  },
  {
    name: "ahl_visited_d14_d_final",
    label: "Visited Day14 — Final",
    group: "visited_noorder",
    body: "Hi {{1}}, this is our last follow-up regarding your consultation. Reply READY if you would like to proceed or discuss the next steps, or STOP if you do not wish to receive further messages.",
    examples: ["Rahul"],
    buttons: qr("READY", "STOP"),
  },
];

export const TASK2_TWO_VAR_TEMPLATE_NAMES: ReadonlySet<string> = new Set(
  TASK2_LEAK_TEMPLATES.filter((t) => t.examples.length >= 2).map((t) => t.name),
);

export function task2TemplatesByGroup(
  group?: Task2TemplateDef["group"] | "all",
): Task2TemplateDef[] {
  if (!group || group === "all") return TASK2_LEAK_TEMPLATES;
  return TASK2_LEAK_TEMPLATES.filter((t) => t.group === group);
}
