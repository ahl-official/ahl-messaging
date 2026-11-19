# AHL Task 2 — WhatsApp Leak Follow-up Templates (CRM Approval)

**Brand:** American Hairline  
**Pilot:** Mehjabeen’s leads first  
**Channel:** WhatsApp (Meta marketing templates)  
**Cadence (Elma / CRM agreed):** Day 1 → A · Day 3 → B · Day 7 → B2 · Day 14 → D (then stop)  
**Special:** Template C = Deferred leads only, on their scheduled callback date  
**Attempt cap:** Max 10 combined (calls + WhatsApp). Day 14 WhatsApp is final automated touch even if under 10.  
**Pause:** 48 hours after any manual executive call/WhatsApp  

### Global variables
| Token | Meaning |
|---|---|
| `{{1}}` / `{{name}}` | Client first name |
| `{{2}}` / `{{agent}}` | Executive / agent name |

### Global stop rules (all templates)
Do **not** send if any of these are true:
- Consultation Booked / Consultation Visited / Order placed  
- Lead blocked  
- Client replied **STOP**  
- Leak 2 only: **genuine NQ** with a real reason (budget / location / not interested properly filled)  
- Status moved out of the leak target set  

---

## LEAK 1 — Calls → Talk  
**Goal:** Get the first real conversation (lead came in; nobody has spoken).

**Target statuses / Q-NQ rule**  
`New Lead`, `Ringing / Busy`, `Not Reachable`;  
or `Lost` / `Dead` with only unreachable-style reasons (switched off, not reachable, RGN, Disconnected / Not Connected).  
Q/NQ ignored (never talked).  
Still in progress if &lt; 2 days old; treat as leak if &gt; 2 days and still never spoken.

---

### L1 · Template A — Day 1 · First follow-up

| Field | Value |
|---|---|
| **Leak # + goal** | Leak 1 — Soft intro; open first talk |
| **Target statuses / Q-NQ rule** | As Leak 1 above |
| **Day offset** | Day 1 |
| **Template code** | `ahl_leak1_d1_a_intro` |
| **Exact message body (template format)** | `Hi {{1}}, this is {{2}} from American Hairline. We tried reaching you about your hair enquiry. When is a good time for a quick 2-min call?` |
| **Variables** | `{{1}}` name · `{{2}}` agent |
| **Suggested buttons** | Call me · WhatsApp only · Not now |
| **Stop rule** | Global stop + already Warm/Cold (talked) |

---

### L1 · Template B — Day 3 · Reminder

| Field | Value |
|---|---|
| **Leak # + goal** | Leak 1 — Value + easy reply |
| **Target statuses / Q-NQ rule** | As Leak 1 above; still never spoken |
| **Day offset** | Day 3 |
| **Template code** | `ahl_leak1_d3_b_reminder` |
| **Exact message body (template format)** | `Hi {{1}}, many clients start with a short consult to find the right hairline option. Reply YES and we will call you, or share a preferred time.` |
| **Variables** | `{{1}}` name |
| **Suggested buttons** | YES · Share time · STOP |
| **Stop rule** | Global stop + already spoken |

---

### L1 · Template B2 — Day 7 · Second reminder

| Field | Value |
|---|---|
| **Leak # + goal** | Leak 1 — Direct choice CTA |
| **Target statuses / Q-NQ rule** | As Leak 1 above |
| **Day offset** | Day 7 |
| **Template code** | `ahl_leak1_d7_b2_cta` |
| **Exact message body (template format)** | `{{1}}, we still could not connect. Are you still exploring a hair solution? Reply 1 for Call me today, 2 for WhatsApp only, 3 for Not interested.` |
| **Variables** | `{{1}}` name |
| **Suggested buttons** | 1 Call me · 2 WhatsApp · 3 Not interested |
| **Stop rule** | Global stop; also stop if reply = 3 |

---

### L1 · Template D — Day 14 · Final follow-up

