/**
 * manifest-loader.ts — Helper for loading run manifests during hello.
 *
 * Moved from crew-broker.ts (M4 / WI-4.1) — pure move, no behavior change.
 * The CrewBroker.loadRunForHello method delegated entirely to
 * loadRunManifestById after one safety check (cwd absence); the helper is
 * now a top-level function the class method delegates to in 1 line.
 */

import { loadRunManifestById } from "../../../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../state/types.ts";

export function loadRunForHello(cwd: string | undefined, runId: string): { manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined {
	if (!cwd) return undefined;
	try {
		return loadRunManifestById(cwd, runId) ?? undefined;
	} catch {
		return undefined;
	}
}
