# AHL Task 2 — WhatsApp Templates (Approval List)

**Brand:** American Hairline  
**Channel:** WhatsApp Meta templates · Category: **Marketing** · Language: **en_US**  
**Pilot:** Mehjabeen’s leads first  
**Cadence:** Day 1 → A · Day 3 → B · Day 7 → B2 · Day 14 → D (then stop)  
**Total templates:** 21  

**Variables**
| Token | Meaning |
|-------|---------|
| `{{1}}` | Client first name |
| `{{2}}` | Agent / executive name (only where used) |

**Global stop (do not send if):** Consultation Booked / Consultation Visited / Order placed · Lead blocked · Client replied STOP · Stage left the target set  

---

## 1. `ahl_leak1_d1_a_intro`
| | |
|---|---|
| **Leak** | Leak 1 — Calls → Talk |
| **Goal** | Soft intro; open first conversation |
| **Stages** | New Lead, Ringing / Busy, Not Reachable (or Lost/Dead with unreachable-only reasons) |
| **Day** | Day 1 |
| **Variables** | `{{1}}` name · `{{2}}` agent |
| **Buttons** | Call me · WhatsApp only · Not now |
| **Body** | Hi {{1}}, this is {{2}} from American Hairline. We tried reaching you about your hair enquiry. When is a good time for a quick 2-min call? |

---

## 2. `ahl_leak1_d3_b_reminder`
| | |
|---|---|
| **Leak** | Leak 1 — Calls → Talk |
| **Goal** | Value + easy reply |
| **Stages** | Same as #1; still never spoken |
| **Day** | Day 3 |
| **Variables** | `{{1}}` name |
| **Buttons** | YES · Share time · STOP |
| **Body** | Hi {{1}}, many clients start with a short consult to find the right hairline option. Reply YES and we will call you, or share a preferred time. |

---

## 3. `ahl_leak1_d7_b2_cta`
| | |
|---|---|
| **Leak** | Leak 1 — Calls → Talk |
| **Goal** | Direct choice CTA |
| **Stages** | Same as #1 |
| **Day** | Day 7 |
| **Variables** | `{{1}}` name |
| **Buttons** | 1 Call me · 2 WhatsApp · 3 Not interested |
| **Body** | {{1}}, we still could not connect. Are you still exploring a hair solution? Reply 1 for Call me today, 2 for WhatsApp only, 3 for Not interested. |

---

## 4. `ahl_leak1_d14_d_final`
| | |
|---|---|
| **Leak** | Leak 1 — Calls → Talk |
| **Goal** | Close loop politely (final automated WhatsApp) |
| **Stages** | Same as #1 |
| **Day** | Day 14 |
| **Variables** | `{{1}}` name |
| **Buttons** | Call me · STOP |
| **Body** | Hi {{1}}, last note from American Hairline. We will pause follow-ups for now. If you want help later, just reply and we will assist. |

---

## 5. `ahl_leak2_d1_a_qualify`
| | |
|---|---|
| **Leak** | Leak 2 — Talk → Qualified |
| **Goal** | Re-open + ask qualify questions |
| **Stages** | Warm Lead, Cold Lead 1, Cold Lead 2, Deferred Lead (Q/NQ = NQ or blank; exclude genuine NQ with real reason) |
| **Day** | Day 1 |
| **Variables** | `{{1}}` name · `{{2}}` agent |
| **Buttons** | Share details · Call me · Not now |
| **Body** | Hi {{1}}, thanks for speaking with {{2}} from American Hairline. To suggest the right option, please share your city, budget range, and when you can visit. |

---

## 6. `ahl_leak2_d3_b_reminder`
| | |
|---|---|
| **Leak** | Leak 2 — Talk → Qualified |
| **Goal** | Help them decide + next step |
| **Stages** | Same as #5 |
| **Day** | Day 3 |
| **Variables** | `{{1}}` name |
| **Buttons** | Share city/day · Call me · STOP |
| **Body** | {{1}}, a short consult helps confirm fit, look, maintenance and cost. Reply with your city and preferred day and we will guide the next step. |

---

## 7. `ahl_leak2_d7_b2_objection`
| | |
|---|---|
| **Leak** | Leak 2 — Talk → Qualified |
| **Goal** | Objection clarity |
| **Stages** | Same as #5 |
| **Day** | Day 7 |
| **Variables** | `{{1}}` name |
| **Buttons** | COST · TRAVEL · TIMING |
| **Body** | Hi {{1}}, if cost, travel or timing was the concern, tell us which one and we can suggest a realistic plan. Reply COST, TRAVEL or TIMING. |

---

