#!/usr/bin/env python3
"""Generate the decision-analysis Excel workbook, PowerPoint deck and CSV files.

Single source of truth: the criteria, weights and alternative scores defined
in the SOURCE DATA section below. Edit them and re-run the script to regenerate
every artifact.

Example: choosing a digital marketing channel for a product launch.
Scores use a 1-10 scale where 10 is the best. Replace them with your own data.

Usage (from the repository root):

    python3 -m venv .venv && . .venv/bin/activate
    pip install openpyxl python-pptx
    python scripts/generate_decision_artifacts.py [--out-dir docs/decision-model]

Outputs:
    <out-dir>/decision-model.xlsx
    <out-dir>/decision-model.pptx
    <out-dir>/csv/*.csv           (one file per workbook sheet, computed values)

Notes:
- The workbook stores formulas only. openpyxl does not write cached values, so
  Excel computes them on open. Viewers that read cached values (some previews,
  Google Sheets imports, data_only=True) may show blank cells. Open the file once
  in Excel or LibreOffice to store the computed values.
- The sensitivity sheet holds computed values (not formulas). It is refreshed
  whenever the script runs.
"""

from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt

# ---------------------------------------------------------------------------
# SOURCE DATA (edit here only)
# ---------------------------------------------------------------------------

PROBLEM = {
    "المشكلة": "الحاجة إلى قناة تسويق رقمي لإطلاق منتج جديد بميزانية محدودة وجمهور مستهدف واضح.",
    "القرار المطلوب": "اختيار قناة التسويق الرقمي الأنسب لإطلاق المنتج.",
    "صاحب القرار": "[يُحدد لاحقًا]",
    "تاريخ القرار": "[يُحدد لاحقًا]",
    "القيود": "[يُحدد لاحقًا]",
    "الافتراضات": "الدرجات على مقياس 1 إلى 10 حيث 10 = الأفضل، والمعايير مستقلة ومجموع أوزانها 1.00.",
}

# (criterion, weight, note)
CRITERIA = [
    ("التكلفة", 0.25, ""),
    ("الوصول للجمهور المستهدف", 0.30, ""),
    ("سرعة النتائج", 0.20, ""),
    ("قابلية القياس", 0.15, ""),
    ("الاستدامة", 0.10, ""),
]

ALTERNATIVES = ["مدفوعة", "محتوى", "مؤثرون"]

# SCORES[criterion_index][alternative_index]
SCORES = [
    [6, 9, 5],  # التكلفة
    [9, 6, 8],  # الوصول للجمهور المستهدف
    [9, 4, 7],  # سرعة النتائج
    [9, 6, 5],  # قابلية القياس
    [5, 9, 4],  # الاستدامة
]

# Implementation plan rows: (activity, owner, date, resources, KPI, status)
PLAN: list[tuple[str, ...]] = [
    ("", "", "", "", "", ""),
    ("", "", "", "", "", ""),
]

SENSITIVITY_STEP = 0.10  # relative change applied to each weight (±10%)

EXCEL_NAME = "decision-model.xlsx"
PPTX_NAME = "decision-model.pptx"

# ---------------------------------------------------------------------------
# Computation (mirrors the Excel formulas, used for the deck, CSV and checks)
# ---------------------------------------------------------------------------


def validate() -> None:
    total = sum(w for _, w, _ in CRITERIA)
    if not math.isclose(total, 1.0, abs_tol=1e-9):
        raise ValueError(f"Criteria weights must sum to 1.00, got {total:.2f}")
    for row in SCORES:
        if len(row) != len(ALTERNATIVES):
            raise ValueError("Each criterion needs one score per alternative")


def _scores_for(weights: list[float]) -> list[float]:
    return [
        sum(weights[i] * SCORES[i][j] for i in range(len(CRITERIA)))
        for j in range(len(ALTERNATIVES))
    ]


def weighted_scores() -> list[float]:
    return [round(s, 2) for s in _scores_for([w for _, w, _ in CRITERIA])]


def ranks(scores: list[float]) -> list[int]:
    ordered = sorted(scores, reverse=True)
    return [ordered.index(s) + 1 for s in scores]


def winner_index(scores: list[float]) -> int:
    return scores.index(max(scores))


