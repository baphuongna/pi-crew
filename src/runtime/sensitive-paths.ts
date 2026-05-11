/**
 * Sensitive file detection for worker constraints.
 *
 * Inspired by caveman's compress.py — prevents workers from reading
 * or compressing files that contain secrets, credentials, or PII.
 *
 * Workers should refuse operations on matching paths. This is enforced
 * in the worker prompt and validated here for defense-in-depth.
 */

import * as path from "node:path";

/** Basenames that almost certainly hold secrets or PII */
const SENSITIVE_BASENAMES = /\.(?:env|pem|key|p12|pfx|crt|cer|jks|keystore|asc|gpg)(?:\..+)?$/i;
const SENSITIVE_EXACT = /^(?:\.env|\.netrc|\.npmrc|\.pypirc|credentials|secrets?|passwords?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|authorized_keys|known_hosts|jwt\.json|session\.cookie|\.token)$/i;

/** Path components that indicate sensitive directories */
const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config/gcloud", ".config/gh"]);

/** Name tokens that suggest sensitive content */
const SENSITIVE_TOKENS = ["secret", "credential", "password", "passwd", "apikey", "accesskey", "token", "privatekey"];

/**
 * Check if a file path looks like it contains sensitive data.
 * Returns true if the path should be refused for worker operations.
 */
export function isSensitivePath(filePath: string): boolean {
	const resolved = path.resolve(filePath);
	const basename = path.basename(resolved);
	const lower = basename.toLowerCase();

	// Check exact sensitive filenames
	if (SENSITIVE_EXACT.test(basename)) return true;

	// Check sensitive extensions
	if (SENSITIVE_BASENAMES.test(basename)) return true;

	// Check path components
	const parts = resolved.split(/[/\\]/).map((p) => p.toLowerCase());
	for (const dir of SENSITIVE_DIRS) {
		const dirParts = dir.split("/");
		for (let i = 0; i <= parts.length - dirParts.length; i++) {
			const slice = parts.slice(i, i + dirParts.length);
			if (slice.join("/") === dir) return true;
		}
	}

	// Check name tokens with word-boundary awareness to reduce false positives.
	// Strategy: split filename on separators to get "words", then check if
	// any token matches. For substring matching in the normalized form,
	// we require the token to end at a segment boundary or string end.
	// This matches 'secret', 'secrets' but NOT 'secretary'.
	const words = lower.split(/[_\-\s.\W]+/).filter(Boolean);
	const normalized = lower.replace(/[_\-\s.]/g, "");
	for (const token of SENSITIVE_TOKENS) {
		// Check individual words — exact match or token is prefix and word is <= token+2 chars
		for (const word of words) {
			if (word === token) return true;
			// 'secrets' starts with 'secret' and is only 1 char longer → match
			// 'secretary' starts with 'secret' but is 4 chars longer → no match
			if (word.startsWith(token) && word.length <= token.length + 2) return true;
		}
		// Check fully-normalized form for compound tokens like 'api-key' → 'apikey'
		// The token must appear as a complete segment (not a partial substring).
		// After the token, the remaining chars must be a complete word (extension).
		const idx = normalized.indexOf(token);
		if (idx !== -1) {
			const after = idx + token.length;
			if (after === normalized.length) return true;
			// Check if remaining chars after token correspond to a known word segment
			const remaining = normalized.slice(after);
			if (words.some((w) => remaining === w || remaining.startsWith(w))) return true;
		}
	}

	return false;
}

/**
 * Build a worker prompt constraint block listing forbidden paths.
 * This goes into the worker system prompt to prevent accidental reads.
 */
export function buildSensitivePathConstraint(): string {
	return [
		"## Security Constraints",
		"NEVER read, compress, or include content from:",
		"- Files matching: .env*, *.pem, *.key, *.p12, credentials*, secrets*, passwords*, id_rsa*",
		"- Directories: .ssh/, .aws/, .gnupg/, .kube/, .docker/",
		"- Files with names containing: secret, credential, password, apikey, token, privatekey",
		"If asked to read such a file, refuse and explain the security risk.",
	].join("\n");
}
