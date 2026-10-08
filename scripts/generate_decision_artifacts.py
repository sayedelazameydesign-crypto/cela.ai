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
import re
import zipfile
from datetime import datetime
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
# Precedence: if SWING_RATIOS is set, it REPLACES the weights in CRITERIA
# (they are not merged). Otherwise the weights in CRITERIA are used as given.
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
# ASSUMPTION: every criterion is treated as "higher is better". For cost, time or risk,
# convert the raw value before entering it (e.g. 10 - x) and say so in the note field.
# Direction support is a deferred item in docs/decision-model/production-plan.md.
CRITERIA = [
    ("التكلفة", 0.25, ""),
    ("الوصول للجمهور المستهدف", 0.30, ""),
    ("سرعة النتائج", 0.20, ""),
    ("قابلية القياس", 0.15, ""),
    ("الاستدامة", 0.10, ""),
]

# Optional raw Swing ratios (one per criterion, same order as CRITERIA), e.g. [100, 60, 40, 20].
# When set, they are normalised to weights and REPLACE the weights above.
# Leave as None to use the explicit weights in CRITERIA.
SWING_RATIOS: list[float] | None = None

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

# Fixed reference timestamp written into document metadata and ZIP entries.
# Keeping it constant makes .xlsx/.pptx byte-for-byte reproducible across runs,
# so a regeneration with unchanged data produces no diff. Change it deliberately
# when you want to record a new revision date.
BUILD_TIMESTAMP = datetime(2026, 1, 1, 0, 0, 0)
BUILD_AUTHOR = "decision-model generator"


def _freeze_zip_timestamps(path: Path) -> None:
    """Rewrite an OOXML (ZIP) file so every entry has BUILD_TIMESTAMP as its time.

    openpyxl and python-pptx write entries with the current clock, which changes the
    bytes on every run even when the content is identical.
    """
    tmp = path.with_name(path.name + ".tmp")
    fixed = BUILD_TIMESTAMP.timetuple()[:6]
    iso = BUILD_TIMESTAMP.strftime("%Y-%m-%dT%H:%M:%SZ")
    # openpyxl overwrites dcterms:modified with the current time on save, so pin it here too.
    modified_re = re.compile(r"(<dcterms:modified[^>]*>)[^<]*(</dcterms:modified>)")
    with zipfile.ZipFile(path) as src, zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            data = src.read(info.filename)
            if info.filename == "docProps/core.xml":
                data = modified_re.sub(rf"\g<1>{iso}\g<2>", data.decode("utf-8")).encode("utf-8")
            zi = zipfile.ZipInfo(info.filename, date_time=fixed)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            dst.writestr(zi, data)
    tmp.replace(path)

# ---------------------------------------------------------------------------
# Computation (mirrors the Excel formulas, used for the deck, CSV and checks)
# ---------------------------------------------------------------------------


def normalize(values: list[float]) -> list[float]:
    """Scale non-negative values so they sum to 1.00."""
    if any(v < 0 for v in values):
        raise ValueError("Ratios must be non-negative")
    total = sum(values)
    if total <= 0:
        raise ValueError("Ratios must sum to a positive number")
    return [v / total for v in values]


def _apply_swing_ratios() -> None:
    """If SWING_RATIOS is set, replace CRITERIA weights with their normalised values."""
    global CRITERIA
    if SWING_RATIOS is None:
        return
    if len(SWING_RATIOS) != len(CRITERIA):
        raise ValueError(
            f"SWING_RATIOS has {len(SWING_RATIOS)} values but there are {len(CRITERIA)} criteria"
        )
    weights = normalize(SWING_RATIOS)
    CRITERIA = [(name, w, note) for (name, _, note), w in zip(CRITERIA, weights)]


_apply_swing_ratios()


def validate() -> None:
    total = sum(w for _, w, _ in CRITERIA)
    if abs(total - 1.0) >= 1e-6:
        raise ValueError(
            f"Criteria weights must sum to 1.00 (got {total:.6f}). "
            "Fix the weights in CRITERIA, or set SWING_RATIOS so they are normalised."
        )
    for name, w, _ in CRITERIA:
        if w < 0:
            raise ValueError(f"Weight for '{name}' is negative")
    for row in SCORES:
        if len(row) != len(ALTERNATIVES):
            raise ValueError("Each criterion needs one score per alternative")
    if len(SCORES) != len(CRITERIA):
        raise ValueError(f"SCORES has {len(SCORES)} rows but there are {len(CRITERIA)} criteria")


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


