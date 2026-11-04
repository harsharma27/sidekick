#!/usr/bin/env python3
"""Regression test for tools/wfo_plan.py. Run: python3 -I tests/wfo_plan_test.py (from the repo root).
Synthetic exports only; no Jira data is stored in the repo."""
import csv, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "tools", "wfo_plan.py")
HDR = ["Summary", "Issue key", "Issue Type", "Status", "Sprint", "Labels",
       "Custom field (Epic Link)", "Custom field (Product Owner)"]

def row(key, summary, status="In Progress - Dev", epic="CMCM-30655", po="cthompson1"):
    return [summary, key, "Story", status, "Q1'27 Sprint 3", "SAP_Impact", epic, po]

def write(path, rows, cut_last_at=None):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(HDR)
        for n, r in enumerate(rows):
            w.writerow(r[:cut_last_at] if cut_last_at and n == len(rows) - 1 else r)

def run(*args):
    p = subprocess.run([sys.executable, "-I", SCRIPT, *args], capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr

fails = 0
def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"\n  {detail}"))
    fails += 0 if ok else 1

with tempfile.TemporaryDirectory() as d:
    full = [row("CMCM-1", "A"), row("CMCM-2", "[CP] A"), row("CMCM-3", "B"), row("CMCM-4", "C")]
    write(f"{d}/full.csv", full)
    code, out = run(f"{d}/full.csv", f"{d}/prev.xlsx")
    check("complete export builds the plan", code == 0 and "4 stories written" in out, out)

    # Cut-off export: last row stops after 3 columns and later stories are missing (4 Nov 2026).
    write(f"{d}/cut.csv", full[:3], cut_last_at=3)
    code, out = run(f"{d}/cut.csv", f"{d}/new.xlsx", f"{d}/prev.xlsx")
    check("cut-off export stops with exit 2", code == 2, out)
    check("cut-off export names the bad row and the fix", "row 4 has 3 of 8 columns" in out and "Export CSV (current fields)" in out, out)
    check("cut-off export writes no workbook", not os.path.exists(f"{d}/new.xlsx"), out)
    check("cut-off export reports no DROPPED stories", "DROPPED" not in out, out)

    # A story that really left the epic is still reported, with where it went.
    moved = full[:3] + [row("CMCM-4", "C", epic="CMCM-99999")]
    write(f"{d}/moved.csv", moved)
    code, out = run(f"{d}/moved.csv", f"{d}/new2.xlsx", f"{d}/prev.xlsx")
    check("story moved to another epic is DROPPED with its new epic", code == 0 and "DROPPED CMCM-4 (still in the export but now Story, epic CMCM-99999" in out, out)

    write(f"{d}/gone.csv", full[:3])
    code, out = run(f"{d}/gone.csv", f"{d}/new3.xlsx", f"{d}/prev.xlsx")
    check("story missing from a complete export is DROPPED with a check-Jira note", code == 0 and "DROPPED CMCM-4 (not in the export: check Jira" in out, out)

print(f"\n{'ALL PASS' if not fails else str(fails) + ' FAILED'}")
sys.exit(1 if fails else 0)
