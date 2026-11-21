# AHL Task 2 — WhatsApp Templates (Approval List)

**Brand:** American Hairline  
**Requested by:** Vinitt Sir (CEO)  
**Channel:** WhatsApp Meta templates · Category: **Marketing** · Language: **en_US**  
**Pilot:** Mehjabeen’s leads first  
**Cadence:** Day 1 → A · Day 3 → B · Day 7 → B2 · Day 14 → D (then stop)  
**Total templates:** 12  

Based on **Vinitt Sir’s (CEO)** three Task 2 points only:
1. Qualified but didn’t book  
2. Booked but didn’t come  
3. Visited but didn’t order  

**Variables**
| Token | Meaning |
|-------|---------|
| `{{1}}` | Client first name |
| `{{2}}` | Agent / executive name (only where used) |

**Global stop (do not send if):** Consultation Booked / Consultation Visited / Order placed (as relevant per sequence) · Lead blocked · Client replied STOP · Stage left the target set  

---

# 1) Qualified but didn’t book (Leak 3)

## 1. `ahl_leak3_d1_a_book`
| | |
|---|---|
| **Leak** | Qualified but didn’t book |
| **Goal** | Ask for booking slots |
| **Stages** | Warm Lead, Cold Lead 1, Cold Lead 2, Deferred Lead (Q/NQ = Q; not yet booked) |
| **Day** | Day 1 |
| **Variables** | `{{1}}` name |
| **Buttons** | Book · Share slots · Not now |
| **Body** | Hi {{1}}, based on our discussion you are a good fit. Shall we book your consultation? Please share 2 preferred slots with day and time. |

---

## 2. `ahl_leak3_d3_b_reminder`
| | |
|---|---|
| **Leak** | Qualified but didn’t book |
| **Goal** | Slot urgency, low pressure |
| **Stages** | Same as #1 |
| **Day** | Day 3 |
| **Variables** | `{{1}}` name · `{{2}}` agent |
| **Buttons** | BOOK · Call me · STOP |
| **Body** | {{1}}, consult slots fill up for in-person and online. Reply BOOK and {{2}} will confirm a time that works for you. |

---

## 3. `ahl_leak3_d7_b2_objection`
| | |
|---|---|
| **Leak** | Qualified but didn’t book |
| **Goal** | Objection handler |
| **Stages** | Same as #1 |
| **Day** | Day 7 |
| **Variables** | `{{1}}` name |
| **Buttons** | PRICE · FAMILY · TRAVEL |
| **Body** | Hi {{1}}, if price, family approval or travel is holding the booking, tell us which one and we will help with options. Reply PRICE, FAMILY or TRAVEL. |

---

## 4. `ahl_leak3_d14_d_final`
| | |
|---|---|
| **Leak** | Qualified but didn’t book |
| **Goal** | Final nudge |
| **Stages** | Same as #1 |
| **Day** | Day 14 |
| **Variables** | `{{1}}` name |
| **Buttons** | YES · LATER · STOP |
| **Body** | {{1}}, last follow-up on your consultation. Reply YES to book, or LATER with a date and we will wait till then. |

---

# 2) Booked but didn’t come (no-show)

## 5. `ahl_noshow_d1_a_reschedule`
| | |
|---|---|
| **Leak** | Booked but didn’t come |
| **Goal** | Reschedule missed consultation |
| **Stages** | Consultation Booked — appointment missed / no-show (not Visited / Order) |
| **Day** | Day 1 |
| **Variables** | `{{1}}` name · `{{2}}` agent |
| **Buttons** | Reschedule · Call me · Not now |
| **Body** | Hi {{1}}, we missed you at your American Hairline consultation. Shall we reschedule? Reply with 2 preferred slots and {{2}} will confirm. |

---

## 6. `ahl_noshow_d3_b_reminder`
| | |
|---|---|
| **Leak** | Booked but didn’t come |
| **Goal** | Reminder to rebook |
| **Stages** | Same as #5 |
| **Day** | Day 3 |
| **Variables** | `{{1}}` name |
| **Buttons** | YES · Share day · STOP |
| **Body** | {{1}}, your consult slot is still open. Reply YES to lock a new time, or share a day that works better for you. |

