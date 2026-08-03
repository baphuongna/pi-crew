export interface ModelEntry {
	id: string;
	name: string;
	provider: string;
}

/**
 * Core Model interface representing a resolved model instance.
 * Used by resolveModel return type to ensure proper typing.
 */
export interface Model {
	id: string;
	name?: string;
	provider?: string;
	// Allow additional properties from the registry
	[key: string]: unknown;
}

export interface ModelRegistry {
	find(provider: string, modelId: string): Model | undefined;
	getAll(): Model[];
	getAvailable?(): Model[];
}

/**
 * Resolve a model string to a Model instance.
 * Exact match first ("provider/modelId"), then fuzzy match.
 * Returns Model on success, error message string on failure.
 */
export function resolveModel(input: string, registry: ModelRegistry): Model | string {
	const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
	const availableSet = new Set(all.map((m) => `${m.provider}/${m.id}`.toLowerCase()));

	// Exact match
	const slashIdx = input.indexOf("/");
	if (slashIdx !== -1) {
		const provider = input.slice(0, slashIdx);
		const modelId = input.slice(slashIdx + 1);
		if (availableSet.has(input.toLowerCase())) {
			const found = registry.find(provider, modelId);
			if (found) return found;
		}
	}

	// Fuzzy match
	const query = input.toLowerCase();
	let bestMatch: ModelEntry | undefined;
	let bestScore = 0;

	for (const m of all) {
		const id = m.id.toLowerCase();
		const name = m.name.toLowerCase();
		const full = `${m.provider}/${m.id}`.toLowerCase();

		let score = 0;
		if (id === query || full === query) {
			score = 100;
		} else if (id.includes(query) || full.includes(query)) {
			score = 60 + (query.length / id.length) * 30;
		} else if (name.includes(query)) {
			score = 40 + (query.length / name.length) * 20;
		} else if (
			query.split(/[\s\-/]+/).every((part) => id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
		) {
			score = 20;
		}

		if (score > bestScore) {
			bestScore = score;
			bestMatch = m;
		}
	}

	if (bestMatch && bestScore >= 20) {
		const found = registry.find(bestMatch.provider, bestMatch.id);
		if (found) return found;
	}

	const modelList = all
		.map((m) => `  ${m.provider}/${m.id}`)
		.sort()
		.join("\n");
	return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}

export interface SimpleModelEntry {
	id: string;
	name?: string;
	provider: string;
}

/**
 * Fuzzy-match a model query against a flat list of available models.
 * Returns the best-match fullId (provider/id) or undefined.
 */
export function fuzzyResolveModelId(input: string, models: SimpleModelEntry[]): string | undefined {
	const query = input.toLowerCase();
	let bestMatch: SimpleModelEntry | undefined;
	let bestScore = 0;

	for (const m of models) {
		const id = m.id.toLowerCase();
		const name = (m.name ?? "").toLowerCase();
		const full = `${m.provider}/${m.id}`.toLowerCase();

		let score = 0;
		if (id === query || full === query) {
			score = 100;
		} else if (id.includes(query) || full.includes(query)) {
			score = 60 + (query.length / id.length) * 30;
		} else if (name.includes(query)) {
			score = 40 + (query.length / (name.length || 1)) * 20;
		} else if (
			query.split(/[\s\-/]+/).every((part) => id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
		) {
			score = 20;
		}

		if (score > bestScore) {
			bestScore = score;
			bestMatch = m;
		}
	}

	return bestMatch && bestScore >= 20 ? `${bestMatch.provider}/${bestMatch.id}` : undefined;
}
