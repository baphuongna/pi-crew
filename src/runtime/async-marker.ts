import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteJson } from "../state/atomic-write.ts";
import type { TeamRunManifest } from "../state/types.ts";

export interface AsyncStartMarker {
	pid: number;
	startedAt: string;
}

export function asyncStartMarkerPath(manifest: Pick<TeamRunManifest, "stateRoot">): string {
	return path.join(manifest.stateRoot, "async.pid");
}

export function writeAsyncStartMarker(manifest: Pick<TeamRunManifest, "stateRoot">, marker: AsyncStartMarker): void {
	atomicWriteJson(asyncStartMarkerPath(manifest), marker);
}

export function hasAsyncStartMarker(manifest: Pick<TeamRunManifest, "stateRoot">): boolean {
	try {
		const raw = JSON.parse(fs.readFileSync(asyncStartMarkerPath(manifest), "utf-8")) as Partial<AsyncStartMarker>;
		return typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0 && typeof raw.startedAt === "string" && raw.startedAt.length > 0;
	} catch {
		return false;
	}
}
