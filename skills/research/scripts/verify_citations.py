#!/usr/bin/env python3
"""
verify_citations.py — borrowed from Geek-skills-deep-research, ported for the
research skill (F13: wired INTO the Agentic Protocol Step 2, never orphaned).

Structural citation-integrity checker: resolves every citation marker `[n]` in
the report against the LOCAL source pool (sources.json); flags unresolved
citations, dangling references, non-sequential numbering, and source
concentration (> 25% from any single source).

⚠️  This is a STRUCTURAL check only — it does NOT make network requests.
It does NOT verify HTTP 404s, redirect chains, or content-drift. A URL that
has gone dead or been hijacked will still pass if it matches the local source
pool. For live-URL verification, use a separate network checker (e.g.
WebFetch HEAD) before relying on citation-liveness.

Stdlib only. Python 3.9+.

Usage:
    python3 verify_citations.py <report.md> <sources.json> [--output results.json]
    python3 verify_citations.py --self-test    # run a quick self-test

Exit codes:
    0  no unresolved / no dangling / no concentration issues
    1  one or more issues found (see --output report)
    2  usage error
"""
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


SOURCE_CONCENTRATION_LIMIT = 0.25  # No single source > 25% of citations


def normalize_url(url: str) -> str:
    """Lowercase + strip trailing slash + strip common tracking params."""
    url = url.strip().rstrip("/")
    parsed = urlparse(url.lower())
    drop_params = {"utm_source", "utm_medium", "utm_campaign", "ref", "fbclid", "gclid"}
    # Best-effort: keep query but strip params in drop_params
    if parsed.query:
        parts = [p for p in parsed.query.split("&") if p.split("=")[0] not in drop_params]
        query = "&".join(parts)
    else:
        query = ""
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}{('?' + query) if query else ''}".rstrip("/")


def url_signature(url: str):
    """Robust (domain, path_segments[:3]) for matching."""
    parsed = urlparse(url.lower())
    host = parsed.hostname or ""
    if host.startswith("www."):
        host = host[4:]
    segments = [s for s in parsed.path.split("/") if s][:3]
    return (host, tuple(segments))


def extract_citations(text: str):
    """Find [n] markers in body. Returns list of int indices."""
    return [int(m) for m in re.findall(r"\[(\d+)\]", text)]


def extract_references(text: str):
    """Find reference list. Returns dict {int_idx: (label, url)}."""
    refs = {}
    # Match common patterns: [1] Label — URL or [1] Label - http...
    for m in re.finditer(r"^\s*\[(\d+)\]\s+([^—\-]+?)\s*[—\-]\s*(\S+)", text, re.MULTILINE):
        refs[int(m.group(1))] = (m.group(2).strip(), m.group(3).strip())
    return refs


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[0] == "--self-test":
        return self_test()
    if len(argv) < 2:
        print("Usage: verify_citations.py <report.md> <sources.json> [--output results.json]", file=sys.stderr)
        return 2

    report_path = Path(argv[0])
    sources_path = Path(argv[1])
    output_path = None
    if len(argv) >= 4 and argv[2] == "--output":
        output_path = Path(argv[3])

    report = report_path.read_text(encoding="utf-8")
    sources_data = json.loads(sources_path.read_text(encoding="utf-8"))

    sources = sources_data.get("sources", [])
    sources_normalized = {normalize_url(s["url"]): s for s in sources}

    citations = extract_citations(report)
    refs = extract_references(report)

    issues = []
    stats = {
        "report_citations": len(citations),
        "unique_citations": len(set(citations)),
        "references_declared": len(refs),
        "sources_in_pool": len(sources),
        "concentration": {},
    }

    # 1. Every [n] has a matching reference
    for c in set(citations):
        if c not in refs:
            issues.append({
                "severity": "fatal",
                "type": "unresolved_citation",
                "detail": f"Citation [{c}] has no matching reference entry",
            })

    # 2. Every reference URL exists in source pool
    for idx, (label, url) in refs.items():
        if normalize_url(url) not in sources_normalized:
            # Try signature match
            sig = url_signature(url)
            match = None
            for s_url, s in sources_normalized.items():
                if url_signature(s_url) == sig:
                    match = s
                    break
            if not match:
                issues.append({
                    "severity": "fatal",
                    "type": "url_not_in_source_pool",
                    "detail": f"Reference [{idx}] URL '{url}' not found in source pool",
                })

    # 3. Dangling references (in list but never cited)
    for idx in refs:
        if idx not in set(citations):
            issues.append({
                "severity": "warn",
                "type": "dangling_reference",
                "detail": f"Reference [{idx}] declared but never cited in body",
            })

    # 4. Sequential numbering, no gaps
    if refs:
        max_idx = max(refs.keys())
        missing = [i for i in range(1, max_idx + 1) if i not in refs]
        if missing:
            issues.append({
                "severity": "warn",
                "type": "non_sequential_numbering",
                "detail": f"Reference numbering gaps: {missing}",
            })

    # 5. Source concentration
    cite_counts = {}
    for c in citations:
        if c in refs:
            label = refs[c][0]
            cite_counts[label] = cite_counts.get(label, 0) + 1
    total = max(len(citations), 1)
    for label, count in cite_counts.items():
        ratio = count / total
        stats["concentration"][label] = round(ratio, 3)
        if ratio > SOURCE_CONCENTRATION_LIMIT:
            issues.append({
                "severity": "fatal",
                "type": "source_concentration",
                "detail": f"Source '{label}' has {count}/{total} citations ({ratio*100:.1f}%) > {SOURCE_CONCENTRATION_LIMIT*100:.0f}% limit",
            })

    result = {
        "ok": all(i["severity"] != "fatal" for i in issues),
        "stats": stats,
        "issues": issues,
    }

    if output_path:
        output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    else:
        print(json.dumps(result, indent=2))

    return 0 if result["ok"] else 1


def self_test():
    """Run a quick self-test on a fabricated report."""
    report = """# Test

Claim one [1]. Claim two [2]. Claim three [3]. Claim four [4]. Claim five [5].

## References

[1] Author A — https://example.com/a
[2] Author B — https://example.org/b
[3] Author C — https://example.net/c
[4] Author D — https://example.io/d
[5] Author E — https://example.dev/e
"""
    sources = {
        "sources": [
            {"url": "https://example.com/a", "title": "Author A's paper"},
            {"url": "https://example.org/b", "title": "Author B's notes"},
            {"url": "https://example.net/c", "title": "Author C's x"},
            {"url": "https://example.io/d", "title": "Author D's y"},
            {"url": "https://example.dev/e", "title": "Author E's z"},
        ]
    }
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write(report)
        rp = f.name
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(sources, f)
        sp = f.name
    code = main([rp, sp])
    Path(rp).unlink()
    Path(sp).unlink()
    print(f"\nself-test: exit={code} (expected 0 — 1 citation per source, no concentration)")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
