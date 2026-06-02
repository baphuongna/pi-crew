/**
 * Safe Bash Tool for pi-crew
 * Wraps bash with dangerous command blocking
 * Uses linear-time scanning to prevent ReDoS attacks
 */

import { Type } from "@sinclair/typebox";

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
 * Replaces O(n²) regex backtracking with O(n) string scanning
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
			// Found "rm " - now check for -rf flags followed by / or ~
			let p = afterRm + 1;
			while (p < len) {
				// Skip whitespace
				while (p < len && /\s/.test(command[p])) p++;
				if (p >= len) break;
				// Check for flag
				if (command[p] !== "-") break;
				p++;
				let hasR = false, hasF = false;
				while (p < len && /[a-zA-Z]/.test(command[p])) {
					if (command[p] === "r" || command[p] === "R") hasR = true;
					if (command[p] === "f" || command[p] === "F") hasF = true;
					p++;
				}
				if (!hasR && !hasF) break; // Flag must have r or f
				// Skip whitespace after flag
				while (p < len && /\s/.test(command[p])) p++;
			}
			// Now check if followed by / or ~ (end or whitespace)
			if (p < len && (command[p] === "/" || command[p] === "~")) {
				const afterSlash = p + 1;
				if (afterSlash >= len || /\s/.test(command[afterSlash]) || command[afterSlash] === ";") {
					return true; // Dangerous!
				}
			}
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

	// Normalize: remove line continuations, collapse whitespace
	const normalized = command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();

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
	// Block command substitution $(...)
	if (/\$\([^)]*\)/.test(command)) {
		return "Command blocked by safe_bash: command substitution $(...) is not allowed";
	}
	// Block backtick substitution
	const backtickRe = /`[^`]*`/;
	if (backtickRe.test(command)) {
		return "Command blocked by safe_bash: backtick substitution is not allowed";
	}
	// Block here-docs <<
	if (/<<\s*['"]?[\w-]+['"]?/.test(command) || /\$<<\s*['"]?[\w-]+['"]?/.test(command)) {
		return "Command blocked by safe_bash: here-doc is not allowed";
	}
	// Block ${...} variable expansion containing shell metacharacters (pipes, redirects, &&/||)
	const varExpRe = /\$\{([^}]*)\}/;
	const varMatch = command.match(varExpRe);
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