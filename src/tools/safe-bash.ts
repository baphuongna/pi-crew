/**
 * Safe Bash Tool for pi-crew
 * Wraps bash with dangerous command blocking
 * Uses linear-time scanning to prevent ReDoS attacks
 */

import { logInternalError } from "../utils/internal-error.ts";


// Backward-compatible pattern array (kept for getPatterns API)
// IMPORTANT: Line 8 (rm pattern with nested quantifiers) has been replaced
// with linear-time checking in isDangerous() to prevent ReDoS attacks.
const DANGEROUS_PATTERNS = [
	// NOTE: rm patterns handled by matchesDangerousRm() for linear-time safety
	/\bsudo\b/,
	/\bsu\s+root\b/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/^:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;.*$/,
	/>\s*\/dev\/[sh]d[a-z]/,
	/\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
	/\bchown\s+(-[a-zA-Z]+\s+)?root/,
	/\bcurl\s.*\|\s*(ba)?sh/i,
	/\bwget\s.*\|\s*(ba)?sh/i,
	/\bshutdown\b/,
	/\breboot\b/,
	/\binit\s+0\b/,
	/\bkill\s+-9\s+1\b/,
	/\bkillall\b/,
	/\|\s*base64\s+-d/,
	/\|\s*python.*-c/,
	/\|\s*perl.*-e/,
	/\|\s*ruby.*-e/,
	/\bbash\s+-i\s*>\s*\&/,
	/\bexec\s+.*bash/,
	/\becho\s+.*>\s*\/etc\/passwd/,
	/\bcat\s+.*>\s*\/etc\/passwd/,
];

/**
 * Linear-time check if command contains a dangerous rm pattern like "rm -rf /" or "rm -rf ~"
 * Replaces O(n²) regex backtracking with O(n) string scanning.
 * Expanded to also block: rm -rf /etc/*, rm --recursive --force /, rm -rf ~/.ssh, etc.
 */
function matchesDangerousRm(command: string): boolean {
	let pos = 0;
	const len = command.length;
	// Find "rm" at word boundary
	while (pos < len) {
		const rmIdx = command.indexOf("rm", pos);
		if (rmIdx === -1) return false;
		// Check word boundary before "rm"
		if (rmIdx > 0 && /\w/.test(command[rmIdx - 1])) {
			pos = rmIdx + 1;
			continue;
		}
		// Must be followed by whitespace
		const afterRm = rmIdx + 2;
		if (afterRm >= len || /\s/.test(command[afterRm])) {
			// Found "rm " - now check for recursive/force flags
			let p = afterRm + 1;
			let hasR = false;
			let hasF = false;
			while (p < len) {
				// Skip whitespace
				while (p < len && /\s/.test(command[p])) p++;
				if (p >= len) break;
				// Check for short flags (-r, -f, -rf, -R, -F, etc.)
				if (command[p] === "-" && p + 1 < len && /[a-zA-Z]/.test(command[p + 1]) && command[p + 1] !== "-") {
					p++;
					while (p < len && /[a-zA-Z]/.test(command[p])) {
						if (command[p] === "r" || command[p] === "R") hasR = true;
						if (command[p] === "f" || command[p] === "F") hasF = true;
						p++;
					}
					// Skip whitespace after flag
					while (p < len && /\s/.test(command[p])) p++;
					continue;
				}
				// Check for long flags (--recursive, --force)
				if (command[p] === "-" && p + 1 < len && command[p + 1] === "-") {
					p += 2;
					const flagStart = p;
					while (p < len && /[a-zA-Z]/.test(command[p])) p++;
					const flagName = command.slice(flagStart, p);
					if (flagName === "recursive") hasR = true;
					if (flagName === "force") hasF = true;
					// Skip whitespace after flag
					while (p < len && /\s/.test(command[p])) p++;
					continue;
				}
				// Not a flag — stop parsing flags
				break;
			}
			// Must have both -r and -f (or equivalents) to be dangerous
			if (!hasR || !hasF) {
				pos = rmIdx + 1;
				continue;
			}
			// Now check if followed by dangerous targets
			if (p >= len) {
				pos = rmIdx + 1;
				continue;
			}
			// Block: ~ (home directory references)
			const charAtP = command[p];
			if (charAtP === "~") return true; // Home directory reference
			// Block: / (root or dangerous system paths)
			if (charAtP === "/") {
				// Exact root '/' with nothing after
				if (p + 1 >= len || /\s/.test(command[p + 1]) || command[p + 1] === ";") return true;
				// Block dangerous system paths
				const rest = command.slice(p);
				if (/^\/etc[\/\s;]/.test(rest) || rest === "/etc") return true;
				if ((/^\/var\/(?!tmp)/.test(rest)) || rest === "/var") return true;
				if (/^\/usr[\/\s;]/.test(rest) || rest === "/usr") return true;
				if (/^\/boot[\/\s;]/.test(rest) || rest === "/boot") return true;
				if (/^\/sys[\/\s;]/.test(rest) || rest === "/sys") return true;
				if (/^\/proc[\/\s;]/.test(rest) || rest === "/proc") return true;
				if (/^\/dev[\/\s;]/.test(rest) || rest === "/dev") return true;
				if (/^\/root[\/\s;]/.test(rest) || rest === "/root") return true;
				if (/^\/home[\/\s;]/.test(rest) || rest === "/home") return true;
				// /tmp/ and other non-system absolute paths are allowed
			}
			// Check for sensitive relative paths: .ssh, .gnupg
			const rest = command.slice(p);
			if (/^\.ssh[\/\\\s;]/.test(rest)) return true;
			if (/^\.gnupg[\/\\\s;]/.test(rest)) return true;
		}
		pos = rmIdx + 1;
	}
	return false;
}

