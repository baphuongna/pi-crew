#!/usr/bin/env python3
"""
code_dna.py — measure Code Expression-DNA on a target file/dir.

The operational-tooling distillation for `distill-software` (F13: wired INTO the
Agentic Protocol Step 2, not orphaned). Encodes the code-Expression-DNA mental
models (distill-software §代码表达DNA) as measurable axes. Input = code →
axes = the style fingerprint → markdown report the agent reasons over.

Stdlib only. Python 3.9+. Supports Python + TS/JS (basic). Other languages:
naming + comment density still measured; language-specific axes skipped.

Usage:
  python3 code_dna.py <file-or-dir> [--lang py|ts] [--top 20]
"""
import argparse
import re
import sys
from collections import Counter
from pathlib import Path

PY_EXT = {".py"}
TS_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}


def iter_files(target: Path, lang: str | None):
    if target.is_file():
        yield target
        return
    for p in sorted(target.rglob("*")):
        if not p.is_file() or ".git" in p.parts:
            continue
        ext = p.suffix.lower()
        if lang == "py" and ext in PY_EXT:
            yield p
        elif lang == "ts" and ext in TS_EXT:
            yield p
        elif lang is None and (ext in PY_EXT or ext in TS_EXT):
            yield p


# ---------------------------------------------------------------- naming
def classify_name(name: str) -> str:
    if not name:
        return "other"
    low = name[0].islower() or name[0] == "_"
    if "_" in name and low:
        return "snake_case"
    if name[:1].isupper() and any(c.isupper() for c in name[1:]):
        return "PascalCase"
    if low and any(c.isupper() for c in name):
        return "camelCase"
    if "-" in name:
        return "kebab-case"
    return "lower"


PREFIX_RE = re.compile(r"^(is|has|get|set|handle|fetch|render|test|should|can|with)[_A-Z]")


# ---------------------------------------------------------------- python
PY_DEF = re.compile(r"^\s*def\s+([A-Za-z_]\w*)\s*\(", re.M)
PY_CLASS = re.compile(r"^\s*class\s+([A-Za-z_]\w*)", re.M)
PY_COMMENT = re.compile(r"^\s*#")
PY_WHY = re.compile(r"#.*(because|why|so that|in order|note:|todo|fixme|hack|warning|intent)", re.I)
PY_RAISE = re.compile(r"\braise\b")
PY_EXCEPT = re.compile(r"\bexcept\b")
PY_RETURN_NONE = re.compile(r"return\s+(None|nil)\b")
PY_TYPED_DEF = re.compile(r"^\s*def\s+\w+\s*\([^)]*\)\s*->\s*\S", re.M)
PY_ANY = re.compile(r":\s*Any\b|\bAny\s*\]|\bDict\[.*Any")