SWEEP_VALUES = [round(0.05 * i, 2) for i in range(1, 11)]  # 0.05 .. 0.50


def _scores_with_weight(k: int, x: float) -> list[float]:
    """Scores when criterion k gets weight x and the other weights are rescaled proportionally."""
    base = [w for _, w, _ in CRITERIA]
    wk = base[k]
    weights = [x if i == k else base[i] * (1 - x) / (1 - wk) for i in range(len(CRITERIA))]
    return _scores_for(weights)


def sweep_table() -> list[dict]:
    """One-way sweep per criterion: winner at each sweep value and the nearest tipping point.

    Scores are linear in a criterion's weight, so the exact crossing weight between
    the base winner b and an alternative j solves A_b + B_b*x = A_j + B_j*x.
    """
    base_weights = [w for _, w, _ in CRITERIA]
    base_winner = winner_index(_scores_for(base_weights))
    out = []
    for k, (name, wk, _) in enumerate(CRITERIA):
        # Linear coefficients: score_j(x) = A[j] + x * B[j]
        T = [sum(base_weights[i] * SCORES[i][j] for i in range(len(CRITERIA))) for j in range(len(ALTERNATIVES))]
        A = [(T[j] - wk * SCORES[k][j]) / (1 - wk) for j in range(len(ALTERNATIVES))]
        B = [SCORES[k][j] - A[j] for j in range(len(ALTERNATIVES))]

        tip = None  # (alternative index, exact weight)
        for j in range(len(ALTERNATIVES)):
            if j == base_winner:
                continue
            denom = B[j] - B[base_winner]
            if abs(denom) < 1e-12:
                continue
            x = (A[base_winner] - A[j]) / denom
            if 0 < x < 1 and abs(x - wk) > 1e-9:
                if tip is None or abs(x - wk) < abs(tip[1] - wk):
                    tip = (j, x)

        winners = [
            ALTERNATIVES[winner_index(_scores_with_weight(k, x))] for x in SWEEP_VALUES
        ]
        out.append(
            {
                "criterion": name,
                "weight": wk,
                "winners": winners,
                "tipping": tip,
            }
        )
    return out


def nearest_tipping_point() -> tuple[str, float, str] | None:
    """Criterion whose tipping point is closest to its base weight: (criterion, weight, new winner)."""
    best = None
    for row in sweep_table():
        if row["tipping"] is None:
            continue
        j, x = row["tipping"]
        dist = abs(x - row["weight"])
        if best is None or dist < best[0]:
            best = (dist, row["criterion"], x, ALTERNATIVES[j])
    return None if best is None else (best[1], best[2], best[3])


def safety_margin() -> list[dict]:
    """Largest relative change ε such that the winner survives every combination of
    weights w_i·(1 + δ_i), |δ_i| ≤ ε, followed by renormalisation, for each rival.

    Model (explicit): each weight is perturbed multiplicatively and independently,
    then all weights are renormalised to sum to 1. This is NOT the same as an
    additive perturbation w_i + δ_i with Σδ_i = 0. The additive model admits a
    larger margin (≈ 46% in the example), so the value reported here is a
    conservative lower bound for that model.

    The gap G(P,Q) = Σ w_i·g_i (g_i = s_iP − s_iQ) is linear in the weights. Its worst
    case over δ_i ∈ [−ε, ε] is G − ε·Σ w_i·|g_i|, so the exact margin is
    ε* = G / Σ w_i·|g_i|. Renormalisation divides by a positive total, so it does not
    change the sign of the gap and does not affect ε*.

    Special case: if g_i > 0 for every i (the winner is at least as good on every
    criterion), then Σ w_i·|g_i| = G and ε* = 1, i.e. no change within [0, 1] can flip it.
    """
    base_weights = [w for _, w, _ in CRITERIA]
    scores = _scores_for(base_weights)
    p = winner_index(scores)
    out = []
    for q in range(len(ALTERNATIVES)):
        if q == p:
            continue
        g = [SCORES[i][p] - SCORES[i][q] for i in range(len(CRITERIA))]
        gap = sum(base_weights[i] * g[i] for i in range(len(CRITERIA)))
        spread = sum(base_weights[i] * abs(g[i]) for i in range(len(CRITERIA)))
        eps = gap / spread
        if eps >= 1 - 1e-12:
            # Winner is at least as good on every criterion: no weight change can flip it.
            out.append(
                {"rival": ALTERNATIVES[q], "winner": ALTERNATIVES[p], "epsilon": 1.0,
                 "worst_weights": None, "worst_gap": None}
            )
            continue
        # Worst-case direction: raise weights where the winner trails, lower where it leads.
        signs = [(-1 if gi > 0 else (1 if gi < 0 else 0)) for gi in g]
        worst = [base_weights[i] * (1 + eps * signs[i]) for i in range(len(CRITERIA))]
        total = sum(worst)
        worst = [x / total for x in worst]
        out.append(
            {
                "rival": ALTERNATIVES[q],
                "winner": ALTERNATIVES[p],
                "epsilon": eps,
                "worst_weights": worst,
                "worst_gap": _gap_at(worst, p, q),
            }
        )
    return out


