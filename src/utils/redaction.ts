const SECRET_KEY_PATTERN = /(?:^|[_.-])(token|api[-_]?key|password|passwd|secret|credential|authorization|private[-_]?key)(?:$|[_.-])/i;
const INLINE_SECRET_PATTERN = /(^|[\s,{])(([A-Za-z0-9_.-]*(?:api[-_]?key|token|password|passwd|secret|credential|authorization|private[-_]?key)[A-Za-z0-9_.-]*)\s*[=:]\s*)([^\s,;"'}]+)/gi;
const AUTH_HEADER_PATTERN = /\b(Authorization\s*:\s*(?:Bearer|Basic|Token)?\s*)([^\r\n]+)/gi;
const BEARER_PATTERN = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})\b/g;
const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSecretKey(keyName: string): boolean {
	return SECRET_KEY_PATTERN.test(keyName) || /^(token|apiKey|api_key|password|secret|credential|authorization|privateKey|private_key)$/i.test(keyName);
}

export function redactSecretString(value: string): string {
	return value
		.replace(PEM_PRIVATE_KEY_PATTERN, "***")
		.replace(AUTH_HEADER_PATTERN, "$1***")
		.replace(BEARER_PATTERN, "$1***")
		.replace(INLINE_SECRET_PATTERN, "$1$2***");
}

export function redactSecrets(value: unknown, keyName = ""): unknown {
	if (keyName && isSecretKey(keyName)) return "***";
	if (typeof value === "string") return redactSecretString(value);
	if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
	if (isRecord(value)) {
		const output: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) output[key] = redactSecrets(entry, key);
		return output;
	}
	return value;
}

export function redactJsonLine(line: string): string {
	try {
		return JSON.stringify(redactSecrets(JSON.parse(line) as unknown));
	} catch {
		return redactSecretString(line);
	}
}