---

## 7. `ahl_noshow_d7_b2_urgency`
| | |
|---|---|
| **Leak** | Booked but didn’t come |
| **Goal** | Urgency check-in |
| **Stages** | Same as #5 |
| **Day** | Day 7 |
| **Variables** | `{{1}}` name |
| **Buttons** | BOOK · CALL · STOP |
| **Body** | Hi {{1}}, just checking in — are you still planning to visit American Hairline? Reply BOOK for a fresh slot or CALL for a quick chat. |

---

## 8. `ahl_noshow_d14_d_final`
| | |
|---|---|
| **Leak** | Booked but didn’t come |
| **Goal** | Final note |
| **Stages** | Same as #5 |
| **Day** | Day 14 |
| **Variables** | `{{1}}` name |
| **Buttons** | READY · STOP |
| **Body** | {{1}}, last note on your missed consultation. Reply READY when you want to rebook, or STOP and we will pause messages. |

---

# 3) Visited but didn’t order

## 9. `ahl_visited_d1_a_followup`
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

## 10. `ahl_visited_d3_b_reminder`
| | |
|---|---|
| **Leak** | Visited but didn’t order |
| **Goal** | Soft reminder to decide |
| **Stages** | Same as #9 |
| **Day** | Day 3 |
| **Variables** | `{{1}}` name |
| **Buttons** | YES · Share concern · STOP |
| **Body** | {{1}}, many clients take a day or two after the visit. Reply YES if you want a quick callback to finalise, or share what is holding you back. |

---

## 11. `ahl_visited_d7_b2_objection`
| | |
|---|---|
| **Leak** | Visited but didn’t order |
| **Goal** | Objection handler |
| **Stages** | Same as #9 |
| **Day** | Day 7 |
| **Variables** | `{{1}}` name |
| **Buttons** | PRICE · TIMING · LOOK |
| **Body** | Hi {{1}}, if price, timing or look is the concern after your visit, tell us which one and we will share clear options. Reply PRICE, TIMING or LOOK. |

---

## 12. `ahl_visited_d14_d_final`
| | |
|---|---|
| **Leak** | Visited but didn’t order |
| **Goal** | Final follow-up |
| **Stages** | Same as #9 |
| **Day** | Day 14 |
| **Variables** | `{{1}}` name |
| **Buttons** | READY · STOP |
| **Body** | {{1}}, last follow-up after your visit. Reply READY when you want to proceed, or STOP to end messages from us. |

---

## Quick index

| # | Template name | Task 2 point |
|---|---------------|--------------|
| 1 | `ahl_leak3_d1_a_book` | Qualified but didn’t book |
| 2 | `ahl_leak3_d3_b_reminder` | Qualified but didn’t book |
| 3 | `ahl_leak3_d7_b2_objection` | Qualified but didn’t book |
| 4 | `ahl_leak3_d14_d_final` | Qualified but didn’t book |
| 5 | `ahl_noshow_d1_a_reschedule` | Booked but didn’t come |
| 6 | `ahl_noshow_d3_b_reminder` | Booked but didn’t come |
| 7 | `ahl_noshow_d7_b2_urgency` | Booked but didn’t come |
| 8 | `ahl_noshow_d14_d_final` | Booked but didn’t come |
| 9 | `ahl_visited_d1_a_followup` | Visited but didn’t order |
| 10 | `ahl_visited_d3_b_reminder` | Visited but didn’t order |
| 11 | `ahl_visited_d7_b2_objection` | Visited but didn’t order |
| 12 | `ahl_visited_d14_d_final` | Visited but didn’t order |

---

**Approval**  
- [ ] CRM / Elma approve all 12 bodies + buttons  
- [ ] Meta: Marketing · en_US  
- [ ] Pilot: Mehjabeen only  

**File:** `docs/AHL_Task2_Templates_Approval_List.md`  
**For:** CRM / Elma / Meta template submission approval  