def sensitivity_rows() -> list[dict]:
    """Base case plus each weight moved by ±SENSITIVITY_STEP, renormalised to 1.00."""
    base_weights = [w for _, w, _ in CRITERIA]
    base_scores = _scores_for(base_weights)
    base_winner = winner_index(base_scores)

    rows = [
        {
            "scenario": "الأساس",
            "scores": base_scores,
            "winner": base_winner,
            "changed": False,
        }
    ]
    for i, (name, _, _) in enumerate(CRITERIA):
        for step in (-SENSITIVITY_STEP, SENSITIVITY_STEP):
            w = base_weights[:]
            w[i] *= 1 + step
            total = sum(w)
            w = [x / total for x in w]
            scores = _scores_for(w)
            win = winner_index(scores)
            sign = "+" if step > 0 else "-"
            rows.append(
                {
                    "scenario": f"{name} {sign}{int(abs(step) * 100)}%",
                    "scores": scores,
                    "winner": win,
                    "changed": win != base_winner,
                }
            )
    return rows


def _fmt(x: float) -> str:
    return f"{x:.2f}"


# ---------------------------------------------------------------------------
# Excel workbook
# ---------------------------------------------------------------------------

HEADER_FILL = PatternFill("solid", fgColor="1F4E78")
HEADER_FONT = Font(bold=True, color="FFFFFF")
TOTAL_FONT = Font(bold=True)
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
WRAP = Alignment(vertical="center", wrap_text=True)


def _style_header(ws, row: int, ncols: int) -> None:
    for col in range(1, ncols + 1):
        cell = ws.cell(row=row, column=col)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = CENTER


def _set_widths(ws, widths: list[int]) -> None:
    for idx, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(idx)].width = width


