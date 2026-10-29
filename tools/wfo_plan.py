#!/usr/bin/env python3
"""Workforce Optimization story plan (Prateek's IVD layout).

Usage: python3 -I tools/wfo_plan.py <jira_export.csv> <out.xlsx> [previous.xlsx]

JQL for the export (columns Key, Summary, Status, Sprint, Labels, Assignee):
  "Epic Link" in (CMCM-30655, CMCM-47698) OR key = CMCM-37518 ORDER BY key ASC

Rules:
- Stage and Sprint always come fresh from Jira.
- Comments/Questions are carried forward from previous.xlsx by Story key (human edits win).
  New stories get a starter comment built from labels (SAP / Service Board / CP pair).
- Prints a change summary (new stories, stage moves, sprint moves, dropped stories).
"""
import csv, sys, collections, re
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

HDR = ["Story", "Description", "Stage", "Proposed Quarterly", "Sprint", "Comments/Questions"]
WFO_EPICS = {"CMCM-30655": "Q1'27", "CMCM-47698": "Q2'27 or later"}
EXTRA_KEYS = {"CMCM-37518"}

def read_csv(path):
    rows = list(csv.reader(open(path, encoding="utf-8-sig")))
    h = rows[0]; idx = collections.defaultdict(list)
    for i, c in enumerate(h): idx[c].append(i)
    out = []
    for r in rows[1:]:
        g = lambda c: [r[i] for i in idx.get(c, []) if i < len(r) and r[i]]
        out.append({"key": "; ".join(g("Issue key")), "type": "; ".join(g("Issue Type")),
                    "summary": " ".join(" ".join(g("Summary")).split()), "status": "; ".join(g("Status")),
                    "sprints": g("Sprint"), "labels": g("Labels"),
                    "epic": "; ".join(g("Custom field (Epic Link)"))})
    return out

def quarter(sprint, epic, status):
    m = re.search(r"(Q\d'\d\d)", sprint or "")
    if m: return m.group(1)
    if status == "On Hold" and epic not in WFO_EPICS: return "TBD"
    return WFO_EPICS.get(epic, "TBD")

def starter_comment(it, by_summary):
    L = set(it["labels"]); bits = []
    if "SAP_Story" in L: bits.append("SAP story.")
    elif "SAP_Testing" in L: bits.append("SAP testing.")
    elif "SAP_Impact" in L: bits.append("SAP impact.")
    elif "SAP_NoImpact" in L: bits.append("SAP no impact.")
    if "ServiceBoard_Review_Needed" in L: bits.append("Service Board review needed.")
    base = it["summary"].replace("[CP] - ", "").replace("[CP] ", "").strip().lower()
    pair = [k for k, s in by_summary.items() if s == base and k != it["key"]]
    if pair: bits.append(("CP story for " if it["summary"].startswith("[CP]") else "CP pair: ") + pair[0] + ".")
    if it["epic"] == "CMCM-47698": bits.append("Under follow-up epic CMCM-47698.")
    return " ".join(bits)

def main():
    src, out = sys.argv[1], sys.argv[2]; prev = sys.argv[3] if len(sys.argv) > 3 else None
    items = [i for i in read_csv(src) if i["type"] == "Story" and (i["epic"] in WFO_EPICS or i["key"] in EXTRA_KEYS)]
    by_summary = {i["key"]: i["summary"].replace("[CP] - ", "").replace("[CP] ", "").strip().lower() for i in items}
    old = {}
    if prev:
        ws = load_workbook(prev).active
        for r in ws.iter_rows(min_row=2, values_only=True):
            if r and r[0] and str(r[0]).startswith("CMCM-"): old[r[0]] = r
    order = lambda i: (0 if i["status"] == "Done" else 2 if i["status"] == "On Hold" else 1, i["sprints"][-1] if i["sprints"] else "zz", i["key"])
    rows, changes = [], []
    for it in sorted(items, key=order):
        sprint = it["sprints"][-1] if it["sprints"] else "Not yet assigned"
        o = old.get(it["key"])
        comment = (o[5] if o and o[5] else starter_comment(it, by_summary))
        rows.append((it["key"], it["summary"], it["status"], quarter(sprint, it["epic"], it["status"]), sprint, comment))
        if prev and not o: changes.append(f"NEW {it['key']} ({it['status']}, {sprint})")
        elif o:
            if o[2] != it["status"]: changes.append(f"STAGE {it['key']}: {o[2]} -> {it['status']}")
            if o[4] != sprint: changes.append(f"SPRINT {it['key']}: {o[4]} -> {sprint}")
    for k in old:
        if k not in {r[0] for r in rows}: changes.append(f"DROPPED {k} (no longer in the export)")
    wb = Workbook(); ws = wb.active; ws.title = "WFO Stories"; ws.append(HDR)
    for r in rows: ws.append(r)
    thin = Side(style="thin", color="BFBFBF")
    for c in ws[1]:
        c.font = Font(name="Arial", bold=True, color="FFFFFF"); c.fill = PatternFill("solid", fgColor="1F4E78")
        c.alignment = Alignment(vertical="center", wrap_text=True)
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.font = Font(name="Arial", size=10); c.alignment = Alignment(vertical="top", wrap_text=True)
            c.border = Border(top=thin, bottom=thin, left=thin, right=thin)
    n = len(rows) + 3
    ws.cell(n, 1, "Source: Jira export of epics CMCM-30655 (Workforce Optimization Q1 2027) and CMCM-47698 (follow-up, Q2 2027 or later) plus CMCM-37518. Stage = Jira status; Sprint = Jira Sprint field (latest).").font = Font(name="Arial", size=9, italic=True)
    ws.merge_cells(start_row=n, start_column=1, end_row=n, end_column=6)
    ws.cell(n, 1).alignment = Alignment(wrap_text=True, vertical="top"); ws.row_dimensions[n].height = 30
    for col, wd in zip("ABCDEF", [13, 52, 20, 16, 18, 60]): ws.column_dimensions[col].width = wd
    ws.freeze_panes = "A2"; ws.auto_filter.ref = f"A1:F{len(rows)+1}"
    wb.save(out)
    print(f"{len(rows)} stories written to {out}")
    print("CHANGES:" if changes else "CHANGES: none" if prev else "CHANGES: first build")
    for c in changes: print(" -", c)

if __name__ == "__main__":
    main()