| Field | Value |
|---|---|
| **Leak # + goal** | Leak 1 — Close loop politely |
| **Target statuses / Q-NQ rule** | As Leak 1 above |
| **Day offset** | Day 14 (final automated WhatsApp) |
| **Template code** | `ahl_leak1_d14_d_final` |
| **Exact message body (template format)** | `Hi {{1}}, last note from American Hairline. We will pause follow-ups for now. If you want help later, just reply and we will assist.` |
| **Variables** | `{{1}}` name |
| **Suggested buttons** | Call me · STOP |
| **Stop rule** | Global stop; end sequence after this send |

---

## LEAK 2 — Talk → Qualified  
**Goal:** Finish qualification where executive/rule failed (not genuine NQ drops).

**Target statuses / Q-NQ rule**  
`Warm Lead` / `Cold Lead 1` / `Cold Lead 2` / `Deferred Lead` (or `Lost` after a real talk);  
**Q/NQ = NQ or blank** AND qualification fields empty / “Not given”.  
**Exclude** NQ with a real reason (budget, location, not interested) — that is a genuine drop, not a leak.  
Also include Warm/Deferred wrongly marked NQ.

---

### L2 · Template A — Day 1 · First follow-up

| Field | Value |
|---|---|
| **Leak # + goal** | Leak 2 — Re-open + ask qualify questions |
| **Target statuses / Q-NQ rule** | As Leak 2 above |
| **Day offset** | Day 1 |
| **Template code** | `ahl_leak2_d1_a_qualify` |
| **Exact message body (template format)** | `Hi {{1}}, thanks for speaking with {{2}} from American Hairline. To suggest the right option, please share your city, budget range, and when you can visit.` |
| **Variables** | `{{1}}` name · `{{2}}` agent |
| **Suggested buttons** | Share details · Call me · Not now |
| **Stop rule** | Global stop + genuine NQ reason filled |

---

### L2 · Template B — Day 3 · Reminder

| Field | Value |
|---|---|
| **Leak # + goal** | Leak 2 — Help them decide + next step |
| **Target statuses / Q-NQ rule** | As Leak 2 above |
| **Day offset** | Day 3 |
| **Template code** | `ahl_leak2_d3_b_reminder` |
| **Exact message body (template format)** | `{{1}}, a short consult helps confirm fit, look, maintenance and cost. Reply with your city and preferred day and we will guide the next step.` |
| **Variables** | `{{1}}` name |
| **Suggested buttons** | Share city/day · Call me · STOP |
| **Stop rule** | Global stop + genuine NQ reason |

---

### L2 · Template B2 — Day 7 · Second reminder

| Field | Value |
|---|---|
| **Leak # + goal** | Leak 2 — Objection clarity |
| **Target statuses / Q-NQ rule** | As Leak 2 above |
| **Day offset** | Day 7 |
| **Template code** | `ahl_leak2_d7_b2_objection` |
| **Exact message body (template format)** | `Hi {{1}}, if cost, travel or timing was the concern, tell us which one and we can suggest a realistic plan. Reply COST, TRAVEL or TIMING.` |
| **Variables** | `{{1}}` name |
| **Suggested buttons** | COST · TRAVEL · TIMING |
| **Stop rule** | Global stop + genuine NQ reason |

---

### L2 · Template D — Day 14 · Final follow-up

| Field | Value |
|---|---|
| **Leak # + goal** | Leak 2 — Soft close |
| **Target statuses / Q-NQ rule** | As Leak 2 above |
| **Day offset** | Day 14 |
| **Template code** | `ahl_leak2_d14_d_final` |
| **Exact message body (template format)** | `{{1}}, we are here when you are ready. Reply READY for a callback, or STOP to end messages.` |
| **Variables** | `{{1}}` name |
| **Suggested buttons** | READY · STOP |
| **Stop rule** | Global stop; STOP ends sequence |

---

### L2 · Template C — Deferred only (callback date)