def build_workbook(path: Path) -> None:
    wb = Workbook()
    wb.remove(wb.active)

    # Sheet 1: problem and decision
    ws1 = wb.create_sheet("المشكلة والقرار")
    ws1.sheet_view.rightToLeft = True
    ws1.append(["البند", "التفاصيل"])
    _style_header(ws1, 1, 2)
    for key, value in PROBLEM.items():
        ws1.append([key, value])
    for row in ws1.iter_rows(min_row=2, max_row=ws1.max_row, min_col=1, max_col=2):
        for cell in row:
            cell.alignment = WRAP
    _set_widths(ws1, [24, 70])

    # Sheet 2: criteria and weights
    ws2 = wb.create_sheet("المعايير والأوزان")
    ws2.sheet_view.rightToLeft = True
    ws2.append(["المعيار", "الوزن", "ملاحظات"])
    _style_header(ws2, 1, 3)
    for name, weight, note in CRITERIA:
        ws2.append([name, weight, note])
    first, last = 2, 1 + len(CRITERIA)
    total_row = last + 1
    ws2.append(["المجموع", f"=SUM(B{first}:B{last})", ""])
    for cell in ws2[total_row]:
        cell.font = TOTAL_FONT
    for row in ws2.iter_rows(min_row=first, max_row=total_row, min_col=2, max_col=2):
        for cell in row:
            cell.number_format = "0.00"
            cell.alignment = CENTER
    _set_widths(ws2, [28, 12, 40])

    # Sheet 3: alternative evaluation (weights linked to sheet 2)
    ws3 = wb.create_sheet("تقييم البدائل")
    ws3.sheet_view.rightToLeft = True
    headers = ["المعيار", "الوزن"] + [f"البديل {a}" for a in ALTERNATIVES]
    ws3.append(headers)
    _style_header(ws3, 1, len(headers))
    for i, (name, _, _) in enumerate(CRITERIA):
        r = first + i
        ws3.append(
            [name, f"='المعايير والأوزان'!B{r}"]
            + [SCORES[i][j] for j in range(len(ALTERNATIVES))]
        )
    eval_last = first + len(CRITERIA) - 1
    eval_total = eval_last + 1
    total = ["الدرجة المرجحة", ""]
    for j in range(len(ALTERNATIVES)):
        col = get_column_letter(3 + j)
        total.append(f"=SUMPRODUCT($B${first}:$B${eval_last},{col}{first}:{col}{eval_last})")
    ws3.append(total)
    for cell in ws3[eval_total]:
        cell.font = TOTAL_FONT
    for row in ws3.iter_rows(min_row=first, max_row=eval_total, min_col=2, max_col=2 + len(ALTERNATIVES)):
        for cell in row:
            cell.alignment = CENTER
    for row in ws3.iter_rows(min_row=first, max_row=eval_last, min_col=2, max_col=2):
        for cell in row:
            cell.number_format = "0.00"
    for row in ws3.iter_rows(min_row=eval_total, max_row=eval_total, min_col=3, max_col=2 + len(ALTERNATIVES)):
        for cell in row:
            cell.number_format = "0.00"
    _set_widths(ws3, [28, 10] + [14] * len(ALTERNATIVES))

    # Sheet 4: decision matrix (linked to sheet 3)
    ws4 = wb.create_sheet("مصفوفة القرار")
    ws4.sheet_view.rightToLeft = True
    ws4.append(["البديل", "الدرجة", "الترتيب", "القرار"])
    _style_header(ws4, 1, 4)
    last_alt_row = 1 + len(ALTERNATIVES)
    for j, alt in enumerate(ALTERNATIVES):
        r = 2 + j
        col = get_column_letter(3 + j)
        ws4.append(
            [
                alt,
                f"='تقييم البدائل'!{col}{eval_total}",
                f"=RANK(B{r},$B$2:$B${last_alt_row})",
                f'=IF(C{r}=1,"✅ مختار","")',
            ]
        )
    for row in ws4.iter_rows(min_row=2, max_row=last_alt_row, min_col=2, max_col=2):
        for cell in row:
            cell.number_format = "0.00"
    for row in ws4.iter_rows(min_row=2, max_row=last_alt_row, min_col=1, max_col=4):
        for cell in row:
            cell.alignment = CENTER
    _set_widths(ws4, [16, 12, 12, 16])

    # Sheet 5: sensitivity analysis (computed values)
    ws5 = wb.create_sheet("تحليل الحساسية")
    ws5.sheet_view.rightToLeft = True
    ws5.append([f"تغيير كل وزن بنسبة ±{int(SENSITIVITY_STEP * 100)}% ثم إعادة التطبيع إلى 1.00. قيم محسوبة بالسكربت."])
    ws5.merge_cells(start_row=1, start_column=1, end_row=1, end_column=3 + len(ALTERNATIVES))
    ws5.cell(row=1, column=1).font = Font(italic=True)
    ws5.append(["السيناريو"] + [f"البديل {a}" for a in ALTERNATIVES] + ["الفائز", "تغيّر الفائز؟"])
    _style_header(ws5, 2, 3 + len(ALTERNATIVES))
    sens = sensitivity_rows()
    for row in sens:
        ws5.append(
            [row["scenario"]]
            + [round(s, 2) for s in row["scores"]]
            + [ALTERNATIVES[row["winner"]], "نعم" if row["changed"] else "لا"]
        )
    for row in ws5.iter_rows(min_row=3, max_row=ws5.max_row, min_col=2, max_col=1 + len(ALTERNATIVES)):
        for cell in row:
            cell.number_format = "0.00"
    for row in ws5.iter_rows(min_row=3, max_row=ws5.max_row, min_col=1, max_col=3 + len(ALTERNATIVES)):
        for cell in row:
            cell.alignment = CENTER
    _set_widths(ws5, [28] + [14] * len(ALTERNATIVES) + [14, 16])

    # Sheet 6: implementation and follow-up
    ws6 = wb.create_sheet("خطة التنفيذ والمتابعة")
    ws6.sheet_view.rightToLeft = True
    ws6.append(["النشاط", "المسؤول", "الموعد", "الموارد", "مؤشر النجاح", "الحالة"])
    _style_header(ws6, 1, 6)
    for row in PLAN:
        ws6.append(list(row))
    _set_widths(ws6, [28, 18, 14, 22, 24, 14])

    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)


# ---------------------------------------------------------------------------
# CSV export (one file per sheet, computed values, UTF-8 with BOM for Excel)
# ---------------------------------------------------------------------------


