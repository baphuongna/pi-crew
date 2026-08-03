# Security Audit Report — pi-crew

**Document Version:** 1.0  
**Date:** 2026-05-25  
**Auditor:** Security Reviewer  
**Scope:** pi-crew v0.3.8 (original audit) — findings verified fixed through v0.5.22  

---

## Executive Summary

pi-crew is a TypeScript-based multi-agent orchestration framework for coordinated AI teams. This security audit reviews the codebase for vulnerabilities defined in the OWASP Top 10 (LLM Applications), STRIDE threat model, and industry best practices.

### Overall Security Posture: **GOOD — With Minor Issues**

The codebase demonstrates strong security awareness with comprehensive fixes for previously identified critical vulnerabilities. However, **8 dependency vulnerabilities** remain unpatched in the supply chain that should be addressed.

| Category | Status |
|----------|--------|
| **Agent System Security** | ✅ SEC-001/002/004 Fixed |
| **Skill Loading Security** | ✅ SEC-003 Fixed |
| **Discovery Cache Integrity** | ✅ SEC-005 Fixed |
| **Workflow Task Injection** | ✅ SEC-007 Fixed |
| **Dependency Vulnerabilities** | ⚠️ 8 unpatched (4 moderate, 4 high) |
| **Secret Protection** | ✅ Comprehensive |
| **Path Traversal Prevention** | ✅ Robust |

---

## Methodology

This audit follows OWASP and STRIDE threat modeling methodology:

### OWASP Top 10 (LLM Applications)
- **LLM01:** Prompt Injection
- **LLM02:** Insecure Output Handling
- **LLM03:** Training Data Poisoning
- **LLM04:** Model Denial of Service
- **LLM05:** Supply Chain Vulnerabilities
- **LLM06:** Sensitive Information Disclosure
- **LLM07:** Insecure Plugin Design
- **LLM08:** Excessive Agency
- **LLM09:** Overreliance
- **LLM10:** Model Theft

### STRIDE Threat Categories
- **S**poofing
- **T**ampering
- **R**epudiation
- **I**nformation Disclosure
- **D**enial of Service
- **E**levation of Privilege

---

## ✅ SECURE — Verified Fixes

### SEC-001 — Dynamic Agent Shadowing Prevention ✅
**Status:** Fixed  
**Severity:** 🔴 CRITICAL  
**Type:** STRIDE: Elevation of Privilege  

**What was fixed:**
- Added `PROTECTED_AGENT_NAMES` blocklist (exact match) for builtin agents
- Added `PROTECTED_AGENT_PATTERNS` blocklist (regex) for typo-squatting prevention
- Implemented `assertAgentNameAllowed()` with security event logging
- Changed dynamic agent source to `"dynamic"` (cannot be spoofed as "project")
- Dynamic agents now only fill gaps — cannot override builtin/user agents

**Verification:**
```typescript
// src/agents/discover-agents.ts:48-79
const PROTECTED_AGENT_NAMES = new Set([
    "executor", "test-engineer", "explorer", "planner",
    "analyst", "critic", "reviewer", "verifier", "writer",
    "security-reviewer",
]);

const PROTECTED_AGENT_PATTERNS: Array<{ pattern: RegExp; example: string }> = [
    { pattern: /^executor[-_]?v?[0-9]/i, example: "executor-v2" },
    { pattern: /^exec[au]t[o0]r$/i, example: "execator" },  // Typo-squatting
    // ... more patterns
];
```

**Tests verified:** `test/unit/security-hardening.test.ts`

---

### SEC-002 — Agent Prompt Injection Prevention ✅
**Status:** Fixed  
**Severity:** 🔴 HIGH  
**Type:** STRIDE: Injection  

**What was fixed:**
- Implemented `sanitizeAgentSystemPrompt()` with OWASP Agent Memory Guard patterns
- Trust levels: builtin (minimal), user (standard), project (strict)
- Strips zero-width Unicode, HTML comments, prompt injection directives
- Strips base64/hex-encoded command payloads
- Strips embedded instruction patterns in brackets

