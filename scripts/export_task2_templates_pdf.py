"""Export Task 2 approval list PDF (12 templates) to Downloads."""

from __future__ import annotations

from pathlib import Path

from fpdf import FPDF

OUT = Path.home() / "Downloads" / "AHL_Task2_Templates_Approval_List.pdf"

TEMPLATES = [
    dict(
        n=1,
        name="ahl_leak3_d1_a_book",
        leak="Qualified but did not book",
        goal="Ask for booking slots",
        stages="Warm Lead, Cold Lead 1, Cold Lead 2, Deferred Lead (Q/NQ = Q; not yet booked)",
        day="Day 1",
        variables="{{1}} name",
        buttons="Book | Share slots | Not now",
        body="Hi {{1}}, based on our discussion you are a good fit. Shall we book your consultation? Please share 2 preferred slots with day and time.",
    ),
    dict(
        n=2,
        name="ahl_leak3_d3_b_reminder",
        leak="Qualified but did not book",
        goal="Slot urgency, low pressure",
        stages="Same as #1",
        day="Day 3",
        variables="{{1}} name | {{2}} agent",
        buttons="BOOK | Call me | STOP",
        body="{{1}}, consult slots fill up for in-person and online. Reply BOOK and {{2}} will confirm a time that works for you.",
    ),
    dict(
        n=3,
        name="ahl_leak3_d7_b2_objection",
        leak="Qualified but did not book",
        goal="Objection handler",
        stages="Same as #1",
        day="Day 7",
        variables="{{1}} name",
        buttons="PRICE | FAMILY | TRAVEL",
        body="Hi {{1}}, if price, family approval or travel is holding the booking, tell us which one and we will help with options. Reply PRICE, FAMILY or TRAVEL.",
    ),
    dict(
        n=4,
        name="ahl_leak3_d14_d_final",
        leak="Qualified but did not book",
        goal="Final nudge",
        stages="Same as #1",
        day="Day 14",
        variables="{{1}} name",
        buttons="YES | LATER | STOP",
        body="{{1}}, last follow-up on your consultation. Reply YES to book, or LATER with a date and we will wait till then.",
    ),
    dict(
        n=5,
        name="ahl_noshow_d1_a_reschedule",
        leak="Booked but did not come (no-show)",
        goal="Reschedule missed consultation",
        stages="Consultation Booked - appointment missed / no-show (not Visited / Order)",
        day="Day 1",
        variables="{{1}} name | {{2}} agent",
        buttons="Reschedule | Call me | Not now",
        body="Hi {{1}}, we missed you at your American Hairline consultation. Shall we reschedule? Reply with 2 preferred slots and {{2}} will confirm.",
    ),
    dict(
        n=6,
        name="ahl_noshow_d3_b_reminder",
        leak="Booked but did not come (no-show)",
        goal="Reminder to rebook",
        stages="Same as #5",
        day="Day 3",
        variables="{{1}} name",
        buttons="YES | Share day | STOP",
        body="{{1}}, your consult slot is still open. Reply YES to lock a new time, or share a day that works better for you.",
    ),
    dict(
        n=7,
        name="ahl_noshow_d7_b2_urgency",
        leak="Booked but did not come (no-show)",
        goal="Urgency check-in",
        stages="Same as #5",
        day="Day 7",
        variables="{{1}} name",
        buttons="BOOK | CALL | STOP",
        body="Hi {{1}}, just checking in - are you still planning to visit American Hairline? Reply BOOK for a fresh slot or CALL for a quick chat.",
    ),
    dict(
        n=8,
        name="ahl_noshow_d14_d_final",
        leak="Booked but did not come (no-show)",
        goal="Final note",
        stages="Same as #5",
        day="Day 14",
        variables="{{1}} name",
        buttons="READY | STOP",
        body="{{1}}, last note on your missed consultation. Reply READY when you want to rebook, or STOP and we will pause messages.",
    ),
    dict(
        n=9,
        name="ahl_visited_d1_a_followup",
        leak="Visited but did not order",
        goal="Post-visit follow-up",
        stages="Consultation Visited - no Order yet",
        day="Day 1",
        variables="{{1}} name | {{2}} agent",
        buttons="Ask question | Call me | Not now",
        body="Hi {{1}}, thank you for visiting American Hairline. This is {{2}}. Any questions on the options we showed? Happy to help you decide.",
    ),
    dict(
        n=10,
        name="ahl_visited_d3_b_reminder",
        leak="Visited but did not order",
        goal="Soft reminder to decide",
        stages="Same as #9",
        day="Day 3",
        variables="{{1}} name",
        buttons="YES | Share concern | STOP",
        body="{{1}}, many clients take a day or two after the visit. Reply YES if you want a quick callback to finalise, or share what is holding you back.",
    ),
    dict(
        n=11,
        name="ahl_visited_d7_b2_objection",
        leak="Visited but did not order",
        goal="Objection handler",
        stages="Same as #9",
        day="Day 7",
        variables="{{1}} name",
        buttons="PRICE | TIMING | LOOK",
        body="Hi {{1}}, if price, timing or look is the concern after your visit, tell us which one and we will share clear options. Reply PRICE, TIMING or LOOK.",
    ),
    dict(
        n=12,
        name="ahl_visited_d14_d_final",
        leak="Visited but did not order",
        goal="Final follow-up",
        stages="Same as #9",
        day="Day 14",
        variables="{{1}} name",
        buttons="READY | STOP",
        body="{{1}}, last follow-up after your visit. Reply READY when you want to proceed, or STOP to end messages from us.",
    ),
]


