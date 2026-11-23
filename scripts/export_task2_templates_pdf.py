"""Export CRM-revised Task 2 approval PDF (12 templates) to Downloads."""

from __future__ import annotations

from pathlib import Path

from fpdf import FPDF

OUT = Path.home() / "Downloads" / "AHL_Task2_Templates_Approval_List.pdf"

TEMPLATES = [
    dict(
        n=1,
        name="ahl_leak3_d1_a_book",
        category="Qualified but did not book",
        day="Day 1",
        variables="{{1}} name",
        buttons="BOOK | SHARE SLOTS | NOT NOW",
        body="Hi {{1}}, thank you for speaking with us. Would you like to schedule your consultation? Please share two preferred slots with the day and time, and our team will help you confirm.",
    ),
    dict(
        n=2,
        name="ahl_leak3_d3_b_reminder",
        category="Qualified but did not book",
        day="Day 3",
        variables="{{1}} name | {{2}} agent",
        buttons="BOOK | CALL ME | STOP",
        body="Hi {{1}}, just following up to check if you would like to schedule your consultation. Reply BOOK and {{2}} will help you confirm a suitable time.",
    ),
    dict(
        n=3,
        name="ahl_leak3_d7_b2_objection",
        category="Qualified but did not book",
        day="Day 7",
        variables="{{1}} name",
        buttons="PRICE | FAMILY | TRAVEL",
        body="Hi {{1}}, if price, family approval or travel is holding you back from booking your consultation, please let us know. We will be happy to help with your concerns.",
    ),
    dict(
        n=4,
        name="ahl_leak3_d14_d_final",
        category="Qualified but did not book",
        day="Day 14",
        variables="{{1}} name",
        buttons="YES | LATER | STOP",
        body="Hi {{1}}, just one last follow-up regarding your consultation. Reply YES if you would like to book, or LATER with a suitable date if you need more time.",
    ),
    dict(
        n=5,
        name="ahl_noshow_d1_a_reschedule",
        category="Booked but did not come",
        day="Day 1",
        variables="{{1}} name | {{2}} agent",
        buttons="RESCHEDULE | CALL ME | NOT NOW",
        body="Hi {{1}}, we noticed you couldn't attend your scheduled consultation at American Hairline. Would you like to reschedule? Please share two preferred slots, and {{2}} will help you confirm.",
    ),
    dict(
        n=6,
        name="ahl_noshow_d3_b_reminder",
        category="Booked but did not come",
        day="Day 3",
        variables="{{1}} name",
        buttons="YES | PREFERRED DATE | STOP",
        body="Hi {{1}}, just checking if you would like to reschedule your missed consultation. Please share your preferred date, and our team will help you arrange a new appointment.",
    ),
    dict(
        n=7,
        name="ahl_noshow_d7_b2_urgency",
        category="Booked but did not come",
        day="Day 7",
        variables="{{1}} name",
        buttons="BOOK | CALL | STOP",
        body="Hi {{1}}, just checking in to see if you are still planning to visit American Hairline. Reply BOOK to schedule a new consultation or CALL if you would like to speak with our team.",
    ),
    dict(
        n=8,
        name="ahl_noshow_d14_d_final",
        category="Booked but did not come",
        day="Day 14",
        variables="{{1}} name",
        buttons="READY | STOP",
        body="Hi {{1}}, this is our last follow-up regarding your missed consultation. Reply READY whenever you would like to reschedule, or STOP if you do not wish to receive further messages.",
    ),
    dict(
        n=9,
        name="ahl_visited_d1_a_followup",
        category="Visited but did not order",
        day="Day 1",
        variables="{{1}} name | {{2}} agent",
        buttons="ASK QUESTION | CALL ME | NOT NOW",
        body="Hi {{1}}, thank you for visiting American Hairline. This is {{2}}. We wanted to check if you have any questions about the options discussed during your consultation. We will be happy to assist you.",
    ),
    dict(
        n=10,
        name="ahl_visited_d3_b_reminder",
        category="Visited but did not order",
        day="Day 3",
        variables="{{1}} name",
        buttons="YES | SHARE CONCERN | STOP",
        body="Hi {{1}}, we hope you had a good experience during your visit. Would you like a callback to discuss your options or clarify any concerns?",
    ),
    dict(
        n=11,
        name="ahl_visited_d7_b2_objection",
        category="Visited but did not order",
        day="Day 7",
        variables="{{1}} name",
        buttons="PRICE | TIMING | LOOK",
        body="Hi {{1}}, if price, timing or the expected look is a concern after your consultation, please let us know. We will be happy to understand your concerns and help you with the available options.",
    ),
    dict(
        n=12,
        name="ahl_visited_d14_d_final",
        category="Visited but did not order",
        day="Day 14",
        variables="{{1}} name",
        buttons="READY | STOP",
        body="Hi {{1}}, this is our last follow-up regarding your consultation. Reply READY if you would like to proceed or discuss the next steps, or STOP if you do not wish to receive further messages.",
    ),
]

SECTIONS = {
    1: (
        "1) Qualified but did not book",
        "Stages: Warm Lead, Cold Lead 1, Cold Lead 2, Deferred Lead (qualified only). Not yet booked.",
    ),
    5: (
        "2) Booked but did not come",
        "Stages: Consultation Booked - verified missed appointment / no-show. Exclude visited.",
    ),
    9: (
        "3) Visited but did not order",
        "Stages: Consultation Visited - no order yet. Verified visit only.",
    ),
}