**Verification:**
```typescript
// src/agents/discover-agents.ts:187-247
export function sanitizeAgentSystemPrompt(
    content: string,
    source: ResourceSource
): string {
    const trustLevel = sourceToTrustLevel(source);
    let sanitized = content;
    
    // 1. Strip zero-width and invisible Unicode characters
    sanitized = sanitized.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, "");
    
    // 2. Strip HTML/JS comments (instruction hiding)
    sanitized = sanitized.replace(/<!--[\s\S]*?-->|<\/?script[^>]*>/gi, "");
    
    // 3. Strip known prompt injection directive patterns
    if (trustLevel !== "builtin") {
        sanitized = sanitized.replace(
            /^\s*(?:SYSTEM|INSTRUCTION|IGNORE(?:\s+ALL)?\s+(?:PREVIOUS|INSTRUCTIONS)?|OVERRIDE|YOUR\s+ROLE\s+IS|MALICIOUS|BACKDOOR)\s*:.*$/gim,
            ""
        );
        // ... more sanitization
    }
    // ...
}
```

**Tests verified:** `test/unit/security-hardening.test.ts`

---

### SEC-003 — Skill Injection Prevention ✅
**Status:** Fixed  
**Severity:** 🔴 HIGH  
**Type:** STRIDE: Injection  

**What was fixed:**
- Reversed skill search order: package skills now checked FIRST, project second
- Added security warnings in skill instructions for project-sourced content
- Project skills are clearly labeled as UNTRUSTED in worker prompts

**Verification:**
```typescript
// src/runtime/skill-instructions.ts:161-167
function candidateSkillDirs(cwd: string): Array<{ root: string; source: "project" | "package" }> {
    return [
        { root: PACKAGE_SKILLS_DIR, source: "package" },   // ✓ Trusted first
        { root: path.resolve(cwd, "skills"), source: "project" },  // ⚠️ Override second
    ];
}
```

**Tests verified:** `test/unit/skill-instructions.test.ts`

---

### SEC-004 — Dynamic Agent Source Misattribution ✅
**Status:** Fixed  
**Severity:** 🟡 MEDIUM  
**Type:** STRIDE: Spoofing  

**What was fixed:**
- Dynamic agents now default to `source: "dynamic"` instead of `"project"`
- Security tooling can now distinguish runtime-registered agents from file-based sources

**Verification:**
```typescript
// src/agents/discover-agents.ts:456-458
dynamicAgents.set(key, {
    ...config,
    source: "dynamic",  // Always "dynamic" — cannot be spoofed
});
```

---

### SEC-005 — Discovery Cache Race Condition ✅
**Status:** Fixed  
**Severity:** 🟡 MEDIUM  
**Type:** STRIDE: Denial of Service  

**What was fixed:**
- Implemented version-based atomic cache invalidation
- Added `cacheVersion` global counter incremented on every mutation
- Cache entries stamped with version; stale entries pruned on access

**Verification:**
```typescript
// src/agents/discover-agents.ts:26-38
let cacheVersion = 0;

export function getCacheVersion(): number {
    return cacheVersion;
}

function incrementCacheVersion(): void {
    cacheVersion++;
}
```

**Tests verified:** `test/unit/discovery-cache-version.test.ts`

---

### SEC-007 — Workflow Step Task Injection ✅
**Status:** Fixed  
**Severity:** 🟡 LOW  
**Type:** STRIDE: Injection  

**What was fixed:**
- Implemented `sanitizeTaskText()` for workflow step task content
- Applied sanitization in `buildTaskPacket()` before task text insertion

**Verification:**
```typescript
// src/runtime/task-packet.ts:18-47
export function sanitizeTaskText(task: string): string {
    let sanitized = task;
    
    // 1. Strip zero-width and invisible Unicode characters
    sanitized = sanitized.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, "");
    
    // 2. Strip known prompt injection directive patterns
    sanitized = sanitized.replace(
        /^\s*(?:SYSTEM|INSTRUCTION|IGNORE(?:\s+ALL)?\s+INSTRUCTIONS|OVERRIDE|YOUR\s+ROLE\s+IS|MALICIOUS)\s*:.*$/gim,
        ""
    );
    
    // 3. Strip base64/hex encoded command payloads
    sanitized = sanitized.replace(/\b(base64|base32|hex)\s*['":]\s*([A-Za-z0-9+\/=]{20,})/gi, "[encoded-redacted]");
    
    // ... more sanitization
    return sanitized.trim();
}
```

**Tests verified:** `test/unit/task-packet-sanitize.test.ts`

---

## 🟡 MEDIUM — Additional Security Measures Verified

### Path Traversal Prevention ✅
**Files:** `src/utils/safe-paths.ts`

