#!/usr/bin/env python3
"""
code_dna.py — borrowed from distill-software, ported for the research skill
(F13: wired INTO the Agentic Protocol Step 2, measures the 12-axis research
expression fingerprint on the output artifacts).

Specialized for research SKILL output (Markdown reports + JSON items×fields).
Measures the 12-axis grid spelled out in the SKILL.md.

Stdlib only. Python 3.9+.

Usage:
    python3 code_dna.py <report.md-or-dir> [--lang md] [--top 20]
    python3 code_dna.py --self-test

Exit codes:
    0  report emitted
    1  no files found
    2  usage error
"""
import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path


MD_EXT = {".md", ".markdown", ".mdx"}
JSON_EXT = {".json"}


# --------------------------- research axes
def section_count(text: str) -> int:
    """Count `##` or `###` headings — the section-completeness axis."""
    return len(re.findall(r"(?m)^#{2,3}\s+\S", text))


def citation_count(text: str) -> int:
    """Count [n] citation markers and (URL) inline refs."""
    bracket = re.findall(r"\[(\d+)\]", text)
    inline = re.findall(r"\((https?://\S+)\)", text)
    return len(set(bracket)) + len(set(inline))


def source_diversity(text: str) -> int:
    """Unique domains in cited URLs."""
    urls = re.findall(r"https?://([\w.-]+)", text)
    return len(set(urls))


def tension_count(text: str) -> int:
    """Count tension-discovery markers (heuristic: 'Tension', 'Disagreement', 'tension row', 'contradict')."""
    keywords = re.findall(r"(?i)\b(tension|disagreement|contradict|conflict|diverg)\w*", text)
    return len(keywords)


def iteration_modes(text: str) -> dict:
    """Count iteration-mode markers in the log.jsonl-like sections."""
    modes = {"breadth": 0, "depth": 0, "refinement": 0}
    for line in text.splitlines():
        ll = line.lower()
        if "breadth" in ll or "add-items" in ll or "add_fields" in ll:
            modes["breadth"] += 1
        if "depth" in ll or "loop.forever" in ll or "iterate" in ll:
            modes["depth"] += 1
        if "refinement" in ll or "refine" in ll or "narrow" in ll:
            modes["refinement"] += 1
    return modes


def analyze_md(text: str) -> dict:
    lines = text.splitlines()
    nlines = max(len(lines), 1)
    return {
        "nlines": nlines,
        "sections": section_count(text),
        "citations": citation_count(text),
        "source_diversity": source_diversity(text),
        "tension_count": tension_count(text),
        "iteration_modes": iteration_modes(text),
        "tables": len(re.findall(r"(?m)^\|.*\|$", text)),
        "code_blocks": len(re.findall(r"(?m)^```", text)) // 2,
    }


def style_tags(a: dict) -> list:
    """Map stats to a 8-tag style fingerprint."""
    tags = []
    if a["sections"] >= 8:
        tags.append("structured-heavy")
    elif a["sections"] <= 3:
        tags.append("narrative-light")
    else:
        tags.append("balanced")
    if a["citations"] >= 10:
        tags.append("citation-dense")
    elif a["citations"] >= 3:
        tags.append("citation-modal")
    else:
        tags.append("citation-sparse")
    if a["tension_count"] >= 3:
        tags.append("tension-aware")
    elif a["tension_count"] >= 1:
        tags.append("tension-light")
    else:
        tags.append("tension-blind")
    if a["tables"] >= 5:
        tags.append("table-heavy")
    elif a["tables"] >= 1:
        tags.append("table-modal")
    else:
        tags.append("prose-default")
    modes = a["iteration_modes"]
    active = [k for k, v in modes.items() if v > 0]
    if len(active) == 1:
        tags.append(f"mono-mode:{active[0]}")
    elif len(active) >= 2:
        tags.append("multi-mode")
    else:
        tags.append("mode-undeclared")
    return tags


