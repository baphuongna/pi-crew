import * as fs from "node:fs";
import * as path from "node:path";
import { logInternalError } from "../utils/internal-error.ts";
import { redactSecrets } from "../utils/redaction.ts";
import type { NotificationDescriptor } from "./notification-router.ts";

export interface NotificationSink {
	write(notification: NotificationDescriptor): void;
	dispose(): void;
}

function rotateOldFiles(dir: string, retentionDays: number, now = Date.now()): void {
	if (!fs.existsSync(dir)) return;
	const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const filePath = path.join(dir, entry.name);
		try {
			if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
		} catch (error) {
			logInternalError("notification-sink.rotate", error, filePath);
		}
	}
}

/**
 * JSONL notification sink.
 *
 * RR-020 Fix 2: writes are gated on the crew root ALREADY existing — this sink
 * is attached at session start (lifecycle.ts) and the router pushes `info`
 * notices through it before any severity filter, which used to create an empty
 * `<crewRoot>/state/notifications/` tree (and with it the crew root) on every
 * project. A project that never ran a team now stays untouched; once the crew
 * root exists the sink behaves exactly as before.
 */
export function createJsonlSink(crewRoot: string, retentionDays = 7): NotificationSink {
	const dir = path.join(crewRoot, "state", "notifications");
	let lastRotateDate = "";
	return {
		write(notification: NotificationDescriptor): void {
			try {
				// RR-020 Fix 2: never materialise the project crew root. The router
				// calls this sink BEFORE its severity filter (notification-router.ts),
				// so an `info` notice on session start used to mkdir `<crewRoot>/`
				// (→ `<crewRoot>/state/notifications/`) for a project that never ran
				// a team. Persist only when the crew root already exists — a project
				// that has real crew state keeps every notification exactly as before.
				if (!fs.existsSync(crewRoot)) return;
				const timestamp = notification.timestamp ?? Date.now();
				const date = new Date(timestamp).toISOString().slice(0, 10);
				if (date !== lastRotateDate) {
					rotateOldFiles(dir, retentionDays, timestamp);
					lastRotateDate = date;
				}
				fs.mkdirSync(dir, { recursive: true });
				const payload = redactSecrets({
					...notification,
					timestamp,
				}) as NotificationDescriptor;
				fs.appendFileSync(path.join(dir, `${date}.jsonl`), `${JSON.stringify(payload)}\n`, "utf-8");
			} catch (error) {
				logInternalError("notification-sink.write", error);
			}
		},
		dispose(): void {
			// Synchronous append-only sink has no resources to close.
		},
	};
}

export const __test__ = { rotateOldFiles };