| Field | Value |
|---|---|
| **Leak # + goal** | Leak 2 — Deferred callback (Elma Template C) |
| **Target statuses / Q-NQ rule** | `Deferred Lead` with a scheduled callback / follow-up date that is due today |
| **Day offset** | On deferred callback date (not Day 1/3/7/14) |
| **Template code** | `ahl_leak2_deferred_c_callback` |
| **Exact message body (template format)** | `Hi {{1}}, as discussed we are connecting today. This is {{2}} from American Hairline. Are you available for a short call now, or should we reschedule?` |
| **Variables** | `{{1}}` name · `{{2}}` agent |
| **Suggested buttons** | Call now · Reschedule · STOP |
| **Stop rule** | Global stop; skip if deferred date not due |

---

## LEAK 3 — Qualified → Booking  
**Goal:** Book the consultation for already-qualified leads.

**Target statuses / Q-NQ rule**  
**Q/NQ = Q**; no Consultation Booked date;  
status still `Warm Lead` / `Cold Lead 1` / `Cold Lead 2` / `Deferred Lead` / `Lost`.  
Over 7 days since qualified with no booking = leaking. Overdue follow-up = our leak.

---

### L3 · Template A — Day 1 · First follow-up

| Field | Value |
|---|---|
| **Leak # + goal** | Leak 3 — Ask for booking slots |
| **Target statuses / Q-NQ rule** | As Leak 3 above |
| **Day offset** | Day 1 (from qualified date; if unknown, last status change) |
| **Template code** | `ahl_leak3_d1_a_book` |
| **Exact message body (template format)** | `Hi {{1}}, based on our discussion you are a good fit. Shall we book your consultation? Please share 2 preferred slots with day and time.` |
| **Variables** | `{{1}}` name |
| **Suggested buttons** | Book · Share slots · Not now |
| **Stop rule** | Global stop (Booked / Visited / Order) |

---

### L3 · Template B — Day 3 · Reminder

| Field | Value |
|---|---|
| **Leak # + goal** | Leak 3 — Slot urgency, low pressure |
| **Target statuses / Q-NQ rule** | As Leak 3 above |
| **Day offset** | Day 3 |
| **Template code** | `ahl_leak3_d3_b_reminder` |
| **Exact message body (template format)** | `{{1}}, consult slots fill up for in-person and online. Reply BOOK and {{2}} will confirm a time that works for you.` |
| **Variables** | `{{1}}` name · `{{2}}` agent |
| **Suggested buttons** | BOOK · Call me · STOP |
| **Stop rule** | Global stop |

---

### L3 · Template B2 — Day 7 · Second reminder

| Field | Value |
|---|---|
| **Leak # + goal** | Leak 3 — Objection handler |
| **Target statuses / Q-NQ rule** | As Leak 3 above |
| **Day offset** | Day 7 |
| **Template code** | `ahl_leak3_d7_b2_objection` |
| **Exact message body (template format)** | `Hi {{1}}, if price, family approval or travel is holding the booking, tell us which one and we will help with options. Reply PRICE, FAMILY or TRAVEL.` |
| **Variables** | `{{1}}` name |
| **Suggested buttons** | PRICE · FAMILY · TRAVEL |
| **Stop rule** | Global stop |

---

### L3 · Template D — Day 14 · Final follow-up

| Field | Value |
|---|---|
| **Leak # + goal** | Leak 3 — Final nudge |
| **Target statuses / Q-NQ rule** | As Leak 3 above |
| **Day offset** | Day 14 |
| **Template code** | `ahl_leak3_d14_d_final` |
| **Exact message body (template format)** | `{{1}}, last follow-up on your consultation. Reply YES to book, or LATER with a date and we will wait till then.` |
| **Variables** | `{{1}}` name |
| **Suggested buttons** | YES · LATER · STOP |
| **Stop rule** | Global stop; end sequence after this send |

---

## Approval checklist
- [ ] CRM / Elma approve all 13 message bodies (12 leak sequence + 1 Deferred C)  
- [ ] Meta category = Marketing; buttons OK  
- [ ] Pilot = Mehjabeen only  
- [ ] One shared message library for CRM team + AI follow-up (no duplicate sets)  
- [ ] Confirm working hours / Sunday / holiday queue before go-live  

**Document for:** CRM approval + Meta template submission  
**Aligned with:** Funnel leaks (Calls→Talk, Talk→Q, Q→Booking) + Elma schedule A/B/B2/D + Template C deferred  