/**
 * Linear-time check for fork bomb pattern: :() { ... | ... & ... } ; ...
 */
function matchesForkBomb(command: string): boolean {
	// Must start with :
	const trimmed = command.trimStart();
	if (!trimmed.startsWith(":")) return false;
	// Find () after :
	const parenIdx = trimmed.indexOf("()");
	if (parenIdx === -1 || parenIdx > 10) return false; // : must be close to ()
	// Find { after ()
	const braceIdx = trimmed.indexOf("{", parenIdx);
	if (braceIdx === -1 || braceIdx > parenIdx + 5) return false;
	// Find } closing brace
	const closeBrace = trimmed.indexOf("}", braceIdx);
	if (closeBrace === -1) return false;
	// Check content between braces for | and &
	const content = trimmed.slice(braceIdx + 1, closeBrace);
	if (content.includes("|") && content.includes("&")) return true;
	return false;
}

/**
 * Check for encoded command patterns (pipe to shell)
 */
function matchesEncodedPipe(command: string): boolean {
	const lower = command.toLowerCase();
	const pipeIdx = lower.indexOf("|");
	if (pipeIdx === -1) return false;
	const afterPipe = lower.slice(pipeIdx + 1).trimStart();
	if (afterPipe.startsWith("base64") || afterPipe.startsWith("python") || afterPipe.startsWith("perl") || afterPipe.startsWith("ruby")) {
		// Check if followed by -d or -c or -e
		const rest = afterPipe.slice(6).trimStart();
		if (rest.startsWith("-d") || rest.startsWith("-c") || rest.startsWith("-e")) return true;
	}
	return false;
}

/**
 * Check if command contains a specific dangerous substring
 */
function containsDangerous(command: string, pattern: string): boolean {
	return command.indexOf(pattern) !== -1;
}

/**
 * Check if command starts with dangerous prefix
 */
function startsWithDangerous(command: string, pattern: string): boolean {
	return command.trimStart().startsWith(pattern);
}

export interface SafeBashOptions {
	/** Enable/disable safe mode. Default: true */
	enabled?: boolean;
	/** Additional patterns to block */
	additionalPatterns?: RegExp[];
	// Patterns to allow (overrides blocked). SECURITY WARNING: an overly
	// broad allow pattern (e.g. /.*/) bypasses ALL safety checks including
	// matchesDangerousRm, fork bomb detection, and command-substitution
	// blocking. Callers that accept allowPatterns from user input or
	// project config should validate that patterns are specific enough.
	allowPatterns?: RegExp[];
}

const DEFAULT_ENABLED = true;

/**
 * Check if a command is dangerous
 * @returns Error message if dangerous, null if safe
 */
