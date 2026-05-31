/**
 * Fuzzy config key suggestions — Levenshtein-based typo correction for pi-crew config keys.
 *
 * SECURITY NOTE: The levenshtein() function processes user-supplied input and compares
 * against a known list. While the timing variance across edit distances is minimal
 * and the input is typically config key names (not secrets), there is a theoretical
 * timing attack risk if an attacker could measure response times for different inputs.
 * Risk level: LOW — mitigated by the small alphabet (config key names only) and
 * the fixed-size DP array used in this implementation.
 */

/**
 * Classic Levenshtein edit distance between two strings.
 * See security note above regarding timing attack considerations.
 */
export function levenshtein(a: string, b: string): number {
	const la = a.length;
	const lb = b.length;
	if (la === 0) return lb;
	if (lb === 0) return la;

	// Single-row DP to keep memory O(min(n,m))
	let prev = new Uint32Array(lb + 1);
	let curr = new Uint32Array(lb + 1);

	for (let j = 0; j <= lb; j++) prev[j] = j;

	for (let i = 1; i <= la; i++) {
		curr[0] = i;
		for (let j = 1; j <= lb; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(
				prev[j] + 1,       // deletion
				curr[j - 1] + 1,   // insertion
				prev[j - 1] + cost // substitution
			);
		}
		const swap = prev;
		prev = curr;
		curr = swap;
	}

	return prev[lb];
}

const DEFAULT_MAX_DISTANCE = 3;

/**
 * Find the closest matching key from a list of valid keys.
 * Case-insensitive. Returns null if no match within `maxDistance`.
 */
export function findClosestKey(
	input: string,
	validKeys: readonly string[],
	maxDistance: number = DEFAULT_MAX_DISTANCE,
): string | null {
	if (validKeys.length === 0) return null;

	const lower = input.toLowerCase();
	let bestKey: string | null = null;
	let bestDist = maxDistance + 1;

	for (const key of validKeys) {
		const dist = levenshtein(lower, key.toLowerCase());
		if (dist < bestDist) {
			bestDist = dist;
			bestKey = key;
		}
	}

	return bestDist <= maxDistance ? bestKey : null;
}

/**
 * Convenience wrapper — suggest the closest known config key for a potentially mistyped input.
 */
export function suggestConfigKey(
	input: string,
	knownKeys: readonly string[],
): string | null {
	return findClosestKey(input, knownKeys);
}