pi-crew implements robust path traversal prevention:

```typescript
export function resolveContainedPath(baseDir: string, targetPath: string): string {
    const base = path.resolve(baseDir);
    const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(base, targetPath);
    const relative = path.relative(base, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Path is outside ${baseDir}: ${targetPath}`);
    }
    return resolved;
}
```

**Tests verified:** `test/unit/task-output-context-security.test.ts`

---

### Secret Redaction ✅
**Files:** `src/utils/redaction.ts`

Comprehensive secret protection with redaction patterns:

```typescript
const SECRET_KEY_PATTERN = /(?:^|[_.-])(token|api[-_]?key|password|passwd|secret|credential|authorization|private[-_]?key)(?:$|[_.-])/i;
const INLINE_SECRET_PATTERN = /(^|[\s,{])(([A-Za-z0-9_.-]*(?:api[-_]?key|token|password|...)[A-Za-z0-9_.-]*)\s*[=:]\s*)([^\s,;"'}]+)/gi;
const AUTH_HEADER_PATTERN = /\b(Authorization\s*:\s*(?:Bearer|Basic|Token)?\s*)([^\r\n]+)/gi;
const BEARER_PATTERN = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})\b/g;
const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,65536}?-----END [A-Z ]*PRIVATE KEY-----/g;
```

**Tests verified:** `test/unit/redaction-transcript-roundtrip.test.ts`

---

### Sensitive Path Detection ✅
**Files:** `src/runtime/sensitive-paths.ts`

Workers are prevented from accessing sensitive files:

```typescript
const SENSITIVE_BASENAMES = /\.(?:env|pem|key|p12|pfx|crt|cer|jks|keystore|asc|gpg)(?:\..+)?$/i;
const SENSITIVE_EXACT = /^(?:\.env|\.netrc|\.npmrc|\.pypirc|credentials|secrets?|...)$/i;
const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config/gcloud", ".config/gh"]);
```

**Tests verified:** `test/unit/sensitive-paths.test.ts`

---

### File Permission Security ✅
**Files:** `src/runtime/subagent-manager.ts`

Sensitive files are written with owner-only permissions:

```typescript
// SECURITY: Restrict permissions to owner-only (rw-------).
// On multi-user systems, other users must not read task prompts.
fs.writeFileSync(filePath, `${JSON.stringify(...)}\n`, { mode: 0o600 });
```

---

### Config Trust Boundary ✅
**Files:** `src/config/config.ts`

Project configs cannot override sensitive user settings:

```typescript
// User/global config is authoritative for sensitive settings
// Project config warnings are logged when overrides are attempted
```

**Tests verified:** `test/unit/security-hardening.test.ts`

---

## ⚠️ HIGH — Dependency Vulnerabilities (Fix Required)

### Dependency Audit Summary

```bash
$ npm audit
# npm audit report

8 vulnerabilities (4 moderate, 4 high)
```

| Package | Severity | Vulnerability | Fix Available |
|---------|----------|--------------|--------------|
| `@protobufjs/utf8` | Moderate | Overlong UTF-8 decoding | `npm audit fix` |
| `basic-ftp` | High | Unbounded multiline response buffering | `npm audit fix` |
| `brace-expansion` | Moderate | DoS via large numeric range | `npm audit fix` |
| `fast-uri` | High | Path traversal via percent-encoded dots | `npm audit fix` |
| `fast-uri` | High | Host confusion via percent-encoded authority | `npm audit fix` |
| `fast-xml-builder` | High | Attribute value quote bypass | `npm audit fix` |
| `fast-xml-builder` | High | Comment value regex bypass | `npm audit fix` |
| `ip-address` | Moderate | XSS in Address6 HTML-emitting methods | `npm audit fix` |
| `protobufjs` | High | Code injection via bytes field defaults | `npm audit fix` |
| `protobufjs` | High | Denial of service via crafted field names | `npm audit fix` |
| `protobufjs` | High | Prototype injection in generated code | `npm audit fix` |
| `ws` | Moderate | Uninitialized memory disclosure | `npm audit fix` |

### Recommended Action

```bash
# Review before applying auto-fix
npm audit fix --dry-run

# Apply fixes
npm audit fix