export function isDangerous(command: string, options: SafeBashOptions = {}): string | null {
	const { enabled = DEFAULT_ENABLED, additionalPatterns = [], allowPatterns = [] } = options;

	if (!enabled) return null;

	// Reject overly permissive allowPatterns that would bypass all safety
	for (const pattern of allowPatterns) {
		if (pattern.source === ".*" || (pattern.test("") && pattern.test("rm -rf /"))) {
			logInternalError("safe-bash.permissive-allow-pattern", new Error(`allowPattern rejects nothing: ${pattern}`));
			throw new Error(`Overly permissive allowPattern rejected: ${pattern}. Use specific patterns only.`);
		}
	}

	// Normalize: strip ANSI escapes and control chars, remove line continuations, collapse whitespace
	const normalized = command
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // strip ANSI escapes
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')  // strip control chars
		.replace(/\\\n/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	// Check allow patterns first (overrides)
	for (const pattern of allowPatterns) {
		if (pattern.test(normalized)) {
			return null; // Explicitly allowed
		}
	}

	// Use linear-time scanning functions for critical patterns
	if (matchesDangerousRm(normalized)) {
		return "Command blocked by safe_bash: dangerous rm pattern detected";
	}
	if (matchesForkBomb(normalized)) {
		return "Command blocked by safe_bash: fork bomb pattern detected";
	}
	if (matchesEncodedPipe(normalized)) {
		return "Command blocked by safe_bash: encoded pipe to shell detected";
	}

	// Check remaining patterns using regex (these are safe from ReDoS)
	for (const pattern of DANGEROUS_PATTERNS) {
		if (pattern.test(normalized)) {
			return `Command blocked by safe_bash: matches dangerous pattern \`${pattern}\``;
		}
	}

	// Additional shell injection checks using regex for non-critical patterns
	// Block command substitution $(...)  — use normalized to prevent $\n(evil) bypass
	// Also match $<space>(...) which is the normalized form of $\n(evil)
	if (/\$\s*\([^)]*\)/.test(normalized)) {
		return "Command blocked by safe_bash: command substitution $(...) is not allowed";
	}
	// Block backtick substitution
	const backtickRe = /`[^`]*`/;
	if (backtickRe.test(normalized)) {
		return "Command blocked by safe_bash: backtick substitution is not allowed";
	}
	// Block here-docs <<
	if (/<<\s*['"]?[\w-]+['"]?/.test(normalized) || /\$<<\s*['"]?[\w-]+['"]?/.test(normalized)) {
		return "Command blocked by safe_bash: here-doc is not allowed";
	}
	// Block ${...} variable expansion containing shell metacharacters
	const varExpRe = /\$\{([^}]*)\}/;
	const varMatch = normalized.match(varExpRe);
	if (varMatch && /[|&;<>]/.test(varMatch[1])) {
		return "Command blocked by safe_bash: variable expansion with shell metacharacters is not allowed";
	}

	// Check additional patterns (user-provided regex)
	for (const pattern of additionalPatterns) {
		if (pattern.test(normalized)) {
			return `Command blocked by safe_bash: matches dangerous pattern \`${pattern}\``;
		}
	}

	return null;
}

/**
 * Validate a bash command before execution
 * Throws if dangerous
 */
export function validateCommand(command: string, options: SafeBashOptions = {}): void {
	const danger = isDangerous(command, options);
	if (danger) {
		throw new Error(danger);
	}
}

/**
 * Create a safe bash tool wrapper
 * Returns an object with validation function and patterns for integration
 */
export function createSafeBash(options: SafeBashOptions = {}) {
	return {
		/**
		 * Validate a command. Throws if dangerous.
		 */
		validate(command: string): void {
			validateCommand(command, options);
		},

		/**
		 * Check if a command is dangerous without throwing
		 */
		check(command: string): string | null {
			return isDangerous(command, options);
		},

		/**
		 * Get all active patterns (for debugging/config display)
		 */
		getPatterns(): { dangerous: RegExp[]; additional: RegExp[]; allow: RegExp[] } {
			return {
				dangerous: [...DANGEROUS_PATTERNS],
				additional: options.additionalPatterns || [],
				allow: options.allowPatterns || [],
			};
		},

		/**
		 * Check if safe mode is enabled
		 */
		isEnabled(): boolean {
			return options.enabled !== false;
		},
	};
}

/**
 * Common safe commands that are often blocked but might be needed
 * These can be used in allowPatterns for specific use cases
 */
export const COMMON_SAFE_PATTERNS = {
	// FIX: Stricter regex — target must be exactly tmp/, cache/, node_modules/, dist/, or build/
	// (with optional ./ prefix). Rejects path traversal (./../../../other) and absolute paths.
	safeRm: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(?:\.\/)?(?:tmp|cache|node_modules|dist|build)\/[a-zA-Z0-9._/-]+$/,
	// Safe git operations
	safeGit: /\bgit\s+(clone|pull|push|commit|add|status|diff|log|branch|checkout|merge|rebase)/,
	// Safe npm/yarn/pnpm
	safePackage: /\b(npm|yarn|pnpm|bun)\s+(install|run|test|build|start|dev)/,
	// Safe file read
	safeRead: /\b(cat|head|tail|less|more|grep|find|ls)\s/,
};

/**
 * Preset configurations for different trust levels
 */
export const SAFE_BASH_PRESETS = {
	/** Maximum security - block everything suspicious */
	strict: {
		enabled: true,
		additionalPatterns: [],
		allowPatterns: [],
	},
	/** Moderate - allow common dev operations */
	development: {
		enabled: true,
		additionalPatterns: [],
		allowPatterns: [COMMON_SAFE_PATTERNS.safePackage],
	},
	/** Minimal - only block catastrophic commands */
	permissive: {
		enabled: true,
		additionalPatterns: [],
		allowPatterns: [
			COMMON_SAFE_PATTERNS.safeRm,
			COMMON_SAFE_PATTERNS.safeGit,
			COMMON_SAFE_PATTERNS.safePackage,
			COMMON_SAFE_PATTERNS.safeRead,
		],
	},
	/** No safety checks */
	disabled: {
		enabled: false,
		additionalPatterns: [],
		allowPatterns: [],
	},
};