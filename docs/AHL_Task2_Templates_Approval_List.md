# AHL Task 2 — WhatsApp Follow-up Templates

**CRM Review Version — for final approval**  
**Brand:** American Hairline  
**Requested by:** Vinitt Sir (CEO)  
**Channel:** WhatsApp Meta templates · Category: **Marketing** · Language: **en_US**  
**Number:** AHL Messaging (Meta Cloud API)  
**Pilot:** Mehjabeen’s leads first  
**Cadence:** Day 1 → Day 3 → Day 7 → Day 14 (then stop)  
**Total templates:** 12  

Based on Vinitt Sir’s (CEO) three Task 2 follow-ups:
1. Qualified but did not book  
2. Booked but did not come  
3. Visited but did not order  

**Note:** Internal funnel term “Leak” is **not** used in this document. Categories use the three labels above only.

**Variables**
| Token | Meaning |
|-------|---------|
| `{{1}}` | Client first name |
| `{{2}}` | Assigned CRM executive / agent name (only where used) |

---

# 1) Qualified but did not book

**Stage targeting**  
Warm Lead · Cold Lead 1 · Cold Lead 2 · Deferred Lead — **qualified only**  
Only leads who have **not yet booked** a consultation.

---

## 1. `ahl_leak3_d1_a_book`
| | |
|---|---|
| **Category** | Qualified but did not book |
| **Day** | Day 1 |
| **Variables** | `{{1}}` name |
| **Buttons** | BOOK · SHARE SLOTS · NOT NOW |
| **Body** | Hi {{1}}, thank you for speaking with us. Would you like to schedule your consultation? Please share two preferred slots with the day and time, and our team will help you confirm. |

---

## 2. `ahl_leak3_d3_b_reminder`
| | |
|---|---|
| **Category** | Qualified but did not book |
| **Day** | Day 3 |
| **Variables** | `{{1}}` name · `{{2}}` agent |
| **Buttons** | BOOK · CALL ME · STOP |
| **Body** | Hi {{1}}, just following up to check if you would like to schedule your consultation. Reply BOOK and {{2}} will help you confirm a suitable time. |

---

## 3. `ahl_leak3_d7_b2_objection`
| | |
|---|---|
| **Category** | Qualified but did not book |
| **Day** | Day 7 |
| **Variables** | `{{1}}` name |
| **Buttons** | PRICE · FAMILY · TRAVEL |
| **Body** | Hi {{1}}, if price, family approval or travel is holding you back from booking your consultation, please let us know. We will be happy to help with your concerns. |

---

## 4. `ahl_leak3_d14_d_final`
| | |
|---|---|
| **Category** | Qualified but did not book |
| **Day** | Day 14 |
| **Variables** | `{{1}}` name |
| **Buttons** | YES · LATER · STOP |
| **Body** | Hi {{1}}, just one last follow-up regarding your consultation. Reply YES if you would like to book, or LATER with a suitable date if you need more time. |

---

# 2) Booked but did not come

**Stage targeting**  
Consultation Booked — **appointment missed / confirmed no-show**  
Only leads with a **verified missed appointment**. Leads who have already visited must be excluded.

---

## 5. `ahl_noshow_d1_a_reschedule`
| | |
|---|---|
| **Category** | Booked but did not come |
| **Day** | Day 1 |
| **Variables** | `{{1}}` name · `{{2}}` agent |
| **Buttons** | RESCHEDULE · CALL ME · NOT NOW |
| **Body** | Hi {{1}}, we noticed you couldn't attend your scheduled consultation at American Hairline. Would you like to reschedule? Please share two preferred slots, and {{2}} will help you confirm. |

---

## 6. `ahl_noshow_d3_b_reminder`
| | |
|---|---|
| **Category** | Booked but did not come |
| **Day** | Day 3 |
| **Variables** | `{{1}}` name |
| **Buttons** | YES · PREFERRED DATE · STOP |
| **Body** | Hi {{1}}, just checking if you would like to reschedule your missed consultation. Please share your preferred date, and our team will help you arrange a new appointment. |

---

## 7. `ahl_noshow_d7_b2_urgency`
| | |
|---|---|
| **Category** | Booked but did not come |
| **Day** | Day 7 |
| **Variables** | `{{1}}` name |
| **Buttons** | BOOK · CALL · STOP |
| **Body** | Hi {{1}}, just checking in to see if you are still planning to visit American Hairline. Reply BOOK to schedule a new consultation or CALL if you would like to speak with our team. |

---