def _gap_at(weights: list[float], p: int, q: int) -> float:
    s = _scores_for(weights)
    return s[p] - s[q]


def _joint_scores(pair: tuple[int, int], t: float) -> list[float]:
    """Raise the weights of two criteria by t each; rescale the rest proportionally."""
    base = [w for _, w, _ in CRITERIA]
    k = set(pair)
    locked = sum(base[i] for i in k)
    factor = (1 - locked - len(k) * t) / (1 - locked)
    weights = [base[i] + t if i in k else base[i] * factor for i in range(len(CRITERIA))]
    return _scores_for(weights)


def joint_tipping(pair: tuple[int, int]) -> tuple[int, float] | None:
    """Smallest t > 0 at which the base winner is overtaken, with the new winner index.

    Scores are affine in t, so the crossing is exact: evaluate at t = 0 and t = 1.
    """
    base_winner = winner_index(_scores_for([w for _, w, _ in CRITERIA]))
    a = _joint_scores(pair, 0.0)
    b = [x - y for x, y in zip(_joint_scores(pair, 1.0), a)]  # slope per unit t
    t_max = (1 - sum(CRITERIA[i][1] for i in pair)) / len(pair)
    best = None
    for j in range(len(ALTERNATIVES)):
        if j == base_winner:
            continue
        denom = b[j] - b[base_winner]
        if abs(denom) < 1e-12:
            continue
        t = (a[base_winner] - a[j]) / denom
        if 0 < t <= t_max and (best is None or t < best[1]):
            best = (j, t)
    return best


