export type RolePermissionMode = "read_only" | "workspace_write" | "danger_full_access" | "explicit_confirm";

const READ_ONLY_ROLES = new Set(["explorer", "reviewer", "security-reviewer", "verifier", "analyst", "critic", "planner", "writer"]);
const WRITE_ROLES = new Set(["executor", "test-engineer"]);
const READ_ONLY_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "wc", "ls", "find", "grep", "rg", "awk", "sed", "echo", "printf", "which", "where", "whoami", "pwd", "env", "printenv", "date", "df", "du", "uname", "file", "stat", "diff", "sort", "uniq", "tr", "cut", "paste", "test", "true", "false", "type", "readlink", "realpath", "basename", "dirname", "sha256sum", "md5sum", "xxd", "hexdump", "od", "strings", "tree", "jq", "git", "gh"]);

export interface PermissionCheckResult {
	allowed: boolean;
	mode: RolePermissionMode;
	reason?: string;
}

export function permissionForRole(role: string): RolePermissionMode {
	if (READ_ONLY_ROLES.has(role)) return "read_only";
	if (WRITE_ROLES.has(role)) return "workspace_write";
	return "workspace_write";
}

export function isReadOnlyCommand(command: string): boolean {
	const first = command.trim().split(/\s+/)[0]?.split(/[\\/]/).pop() ?? "";
	return READ_ONLY_COMMANDS.has(first) && !/\s(-i|--in-place)\b|\s>{1,2}\s|\brm\b|\bmv\b|\bcp\b|\bnpm\s+install\b|\bgit\s+(commit|push|merge|rebase|reset|checkout)\b/.test(command);
}

export function checkRolePermission(role: string, command: string): PermissionCheckResult {
	const mode = permissionForRole(role);
	if (mode === "read_only" && !isReadOnlyCommand(command)) return { allowed: false, mode, reason: `Role '${role}' is read-only and command may modify state.` };
	return { allowed: true, mode };
}