## 8. `ahl_leak2_d14_d_final`
| | |
|---|---|
| **Leak** | Leak 2 — Talk → Qualified |
| **Goal** | Soft close |
| **Stages** | Same as #5 |
| **Day** | Day 14 |
| **Variables** | `{{1}}` name |
| **Buttons** | READY · STOP |
| **Body** | {{1}}, we are here when you are ready. Reply READY for a callback, or STOP to end messages. |

---

## 9. `ahl_leak2_deferred_c_callback`
| | |
|---|---|
| **Leak** | Leak 2 — Deferred callback (Template C) |
| **Goal** | Connect on scheduled deferred date |
| **Stages** | Deferred Lead with callback / follow-up date due today |
| **Day** | On deferred callback date (not Day 1/3/7/14) |
| **Variables** | `{{1}}` name · `{{2}}` agent |
| **Buttons** | Call now · Reschedule · STOP |
| **Body** | Hi {{1}}, as discussed we are connecting today. This is {{2}} from American Hairline. Are you available for a short call now, or should we reschedule? |

---

## 10. `ahl_leak3_d1_a_book`
| | |
|---|---|
| **Leak** | Leak 3 — Qualified → Booking |
| **Goal** | Ask for booking slots |
| **Stages** | Warm Lead, Cold Lead 1, Cold Lead 2, Deferred Lead (Q/NQ = Q; not yet booked) |
| **Day** | Day 1 |
| **Variables** | `{{1}}` name |
| **Buttons** | Book · Share slots · Not now |
| **Body** | Hi {{1}}, based on our discussion you are a good fit. Shall we book your consultation? Please share 2 preferred slots with day and time. |

---

## 11. `ahl_leak3_d3_b_reminder`
| | |
|---|---|
| **Leak** | Leak 3 — Qualified → Booking |
| **Goal** | Slot urgency, low pressure |
| **Stages** | Same as #10 |
| **Day** | Day 3 |
| **Variables** | `{{1}}` name · `{{2}}` agent |
| **Buttons** | BOOK · Call me · STOP |
| **Body** | {{1}}, consult slots fill up for in-person and online. Reply BOOK and {{2}} will confirm a time that works for you. |

---

## 12. `ahl_leak3_d7_b2_objection`
| | |
|---|---|
| **Leak** | Leak 3 — Qualified → Booking |
| **Goal** | Objection handler |
| **Stages** | Same as #10 |
| **Day** | Day 7 |
| **Variables** | `{{1}}` name |
| **Buttons** | PRICE · FAMILY · TRAVEL |
| **Body** | Hi {{1}}, if price, family approval or travel is holding the booking, tell us which one and we will help with options. Reply PRICE, FAMILY or TRAVEL. |

---

## 13. `ahl_leak3_d14_d_final`
| | |
|---|---|
| **Leak** | Leak 3 — Qualified → Booking |
| **Goal** | Final nudge |
| **Stages** | Same as #10 |
| **Day** | Day 14 |
| **Variables** | `{{1}}` name |
| **Buttons** | YES · LATER · STOP |
| **Body** | {{1}}, last follow-up on your consultation. Reply YES to book, or LATER with a date and we will wait till then. |

---

## 14. `ahl_noshow_d1_a_reschedule`
| | |
|---|---|
| **Leak** | Booked but didn’t come (no-show) |
| **Goal** | Reschedule missed consultation |
| **Stages** | Consultation Booked — appointment missed / no-show (not Visited / Order) |
| **Day** | Day 1 |
| **Variables** | `{{1}}` name · `{{2}}` agent |
| **Buttons** | Reschedule · Call me · Not now |
| **Body** | Hi {{1}}, we missed you at your American Hairline consultation. Shall we reschedule? Reply with 2 preferred slots and {{2}} will confirm. |

---

## 15. `ahl_noshow_d3_b_reminder`
| | |
|---|---|
| **Leak** | Booked but didn’t come (no-show) |
| **Goal** | Reminder to rebook |
| **Stages** | Same as #14 |
| **Day** | Day 3 |
| **Variables** | `{{1}}` name |
| **Buttons** | YES · Share day · STOP |
| **Body** | {{1}}, your consult slot is still open. Reply YES to lock a new time, or share a day that works better for you. |

---

## 16. `ahl_noshow_d7_b2_urgency`
| | |
|---|---|
| **Leak** | Booked but didn’t come (no-show) |
| **Goal** | Urgency check-in |
| **Stages** | Same as #14 |
| **Day** | Day 7 |
| **Variables** | `{{1}}` name |
| **Buttons** | BOOK · CALL · STOP |
| **Body** | Hi {{1}}, just checking in — are you still planning to visit American Hairline? Reply BOOK for a fresh slot or CALL for a quick chat. |

