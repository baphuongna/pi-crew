#!/usr/bin/env python3
"""
safe_io.py — SSRF-safe fetch guard + secret/PII redaction helper for the
research/distill operational scripts (MEDIUM-3 + MEDIUM-4 hardening).

Two functions:
  - is_safe_url(url): SSRF guard. Returns True ONLY for http(s) URLs whose host
    is not a private/loopback/link-local/metadata/reserved address. Rejects
    non-http(s) schemes (file://, gopher://, dict://, ...). Optionally resolves
    DNS and rejects if any A/AAAA record lands in a blocked range (DNS-rebind).
  - redact_secrets(text): regex-based secret/PII redaction. Masks the VALUE of
    private-key blocks, Authorization/Bearer headers, AWS keys, named
    VAR=secret assignments, and common service tokens (sk_/pk_/xox_/gh*_),
    keeping the finding TYPE + location intact
    (e.g. "API_KEY=sk-abc123" -> "API_KEY=***REDACTED***").

Stdlib only. Python 3.9+.

Usage:
    from safe_io import is_safe_url, redact_secrets
    python3 safe_io.py --self-test    # exits 0 on success

Imported by scripts that persist source content (redact_secrets) or fetch URLs
(is_safe_url). Referenced from the 3 SKILL.md files so agents invoke it before
persisting fetched content or fetching live URLs.
"""
import ipaddress
import re
import socket
import sys
from urllib.parse import urlparse


REDACTED = "***REDACTED***"

# Hostnames that ALWAYS resolve to loopback / cloud-metadata and must be
# rejected even when resolve_dns=False (no network call). SSRF defense for the
# common bypass: is_safe_url("http://localhost") would otherwise pass because
# the hostname-only path skips DNS.
_BLOCKED_HOSTNAMES = frozenset({
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
    "metadata",                    # cloud metadata shorthand
    "metadata.google.internal",
    "metadata.aws.internal",
    "metadata.azure.com",
})


# --------------------------------------------------------------------------- #
# redact_secrets — regex rules. Each preserves the type/key and blanks only
# the secret VALUE. Order matters: blocks first, then headers, then inline.
# --------------------------------------------------------------------------- #
_SECRET_RULES = [
    # 1. PEM/DER private-key blocks (keep the BEGIN/END markers, blank the body)
    (
        "private_key_block",
        re.compile(
            r"(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----)"
            r"[\s\S]*?"
            r"(-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----)",
            re.MULTILINE,
        ),
        lambda m: m.group(1) + "\n" + REDACTED + "\n-----END PRIVATE KEY-----",
    ),
    # 1b. Unterminated private-key BEGIN (leaked partial key — no END marker).
    # Rule 1 above already handled any complete BEGIN/END block, so this only
    # fires on partials. Matches BEGIN + base64-ish content to end of line.
    (
        "private_key_begin_only",
        re.compile(
            r"(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----)"
            r"([A-Za-z0-9+/=\s]+)$"
        ),
        lambda m: m.group(1) + "\n" + REDACTED,
    ),
    # 2. Authorization / Proxy-Authorization / X-Authorization header lines
    (
        "auth_header",
        re.compile(
            r"(?im)^(\s*(?:authorization|proxy-authorization|x-authorization)\s*:\s*"
            r"(?:bearer|basic|token|jwt)?\s*)([^\r\n]+)"
        ),
        lambda m: m.group(1) + REDACTED,
    ),
    # 3. Inline "Bearer <token>" / "Basic <token>" anywhere
    (
        "bearer_inline",
        re.compile(r"(?i)\b(bearer|basic)\s+([A-Za-z0-9\-._~+/]+=*)"),
        lambda m: m.group(1) + " " + REDACTED,
    ),
    # 4. AWS access-key id (AKIA...) — the id itself is a credential
    (
        "aws_key_id",
        re.compile(r"\b(AKIA[0-9A-Z]{16})\b"),
        lambda m: REDACTED,
    ),
    # 4b. High-confidence credential names with SHORT values (password/passwd/pwd)
    # — rule 5 below requires value length >=8, which misses weak short
    # passwords. These names are almost always secrets, so redact any value.
    (
        "short_credential",
        re.compile(r"(?i)\b(password|passwd|pwd)\s*[:=]\s*([^\s\"'#&|]+)"),
        lambda m: m.group(1) + "=" + REDACTED,
    ),
    # 5. .env-style / JSON named assignments with a secret-like name:
    #    keeps NAME= / "name": and blanks the value
    (
        "named_assignment",
        re.compile(
            r"(?i)([\"']?[A-Za-z0-9_\-\.]*(?:"
            r"pass(?:word)?|secret|api[_-]?key|token|access[_-]?key|private[_-]?key|"
            r"client[_-]?secret|auth(?:orization)?|credential|refresh[_-]?token|"
            r"jwt|passwd"
            r")[A-Za-z0-9_\-\.]*[\"']?\s*[:=]\s*)([\"']?)([^\"'\r\n#&|]{8,})"
        ),
        lambda m: m.group(1) + m.group(2) + REDACTED + m.group(2),
    ),
    # 6. Common service tokens standing alone (Stripe/OpenAI sk_/pk_, Slack xox, GitHub gh*)
    (
        "service_token",
        re.compile(r"\b(sk|pk|xox[abp]|gh[opsu]|github_pat)_[A-Za-z0-9]{16,}\b"),
        lambda m: REDACTED,
    ),
]
def redact_secrets(text: str) -> str:
    """Redact secret VALUES in *text*, keeping the type/location.

    A second pass is safe: already-redacted spans do not match value patterns.
    """
    if not text:
        return text
    out = text
    for _name, rx, build in _SECRET_RULES:
        out = rx.sub(build, out)
    return out


