import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { clearTranscriptCache, getTranscriptCacheEntry, readTranscriptLinesCached } from "../../../src/ui/transcript-cache.ts";

function tmpDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function parseLines(text: string): string[] {
	return text.split(/\r?\n/).filter(Boolean);
}

// Independent oracle: mirrors the documented tail algorithm (read the last
// `cap` bytes, then skip through the first newline) over a full byte view.
function expectedTailLines(fileBytes: Buffer, cap: number): string[] {
	if (fileBytes.length <= cap) return parseLines(fileBytes.toString("utf-8"));
	const window = fileBytes.subarray(fileBytes.length - cap);
	const firstNewline = window.indexOf(0x0a);
	const start = firstNewline >= 0 ? firstNewline + 1 : 0;
	return parseLines(window.subarray(start).toString("utf-8"));
}

function line(index: number): string {
	return `line-${index.toString().padStart(4, "0")}-${"x".repeat(56)}`;
}

test("growing transcript reads only the appended bytes", () => {
	const tmp = tmpDir("pi-crew-tc-incremental-grow-");
	try {
		const transcriptPath = path.join(tmp, "growing.jsonl");
		const first = Array.from({ length: 100 }, (_v, i) => line(i)).join("\n") + "\n";
		fs.writeFileSync(transcriptPath, first, "utf-8");
		clearTranscriptCache(transcriptPath);
		const seenTexts: string[] = [];
		const parse = (text: string): string[] => {
			seenTexts.push(text);
			return parseLines(text);
		};
		const lines1 = readTranscriptLinesCached(transcriptPath, parse, Date.now());
		const entry1 = getTranscriptCacheEntry(transcriptPath);
		assert.equal(entry1?.bytesRead, Buffer.byteLength(first, "utf-8"));
		assert.equal(entry1?.size, fs.statSync(transcriptPath).size);
		assert.equal(entry1?.offset, 0);

		const appended = Array.from({ length: 10 }, (_v, i) => line(100 + i)).join("\n") + "\n";
		fs.appendFileSync(transcriptPath, appended, "utf-8");
		const lines2 = readTranscriptLinesCached(transcriptPath, parse, Date.now());
		const entry2 = getTranscriptCacheEntry(transcriptPath);
		assert.equal(entry2?.readCount, 2);
		// Only the appended region was read from disk.
		assert.equal(entry2?.bytesRead, Buffer.byteLength(appended, "utf-8"));
		assert.equal(entry2?.size, fs.statSync(transcriptPath).size);
		assert.equal(entry2?.offset, 0);
		assert.equal(entry2?.truncated, false);
		// The second parse received the exact concatenation of cached + delta text.
		assert.equal(seenTexts[1], first + appended);
		assert.deepEqual(lines2, [...lines1, ...parseLines(appended)]);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("shrinking or backdated transcript falls back to a full re-read", () => {
	const tmp = tmpDir("pi-crew-tc-incremental-shrink-");
	try {
		const transcriptPath = path.join(tmp, "rotated.jsonl");
		const first = Array.from({ length: 80 }, (_v, i) => line(i)).join("\n") + "\n";
		fs.writeFileSync(transcriptPath, first, "utf-8");
		clearTranscriptCache(transcriptPath);
		readTranscriptLinesCached(transcriptPath, parseLines, Date.now());
		assert.equal(getTranscriptCacheEntry(transcriptPath)?.readCount, 1);

		// Rotation: the file shrinks — incremental append is impossible.
		const rotated = Array.from({ length: 20 }, (_v, i) => `rotated-${i}`).join("\n") + "\n";
		fs.writeFileSync(transcriptPath, rotated, "utf-8");
		const lines2 = readTranscriptLinesCached(transcriptPath, parseLines, Date.now());
		const entry2 = getTranscriptCacheEntry(transcriptPath);
		assert.deepEqual(lines2, parseLines(rotated));
		assert.equal(entry2?.bytesRead, Buffer.byteLength(rotated, "utf-8"));
		assert.equal(entry2?.size, fs.statSync(transcriptPath).size);
		assert.equal(entry2?.offset, 0);

		// Larger file but older mtime (restored from a backup): full re-read too.
		const backdated = Array.from({ length: 120 }, (_v, i) => `backdated-${i}`).join("\n") + "\n";
		const older = new Date(Date.now() - 60_000);
		fs.writeFileSync(transcriptPath, backdated, "utf-8");
		fs.utimesSync(transcriptPath, older, older);
		const lines3 = readTranscriptLinesCached(transcriptPath, parseLines, Date.now());
		const entry3 = getTranscriptCacheEntry(transcriptPath);
		assert.deepEqual(lines3, parseLines(backdated));
		assert.equal(entry3?.bytesRead, Buffer.byteLength(backdated, "utf-8"));
		assert.equal(entry3?.offset, 0);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("tail cap front-trims while keeping byte offset bookkeeping across appends", () => {
	const tmp = tmpDir("pi-crew-tc-incremental-tail-");
	try {
		const transcriptPath = path.join(tmp, "large.jsonl");
		const maxTailBytes = 2048;
		const options = { maxTailBytes };
		const initial = Array.from({ length: 300 }, (_v, i) => line(i)).join("\n") + "\n";
		fs.writeFileSync(transcriptPath, initial, "utf-8");
		clearTranscriptCache(transcriptPath);

		const lines1 = readTranscriptLinesCached(transcriptPath, parseLines, Date.now(), options);
		const entry1 = getTranscriptCacheEntry(transcriptPath, options);
		assert.equal(entry1?.truncated, true);
		assert.equal(entry1?.bytesRead, maxTailBytes);
		assert.ok((entry1?.offset ?? 0) > 0);
		assert.deepEqual(lines1, expectedTailLines(fs.readFileSync(transcriptPath), maxTailBytes));

		const appended = Array.from({ length: 20 }, (_v, i) => line(300 + i)).join("\n") + "\n";
		fs.appendFileSync(transcriptPath, appended, "utf-8");
		const lines2 = readTranscriptLinesCached(transcriptPath, parseLines, Date.now(), options);
		const entry2 = getTranscriptCacheEntry(transcriptPath, options);
		assert.equal(entry2?.bytesRead, Buffer.byteLength(appended, "utf-8"));
		assert.ok((entry2?.offset ?? 0) > (entry1?.offset ?? 0));
		// Byte invariant: cached bytes span exactly [offset, size).
		assert.equal(entry2?.size, fs.statSync(transcriptPath).size);
		assert.deepEqual(lines2, expectedTailLines(fs.readFileSync(transcriptPath), maxTailBytes));

		// A second append keeps sliding the window without corrupting content.
		const more = Array.from({ length: 5 }, (_v, i) => line(320 + i)).join("\n") + "\n";
		fs.appendFileSync(transcriptPath, more, "utf-8");
		const lines3 = readTranscriptLinesCached(transcriptPath, parseLines, Date.now(), options);
		const entry3 = getTranscriptCacheEntry(transcriptPath, options);
		assert.equal(entry3?.bytesRead, Buffer.byteLength(more, "utf-8"));
		assert.equal(entry3?.size, fs.statSync(transcriptPath).size);
		assert.ok((entry3?.offset ?? 0) > (entry2?.offset ?? 0));
		assert.deepEqual(lines3, expectedTailLines(fs.readFileSync(transcriptPath), maxTailBytes));
		// The newest content is always present in the tail.
		assert.deepEqual(lines3.slice(-5), parseLines(more));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("append ending mid-line or mid-codepoint matches a full read exactly", () => {
	const tmp = tmpDir("pi-crew-tc-incremental-partial-");
	try {
		const transcriptPath = path.join(tmp, "partial.jsonl");
		fs.writeFileSync(transcriptPath, "one\ntwo\n", "utf-8");
		clearTranscriptCache(transcriptPath);
		readTranscriptLinesCached(transcriptPath, parseLines, Date.now());

		// Append a trailing partial line whose last UTF-8 codepoint is torn in
		// half (first two bytes of a 3-byte "€"). Writers mid-append look like
		// this; the reader must surface them exactly like a full read would.
		const torn = Buffer.concat([Buffer.from("three-par", "utf-8"), Buffer.from([0xe2, 0x82])]);
		fs.appendFileSync(transcriptPath, torn);
		const lines2 = readTranscriptLinesCached(transcriptPath, parseLines, Date.now());
		const full2 = fs.readFileSync(transcriptPath);
		assert.deepEqual(lines2, parseLines(full2.toString("utf-8")));
		assert.equal(lines2.at(-1), "three-par\u{FFFD}");

		// The completing byte arrives: the codepoint must decode whole, with no
		// duplicated or dropped bytes across the torn boundary.
		fs.appendFileSync(transcriptPath, Buffer.from([0xac]));
		const lines3 = readTranscriptLinesCached(transcriptPath, parseLines, Date.now());
		const full3 = fs.readFileSync(transcriptPath);
		assert.deepEqual(lines3, parseLines(full3.toString("utf-8")));
		assert.equal(lines3.at(-1), "three-par€");

		fs.appendFileSync(transcriptPath, "\nfour\n", "utf-8");
		const lines4 = readTranscriptLinesCached(transcriptPath, parseLines, Date.now());
		assert.deepEqual(lines4, ["one", "two", "three-par€", "four"]);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("full mode also grows incrementally without trimming", () => {
	const tmp = tmpDir("pi-crew-tc-incremental-full-");
	try {
		const transcriptPath = path.join(tmp, "full.jsonl");
		const first = Array.from({ length: 40 }, (_v, i) => line(i)).join("\n") + "\n";
		fs.writeFileSync(transcriptPath, first, "utf-8");
		clearTranscriptCache(transcriptPath);
		const options = { full: true, maxTailBytes: 1024 };
		readTranscriptLinesCached(transcriptPath, parseLines, Date.now(), options);
		const entry1 = getTranscriptCacheEntry(transcriptPath, options);
		assert.equal(entry1?.truncated, false);
		assert.equal(entry1?.bytesRead, Buffer.byteLength(first, "utf-8"));

		const appended = Array.from({ length: 10 }, (_v, i) => line(40 + i)).join("\n") + "\n";
		fs.appendFileSync(transcriptPath, appended, "utf-8");
		const lines2 = readTranscriptLinesCached(transcriptPath, parseLines, Date.now(), options);
		const entry2 = getTranscriptCacheEntry(transcriptPath, options);
		assert.equal(entry2?.bytesRead, Buffer.byteLength(appended, "utf-8"));
		assert.equal(entry2?.offset, 0);
		assert.equal(entry2?.truncated, false);
		assert.equal(entry2?.size, fs.statSync(transcriptPath).size);
		// Full mode never front-trims: the first line is still present.
		assert.equal(lines2[0], line(0));
		assert.deepEqual(lines2.slice(-10), parseLines(appended));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
