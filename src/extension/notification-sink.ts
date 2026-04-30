import * as fs from "node:fs";
import * as path from "node:path";
import type { NotificationDescriptor } from "./notification-router.ts";
import { redactSecrets } from "../utils/redaction.ts";
import { logInternalError } from "../utils/internal-error.ts";

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

export function createJsonlSink(crewRoot: string, retentionDays = 7): NotificationSink {
	const dir = path.join(crewRoot, "state", "notifications");
	let lastRotateDate = "";
	return {
		write(notification: NotificationDescriptor): void {
			try {
				const timestamp = notification.timestamp ?? Date.now();
				const date = new Date(timestamp).toISOString().slice(0, 10);
				if (date !== lastRotateDate) {
					rotateOldFiles(dir, retentionDays, timestamp);
					lastRotateDate = date;
				}
				fs.mkdirSync(dir, { recursive: true });
				const payload = redactSecrets({ ...notification, timestamp }) as NotificationDescriptor;
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
