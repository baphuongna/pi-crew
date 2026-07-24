#!/usr/bin/env python3
"""
fidelity_eval.py — Phase 4 automation + reproducibility test for distilled skills.

Closes two gaps from the distill-persona build:
  1. Automates Phase 4 fidelity validation (known-stance + FRAMEWORK-ANSWERABLE novel
     edge + blind independent scorer). The novel edge MUST be framework-answerable
     (validated at n=3: fact-demanding edges give false passes via refusal vocab).
  2. Adds a reproducibility test (distill the same persona twice, diff the mental-model
     sets; flag if overlap < 60%).

Runtime-agnostic by design: the deterministic parts (test-spec validation, scorecard
parsing, reproducibility diff, grading) live here; the LLM calls (answerer + scorer)
are emitted as ready-to-dispatch prompts that THIS runtime's subagent mechanism runs
(pi-crew `Agent`, Claude Code subagents, etc.). We never hardcode an LLM API — there is
no key here, and runtimes vary.

Stdlib only. Python 3.9+.

Usage:
  python3 fidelity_eval.py validate <test-spec.md>     # check spec structure
  python3 fidelity_eval.py runbook <skill-dir> <spec>  # emit answerer+scorer prompts
  python3 fidelity_eval.py parse <score.md>            # extract 5-dim numbers
  python3 fidelity_eval.py repro <skillA.md> <skillB.md>  # diff mental models (Jaccard)

Test-spec format (markdown):
  ## known
  1. <question>
  2. <question>
  3. <question>
  ## edge            # exactly ONE, must be framework-answerable
  <question>
  ## ground-truth
  <the persona's real documented public stances — for the blind scorer only>
  ## edge-note
  <one line: why this edge is framework-answerable + that the persona never addressed it>
"""
import argparse
import re
import sys
from pathlib import Path

# --- grading thresholds (from nuwa fidelity-scorecard, + the F2' edge-honesty gate) ---
GRADE_A = 85          # ship
GRADE_B = 70          # acceptable with flagged weak spots
EDGE_HONESTY_SHIP = 14   # /20 — a skill that fails edge-honesty is NOT ship-ready even if total is high
REPRO_FLOOR = 0.60    # mental-model Jaccard overlap below this flags non-reproducible distillation

DIMS = [
    ("stance_consistency", 30),
    ("style_recognizability", 20),
    ("edge_honesty", 20),
    ("source_transparency", 15),
    ("structural_completeness", 15),
]