# If issues remain, consider updating package versions directly
npm update @protobufjs/utf8 protobufjs basic-ftp fast-uri fast-xml-builder brace-expansion ip-address ws
```

### Risk Assessment

Most of these vulnerabilities are in transitive dependencies used by peer packages (e.g., `pi-agent-core`). The actual exploitability depends on whether pi-crew directly uses the vulnerable code paths:

| Vulnerability | Direct Usage Risk |
|--------------|-------------------|
| `protobufjs` | Low — used transitively via AI SDKs |
| `fast-uri` | Low — URL parsing edge cases |
| `basic-ftp` | Low — FTP features unlikely to be used |
| `ws` | Moderate — WebSocket usage should be verified |

---

## Verification Evidence

### Security Test Suite Coverage

| Test File | Coverage |
|-----------|----------|
| `test/unit/security-hardening.test.ts` | Agent shadowing, source attribution, config trust |
| `test/unit/discovery-cache-version.test.ts` | Cache race condition fixes |
| `test/unit/task-output-context-security.test.ts` | Path traversal prevention |
| `test/unit/redaction-transcript-roundtrip.test.ts` | Secret redaction |
| `test/unit/sensitive-paths.test.ts` | Sensitive path detection |
| `test/unit/skill-instructions.test.ts` | Skill loading order |
| `test/unit/task-packet-sanitize.test.ts` | Workflow task sanitization |
| `test/unit/api-artifact-security.test.ts` | Artifact path validation |
| `test/unit/run-import-security.test.ts` | Import path validation |
| `test/unit/cwd-override-security.test.ts` | CWD override security |

---

## STRIDE Threat Analysis

| Threat | Mitigations in Place | Residual Risk |
|--------|---------------------|--------------|
| **Spoofing** | Agent source tracking, protected names blocklist | Low |
| **Tampering** | Path traversal prevention, artifact validation | Low |
| **Repudiation** | Security event logging, `logSecurityEvent()` | Low |
| **Information Disclosure** | Secret redaction, sensitive path detection | Low |
| **Denial of Service** | Version-based cache, graceful error handling | Low |
| **Elevation of Privilege** | Protected agent names, role permissions | Low |

---

## Recommendations

### Priority 1: Patch Dependencies

```bash
npm audit fix
```

### Priority 2: Add SecurityWebhook Integration

Currently, `logSecurityEvent()` only logs to console. Consider integrating with a SIEM:

```typescript
// TODO: In production, integrate with project's logging infrastructure
function logSecurityEvent(event: SecurityEvent): void {
    // Send to SIEM, log aggregator, or security webhook
    await sendToSecurityWebhook(event);
}
```

### Priority 3: Consider Trusted Mode

Similar to `claw-code`'s `trusted=True` mode, consider adding environment-based security gates for sensitive operations.

### Priority 4: OWASP Agent Memory Guard Integration

Consider adopting the [OWASP Agent Memory Guard](https://github.com/OWASP/www-project-agent-memory-guard) library for enhanced prompt injection detection:

```typescript
import { MemoryGuard, TrustLevel } from 'agent-memory-guard';

const guard = new MemoryGuard({ rulesPath: 'owasp_asi06_rules.yaml' });
const result = guard.validate(rawSystemPrompt, TrustLevel.UNTRUSTED);
```

---

## Conclusion

pi-crew has undergone significant security hardening since the initial vulnerability discovery. The major agent shadowing and prompt injection vulnerabilities have been addressed with:

- ✅ Comprehensive blocklists for protected agent names
- ✅ Pattern-based detection for typo-squatting attempts
- ✅ Sanitization of agent prompts, skills, and workflow tasks
- ✅ Robust path traversal prevention
- ✅ Secret redaction at all persistence boundaries
- ✅ Version-based atomic cache invalidation
- ✅ Security event logging for audit trails

The **only remaining high-priority item** is the dependency vulnerability audit, which should be addressed by running `npm audit fix`.

**Deploy Risk: LOW** — The codebase is safe for production use with the dependency fixes applied.

---

## References

- [OWASP Agent Security for LLM Applications](https://github.com/OWASP/www-project-agent-security-for-llm-applications)
- [OWASP LLM Top 10](https://owasp.org/www-project-llm-top-10/)
- [MITRE ATLAS](https://atlas.mitre.org/)
- [STRIDE Threat Modeling](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-stride)
- [SECURITY-ISSUES.md](./SECURITY-ISSUES.md) — Detailed vulnerability documentation

---

*This audit was conducted on 2026-05-25. Security posture should be reviewed regularly, especially after dependency updates or significant code changes.*
