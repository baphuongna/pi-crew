#!/usr/bin/env python3
"""
emit_run_summary.py — borrowed from Geek-skills-deep-research, ported for the
research skill (F13: wired INTO the Agentic Protocol Step 4 finalize).

Emits a wall-clock + token + cost summary at run-end. Reads an event log
(JSONL) and emits a structured summary.

Stdlib only. Python 3.9+.

Usage:
    python3 emit_run_summary.py <log_dir> [--output summary.json]
    python3 emit_run_summary.py --self-test

Exit codes:
    0  summary emitted; no fatal issues
    1  log_dir missing or empty
    2  usage error
"""
import json
import sys
from pathlib import Path
from datetime import datetime, timezone


def parse_iso(ts: str) -> datetime:
    """Parse ISO-8601 timestamps; tolerate Z suffix."""
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    return datetime.fromisoformat(ts)


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[0] == "--self-test":
        return self_test()
    if len(argv) < 1:
        print("Usage: emit_run_summary.py <log_dir> [--output summary.json]", file=sys.stderr)
        return 2

    log_dir = Path(argv[0])
    output_path = None
    force = "--force" in argv
    if len(argv) >= 3 and argv[1] == "--output":
        output_path = Path(argv[2])

    # Find log files (JSONL)
    log_files = []
    if log_dir.is_file() and log_dir.suffix == ".jsonl":
        log_files = [log_dir]
    elif log_dir.is_dir():
        log_files = sorted(log_dir.rglob("*.jsonl"))

    if not log_files:
        print(f"no JSONL logs found in {log_dir}", file=sys.stderr)
        return 1

    events = []
    for log in log_files:
        for line in log.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    if not events:
        print("no events logged", file=sys.stderr)
        return 1

    # Compute summary
    start_times = [parse_iso(e["ts"]) for e in events if e.get("ts")]
    costs = [e.get("cost", 0) for e in events if isinstance(e.get("cost"), (int, float))]
    tokens_in = [e.get("tokens_in", 0) for e in events if isinstance(e.get("tokens_in"), (int, float))]
    tokens_out = [e.get("tokens_out", 0) for e in events if isinstance(e.get("tokens_out"), (int, float))]

    # Categorize events
    by_type = {}
    for e in events:
        t = e.get("type", "unknown")
        by_type[t] = by_type.get(t, 0) + 1

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "log_dir": str(log_dir),
        "log_files": [str(p) for p in log_files],
        "events": {
            "total": len(events),
            "by_type": by_type,
        },
        "wall_clock": {
            "first_event": min(start_times).isoformat() if start_times else None,
            "last_event": max(start_times).isoformat() if start_times else None,
            "duration_seconds": (max(start_times) - min(start_times)).total_seconds() if start_times else 0,
        },
        "tokens": {
            "input_total": sum(tokens_in),
            "output_total": sum(tokens_out),
            "input_events": len(tokens_in),
            "output_events": len(tokens_out),
        },
        "cost": {
            "total": round(sum(costs), 4),
            "events_with_cost": len(costs),
            "average_per_event": round(sum(costs) / max(len(costs), 1), 4),
        },
    }

    out = json.dumps(summary, indent=2)
    if output_path:
        if output_path.exists() and not force:
            print(f"\u274c output exists (use --force to overwrite): {output_path}", file=sys.stderr)
            return 1
        output_path.write_text(out, encoding="utf-8")
    else:
        print(out)

    return 0


def self_test():
    """Run a quick self-test on a fabricated log dir."""
    import tempfile
    with tempfile.TemporaryDirectory() as tmpdir:
        log_path = Path(tmpdir) / "test.jsonl"
        events = [
            {"ts": "2026-07-24T10:00:00+00:00", "type": "research", "tokens_in": 1000, "tokens_out": 500, "cost": 0.01},
            {"ts": "2026-07-24T10:05:00+00:00", "type": "synthesize", "tokens_in": 2000, "tokens_out": 1000, "cost": 0.02},
            {"ts": "2026-07-24T10:10:00+00:00", "type": "finalize", "tokens_in": 500, "tokens_out": 200, "cost": 0.005},
        ]
        log_path.write_text("\n".join(json.dumps(e) for e in events), encoding="utf-8")
        code = main([tmpdir])
    print(f"\nself-test: exit={code} (expected 0)")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
