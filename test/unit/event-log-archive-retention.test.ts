/**
 * H2 regression guard: event-log archive retention.
 *
 * rotateEventLogUnlocked creates `<eventsPath>.<ts>.archive.jsonl` files; before
 * this fix nothing deleted them, so they accumulated forever. The rotation now
 * sweeps archive files older than ARCHIVE_RETENTION_DAYS (mirrors the
 * notification/metric-sink rotateOldFiles pattern).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { rotateEventLogUnlocked } from "../../src/state/event-log/event-log-rotation.ts";

const createdTmpDirs: string[] = [];
after(() => {
	for (const d of createdTmpDirs) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
});

const DAY = 24 * 60 * 60 * 1000;

function touchAge(filePath: string, ageDays: number): void {
	fs.writeFileSync(filePath, "x");
	const t = (Date.now() - ageDays * DAY) / 1000;
	fs.utimesSync(filePath, t, t);
}

test("H2: rotation sweeps archive files older than the retention window", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-archive-ret-"));
	createdTmpDirs.push(dir);
	const eventsPath = path.join(dir, "events.jsonl");
	fs.writeFileSync(eventsPath, '{"type":"run.created"}\n');

	// Old archive (8 days) → swept.
	const oldArchive = path.join(dir, "events.jsonl.2026-01-01T00-00-00-000Z.archive.jsonl");
	touchAge(oldArchive, 8);
	// Recent archive (1 day) → kept.
	const recentArchive = path.join(dir, "events.jsonl.2026-07-28T00-00-00-000Z.archive.jsonl");
	touchAge(recentArchive, 1);
	// Unrelated file → untouched.
	const unrelated = path.join(dir, "manifest.json");
	touchAge(unrelated, 30);

	assert.ok(rotateEventLogUnlocked(eventsPath));

	assert.ok(!fs.existsSync(oldArchive), "old archive swept");
	assert.ok(fs.existsSync(recentArchive), "recent archive kept");
	assert.ok(fs.existsSync(unrelated), "unrelated file untouched");
	// Rotation itself created exactly one fresh archive (the eventsPath copy).
	const archives = fs.readdirSync(dir).filter((f) => f.endsWith(".archive.jsonl"));
	assert.equal(archives.length, 2, "recent + the new rotation archive");
});

test("H2: sweep is best-effort (missing dir / no archives does not throw)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-archive-empty-"));
	createdTmpDirs.push(dir);
	const eventsPath = path.join(dir, "events.jsonl");
	fs.writeFileSync(eventsPath, '{"type":"x"}\n');
	// No archives present — rotation + sweep must not throw.
	assert.doesNotThrow(() => rotateEventLogUnlocked(eventsPath));
});
