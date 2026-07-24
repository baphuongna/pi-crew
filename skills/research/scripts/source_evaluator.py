#!/usr/bin/env python3
"""
source_evaluator.py — borrowed from Geek-skills-deep-research, ported for the
research skill (F13: wired INTO the Agentic Protocol Step 2, never orphaned).

3D filter on a source list:
  1. Authority (domain class, peer-review, primary-vs-secondary)
  2. Freshness (publication date / last-modified)
  3. Primary-vs-secondary (original research vs aggregation)

Accepts JSON input, emits a scored report. Default thresholds below.

Stdlib only. Python 3.9+.

Usage:
    python3 source_evaluator.py <sources.json> [--min-authority 0.6] [--max-age-days 365]
    python3 source_evaluator.py --self-test

Exit codes:
    0  ≥80% of sources pass thresholds
    1  <80% of sources pass; see output
    2  usage error
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

# MEDIUM-4: redact secret/PII values before persisting source-derived content.
# Same-dir import (script dir is on sys.path[0]); graceful fallback if absent.
try:
    from safe_io import redact_secrets
except ImportError:  # pragma: no cover - safe_io bundled alongside this script
    redact_secrets = None


DEFAULT_MIN_AUTHORITY = 0.6
DEFAULT_MAX_AGE_DAYS = 365
DEFAULT_ACCEPT_RATIO = 0.8


def host_match(host: str, trusted: str) -> bool:
    """Exact host or subdomain match — rejects lookalikes like evilgithub.com."""
    return host == trusted or host.endswith("." + trusted)


NEWS_DOMAINS = {"nytimes.com", "reuters.com", "bloomberg.com", "ft.com", "wsj.com"}
BLOG_DOMAINS = {"medium.com", "substack.com", "wordpress.com"}


def score_authority(url: str, source_meta: dict) -> float:
    """
    Heuristic authority score 0-1.
    Primary author / official docs / peer-reviewed = 0.9-1.0
    Engineering blog / canonical framework = 0.7-0.9
    Medium-tier publication / reputable blog = 0.5-0.7
    Forum / aggregation / personal blog = 0.2-0.5
    Unknown = 0.4

    NOTE: `primary` and `official` flags are self-declared hints from input JSON.
    They boost scores but should NOT be the sole basis for trust — verify
    provenance independently before relying on them for high-stakes decisions.
    Domain matching uses exact-host-or-subdomain (no substring), so
    `evilgithub.com` will NOT match `github.com`.
    """
    parsed = urlparse(url.lower())
    host = (parsed.hostname or "").replace("www.", "")
    # Authoritative classes
    if source_meta.get("primary"):
        return 1.0
    if host.endswith((".edu", ".gov", ".ac.uk", ".ac.jp")):
        return 0.95
    if any(host_match(host, d) for d in ("arxiv.org", "nature.com", "science.org")):
        return 0.95
    if host_match(host, "github.io") or host_match(host, "github.com"):
        # Official source code / docs — treat as authoritative if "official" flag
        return 0.9 if source_meta.get("official") else 0.7
    if host_match(host, "wikipedia.org"):
        return 0.65  # secondary aggregator
    # Class by exact domain allowlist (not substring — prevents spoofing)
    if any(host_match(host, d) for d in NEWS_DOMAINS):
        return 0.85
    if any(host_match(host, d) for d in BLOG_DOMAINS):
        return 0.5
    return 0.4  # unknown


def score_freshness(source_meta: dict, max_age_days: int, now: datetime) -> float:
    """
    Heuristic freshness score 0-1.
    - < 30 days: 1.0
    - < 90 days: 0.9
    - < 180 days: 0.8
    - < 365 days: 0.7
    - > 365 days: 0.5
    - no date: 0.5
    """
    date_str = source_meta.get("date") or source_meta.get("published") or source_meta.get("last_modified")
    if not date_str:
        return 0.5
    try:
        d = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
    except ValueError:
        try:
            d = datetime.strptime(date_str, "%Y-%m-%d")
        except ValueError:
            return 0.5
    age = (now - d.replace(tzinfo=timezone.utc)).days if d.tzinfo is None else (now - d).days
    if age < 30:
        return 1.0
    if age < 90:
        return 0.9
    if age < 180:
        return 0.8
    if age < max_age_days:
        return 0.7
    return 0.5


def score_primary(source_meta: dict) -> float:
    """Heuristic primary-vs-secondary score 0-1."""
    if source_meta.get("primary"):
        return 1.0
    if source_meta.get("secondary"):
        return 0.3
    return 0.6  # neutral


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[0] == "--self-test":
        return self_test()
    if len(argv) < 1:
        print("Usage: source_evaluator.py <sources.json> [--min-authority 0.6] [--max-age-days 365]", file=sys.stderr)
        return 2

    sources_path = Path(argv[0])
    min_authority = DEFAULT_MIN_AUTHORITY
    max_age = DEFAULT_MAX_AGE_DAYS
    accept_ratio = DEFAULT_ACCEPT_RATIO

    i = 1
    while i < len(argv):
        if argv[i] == "--min-authority" and i + 1 < len(argv):
            min_authority = float(argv[i + 1])
            i += 2
        elif argv[i] == "--max-age-days" and i + 1 < len(argv):
            max_age = int(argv[i + 1])
            i += 2
        elif argv[i] == "--accept-ratio" and i + 1 < len(argv):
            accept_ratio = float(argv[i + 1])
            i += 2
        else:
            i += 1

    data = json.loads(sources_path.read_text(encoding="utf-8"))
    sources = data.get("sources", [])
    now = datetime.now(timezone.utc)

    scored = []
    for s in sources:
        url = s.get("url", "")
        meta = {k: v for k, v in s.items() if k != "url"}
        a = score_authority(url, meta)
        f = score_freshness(meta, max_age, now)
        p = score_primary(meta)
        # Composite: 0.5 * authority + 0.3 * freshness + 0.2 * primary
        composite = 0.5 * a + 0.3 * f + 0.2 * p
        passes = a >= min_authority and f >= 0.5
        scored.append({
            "url": url,
            "title": s.get("title", ""),
            "authority": round(a, 3),
            "freshness": round(f, 3),
            "primary": round(p, 3),
            "composite": round(composite, 3),
            "passes": passes,
        })

    accepted = sum(1 for s in scored if s["passes"])
    ratio = accepted / max(len(scored), 1)
    ok = ratio >= accept_ratio

    result = {
        "ok": ok,
        "thresholds": {
            "min_authority": min_authority,
            "max_age_days": max_age,
            "accept_ratio": accept_ratio,
        },
        "stats": {
            "total": len(scored),
            "accepted": accepted,
            "rejected": len(scored) - accepted,
            "ratio": round(ratio, 3),
        },
        "sources": scored,
    }

    # MEDIUM-4: mask any secret/PII values that leaked into source metadata
    # (titles, echoed content) before printing the report.
    out = json.dumps(result, indent=2)
    if redact_secrets:
        out = redact_secrets(out)
    print(out)
    return 0 if ok else 1


def self_test():
    """Run a quick self-test on a fabricated source list."""
    sources = {
        "sources": [
            {"url": "https://arxiv.org/abs/2605.23899", "date": "2026-06-01", "primary": True, "title": "SkillLens"},
            {"url": "https://github.com/foo/bar", "official": True, "date": "2026-05-01", "title": "Official repo"},
            {"url": "https://en.wikipedia.org/wiki/X", "date": "2026-07-01", "title": "Wikipedia article"},
            {"url": "https://nytimes.com/article", "date": "2026-07-15", "title": "NYTimes article"},
        ]
    }
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(sources, f)
        sp = f.name
    code = main([sp])
    Path(sp).unlink()
    print(f"\nself-test: exit={code} (expected 0 — 4 sources, all above 0.6 authority)")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