def joint_pairs() -> list[dict]:
    rows = []
    for i in range(len(CRITERIA)):
        for j in range(i + 1, len(CRITERIA)):
            tip = joint_tipping((i, j))
            rows.append(
                {
                    "pair": (CRITERIA[i][0], CRITERIA[j][0]),
                    "tipping": tip,
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
    wb.properties.creator = BUILD_AUTHOR
    wb.properties.lastModifiedBy = BUILD_AUTHOR
    wb.properties.created = BUILD_TIMESTAMP
    wb.properties.modified = BUILD_TIMESTAMP

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

    # Sheet 6: one-way sweep and tipping points (computed values)
    ws6s = wb.create_sheet("مسح الحساسية")
    ws6s.sheet_view.rightToLeft = True
    ws6s.append(
        [
            "الخانات تُظهر الفائز عند كل وزن للمعيار، مع إعادة تطبيع بقية الأوزان تناسبيًا. "
            "نقطة الانقلاب محسوبة تحليليًا لأن الدرجات خطية في الوزن."
        ]
    )
    ws6s.merge_cells(start_row=1, start_column=1, end_row=1, end_column=4 + len(SWEEP_VALUES))
    ws6s.cell(row=1, column=1).font = Font(italic=True)
    ws6s.append(
        ["المعيار", "الوزن الحالي"]
        + [f"{x:.2f}" for x in SWEEP_VALUES]
        + ["نقطة الانقلاب", "الفائز بعدها"]
    )
    _style_header(ws6s, 2, 4 + len(SWEEP_VALUES))
    for row in sweep_table():
        tip = row["tipping"]
        ws6s.append(
            [row["criterion"], f"{row['weight']:.2f}"]
            + row["winners"]
            + [
                f"{tip[1]:.3f}" if tip else "لا يوجد ضمن 0–1",
                ALTERNATIVES[tip[0]] if tip else "—",
            ]
        )
    for row in ws6s.iter_rows(min_row=3, max_row=ws6s.max_row, min_col=1, max_col=4 + len(SWEEP_VALUES)):
        for cell in row:
            cell.alignment = CENTER
    _set_widths(ws6s, [28, 12] + [11] * len(SWEEP_VALUES) + [18, 14])

    # Sheet 7: safety margin and joint tipping points (computed values)
    ws7 = wb.create_sheet("هامش الأمان والتحليل الثنائي")
    ws7.sheet_view.rightToLeft = True
    ws7.append(
        ["هامش الأمان: أكبر تغيير نسبي ±ε لكل وزن على حدة (في أي اتجاه ومهما كانت التركيبة) يصمد أمامه الفائز. "
         "الانقلاب الثنائي: رفع وزني معيارين بمقدار t لكل منهما مع تطبيع البقية."]
    )
    ws7.merge_cells(start_row=1, start_column=1, end_row=1, end_column=2 + len(CRITERIA))
    ws7.cell(row=1, column=1).font = Font(italic=True)
    ws7.append(["المنافس", "هامش الأمان ε*"] + [f"أسوأ وزن: {n}" for n, _, _ in CRITERIA] + ["الفارق عند أسوأ حالة"])
    _style_header(ws7, 2, 3 + len(CRITERIA))
    for m in safety_margin():
        ws7.append(
            [m["rival"], f"{m['epsilon'] * 100:.1f}%"]
            + ([f"{x:.3f}" for x in m["worst_weights"]] if m["worst_weights"] else ["—"] * len(CRITERIA))
            + ([f"{m['worst_gap']:.2f}"] if m["worst_gap"] is not None else ["لا ينقلب"])
        )
    # Leave one blank row, then the joint-tipping table.
    joint_header_row = ws7.max_row + 2
    for col, text in enumerate(["المعيار الأول", "المعيار الثاني", "نقطة الانقلاب المشتركة t", "الفائز بعدها"], start=1):
        ws7.cell(row=joint_header_row, column=col, value=text)
    _style_header(ws7, joint_header_row, 4)
    for r in joint_pairs():
        tip = r["tipping"]
        ws7.append(
            [r["pair"][0], r["pair"][1], f"{tip[1]:.4f}" if tip else "لا يوجد", ALTERNATIVES[tip[0]] if tip else "—"]
        )
    for row in ws7.iter_rows(min_row=3, max_row=ws7.max_row, min_col=1, max_col=3 + len(CRITERIA)):
        for cell in row:
            cell.alignment = CENTER
    _set_widths(ws7, [26, 22] + [18] * len(CRITERIA) + [18])

    # Sheet 8: implementation and follow-up
    ws6 = wb.create_sheet("خطة التنفيذ والمتابعة")
    ws6.sheet_view.rightToLeft = True
    ws6.append(["النشاط", "المسؤول", "الموعد", "الموارد", "مؤشر النجاح", "الحالة"])
    _style_header(ws6, 1, 6)
    for row in PLAN:
        ws6.append(list(row))
    _set_widths(ws6, [28, 18, 14, 22, 24, 14])

    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    _freeze_zip_timestamps(path)


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
    sweep_rows = [["المعيار", "الوزن الحالي"] + [f"{x:.2f}" for x in SWEEP_VALUES] + ["نقطة الانقلاب", "الفائز بعدها"]]
    for row in sweep_table():
        tip = row["tipping"]
        sweep_rows.append(
            [row["criterion"], f"{row['weight']:.2f}"]
            + row["winners"]
            + [f"{tip[1]:.3f}" if tip else "لا يوجد ضمن 0–1", ALTERNATIVES[tip[0]] if tip else "—"]
        )
    write("07-sweep.csv", sweep_rows)

    margin_rows = [["المنافس", "هامش الأمان ε*"] + [f"أسوأ وزن: {n}" for n, _, _ in CRITERIA] + ["الفارق عند أسوأ حالة"]]
    for m in safety_margin():
        if m["worst_weights"] is None:
            margin_rows.append([m["rival"], "100%"] + ["—"] * len(CRITERIA) + ["لا ينقلب"])
        else:
            margin_rows.append(
                [m["rival"], f"{m['epsilon'] * 100:.1f}%"]
                + [f"{x:.3f}" for x in m["worst_weights"]]
                + [f"{m['worst_gap']:.2f}"]
            )
    write("08-margin.csv", margin_rows)

    joint_csv = [["المعيار الأول", "المعيار الثاني", "نقطة الانقلاب المشتركة t", "الفائز بعدها"]]
    for r in joint_pairs():
        tip = r["tipping"]
        joint_csv.append(
            [r["pair"][0], r["pair"][1], f"{tip[1]:.4f}" if tip else "لا يوجد", ALTERNATIVES[tip[0]] if tip else "—"]
        )
    write("09-joint.csv", joint_csv)


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


def margin_line() -> str:
    """Worst-case safety margin across rivals (the binding one is the smallest ε*)."""
    rows = [m for m in safety_margin() if m["worst_weights"] is not None]
    if not rows:
        return "• الفائز يتفوق على كل المنافسين في كل المعايير"
    binding = min(rows, key=lambda m: m["epsilon"])
    return f"• هامش الأمان: الفائز يصمد أمام تغيير نسبي ±{binding['epsilon'] * 100:.0f}% لكل وزن على حدة، في أي تركيبة"


def joint_line() -> str:
    """Fastest joint move that flips the winner (two weights raised together)."""
    hits = [r for r in joint_pairs() if r["tipping"] is not None]
    if not hits:
        return "• لا ينقلب الفائز بتحريك أي زوج من الأوزان معًا"
    best = min(hits, key=lambda r: r["tipping"][1])
    alt = ALTERNATIVES[best["tipping"][0]]
    return f"• أسرع انقلاب مشترك: {best['pair'][0]} + {best['pair'][1]} عند +{best['tipping'][1]:.3f} لكل منهما ({alt})"


def tipping_line() -> str:
    tp = nearest_tipping_point()
    if tp is None:
        return "• لا تنقلب النتيجة عند أي وزن ضمن 0–1 لأي معيار"
    crit, x, alt = tp
    base = next(w for n, w, _ in CRITERIA if n == crit)
    return f"• أقرب نقطة انقلاب: {crit} عند الوزن {x:.2f} (الحالي {base:.2f}) ويصبح الفائز {alt}"


def build_outline() -> list[dict]:
    """Single source for slide content. Rendered to PowerPoint and to slides.md."""
    scores = weighted_scores()
    rnk = ranks(scores)
    best = ALTERNATIVES[winner_index(scores)]
    sens = sensitivity_rows()
    stable = sum(1 for r in sens[1:] if not r["changed"])
    order = sorted(range(len(ALTERNATIVES)), key=lambda j: -scores[j])
    gap = scores[order[0]] - scores[order[1]]

    table_rows = [["المعيار", "الوزن"] + [f"البديل {a}" for a in ALTERNATIVES]]
    for i, (name, weight, _) in enumerate(CRITERIA):
        table_rows.append([name, f"{weight:.2f}"] + [str(SCORES[i][j]) for j in range(len(ALTERNATIVES))])
    table_rows.append(["الدرجة المرجحة", ""] + [_fmt(s) for s in scores])

    return [
        {"kind": "cover", "title": "تحليل البيانات واتخاذ القرار", "lines": ["من البيانات إلى القرار"]},
        {"kind": "text", "title": "المشكلة", "lines": [PROBLEM["المشكلة"]]},
        {"kind": "text", "title": "القرار المطلوب",
         "lines": [PROBLEM["القرار المطلوب"], f"صاحب القرار: {PROBLEM['صاحب القرار']}"]},
        {"kind": "text", "title": "البيانات والمصادر", "lines": ["[مصادر البيانات وحجمها وفترتها]"]},
        {"kind": "text", "title": "منهجية التحليل", "lines": [
            "• وصفي: ماذا حدث؟",
            "• تشخيصي: لماذا حدث؟",
            "• تنبؤي: ماذا سيحدث؟",
            "• توجيهي: ماذا نفعل؟",
            "• تقييم: مصفوفة قرار مرجحة، واختبار حساسية للأوزان (±10%) ومسح أحادي لنقاط الانقلاب، وهامش أمان، وانقلاب ثنائي",
        ]},
        {"kind": "text", "title": "النتائج والرؤى", "lines": [
            f"• البديل الأعلى درجة: {best} ({_fmt(scores[order[0]])})",
            f"• الفارق عن البديل الثاني: {gap:.2f} نقطة",
            f"• الفائز ثابت في {stable} من {len(sens) - 1} سيناريو حساسية (±10%)",
            tipping_line(),
            margin_line(),
            joint_line(),
        ]},
        {"kind": "text", "title": "البدائل المطروحة", "lines": [f"• {a}" for a in ALTERNATIVES]},
        {"kind": "table", "title": "مصفوفة التقييم", "rows": table_rows},
        {"kind": "text", "title": "القرار والتوصية", "lines": [
            f"التوصية: {best} (الدرجة {_fmt(max(scores))})",
            "الترتيب: " + "، ".join(
                f"{ALTERNATIVES[j]} = {_fmt(scores[j])} (المركز {rnk[j]})" for j in range(len(ALTERNATIVES))
            ),
            f"الفائز ثابت في {stable} من {len(sens) - 1} سيناريو حساسية (تغيير الأوزان ±10%)",
            tipping_line(),
            margin_line(),
            "[المخاطر وخطة التعامل معها]",
        ]},
        {"kind": "text", "title": "خطة التنفيذ والمتابعة", "lines": [
            "[المسؤوليات والمواعيد ومؤشرات النجاح]",
            "التفاصيل الكاملة في implementation-guide.md",
        ]},
    ]


def _render_pptx(outline: list[dict], path: Path) -> None:
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    cp = prs.core_properties
    cp.author = BUILD_AUTHOR
    cp.last_modified_by = BUILD_AUTHOR
    cp.created = BUILD_TIMESTAMP
    cp.modified = BUILD_TIMESTAMP
    cp.revision = 1

    for item in outline:
        if item["kind"] == "cover":
            cover = prs.slides.add_slide(prs.slide_layouts[0])
            cover.shapes.title.text = item["title"]
            _rtl(cover.shapes.title.text_frame.paragraphs[0])
            cover.placeholders[1].text = item["lines"][0]
            _rtl(cover.placeholders[1].text_frame.paragraphs[0])
        elif item["kind"] == "text":
            s = _slide_with_title(prs, item["title"])
            _add_body(s, item["lines"])
        elif item["kind"] == "table":
            s = _slide_with_title(prs, item["title"])
            rows = item["rows"]
            n_rows, n_cols = len(rows), len(rows[0])
            table = s.shapes.add_table(
                n_rows, n_cols, Inches(0.7), Inches(1.6), Inches(12.0), Inches(0.55) * n_rows
            ).table
            for r, row in enumerate(rows):
                for c, text in enumerate(row):
                    table.cell(r, c).text = text
                    for p in table.cell(r, c).text_frame.paragraphs:
                        _rtl(p)
                        p.font.size = Pt(18)

    path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(path)
    _freeze_zip_timestamps(path)


def _render_slides_md(outline: list[dict], path: Path) -> None:
    out = [
        "<!-- Generated by scripts/generate_decision_artifacts.py from SOURCE DATA. Do not edit by hand. -->",
        "",
        "# نص شرائح العرض التقديمي",
        "",
        f"هذا الملف مُولَّد آليًا من البيانات نفسها التي تُبنى منها الشرائح في `{PPTX_NAME}`. لا تعدّله يدويًا، بل عدّل `SOURCE DATA` في السكربت ثم أعد التوليد.",
        "",
    ]
    for n, item in enumerate(outline, start=1):
        out += ["---", "", f"## الشريحة {n}: {item['title']}", ""]
        if item["kind"] == "table":
            rows = item["rows"]
            out.append("| " + " | ".join(rows[0]) + " |")
            out.append("|" + "|".join(["---"] * len(rows[0])) + "|")
            for row in rows[1:]:
                out.append("| " + " | ".join(row) + " |")
            out.append("")
        else:
            for line in item["lines"]:
                text = line[1:].strip() if line.startswith("•") else line
                out.append(f"- {text}")
            out.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out), encoding="utf-8")