def ascii(s: str) -> str:
    return (
        s.replace("\u2014", "-")
        .replace("\u2013", "-")
        .replace("\u2019", "'")
        .replace("\u2018", "'")
        .replace("\u2022", "-")
        .replace("\u00b7", "|")
        .replace("\u2192", "->")
        .encode("latin-1", "replace")
        .decode("latin-1")
    )


class PDF(FPDF):
    def header(self) -> None:
        if self.page_no() == 1:
            return
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(100, 100, 100)
        self.cell(0, 6, "AHL Task 2 - Templates Approval List (12)", align="C")
        self.ln(8)

    def footer(self) -> None:
        self.set_y(-12)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(120, 120, 120)
        self.cell(0, 8, f"Page {self.page_no()}", align="C")


def field(pdf: PDF, label: str, value: str) -> None:
    pdf.set_x(pdf.l_margin)
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_text_color(30, 30, 30)
    pdf.write(5, f"{label}: ")
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(40, 40, 40)
    pdf.multi_cell(0, 5, ascii(value))


def main() -> None:
    pdf = PDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=16)
    pdf.add_page()
    pdf.set_margins(16, 16, 16)

    pdf.set_font("Helvetica", "B", 16)
    pdf.set_text_color(20, 20, 20)
    pdf.multi_cell(0, 8, "AHL Task 2 - WhatsApp Templates (Approval List)")
    pdf.ln(2)

    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(40, 40, 40)
    for line in [
        "Brand: American Hairline",
        "Requested by: Vinitt Sir (CEO)",
        "Channel: WhatsApp Meta templates | Category: Marketing | Language: en_US",
        "Pilot: Mehjabeen's leads first",
        "Cadence: Day 1 = A | Day 3 = B | Day 7 = B2 | Day 14 = D (then stop)",
        "Total templates: 12",
        "",
        "Based on Vinitt Sir's (CEO) three Task 2 points only:",
        "1) Qualified but did not book",
        "2) Booked but did not come",
        "3) Visited but did not order",
    ]:
        pdf.cell(0, 5, line, new_x="LMARGIN", new_y="NEXT")

    pdf.ln(2)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 5, "Variables", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 5, "{{1}} = Client first name", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 5, "{{2}} = Agent / executive name (only where used)", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(1)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 5, "Global stop (do not send if):", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)
    pdf.multi_cell(
        0,
        5,
        "Booked / Visited / Order (as relevant per sequence) | Lead blocked | Client replied STOP | Stage left the target set",
    )
    pdf.ln(3)

    sections = [
        (1, "1) Qualified but did not book"),
        (5, "2) Booked but did not come"),
        (9, "3) Visited but did not order"),
    ]
    section_at = {n: title for n, title in sections}

    for t in TEMPLATES:
        if t["n"] in section_at:
            if pdf.get_y() > 250:
                pdf.add_page()
            pdf.set_font("Helvetica", "B", 12)
            pdf.set_text_color(15, 40, 80)
            pdf.cell(0, 8, section_at[t["n"]], new_x="LMARGIN", new_y="NEXT")
            pdf.ln(1)
        if pdf.get_y() > 230:
            pdf.add_page()
        pdf.set_fill_color(240, 244, 248)
        pdf.set_font("Helvetica", "B", 11)
        pdf.set_text_color(15, 40, 80)
        pdf.cell(0, 7, ascii(f"{t['n']}. {t['name']}"), fill=True, new_x="LMARGIN", new_y="NEXT")
        pdf.ln(1)
        field(pdf, "Leak", t["leak"])
        field(pdf, "Goal", t["goal"])
        field(pdf, "Stages", t["stages"])
        field(pdf, "Day", t["day"])
        field(pdf, "Variables", t["variables"])
        field(pdf, "Buttons", t["buttons"])
        field(pdf, "Body", t["body"])
        pdf.ln(3)

    if pdf.get_y() > 220:
        pdf.add_page()
    pdf.set_font("Helvetica", "B", 12)
    pdf.set_text_color(15, 40, 80)
    pdf.cell(0, 8, "Approval checklist", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(30, 30, 30)
    for item in [
        "[ ] CRM / Elma approve all 12 bodies + buttons",
        "[ ] Meta: Marketing | en_US",
        "[ ] Pilot: Mehjabeen only",
    ]:
        pdf.cell(0, 6, item, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)
    pdf.set_font("Helvetica", "I", 9)
    pdf.set_text_color(90, 90, 90)
    pdf.multi_cell(0, 5, "For: CRM / Elma / Meta template submission approval")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    pdf.output(str(OUT))
    print(f"Saved: {OUT}")
    print(f"Size: {OUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
