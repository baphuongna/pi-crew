export interface ParsedFrontmatter {
	frontmatter: Record<string, string>;
	body: string;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
		return { frontmatter: {}, body: content };
	}

	const normalized = content.replaceAll("\r\n", "\n");
	const end = normalized.indexOf("\n---\n", 4);
	if (end === -1) {
		// Support frontmatter that ends at EOF without trailing newline after ---.
		const altEnd = normalized.indexOf("\n---", 4);
		if (altEnd !== -1 && altEnd + 4 === normalized.length) {
			const raw = normalized.slice(4, altEnd);
			const frontmatter = parseLines(raw);
			return { frontmatter, body: "" };
		}
		return { frontmatter: {}, body: content };
	}

	const raw = normalized.slice(4, end);
	const body = normalized.slice(end + "\n---\n".length);
	const frontmatter = parseLines(raw);
	return { frontmatter, body };
}

function parseLines(raw: string): Record<string, string> {
	const frontmatter: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf(":");
		if (separator === -1) continue;
		const key = trimmed.slice(0, separator).trim();
		let value = trimmed.slice(separator + 1).trim();
		// Strip one pair of symmetric surrounding double quotes so quoted
		// frontmatter values (required by strict YAML when the value contains
		// ": ") behave identically to unquoted ones for every consumer.
		if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
			value = value.slice(1, -1);
		}
		if (key) frontmatter[key] = value;
	}
	return frontmatter;
}

export function parseCsv(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	// Handle quoted values with commas inside.
	const values = splitCsv(value)
		.map((item) => item.trim())
		.filter(Boolean);
	return values.length > 0 ? [...new Set(values)] : undefined;
}

function splitCsv(input: string): string[] {
	const result: string[] = [];
	let current = "";
	let inQuotes = false;
	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (char === '"') {
			inQuotes = !inQuotes;
		} else if (char === "," && !inQuotes) {
			result.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	result.push(current);
	return result;
}