def report(path: Path, agg: dict) -> str:
    out = [f"# Research Expression-DNA — `{path}`", ""]
    out.append(f"**Scope**: {agg['nfiles']} file(s), {agg['nlines']} lines, {agg['sections']} sections, {agg['tables']} tables.")
    out.append("")
    out.append("## 12-axis grid")
    out.append("")
    out.append("### Output-shape axes (1–6)")
    out.append(f"1. **Schema conformance**: {agg['sections']} sections (target ≥ 8 for a structured report)")
    out.append(f"2. **Citation density**: {agg['citations']} citations (target ≥ 10)")
    out.append(f"3. **Source diversity**: {agg['source_diversity']} unique domains (target ≥ 5)")
    out.append(f"4. **Section completeness**: {agg['sections']} sections")
    out.append(f"5. **Tension density**: {agg['tension_count']} tension markers (target ≥ 3)")
    modes = agg["iteration_modes"]
    out.append(f"6. **Iteration discipline**: breadth={modes['breadth']} depth={modes['depth']} refinement={modes['refinement']}")
    out.append("")
    out.append("### Style-meta (8-tag grid)")
    out.append("`" + " · ".join(style_tags(agg)) + "`")
    out.append("")
    out.append("### Process axes (7–12) — read from log.jsonl")
    out.append("7. **State-on-disk compliance**: did handoff files exist before context reset? — check `ls .auto/`")
    out.append("8. **Coverage manifest completeness**: every field COVERED or UNFETCHABLE — check `coverage-manifest.md`")
    out.append("9. **3-empty-rounds gate**: round log shows ≥3 consecutive empty rounds — check `DISTILLATION-PROCESS-CHECKLIST.md`")
    out.append("10. **Validator exit codes**: every validator exit 0 — check `echo $?`")
    out.append("11. **Cost transparency**: cost line per API call — check `x-search.ts` output column")
    out.append("12. **Hook firing**: hooks actually invoked — check `log.jsonl` event audit")
    out.append("")
    out.append("---")
    out.append("_Generated by `code_dna.py` (research skill operational tooling). The Agentic Protocol Step 2 reads this report and applies the skill's mental models to interpret it._")
    return "\n".join(out)


def iter_files(target: Path, lang: str):
    if target.is_file():
        yield target
        return
    for p in sorted(target.rglob("*")):
        if not p.is_file() or ".git" in p.parts:
            continue
        ext = p.suffix.lower()
        if lang == "md" and ext in MD_EXT:
            yield p
        elif lang == "json" and ext in JSON_EXT:
            yield p
        elif lang is None and (ext in MD_EXT or ext in JSON_EXT):
            yield p


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", help="file or dir to measure")
    ap.add_argument("--lang", choices=["md", "json"], default=None)
    args = ap.parse_args(argv)
    target = Path(args.target)
    if not target.exists():
        print(f"\u274c not found: {target}", file=sys.stderr)
        return 1
    agg = {"nfiles": 0, "nlines": 0, "sections": 0, "citations": 0, "source_diversity": 0,
           "tension_count": 0, "iteration_modes": {"breadth": 0, "depth": 0, "refinement": 0}, "tables": 0, "code_blocks": 0}
    seen_domains = set()
    for f in iter_files(target, args.lang):
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        a = analyze_md(text)
        for k in ["nlines", "sections", "citations", "tension_count", "tables", "code_blocks"]:
            agg[k] += a.get(k, 0)
        seen_domains.update(re.findall(r"https?://([\w.-]+)", text))
        for k, v in a["iteration_modes"].items():
            agg["iteration_modes"][k] += v
        agg["nfiles"] += 1
    agg["source_diversity"] = len(seen_domains)
    if agg["nfiles"] == 0:
        print(f"\u274c no .md/.json files under {target}", file=sys.stderr)
        return 1
    print(report(target, agg))
    return 0


def self_test():
    """Run a quick self-test on a fabricated report."""
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write("""# Test

## Section 1
Claim one [1]. Source (https://example.com). Another (https://example.org).

## Section 2
Tension between sources. Disagreement here.

## Section 3
| col1 | col2 |
|------|------|
| a    | b    |
""")
        rp = f.name
    code = main([rp])
    Path(rp).unlink()
    print(f"\nself-test: exit={code} (expected 0)")
    return code


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    sys.exit(main())