def analyze_py(text: str) -> dict:
    defs = PY_DEF.findall(text)
    classes = PY_CLASS.findall(text)
    names = defs + classes
    lines = text.splitlines()
    nlines = max(len(lines), 1)
    comments = sum(1 for ln in lines if PY_COMMENT.match(ln))
    why = sum(1 for ln in lines if PY_WHY.search(ln))
    # function length: split body by def boundaries
    func_lens = []
    blocks = re.split(r"(?m)^\s*def\s+\w+\s*\(", text)
    for b in blocks[1:]:
        body = b.split("\n")
        func_lens.append(len([l for l in body if l.strip()]))
    func_lens = [x for x in func_lens if x > 0] or [0]
    func_lens.sort()
    n = len(func_lens)
    median = func_lens[n // 2]
    p90 = func_lens[min(int(n * 0.9), n - 1)]
    return {
        "names": names, "nlines": nlines, "comments": comments, "why_comments": why,
        "raise": len(PY_RAISE.findall(text)), "except": len(PY_EXCEPT.findall(text)),
        "return_none": len(PY_RETURN_NONE.findall(text)),
        "typed_defs": len(PY_TYPED_DEF.findall(text)), "any_": len(PY_ANY.findall(text)),
        "ndefs": len(defs), "func_median": median, "func_p90": p90,
    }


# ---------------------------------------------------------------- ts/js
TS_FUNC = re.compile(r"(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)")
TS_CLASS = re.compile(r"\bclass\s+([A-Za-z_$][\w]*)")
TS_COMMENT_LINE = re.compile(r"^\s*//|^\s*\*")
TS_WHY = re.compile(r"(because|why|so that|in order|note:|todo|fixme|hack|warning|intent|rationale)", re.I)
TS_THROW = re.compile(r"\bthrow\b")
TS_CATCH = re.compile(r"\bcatch\b")
TS_RETURN_NULL = re.compile(r"return\s+(null|undefined)\b")
TS_OK = re.compile(r"\.ok\b")
TS_TYPED = re.compile(r":\s*(?:[A-Za-z_$][\w$<>\[\],\s|&]*)\s*[=,)\n{]")
TS_ANY = re.compile(r":\s*any\b|<any>|Array<any>|Promise<any>")


def analyze_ts(text: str) -> dict:
    fn = [m for m in (TS_FUNC.findall(text))]
    names = [a or b for a, b in fn] + TS_CLASS.findall(text)
    lines = text.splitlines()
    nlines = max(len(lines), 1)
    comments = sum(1 for ln in lines if TS_COMMENT_LINE.match(ln))
    why = sum(1 for ln in lines if TS_COMMENT_LINE.match(ln) and TS_WHY.search(ln))
    return {
        "names": names, "nlines": nlines, "comments": comments, "why_comments": why,
        "raise": len(TS_THROW.findall(text)), "except": len(TS_CATCH.findall(text)),
        "return_none": len(TS_RETURN_NULL.findall(text)), "ok_result": len(TS_OK.findall(text)),
        "typed_defs": len(TS_TYPED.findall(text)), "any_": len(TS_ANY.findall(text)),
        "ndefs": len(fn), "func_median": 0, "func_p90": 0,  # body-split unreliable for TS
    }


# ---------------------------------------------------------------- render
def style_tags(a: dict) -> list[str]:
    tags = []
    comment_ratio = a["comments"] / max(a["nlines"], 1)
    tags.append("verbose" if comment_ratio > 0.20 else "terse" if comment_ratio < 0.05 else "mid-comments")
    err = a["raise"] + a["except"] + a.get("ok_result", 0)
    tags.append("strict-errors" if err > a["nlines"] * 0.03 else "loose-errors")
    if a.get("typed_defs", 0) or a.get("any_", 0):
        ratio = a["typed_defs"] / max(a["typed_defs"] + a["any_"], 1)
        tags.append("typed" if ratio > 0.7 else "any-heavy" if a["any_"] > a["typed_defs"] else "mixed-types")
    else:
        tags.append("untyped")
    why_ratio = a["why_comments"] / max(a["comments"], 1)
    tags.append("why-comments" if why_ratio > 0.3 else "what-comments" if a["comments"] > 5 else "sparse-comments")
    return tags


def naming_dist(names: list[str], top: int) -> tuple[Counter, Counter]:
    cls = Counter(classify_name(n) for n in names)
    pref = Counter()
    for n in names:
        m = PREFIX_RE.match(n)
        if m:
            pref[m.group(1) + "_*"] += 1
    return cls, pref


def report(path: Path, agg: dict, top: int) -> str:
    a = agg
    cls, pref = naming_dist(a["names"], top)
    n_names = max(len(a["names"]), 1)
    tags = style_tags(a)
    out = [f"# Code Expression-DNA — `{path}`", ""]
    out.append(f"**Scope**: {a['nfiles']} file(s), {a['nlines']} lines, {a['ndefs']} functions/methods, {len(a['names'])} named symbols.")
    out.append("")
    out.append("## Style fingerprint (8-axis grid)")
    out.append("`" + " · ".join(tags) + "`")
    out.append("")
    out.append("## Naming axis")
    for k, v in cls.most_common():
        out.append(f"- **{k}**: {v} ({v/n_names:.0%})")
    if pref:
        out.append("")
        out.append("Common prefixes:")
        for k, v in pref.most_common(top):
            out.append(f"- `{k}`: {v}")
    out.append("")
    out.append("## Function-length axis")
    if a.get("func_median"):
        out.append(f"- median ≈ {a['func_median']} stmts · p90 ≈ {a['func_p90']} stmts")
        out.append("- " + ("tiny-pure preferred" if a["func_median"] <= 8 else "longer orchestrators"))
    else:
        out.append("- (body-length measurement not supported for this language; measure via LSP/tree-sitter)")
    out.append("")
    out.append("## Comment axis")
    cr = a["comments"] / max(a["nlines"], 1)
    out.append(f"- density: {a['comments']} comment lines ({cr:.0%} of code)")
    why_ratio = a["why_comments"] / max(a["comments"], 1)
    out.append(f"- *why*-comments: {a['why_comments']} ({why_ratio:.0%} of comments)")
    out.append("")
    out.append("## Error-handling axis")
    out.append(f"- `raise`/`throw`: {a['raise']} · `except`/`catch`: {a['except']} · `return null/None`: {a['return_none']}" + (f" · `.ok` result-style: {a.get('ok_result',0)}" if a.get("ok_result") else ""))
    out.append("")
    out.append("## Type-strictness axis")
    out.append(f"- typed signatures: {a['typed_defs']} · `any`: {a['any_']}")
    out.append("")
    out.append("## 口癖 (forbidden patterns) — mine from the detected lint toolchain (matrix)")
    out.append("```bash")
    out.append("# eslint: no-restricted-syntax / no-restricted-properties")
    out.append("rg -A3 'no-restricted-(syntax|properties|globals)' eslint.config.* .eslintrc* 2>/dev/null")
    out.append("# oxc (oxlint): flat rules list (no no-restricted equiv)")
    out.append("rg -A3 'rules' .oxlintrc.json oxlint.config.* 2>/dev/null")
    out.append("# biome / deno")
    out.append("rg -A3 'lint|rules' biome.json deno.json 2>/dev/null")
    out.append("# tsconfig strict flags (often the real type-strictness DNA)")
    out.append("grep -nE 'strict|exactOptionalPropertyTypes|noUncheckedIndexedAccess' tsconfig.json")
    out.append("```")
    out.append("")
    out.append("---")
    out.append("_Generated by `code_dna.py` (distill-software operational tooling). The Agentic Protocol Step 2 reads this report and applies the skill's mental models to interpret it._")
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", help="file or dir to measure")
    ap.add_argument("--lang", choices=["py", "ts"], default=None)
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("-o", "--out", default=None, help="write report to file (default stdout)")
    ap.add_argument("--force", action="store_true", help="overwrite existing output file")
    args = ap.parse_args(argv)
    target = Path(args.target)
    if not target.exists():
        print(f"❌ not found: {target}", file=sys.stderr)
        return 1
    agg = {"names": [], "nfiles": 0, "nlines": 0, "comments": 0, "why_comments": 0,
           "raise": 0, "except": 0, "return_none": 0, "ok_result": 0,
           "typed_defs": 0, "any_": 0, "ndefs": 0, "func_lens": []}
    for f in iter_files(target, args.lang):
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        ext = f.suffix.lower()
        a = analyze_py(text) if ext in PY_EXT else analyze_ts(text) if ext in TS_EXT else None
        if a is None:
            # generic fallback: naming + comment density only
            names = re.findall(r"\b(?:def|function|class|const)\s+([A-Za-z_$][\w$]*)", text)
            lines = text.splitlines()
            a = {"names": names, "nlines": len(lines), "comments": sum(1 for l in lines if re.match(r"\s*(#|//|\*)", l)),
                 "why_comments": 0, "raise": 0, "except": 0, "return_none": 0, "ok_result": 0,
                 "typed_defs": 0, "any_": 0, "ndefs": len(names), "func_median": 0, "func_p90": 0}
        for k in ["names", "nlines", "comments", "why_comments", "raise", "except", "return_none", "ok_result", "typed_defs", "any_", "ndefs"]:
            agg[k] += a.get(k, 0)
        agg["nfiles"] += 1
        agg["func_lens"] += [a["func_median"]] if a.get("func_median") else []
    agg["func_median"] = sorted(agg["func_lens"])[len(agg["func_lens"]) // 2] if agg["func_lens"] else 0
    agg["func_p90"] = sorted(agg["func_lens"])[min(int(len(agg["func_lens"]) * 0.9), len(agg["func_lens"]) - 1)] if agg["func_lens"] else 0
    if agg["nfiles"] == 0:
        print(f"❌ no .py/.ts/.js files under {target} (use --lang py|ts, or pass a file)", file=sys.stderr)
        return 1
    rep = report(target, agg, args.top)
    if args.out:
        out_path = Path(args.out)
        if out_path.exists() and not args.force:
            print(f"❌ output exists (use --force to overwrite): {out_path}", file=sys.stderr)
            return 1
        out_path.write_text(rep, encoding="utf-8")
        print(f"✅ wrote {args.out}")
    else:
        print(rep)
    return 0


def self_test():
    """Run a quick self-test on a fabricated Python source file."""
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write('''# Test module
def hello(name: str) -> str:
    """Greet someone."""  # because the API needs it
    return f"hello, {name}"

class Foo:
    def __init__(self, x: int) -> None:
        self.x = x

    def get_value(self):
        return self.x
''')
        rp = f.name
    code = main([rp])
    Path(rp).unlink()
    print(f"\nself-test: exit={code} (expected 0)")
    return code


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    sys.exit(main())