def ascii(s: str) -> str:
    return (
        s.replace("\u2014", "-")
        .replace("\u2013", "-")
        .replace("\u2019", "'")
        .replace("\u2018", "'")
        .replace("\u2022", "-")
        .replace("\u00b7", "|")
        .encode("latin-1", "replace")
        .decode("latin-1")
    )


class PDF(FPDF):
    def header(self) -> None:
        if self.page_no() == 1:
            return
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(100, 100, 100)
        self.cell(0, 6, "AHL Task 2 - CRM Revised Templates (Final Approval)", align="C")
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

    pdf.set_font("Helvetica", "B", 15)
    pdf.set_text_color(20, 20, 20)
    pdf.multi_cell(0, 7, "AHL Task 2 - WhatsApp Follow-up Templates")
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(15, 40, 80)
    pdf.cell(0, 6, "CRM Review Version - for final approval", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(40, 40, 40)
    for line in [
        "Brand: American Hairline",
        "Requested by: Vinitt Sir (CEO)",
        "Channel: WhatsApp Meta templates | Category: Marketing | Language: en_US",
        "Number: AHL Messaging (Meta Cloud API)",
        "Pilot: Mehjabeen's leads first",
        "Cadence: Day 1 -> Day 3 -> Day 7 -> Day 14 (then stop)",
        "Total templates: 12",
        "",
        "Incorporates CRM suggested wording, buttons, stage targeting and stop rules.",
        'Internal term "Leak" is not used - categories use the three labels below only.',
        "",
        "1) Qualified but did not book",
        "2) Booked but did not come",
        "3) Visited but did not order",
        "",
        "{{1}} = Client first name",
        "{{2}} = Assigned CRM executive / agent name (where used)",
    ]:
        pdf.cell(0, 5, line, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)

    for t in TEMPLATES:
        if t["n"] in SECTIONS:
            if pdf.get_y() > 245:
                pdf.add_page()
            title, stage = SECTIONS[t["n"]]
            pdf.set_font("Helvetica", "B", 12)
            pdf.set_text_color(15, 40, 80)
            pdf.cell(0, 7, title, new_x="LMARGIN", new_y="NEXT")
            pdf.set_font("Helvetica", "", 9)
            pdf.set_text_color(50, 50, 50)
            pdf.multi_cell(0, 5, ascii(stage))
            pdf.ln(1)
        if pdf.get_y() > 235:
            pdf.add_page()
        pdf.set_fill_color(240, 244, 248)
        pdf.set_font("Helvetica", "B", 11)
        pdf.set_text_color(15, 40, 80)
        pdf.cell(0, 7, ascii(f"{t['n']}. {t['name']}"), fill=True, new_x="LMARGIN", new_y="NEXT")
        pdf.ln(1)
        field(pdf, "Category", t["category"])
        field(pdf, "Day", t["day"])
        field(pdf, "Variables", t["variables"])
        field(pdf, "Buttons", t["buttons"])
        field(pdf, "Body", t["body"])
        pdf.ln(3)

    if pdf.get_y() > 200:
        pdf.add_page()
    pdf.set_font("Helvetica", "B", 12)
    pdf.set_text_color(15, 40, 80)
    pdf.cell(0, 8, "Stop rules and exclusions", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(30, 30, 30)
    for item in [
        "- Stop sequence when lead leaves target stage or completes next action (book / visit / order).",
        "- STOP -> stop automated WhatsApp immediately.",
        "- CALL ME / CALL -> hand over to assigned CRM executive.",
        "- NOT NOW / LATER -> CRM callback process.",
        "- No duplicate or overlapping sequences for the same lead.",
        "- Exclude leads already booked / visited / converted from earlier sequences.",
        "- Unclear replies or human-help requests -> flag for executive review.",
        "- Pilot: Mehjabeen's leads only until CRM expands.",
    ]:
        pdf.set_x(pdf.l_margin)
        pdf.multi_cell(0, 5, item)

    pdf.ln(3)
    pdf.set_font("Helvetica", "B", 12)
    pdf.set_text_color(15, 40, 80)
    pdf.cell(0, 8, "After final CRM approval", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(30, 30, 30)
    for item in [
        "1. Submit 12 templates to Meta as Marketing / en_US on AHL Messaging.",
        "2. Wait for APPROVED status.",
        "3. Attach to One Inbox drip campaigns (Mehjabeen pilot).",
        "4. Auto-send Day 1 -> 3 -> 7 -> 14 with stop rules above.",
    ]:
        pdf.set_x(pdf.l_margin)
        pdf.multi_cell(0, 5, item)

    pdf.ln(3)
    pdf.set_font("Helvetica", "B", 12)
    pdf.set_text_color(15, 40, 80)
    pdf.cell(0, 8, "CRM approval checklist", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(30, 30, 30)
    for item in [
        "[ ] Elma / CRM approve all 12 bodies + buttons",
        "[ ] Stage targeting confirmed",
        "[ ] Stop rules confirmed",
        "[ ] Ready for Meta submission",
    ]:
        pdf.cell(0, 6, item, new_x="LMARGIN", new_y="NEXT")

    pdf.ln(4)
    pdf.set_font("Helvetica", "I", 9)
    pdf.set_text_color(90, 90, 90)
    pdf.multi_cell(
        0,
        5,
        "Status: Revised after CRM suggested corrections - pending final approval.",
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    pdf.output(str(OUT))
    print(f"Saved: {OUT}")
    print(f"Size: {OUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