# --------------------------------------------------------------------------- spec validation
def parse_spec(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    sections = {}
    cur = None
    for line in text.splitlines():
        m = re.match(r"^##\s+(\S.*)$", line)
        if m:
            cur = m.group(1).strip().lower().replace("-", "_").replace(" ", "_")
            sections[cur] = []
        elif cur:
            sections[cur].append(line)
    return {k: "\n".join(v).strip() for k, v in sections.items()}


def validate_spec(path: Path) -> int:
    s = parse_spec(path)
    problems = []
    if "known" not in s:
        problems.append("missing '## known' section")
    else:
        known = [ln for ln in s["known"].splitlines() if re.match(r"^\s*\d+\.", ln.strip())]
        if len(known) != 3:
            problems.append(f"'## known' must have exactly 3 numbered questions, found {len(known)}")
    if "edge" not in s or not s["edge"].strip():
        problems.append("missing '## edge' section (exactly ONE novel edge question)")
    if "ground_truth" not in s or len(s["ground_truth"]) < 50:
        problems.append("missing or too-short '## ground-truth' (the blind scorer's reference)")
    if "edge_note" not in s or "framework" not in s["edge_note"].lower():
        problems.append("'## edge-note' must state why the edge is FRAMEWORK-answerable "
                        "(fact-demanding edges give false passes — see f2-experiment/validation-conclusion.md)")
    if problems:
        print("❌ INVALID test spec:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("✅ test spec OK (3 known + 1 framework-answerable edge + ground-truth + edge-note)")
    print(f"   edge question: {s['edge'].splitlines()[0][:90]}")
    return 0


# --------------------------------------------------------------------------- runbook emission
RUNBOOK_HEADER = """# Fidelity runbook for {skill}

Runtime-agnostic. Run the two steps below via THIS runtime's subagent mechanism, in order.
Step 1 (answerer) MUST finish before Step 2 (scorer). The scorer is BLIND (ground-truth only,
NO skill-file access) — F2 was refuted (skill-file access does not inflate scores) but the blind
condition keeps the score independent of the author's design intent.

## Step 1 — answerer (skill-only, NO web)
Allowlist these files ONLY: <skill-dir>/SKILL.md + <skill-dir>/references/research/*
Answer the 3 known + 1 edge question in character per the skill's Agentic Protocol.
For the edge question, honor the skill's F2' third-category rule (flag framework-derived
inference as inference, not established stance). Write answers to answers.md.

## Step 2 — blind scorer (ground-truth ONLY, NO skill file)
Allowlist: answers.md + rubric.md + ground-truth (from the test spec). Score 5 dims.
Write scorecard to score-B.md.

## Questions
{questions}

## Ground-truth (for blind scorer)
{ground_truth}
"""


def emit_runbook(skill_dir: Path, spec_path: Path) -> int:
    s = parse_spec(spec_path)
    questions = "### known\n" + s.get("known", "") + "\n\n### edge (FRAMEWORK-answerable)\n" + s.get("edge", "")
    out = RUNBOOK_HEADER.format(
        skill=skill_dir.name,
        questions=questions,
        ground_truth=s.get("ground_truth", "(none)"),
    )
    dest = skill_dir / "fidelity-runbook.md"
    dest.write_text(out, encoding="utf-8")
    print(f"✅ wrote {dest}")
    print("   next: dispatch Step 1 (answerer) then Step 2 (blind scorer) via your runtime.")
    return 0


# --------------------------------------------------------------------------- scorecard parsing
def parse_score(path: Path) -> dict:
    """Extract the 5 dimension scores from a scorer's markdown scorecard."""
    text = path.read_text(encoding="utf-8")
    found = {}
    for name, _ in DIMS:
        # match e.g. "| 1 Stance consistency | 26/30 |" or "| 3 Edge honesty | **6/20** |"
        # [\s*]* tolerates bold (**..**) wrappers around the score.
        pat = re.compile(rf"\|[^|]*{re.escape(name.split('_')[0])}[^|]*\|[\s*]*(\d+)\s*/\s*(\d+)", re.I)
        m = pat.search(text)
        if m:
            found[name] = int(m.group(1))
    total_m = re.search(r"\*\*TOTAL\*\*\s*\|\s*(\d+)\s*/\s*100", text, re.I)
    if not total_m:
        total_m = re.search(r"(\d+)\s*/\s*100", text)
    total = int(total_m.group(1)) if total_m else sum(found.values())
    return {"dims": found, "total": total}


def report_score(path: Path) -> int:
    r = parse_score(path)
    if not r["dims"]:
        print("❌ could not parse any dimension scores from", path)
        return 1
    print(f"Scores from {path}:")
    for name, _max in DIMS:
        v = r["dims"].get(name)
        print(f"  {name:28} {v}/{_max}" if v is not None else f"  {name:28} (not found)")
    print(f"  {'TOTAL':28} {r['total']}/100")
    grade = grade_for(r["total"], r["dims"].get("edge_honesty", 0))
    print(f"  grade: {grade}")
    return 0


def grade_for(total: int, edge: int) -> str:
    if edge < EDGE_HONESTY_SHIP:
        return f"NO-SHIP (edge-honesty {edge}/20 < {EDGE_HONESTY_SHIP} — fails the F2' gate regardless of total)"
    if total >= GRADE_A:
        return f"A (≥{GRADE_A}) — ship"
    if total >= GRADE_B:
        return f"B (≥{GRADE_B}) — acceptable with flagged weak spots"
    return f"C (<{GRADE_B}) — re-distill"


# --------------------------------------------------------------------------- reproducibility diff
def extract_models(skill_md: Path) -> set:
    """Extract mental-model names from a SKILL.md (### 模型N: / ### Model N: / ### N. Name)."""
    text = skill_md.read_text(encoding="utf-8")
    names = set()
    # match model headings in either language; tolerate arabic OR Chinese numerals.
    for m in re.finditer(r"^#{2,4}\s+(?:模型\s*[0-9一二三四五六七八九十]+\s*[:：]?\s*|Model\s*\d+\s*[:：]\s*|\d+\.\s*)(.+)$", text, re.M):
        name = m.group(1).strip().split("(")[0].strip().split("（")[0].strip()
        # drop parenthetical english + trailing junk
        name = re.sub(r"\s+", " ", name)
        if 2 <= len(name) <= 60:
            names.add(name.lower())
    return names


def repro(a: Path, b: Path) -> int:
    ma, mb = extract_models(a), extract_models(b)
    if not ma or not mb:
        print(f"❌ could not extract models (A={len(ma)}, B={len(mb)}). "
              "Ensure SKILL.md uses '### 模型N: Name' / '### Model N: Name' headings.")
        return 1
    inter = ma & mb
    union = ma | mb
    jaccard = len(inter) / len(union) if union else 0.0
    name_overlap = len(inter) / min(len(ma), len(mb)) if min(len(ma), len(mb)) else 0.0
    print(f"Skill A models ({len(ma)}): {sorted(ma)}")
    print(f"Skill B models ({len(mb)}): {sorted(mb)}")
    print(f"intersection ({len(inter)}): {sorted(inter)}")
    print(f"Jaccard overlap: {jaccard:.0%}   name-overlap/min: {name_overlap:.0%}")
    if name_overlap < REPRO_FLOOR:
        print(f"⚠️  NON-REPRODUCIBLE: overlap {name_overlap:.0%} < {REPRO_FLOOR:.0%} floor — "
              "two distillations of the same persona diverge too much. Investigate Phase 2 subjectivity.")
        return 2
    print(f"✅ reproducible (overlap {name_overlap:.0%} ≥ {REPRO_FLOOR:.0%})")
    return 0


# --------------------------------------------------------------------------- CLI
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("validate", help="validate a test-spec.md structure").add_argument("spec")
    sub.add_parser("runbook", help="emit answerer+scorer prompts for a skill").add_argument("skill_dir")
    [a.add_argument("spec") for a in [sub.choices["runbook"]]]
    sub.add_parser("parse", help="extract 5-dim scores from a scorer's markdown").add_argument("score")
    r = sub.add_parser("repro", help="diff mental models of two SKILL.md (reproducibility test)")
    r.add_argument("skillA"); r.add_argument("skillB")
    args = ap.parse_args()
    if args.cmd == "validate":
        return validate_spec(Path(args.spec))
    if args.cmd == "runbook":
        return emit_runbook(Path(args.skill_dir), Path(args.spec))
    if args.cmd == "parse":
        return report_score(Path(args.score))
    if args.cmd == "repro":
        return repro(Path(args.skillA), Path(args.skillB))
    return 1


if __name__ == "__main__":
    sys.exit(main())
