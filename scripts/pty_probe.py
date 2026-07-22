#!/usr/bin/env python3
"""pty_probe.py — bulk-key + diag probe for pi-crew TUI components.

Spawns a real `pi` session under a pty, sends a sequence of keys with
short sleeps, captures the resulting output. Useful for verifying that
keystrokes reached the component's handleInput after a ui/ change.

Requires Python 3.x on PATH. On Linux only (uses Unix-only `pty.fork`).

Usage:
    python3 scripts/pty_probe.py [--keys j,k,q] [--cwd /path/to/repo]

Env:
    PI_CREW_BROKER_DIAG_UI=1   enable diag stderr writes from run-dashboard
    PI_CREW_BROKER_DIAG_KEYS=1 capture per-keystroke data lines to stderr

Examples:
    # Default probe (vim nav + arrow keys + quit)
    python3 scripts/pty_probe.py

    # Custom probe: only arrow keys
    python3 scripts/pty_probe.py --keys '\x1bOA,\x1bOB,\x1bOC,\x1bOD,q,q'

    # Capture to a file
    python3 scripts/pty_probe.py 2>&1 | tee /tmp/diag.log
"""
import argparse
import os
import pty
import sys
import time


# Default key sequence — exercises the dispatch path:
#   j, j, k       — vim-style nav (j down, k up) in run-dashboard
#   \x1b[A, \x1b[B — legacy CSI arrow up/down
#   \x1bOA, \x1bOB — app-cursor-mode arrow up/down
#   q, q          — quit (double-tap, matches the SettingsOverlay close binding)
DEFAULT_KEYS = [
    "j", "j", "k",
    "\x1b[A", "\x1b[B",
    "\x1bOA", "\x1bOB",
    "q", "q",
]

# Per-key sleep — long enough for the TUI to process each input.
DEFAULT_PER_KEY_SLEEP_S = 0.3

# Initial sleep after `pi` spawn — let the TUI render before first keystroke.
DEFAULT_STARTUP_SLEEP_S = 2.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--keys",
        default=",".join(DEFAULT_KEYS),
        help="Comma-separated sequence of keys to send (default: vim nav + arrow + quit)",
    )
    parser.add_argument(
        "--cwd",
        default=os.getcwd(),
        help="Working directory for the spawned pi process",
    )
    parser.add_argument(
        "--per-key-sleep",
        type=float,
        default=DEFAULT_PER_KEY_SLEEP_S,
        help=f"Sleep between keys (default {DEFAULT_PER_KEY_SLEEP_S}s)",
    )
    parser.add_argument(
        "--startup-sleep",
        type=float,
        default=DEFAULT_STARTUP_SLEEP_S,
        help=f"Initial sleep after pi spawn (default {DEFAULT_STARTUP_SLEEP_S}s)",
    )
    parser.add_argument(
        "--read-chunk",
        type=int,
        default=65536,
        help="Read chunk size in bytes (default 65536)",
    )
    args = parser.parse_args()

    keys = [k for k in args.keys.split(",") if k]

    env = {**os.environ, "PI_CREW_BROKER_DIAG_UI": "1"}

    pid, fd = pty.fork()
    if pid == 0:
        # Child: exec `pi` in the requested cwd.
        os.chdir(args.cwd)
        os.execvpe("pi", ["pi"], env)
        # execvpe never returns on success.
        os._exit(127)

    # Parent: send keys with sleeps, then dump final screen.
    try:
        time.sleep(args.startup_sleep)
        for k in keys:
            os.write(fd, k.encode())
            time.sleep(args.per_key_sleep)
        time.sleep(args.startup_sleep)
        sys.stdout.write(os.read(fd, args.read_chunk).decode(errors="replace"))
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