def build_csv(out_dir: Path) -> None:
    csv_dir = out_dir / "csv"
    csv_dir.mkdir(parents=True, exist_ok=True)
    scores = weighted_scores()
    rnk = ranks(scores)

    def write(name: str, rows: list[list]) -> None:
        with open(csv_dir / name, "w", newline="", encoding="utf-8-sig") as fh:
            csv.writer(fh).writerows(rows)

    write("01-problem.csv", [["البند", "التفاصيل"]] + [[k, v] for k, v in PROBLEM.items()])
    write(
        "02-criteria.csv",
        [["المعيار", "الوزن", "ملاحظات"]]
        + [[n, f"{w:.2f}", note] for n, w, note in CRITERIA]
        + [["المجموع", f"{sum(w for _, w, _ in CRITERIA):.2f}", ""]],
    )
    eval_rows = [["المعيار", "الوزن"] + [f"البديل {a}" for a in ALTERNATIVES]]
    for i, (n, w, _) in enumerate(CRITERIA):
        eval_rows.append([n, f"{w:.2f}"] + [str(s) for s in SCORES[i]])
    eval_rows.append(["الدرجة المرجحة", ""] + [_fmt(s) for s in scores])
    write("03-evaluation.csv", eval_rows)
    write(
        "04-decision.csv",
        [["البديل", "الدرجة", "الترتيب", "القرار"]]
        + [
            [a, _fmt(scores[j]), str(rnk[j]), "مختار" if rnk[j] == 1 else ""]
            for j, a in enumerate(ALTERNATIVES)
        ],
    )
    sens_rows = [["السيناريو"] + [f"البديل {a}" for a in ALTERNATIVES] + ["الفائز", "تغيّر الفائز؟"]]
    for row in sensitivity_rows():
        sens_rows.append(
            [row["scenario"]]
            + [_fmt(s) for s in row["scores"]]
            + [ALTERNATIVES[row["winner"]], "نعم" if row["changed"] else "لا"]
        )
    write("05-sensitivity.csv", sens_rows)
    write(
        "06-plan.csv",
        [["النشاط", "المسؤول", "الموعد", "الموارد", "مؤشر النجاح", "الحالة"]] + [list(r) for r in PLAN],
    )


# ---------------------------------------------------------------------------
# PowerPoint deck
# ---------------------------------------------------------------------------

TITLE_COLOR = RGBColor(0x1F, 0x4E, 0x78)


def _rtl(paragraph) -> None:
    """Make a paragraph right-to-left (Arabic)."""
    paragraph.alignment = PP_ALIGN.RIGHT
    pPr = paragraph._p.get_or_add_pPr()
    pPr.set("rtl", "1")


def _fill_text(tf, lines: list[str], size: int = 20) -> None:
    tf.clear()
    tf.word_wrap = True
    for idx, line in enumerate(lines):
        p = tf.paragraphs[0] if idx == 0 else tf.add_paragraph()
        p.text = line
        p.font.size = Pt(size)
        _rtl(p)


def _slide_with_title(prs: Presentation, title: str):
    slide = prs.slides.add_slide(prs.slide_layouts[5])  # title only
    slide.shapes.title.text = title
    t = slide.shapes.title.text_frame.paragraphs[0]
    _rtl(t)
    t.font.size = Pt(32)
    t.font.bold = True
    t.font.color.rgb = TITLE_COLOR
    return slide


def _add_body(slide, lines: list[str], top: float = 1.7, height: float = 5.0, size: int = 20):
    box = slide.shapes.add_textbox(Inches(0.7), Inches(top), Inches(12.0), Inches(height))
    _fill_text(box.text_frame, lines, size=size)
    return box


