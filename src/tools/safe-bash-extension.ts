/**
 * Safe Bash Extension for pi-crew
 * Wraps the built-in bash tool with dangerous command blocking
 * 
 * Usage:
 * 1. Enable in config: { "tools": { "bash": { "safeMode": true } } }
 * 2. Or use via agent config: { "extensions": ["path/to/safe-bash-extension.ts"] }
 * 3. Or set env var: PI_CREW_SAFE_BASH=true
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// Dangerous command patterns to block
const DANGEROUS_PATTERNS = [
	// rm -rf on root or home
	/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
	// Privilege escalation
	/\bsudo\b/,
	/\bsu\s+root\b/,
	// Filesystem destruction
	/\bmkfs\b/,
	/\bdd\s+if=/,
	// Fork bomb
	/:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
	// Device writing
	/>\s*\/dev\/[sh]d[a-z]/,
	/\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
	/\bchown\s+(-[a-zA-Z]+\s+)?root/,
	// Pipe to shell (download and execute)
	/\bcurl\s.*\|\s*(ba)?sh/i,
	/\bwget\s.*\|\s*(ba)?sh/i,
	// System shutdown/reboot
	/\bshutdown\b/,
	/\breboot\b/,
	/\binit\s+0\b/,
	// Kill critical processes
	/\bkill\s+-9\s+1\b/,
	/\bkillall\b/,
	// Encoded commands
	/\|\s*base64\s+-d/,
	// Network to shell
	/\bbash\s+-i\s+>\s*\&/,
	// /etc/passwd manipulation
	/\becho\s+.*>\s*\/etc\/passwd/,
];

function isDangerous(command: string): string | null {
	const normalized = command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
	for (const pattern of DANGEROUS_PATTERNS) {
		if (pattern.test(normalized)) {
			return `Command blocked: matches dangerous pattern \`${pattern}\``;
		}
	}
	return null;
}

export default function safeBashExtension(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	const bashTool = createBashTool(cwd);

	pi.registerTool({
		name: "safe_bash",
		label: "Safe Bash",
		description:
			"Execute a bash command safely. Blocks dangerous commands like `rm -rf /`, `sudo`, `curl | sh`, etc.",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (optional)" }),
			),
			description: Type.Optional(
				Type.String({ description: "Description of what this command does (optional)" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const danger = isDangerous(params.command);
			if (danger) {
				return {
					details: {},
					content: [
						{
							type: "text" as const,
							text: `🚫 ${danger}\n\nIf you need to run this command, use the regular 'bash' tool instead, but be careful!`,
						},
					],
				};
			}
			// Safe - delegate to real bash tool
			return bashTool.execute(toolCallId, params, signal, onUpdate);
		},
	});
}