## 8. `ahl_noshow_d14_d_final`
| | |
|---|---|
| **Category** | Booked but did not come |
| **Day** | Day 14 |
| **Variables** | `{{1}}` name |
| **Buttons** | READY · STOP |
| **Body** | Hi {{1}}, this is our last follow-up regarding your missed consultation. Reply READY whenever you would like to reschedule, or STOP if you do not wish to receive further messages. |

---

# 3) Visited but did not order

**Stage targeting**  
Consultation Visited — **no order yet**  
Only leads with a **verified consultation visit** and no order.

---

## 9. `ahl_visited_d1_a_followup`
| | |
|---|---|
| **Category** | Visited but did not order |
| **Day** | Day 1 |
| **Variables** | `{{1}}` name · `{{2}}` agent |
| **Buttons** | ASK QUESTION · CALL ME · NOT NOW |
| **Body** | Hi {{1}}, thank you for visiting American Hairline. This is {{2}}. We wanted to check if you have any questions about the options discussed during your consultation. We will be happy to assist you. |

---

## 10. `ahl_visited_d3_b_reminder`
| | |
|---|---|
| **Category** | Visited but did not order |
| **Day** | Day 3 |
| **Variables** | `{{1}}` name |
| **Buttons** | YES · SHARE CONCERN · STOP |
| **Body** | Hi {{1}}, we hope you had a good experience during your visit. Would you like a callback to discuss your options or clarify any concerns? |

---

## 11. `ahl_visited_d7_b2_objection`
| | |
|---|---|
| **Category** | Visited but did not order |
| **Day** | Day 7 |
| **Variables** | `{{1}}` name |
| **Buttons** | PRICE · TIMING · LOOK |
| **Body** | Hi {{1}}, if price, timing or the expected look is a concern after your consultation, please let us know. We will be happy to understand your concerns and help you with the available options. |

---

## 12. `ahl_visited_d14_d_final`
| | |
|---|---|
| **Category** | Visited but did not order |
| **Day** | Day 14 |
| **Variables** | `{{1}}` name |
| **Buttons** | READY · STOP |
| **Body** | Hi {{1}}, this is our last follow-up regarding your consultation. Reply READY if you would like to proceed or discuss the next steps, or STOP if you do not wish to receive further messages. |

---

# Stop rules and exclusions

- Stop the sequence when the lead moves out of its target stage or completes the next action (booking, visiting, or placing an order).  
- **STOP** → stop automated WhatsApp messages immediately.  
- **CALL ME / CALL** → hand over to the assigned CRM executive.  
- **NOT NOW / LATER** → handle via CRM callback process.  
- No duplicate or overlapping follow-up sequences for the same lead.  
- Leads already booked, visited, or converted are excluded from earlier sequences.  
- Unclear replies or requests for human help → flag for executive review.  
- Pilot scope: **Mehjabeen’s leads only** until CRM expands.

---

# Quick index

| # | Template name | Category | Day |
|---|---------------|----------|-----|
| 1 | `ahl_leak3_d1_a_book` | Qualified but did not book | Day 1 |
| 2 | `ahl_leak3_d3_b_reminder` | Qualified but did not book | Day 3 |
| 3 | `ahl_leak3_d7_b2_objection` | Qualified but did not book | Day 7 |
| 4 | `ahl_leak3_d14_d_final` | Qualified but did not book | Day 14 |
| 5 | `ahl_noshow_d1_a_reschedule` | Booked but did not come | Day 1 |
| 6 | `ahl_noshow_d3_b_reminder` | Booked but did not come | Day 3 |
| 7 | `ahl_noshow_d7_b2_urgency` | Booked but did not come | Day 7 |
| 8 | `ahl_noshow_d14_d_final` | Booked but did not come | Day 14 |
| 9 | `ahl_visited_d1_a_followup` | Visited but did not order | Day 1 |
| 10 | `ahl_visited_d3_b_reminder` | Visited but did not order | Day 3 |
| 11 | `ahl_visited_d7_b2_objection` | Visited but did not order | Day 7 |
| 12 | `ahl_visited_d14_d_final` | Visited but did not order | Day 14 |

---

# Implementation (after final CRM approval)

1. Submit all 12 templates to Meta as **Marketing / en_US** on **AHL Messaging**.  
2. Wait for Meta **APPROVED** status.  
3. Attach to One Inbox drip campaigns (Mehjabeen pilot).  
4. Auto-send Day 1 → 3 → 7 → 14 with stop rules above.  

---

**CRM approval**  
- [ ] Elma / CRM approve all 12 bodies + buttons  
- [ ] Stage targeting confirmed  
- [ ] Stop rules confirmed  
- [ ] Ready for Meta submission  

**Status:** Revised after CRM suggested corrections — pending final approval  

**For:** Final CRM approval before Meta template creation  