def build_deck(path: Path) -> None:
    _render_pptx(build_outline(), path)


# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out-dir", default="docs/decision-model", help="output directory")
    args = parser.parse_args()

    validate()
    out = Path(args.out_dir)
    build_workbook(out / EXCEL_NAME)
    build_deck(out / PPTX_NAME)
    _render_slides_md(build_outline(), out / "slides.md")
    build_csv(out)

    scores = weighted_scores()
    print("Weighted scores:", dict(zip(ALTERNATIVES, scores)))
    stable = sum(1 for r in sensitivity_rows()[1:] if not r["changed"])
    print(f"Winner stable in {stable} of {len(CRITERIA) * 2} sensitivity scenarios")
    print("Tipping points:", [(r["criterion"], round(r["tipping"][1], 3), ALTERNATIVES[r["tipping"][0]]) for r in sweep_table() if r["tipping"]])
    print("Safety margins:", [(m["rival"], round(m["epsilon"], 4)) for m in safety_margin()])
    print("Joint tipping:", [(r["pair"], None if r["tipping"] is None else round(r["tipping"][1], 4)) for r in joint_pairs() if r["tipping"]])
    print(f"Wrote {out / EXCEL_NAME}")
    print(f"Wrote {out / PPTX_NAME}")
    print(f"Wrote CSV files to {out / 'csv'}")


if __name__ == "__main__":
    main()