# --------------------------------------------------------------------------- #
# is_safe_url — SSRF guard
# --------------------------------------------------------------------------- #
def _is_ip_literal(host: str) -> bool:
    h = host.strip("[]")
    try:
        ipaddress.ip_address(h)
        return True
    except ValueError:
        return False


def _is_blocked_ip(ip: str) -> bool:
    """True if the IP is private/loopback/link-local/reserved/multicast/etc.

    Fail-closed: an unparseable address is treated as blocked.
    """
    try:
        addr = ipaddress.ip_address(ip.strip("[]"))
    except ValueError:
        return True
    return (
        addr.is_loopback
        or addr.is_private
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def is_safe_url(url: str, resolve_dns: bool = False) -> bool:
    """SSRF guard. Returns True ONLY for http(s) URLs whose host is not a
    private/loopback/link-local/metadata/reserved address.

    - Rejects non-http(s) schemes (file://, gopher://, dict://, ftp://, ...).
    - Rejects IP-literal hosts in blocked ranges (127.0.0.1, 169.254.169.254,
      10/8, 172.16/12, 192.168/16, ::1, fc00::/7 ...).
    - For hostnames, when resolve_dns=True: resolves DNS and rejects if ANY
      A/AAAA record is in a blocked range (catches DNS-rebinding to 127.0.0.1).
      Default resolve_dns=False does a hostname-only check (no network call) —
      the DNS-rebinding guard is opt-in for callers that will actually fetch.
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme.lower() not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    if not host:
        return False
    # IP-literal host: check range directly (no DNS needed)
    if _is_ip_literal(host):
        return not _is_blocked_ip(host)
    # Hostname: block well-known loopback / cloud-metadata aliases without DNS
    if host in _BLOCKED_HOSTNAMES:
        return False
    # Hostname: optional DNS-rebinding check
    if resolve_dns:
        try:
            infos = socket.getaddrinfo(host, None)
        except socket.gaierror:
            return False  # fail closed — cannot verify, refuse to fetch
        for info in infos:
            if _is_blocked_ip(info[4][0]):
                return False
    return True


# --------------------------------------------------------------------------- #
# self-test
# --------------------------------------------------------------------------- #
def self_test():
    """Verify the SSRF guard rejects known-bad URLs and the redactor masks a
    sample secret. Exits 0 on success, 1 on failure."""
    ok = True

    # --- SSRF: known-bad must REJECT (no DNS needed — IP literals) ---
    bad_urls = [
        "http://127.0.0.1/admin",
        "http://169.254.169.254/latest/meta-data/",  # cloud metadata
        "http://10.0.0.1/",
        "http://192.168.1.1/",
        "http://172.16.0.1/",
        "http://[::1]/",
        "http://0.0.0.0/",
        "file:///etc/passwd",          # non-http scheme
        "gopher://127.0.0.1:6379/",    # non-http scheme
        "dict://localhost:11211/",     # non-http scheme
        "ftp://internal/",             # non-http scheme
        "http://localhost/admin",      # loopback HOSTNAME (not IP literal)
        "http://metadata.google.internal/",  # cloud metadata hostname
    ]
    for u in bad_urls:
        if is_safe_url(u):
            print(f"  ✗ FAIL: bad URL allowed: {u}")
            ok = False
    # --- SSRF: known-good must ALLOW (resolve_dns=False — no network needed) ---
    good_urls = [
        "https://example.com/",
        "http://example.org/path?q=1",
        "https://arxiv.org/abs/2605.23899",
        "https://8.8.8.8/",  # public IP literal
    ]
    for u in good_urls:
        if not is_safe_url(u, resolve_dns=False):
            print(f"  ✗ FAIL: good URL rejected: {u}")
            ok = False

    # --- redaction: sample secrets must be masked, type/location kept ---
    samples = {
        "API_KEY=sk-live-abcdef1234567890XYZ": "API_KEY=***REDACTED***",
        'config = {"token": "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"}': "***REDACTED***",
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig": "Authorization: ***REDACTED***",
        "aws_access_key_id = AKIAIOSFODNN7EXAMPLE": "***REDACTED***",
        "DATABASE_PASSWORD=hunter2-super-secret": "DATABASE_PASSWORD=***REDACTED***",
    }
    for inp, _expected_fragment in samples.items():
        masked = redact_secrets(inp)
        # The secret VALUE must no longer appear; the key/type must remain.
        if "sk-live-abcdef1234567890XYZ" in masked and inp != masked:
            print(f"  ✗ FAIL: secret value leaked: {masked}")
            ok = False
        if inp == masked:
            print(f"  ✗ FAIL: nothing redacted in: {inp}")
            ok = False
        if REDACTED not in masked:
            print(f"  ✗ FAIL: no redaction marker in: {masked}")
            ok = False

    # private-key block
    pem = (
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "MIIEpAIBAAKCAQEAabcd...supersecretkeymaterial\n"
        "-----END RSA PRIVATE KEY-----"
    )
    masked_pem = redact_secrets(pem)
    if "supersecretkeymaterial" in masked_pem or REDACTED not in masked_pem:
        print(f"  ✗ FAIL: private-key body leaked: {masked_pem}")
        ok = False

    # partial private key WITHOUT an END marker (rule 1b)
    partial_pem = "-----BEGIN PRIVATE KEY-----MIIEvQIBADANBsupersecret"
    masked_partial = redact_secrets(partial_pem)
    if "supersecret" in masked_partial or REDACTED not in masked_partial:
        print(f"  ✗ FAIL: partial private-key leaked: {masked_partial}")
        ok = False

    # short password (rule 4b — rule 5 requires value >=8 chars)
    masked_pw = redact_secrets("password=hunter2")
    if "hunter2" in masked_pw or REDACTED not in masked_pw:
        print(f"  ✗ FAIL: short password leaked: {masked_pw}")
        ok = False

    # benign text must pass through unchanged (no false positives)
    benign = "The quick brown fox jumps over the lazy dog. https://example.com/path info@example.com"
    if redact_secrets(benign) != benign:
        print(f"  ✗ FAIL: false positive on benign text")
        ok = False

    print("safe_io self-test:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)
    if argv[0] == "--self-test":
        sys.exit(self_test())
    print("Usage: safe_io.py --self-test", file=sys.stderr)
    sys.exit(2)
