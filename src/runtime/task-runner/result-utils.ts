export function cleanResultText(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	if (!trimmed) return undefined;
	const doneIndex = trimmed.lastIndexOf("\nDONE\n");
	if (doneIndex >= 0) return trimmed.slice(doneIndex + 1).trim();
	if (trimmed === "DONE" || trimmed.startsWith("DONE\n")) return trimmed;
	const fencedPromptIndex = trimmed.lastIndexOf("</file>");
	if (fencedPromptIndex >= 0 && fencedPromptIndex < trimmed.length - 7) return trimmed.slice(fencedPromptIndex + 7).trim() || trimmed;
	return trimmed;
}

export function isFinalChildEvent(event: unknown): boolean {
	return Boolean(event && typeof event === "object" && !Array.isArray(event) && (event as Record<string, unknown>).type === "message_end");
}