def build_deck(path: Path) -> None:
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    scores = weighted_scores()
    rnk = ranks(scores)
    best = ALTERNATIVES[winner_index(scores)]
    sens = sensitivity_rows()
    stable = sum(1 for r in sens[1:] if not r["changed"])

    # 1. Cover
    cover = prs.slides.add_slide(prs.slide_layouts[0])
    cover.shapes.title.text = "تحليل البيانات واتخاذ القرار"
    _rtl(cover.shapes.title.text_frame.paragraphs[0])
    cover.placeholders[1].text = "من البيانات إلى القرار"
    _rtl(cover.placeholders[1].text_frame.paragraphs[0])

    # 2. Problem
    s = _slide_with_title(prs, "المشكلة")
    _add_body(s, [PROBLEM["المشكلة"]])

    # 3. Decision required
    s = _slide_with_title(prs, "القرار المطلوب")
    _add_body(s, [PROBLEM["القرار المطلوب"], f"صاحب القرار: {PROBLEM['صاحب القرار']}"])

    # 4. Data and sources
    s = _slide_with_title(prs, "البيانات والمصادر")
    _add_body(s, ["[مصادر البيانات وحجمها وفترتها]"])

    # 5. Methodology
    s = _slide_with_title(prs, "منهجية التحليل")
    _add_body(
        s,
        [
            "• وصفي: ماذا حدث؟",
            "• تشخيصي: لماذا حدث؟",
            "• تنبؤي: ماذا سيحدث؟",
            "• توجيهي: ماذا نفعل؟",
            "• تقييم: مصفوفة قرار مرجحة، واختبار حساسية للأوزان (±10%)",
        ],
    )

    # 6. Findings
    s = _slide_with_title(prs, "النتائج والرؤى")
    order = sorted(range(len(ALTERNATIVES)), key=lambda j: -scores[j])
    gap = scores[order[0]] - scores[order[1]]
    _add_body(
        s,
        [
            f"• البديل الأعلى درجة: {best} ({_fmt(scores[order[0]])})",
            f"• الفارق عن البديل الثاني: {gap:.2f} نقطة",
            f"• الفائز ثابت في {stable} من {len(sens) - 1} سيناريو حساسية",
        ],
    )

    # 7. Alternatives
    s = _slide_with_title(prs, "البدائل المطروحة")
    _add_body(s, [f"• {a}" for a in ALTERNATIVES])

    # 8. Evaluation matrix (table)
    s = _slide_with_title(prs, "مصفوفة التقييم")
    rows = len(CRITERIA) + 2
    cols = 2 + len(ALTERNATIVES)
    table = s.shapes.add_table(rows, cols, Inches(0.7), Inches(1.6), Inches(12.0), Inches(0.55) * rows).table
    header = ["المعيار", "الوزن"] + [f"البديل {a}" for a in ALTERNATIVES]
    for c, text in enumerate(header):
        table.cell(0, c).text = text
    for r, (name, weight, _) in enumerate(CRITERIA, start=1):
        table.cell(r, 0).text = name
        table.cell(r, 1).text = f"{weight:.2f}"
        for j in range(len(ALTERNATIVES)):
            table.cell(r, 2 + j).text = str(SCORES[r - 1][j])
    table.cell(rows - 1, 0).text = "الدرجة المرجحة"
    table.cell(rows - 1, 1).text = ""
    for j, sc in enumerate(scores):
        table.cell(rows - 1, 2 + j).text = _fmt(sc)
    for r in range(rows):
        for c in range(cols):
            for p in table.cell(r, c).text_frame.paragraphs:
                _rtl(p)
                p.font.size = Pt(18)

    # 9. Recommendation
    s = _slide_with_title(prs, "القرار والتوصية")
    _add_body(
        s,
        [
            f"التوصية: {best} (الدرجة {_fmt(max(scores))})",
            "الترتيب: " + "، ".join(
                f"{ALTERNATIVES[j]} = {_fmt(scores[j])} (المركز {rnk[j]})"
                for j in range(len(ALTERNATIVES))
            ),
            f"الفائز ثابت في {stable} من {len(sens) - 1} سيناريو حساسية (تغيير الأوزان ±10%)",
            "[المخاطر وخطة التعامل معها]",
        ],
    )

    # 10. Implementation and follow-up
    s = _slide_with_title(prs, "خطة التنفيذ والمتابعة")
    _add_body(s, ["[المسؤوليات والمواعيد ومؤشرات النجاح]", "التفاصيل الكاملة في implementation-guide.md"])

    path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(path)


# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out-dir", default="docs/decision-model", help="output directory")
    args = parser.parse_args()

    validate()
    out = Path(args.out_dir)
    build_workbook(out / EXCEL_NAME)
    build_deck(out / PPTX_NAME)
    build_csv(out)

    scores = weighted_scores()
    print("Weighted scores:", dict(zip(ALTERNATIVES, scores)))
    stable = sum(1 for r in sensitivity_rows()[1:] if not r["changed"])
    print(f"Winner stable in {stable} of {len(CRITERIA) * 2} sensitivity scenarios")
    print(f"Wrote {out / EXCEL_NAME}")
    print(f"Wrote {out / PPTX_NAME}")
    print(f"Wrote CSV files to {out / 'csv'}")


if __name__ == "__main__":
    main()