---

## 17. `ahl_noshow_d14_d_final`
| | |
|---|---|
| **Leak** | Booked but didn’t come (no-show) |
| **Goal** | Final note |
| **Stages** | Same as #14 |
| **Day** | Day 14 |
| **Variables** | `{{1}}` name |
| **Buttons** | READY · STOP |
| **Body** | {{1}}, last note on your missed consultation. Reply READY when you want to rebook, or STOP and we will pause messages. |

---

## 18. `ahl_visited_d1_a_followup`
| | |
|---|---|
| **Leak** | Visited but didn’t order |
| **Goal** | Post-visit follow-up |
| **Stages** | Consultation Visited — no Order yet |
| **Day** | Day 1 |
| **Variables** | `{{1}}` name · `{{2}}` agent |
| **Buttons** | Ask question · Call me · Not now |
| **Body** | Hi {{1}}, thank you for visiting American Hairline. This is {{2}}. Any questions on the options we showed? Happy to help you decide. |

---

## 19. `ahl_visited_d3_b_reminder`
| | |
|---|---|
| **Leak** | Visited but didn’t order |
| **Goal** | Soft reminder to decide |
| **Stages** | Same as #18 |
| **Day** | Day 3 |
| **Variables** | `{{1}}` name |
| **Buttons** | YES · Share concern · STOP |
| **Body** | {{1}}, many clients take a day or two after the visit. Reply YES if you want a quick callback to finalise, or share what is holding you back. |

---

## 20. `ahl_visited_d7_b2_objection`
| | |
|---|---|
| **Leak** | Visited but didn’t order |
| **Goal** | Objection handler |
| **Stages** | Same as #18 |
| **Day** | Day 7 |
| **Variables** | `{{1}}` name |
| **Buttons** | PRICE · TIMING · LOOK |
| **Body** | Hi {{1}}, if price, timing or look is the concern after your visit, tell us which one and we will share clear options. Reply PRICE, TIMING or LOOK. |

---

## 21. `ahl_visited_d14_d_final`
| | |
|---|---|
| **Leak** | Visited but didn’t order |
| **Goal** | Final follow-up |
| **Stages** | Same as #18 |
| **Day** | Day 14 |
| **Variables** | `{{1}}` name |
| **Buttons** | READY · STOP |
| **Body** | {{1}}, last follow-up after your visit. Reply READY when you want to proceed, or STOP to end messages from us. |

---

## Quick index

| # | Template name | Leak / stage goal |
|---|---------------|-------------------|
| 1 | `ahl_leak1_d1_a_intro` | Leak 1 — first talk |
| 2 | `ahl_leak1_d3_b_reminder` | Leak 1 — reminder |
| 3 | `ahl_leak1_d7_b2_cta` | Leak 1 — CTA |
| 4 | `ahl_leak1_d14_d_final` | Leak 1 — final |
| 5 | `ahl_leak2_d1_a_qualify` | Leak 2 — qualify |
| 6 | `ahl_leak2_d3_b_reminder` | Leak 2 — reminder |
| 7 | `ahl_leak2_d7_b2_objection` | Leak 2 — objection |
| 8 | `ahl_leak2_d14_d_final` | Leak 2 — final |
| 9 | `ahl_leak2_deferred_c_callback` | Leak 2 — deferred callback day |
| 10 | `ahl_leak3_d1_a_book` | Leak 3 — ask to book |
| 11 | `ahl_leak3_d3_b_reminder` | Leak 3 — slot urgency |
| 12 | `ahl_leak3_d7_b2_objection` | Leak 3 — objection |
| 13 | `ahl_leak3_d14_d_final` | Leak 3 — final |
| 14 | `ahl_noshow_d1_a_reschedule` | Booked, didn’t come |
| 15 | `ahl_noshow_d3_b_reminder` | Booked, didn’t come |
| 16 | `ahl_noshow_d7_b2_urgency` | Booked, didn’t come |
| 17 | `ahl_noshow_d14_d_final` | Booked, didn’t come |
| 18 | `ahl_visited_d1_a_followup` | Visited, didn’t order |
| 19 | `ahl_visited_d3_b_reminder` | Visited, didn’t order |
| 20 | `ahl_visited_d7_b2_objection` | Visited, didn’t order |
| 21 | `ahl_visited_d14_d_final` | Visited, didn’t order |

---

**Approval**  
- [ ] CRM / Elma approve all 21 bodies + buttons  
- [ ] Meta: Marketing · en_US  
- [ ] Pilot: Mehjabeen only  

**File:** `docs/AHL_Task2_Templates_Approval_List.md`  
**For:** CRM / Elma / Meta template submission approval  
