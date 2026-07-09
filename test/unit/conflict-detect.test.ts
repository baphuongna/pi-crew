/**
 * Unit tests for conflict-detect.ts
 * Forked from oh-my-pi with pi-crew adaptations.
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	ConflictHistory,
	expandContentTokens,
	formatConflictSummary,
	formatConflictWarning,
	parseConflictUri,
	renderConflictRegion,
	scanConflictLines,
	scanFileForConflicts,
	scanFileForConflictsSync,
	spliceConflict,
} from "../../src/utils/conflict-detect.ts";

function tempFile(content: string): string {
	const tmp = path.join(os.tmpdir(), `pi-crew-conflict-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
	fs.writeFileSync(tmp, content);
	return tmp;
}

describe("scanConflictLines", () => {
	it("detects basic two-way conflict block", () => {
		const lines = ["line before", "<<<<<<< HEAD", "our change", "=======", "their change", ">>>>>>> feature", "line after"];
		const blocks = scanConflictLines(lines, 1);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].startLine, 2);
		assert.strictEqual(blocks[0].separatorLine, 4);
		assert.strictEqual(blocks[0].endLine, 6);
		assert.deepStrictEqual(blocks[0].oursLines, ["our change"]);
		assert.deepStrictEqual(blocks[0].theirsLines, ["their change"]);
		assert.strictEqual(blocks[0].oursLabel, "HEAD");
		assert.strictEqual(blocks[0].theirsLabel, "feature");
	});

	it("detects basic two-way conflict block in CRLF (Windows) files", () => {
		// Lines carry a trailing CR, mirroring text.split("\n") on a CRLF file.
		const lines = [
			"line before\r",
			"<<<<<<< HEAD\r",
			"our change\r",
			"=======\r",
			"their change\r",
			">>>>>>> feature\r",
			"line after\r",
		];
		const blocks = scanConflictLines(lines, 1);
		assert.strictEqual(blocks.length, 1, "separator/marker with trailing CR must still match");
		assert.strictEqual(blocks[0].startLine, 2);
		assert.strictEqual(blocks[0].separatorLine, 4);
		assert.strictEqual(blocks[0].endLine, 6);
		assert.deepStrictEqual(blocks[0].oursLines, ["our change"]);
		assert.deepStrictEqual(blocks[0].theirsLines, ["their change"]);
		assert.strictEqual(blocks[0].oursLabel, "HEAD");
		assert.strictEqual(blocks[0].theirsLabel, "feature");
	});

	it("detects CRLF conflict with bare (label-less) markers", () => {
		const lines = ["<<<<<<<\r", "ours content\r", "=======\r", "theirs content\r", ">>>>>>>\r"];
		const blocks = scanConflictLines(lines, 1);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].oursLabel, undefined);
		assert.strictEqual(blocks[0].theirsLabel, undefined);
		assert.deepStrictEqual(blocks[0].oursLines, ["ours content"]);
		assert.deepStrictEqual(blocks[0].theirsLines, ["theirs content"]);
	});

	it("detects conflict with no labels", () => {
		const lines = ["<<<<<<<", "ours content", "=======", "theirs content", ">>>>>>>"];
		const blocks = scanConflictLines(lines, 1);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].oursLabel, undefined);
		assert.strictEqual(blocks[0].theirsLabel, undefined);
		assert.deepStrictEqual(blocks[0].oursLines, ["ours content"]);
		assert.deepStrictEqual(blocks[0].theirsLines, ["theirs content"]);
	});

	it("detects diff3 conflict with base section", () => {
		const lines = ["<<<<<<< HEAD", "new feature", "||||||| old", "original line", "=======", "another change", ">>>>>>> feature"];
		const blocks = scanConflictLines(lines, 1);
		assert.strictEqual(blocks.length, 1);
		// baseLine is the ||||||| marker line
		assert.strictEqual(blocks[0].baseLine, 3);
		assert.deepStrictEqual(blocks[0].baseLines, ["original line"]);
		assert.deepStrictEqual(blocks[0].oursLines, ["new feature"]);
		assert.deepStrictEqual(blocks[0].theirsLines, ["another change"]);
	});

	it("returns empty for clean file", () => {
		const lines = ["const x = 1;", "export default x;"];
		const blocks = scanConflictLines(lines, 1);
		assert.strictEqual(blocks.length, 0);
	});

	it("detects multiple conflict blocks", () => {
		const lines = ["<<<<<<< a", "a1", "=======", "b1", ">>>>>>> b", "middle", "<<<<<<< c", "c1", "=======", "d1", ">>>>>>> d"];
		const blocks = scanConflictLines(lines, 1);
		assert.strictEqual(blocks.length, 2);
		assert.strictEqual(blocks[0].startLine, 1);
		assert.strictEqual(blocks[1].startLine, 7);
	});

	it("drops block with missing closer", () => {
		const lines = ["<<<<<<< HEAD", "ours", "=======", "theirs"];
		const blocks = scanConflictLines(lines, 1);
		assert.strictEqual(blocks.length, 0);
	});

	it("drops block with missing separator", () => {
		const lines = ["<<<<<<< HEAD", "ours", ">>>>>>> feature"];
		const blocks = scanConflictLines(lines, 1);
		assert.strictEqual(blocks.length, 0);
	});

	it("skips orphan separator", () => {
		const lines = ["normal line", "=======", "normal line 2"];
		const blocks = scanConflictLines(lines, 1);
		assert.strictEqual(blocks.length, 0);
	});

	it("skips orphan closer", () => {
		const lines = ["normal line", ">>>>>>> feature"];
		const blocks = scanConflictLines(lines, 1);
		assert.strictEqual(blocks.length, 0);
	});

	it("handles empty lines inside conflict", () => {
		const lines = ["<<<<<<<", "", "=======", "", ">>>>>>>"];
		const blocks = scanConflictLines(lines, 1);
		assert.strictEqual(blocks.length, 1);
		assert.deepStrictEqual(blocks[0].oursLines, [""]);
		assert.deepStrictEqual(blocks[0].theirsLines, [""]);
	});

	it("respects firstLineNumber offset for windowed reads", () => {
		const lines = ["<<<<<<<", "ours", "=======", "theirs", ">>>>>>>"];
		const blocks = scanConflictLines(lines, 201);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].startLine, 201);
		assert.strictEqual(blocks[0].separatorLine, 203);
		assert.strictEqual(blocks[0].endLine, 205);
	});

	it("ignores non-column-0 markers", () => {
		const lines = ["  <<<<<<< (not a marker)", "  ======= (not a separator)", "  >>>>>>> (not a closer)"];
		const blocks = scanConflictLines(lines, 1);
		assert.strictEqual(blocks.length, 0);
	});
});

describe("scanFileForConflicts / sync", () => {
	const cleanup: string[] = [];

	after(() => {
		for (const p of cleanup) {
			try {
				fs.unlinkSync(p);
			} catch {
				/* ignore */
			}
		}
	});

	it("detects conflicts in file", () => {
		const tmp = tempFile("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> feat\na\n");
		cleanup.push(tmp);
		const result = scanFileForConflictsSync(tmp);
		assert.strictEqual(result.blocks.length, 1);
		assert.strictEqual(result.scanTruncated, false);
	});

	it("returns empty for clean file", () => {
		const tmp = tempFile("const x = 1;\n");
		cleanup.push(tmp);
		const result = scanFileForConflictsSync(tmp);
		assert.strictEqual(result.blocks.length, 0);
	});

	it("returns empty for non-existent file", () => {
		const result = scanFileForConflictsSync("/no/such/file.txt");
		assert.strictEqual(result.blocks.length, 0);
		assert.strictEqual(result.scanTruncated, false);
	});

	it("async version matches sync", async () => {
		const tmp = tempFile("<<<<<<< a\na1\n=======\nb1\n>>>>>>>\n");
		cleanup.push(tmp);
		const [sync, async] = await Promise.all([Promise.resolve(scanFileForConflictsSync(tmp)), scanFileForConflicts(tmp)]);
		assert.strictEqual(sync.blocks.length, async.blocks.length);
		assert.strictEqual(sync.scanTruncated, async.scanTruncated);
	});
});

describe("ConflictHistory", () => {
	it("registers and retrieves entry", () => {
		const history = new ConflictHistory();
		const entry = history.register({
			absolutePath: "/a/b.txt",
			displayPath: "b.txt",
			startLine: 5,
			separatorLine: 8,
			endLine: 11,
			oursLines: ["ours"],
			theirsLines: ["theirs"],
		});
		assert.ok(entry.id >= 1);
		assert.strictEqual(history.get(entry.id), entry);
		assert.strictEqual(history.size, 1);
	});

	it("deduplicates by path+startLine", () => {
		const history = new ConflictHistory();
		const e1 = history.register({
			absolutePath: "/a/b.txt",
			displayPath: "b.txt",
			startLine: 5,
			separatorLine: 8,
			endLine: 11,
			oursLines: ["original"],
			theirsLines: ["theirs"],
		});
		const e2 = history.register({
			absolutePath: "/a/b.txt",
			displayPath: "b.txt",
			startLine: 5,
			separatorLine: 8,
			endLine: 11,
			oursLines: ["updated"],
			theirsLines: ["theirs updated"],
		});
		assert.strictEqual(e1.id, e2.id);
		assert.strictEqual(history.size, 1);
		// Updated content reflected
		assert.strictEqual(history.get(e1.id)!.oursLines[0], "updated");
	});

	it("entries returns in insertion order", () => {
		const history = new ConflictHistory();
		const e1 = history.register({
			absolutePath: "/a/1.txt",
			displayPath: "1.txt",
			startLine: 1,
			separatorLine: 2,
			endLine: 3,
			oursLines: [],
			theirsLines: [],
		});
		const e2 = history.register({
			absolutePath: "/a/2.txt",
			displayPath: "2.txt",
			startLine: 1,
			separatorLine: 2,
			endLine: 3,
			oursLines: [],
			theirsLines: [],
		});
		const entries = history.entries();
		assert.strictEqual(entries[0].id, e1.id);
		assert.strictEqual(entries[1].id, e2.id);
	});

	it("invalidate removes single entry", () => {
		const history = new ConflictHistory();
		const e = history.register({
			absolutePath: "/a.txt",
			displayPath: "a.txt",
			startLine: 1,
			separatorLine: 2,
			endLine: 3,
			oursLines: [],
			theirsLines: [],
		});
		history.invalidate(e.id);
		assert.strictEqual(history.get(e.id), undefined);
		assert.strictEqual(history.size, 0);
	});

	it("invalidatePath removes all matching", () => {
		const history = new ConflictHistory();
		history.register({
			absolutePath: "/a.txt",
			displayPath: "a.txt",
			startLine: 1,
			separatorLine: 2,
			endLine: 3,
			oursLines: [],
			theirsLines: [],
		});
		history.register({
			absolutePath: "/a.txt",
			displayPath: "a.txt",
			startLine: 10,
			separatorLine: 12,
			endLine: 14,
			oursLines: [],
			theirsLines: [],
		});
		history.register({
			absolutePath: "/b.txt",
			displayPath: "b.txt",
			startLine: 1,
			separatorLine: 2,
			endLine: 3,
			oursLines: [],
			theirsLines: [],
		});
		history.invalidatePath("/a.txt");
		assert.strictEqual(history.size, 1);
	});
});

describe("parseConflictUri", () => {
	it("parses conflict://<N>", () => {
		const result = parseConflictUri("conflict://42");
		assert.notStrictEqual(result, null);
		assert.strictEqual(result!.id, 42);
		assert.strictEqual(result!.scope, undefined);
	});

	it("parses conflict://<N>/ours", () => {
		const result = parseConflictUri("conflict://7/ours");
		assert.notStrictEqual(result, null);
		assert.strictEqual(result!.id, 7);
		assert.strictEqual(result!.scope, "ours");
	});

	it("parses conflict://<N>/theirs", () => {
		const result = parseConflictUri("conflict://7/theirs");
		assert.notStrictEqual(result, null);
		assert.strictEqual(result!.id, 7);
		assert.strictEqual(result!.scope, "theirs");
	});

	it("parses conflict://<N>/base", () => {
		const result = parseConflictUri("conflict://7/base");
		assert.notStrictEqual(result, null);
		assert.strictEqual(result!.id, 7);
		assert.strictEqual(result!.scope, "base");
	});

	it("parses conflict://*", () => {
		const result = parseConflictUri("conflict://*");
		assert.notStrictEqual(result, null);
		assert.strictEqual(result!.id, "*");
	});

	it("returns null for non-conflict path", () => {
		assert.strictEqual(parseConflictUri("/a/b.txt"), null);
		assert.strictEqual(parseConflictUri("conflict.txt"), null);
		assert.strictEqual(parseConflictUri("foo://bar"), null);
	});

	it("throws for invalid id", () => {
		assert.throws(() => parseConflictUri("conflict://abc"), /positive integer/i);
		assert.throws(() => parseConflictUri("conflict://0"), /≥ 1|positive integer/i);
		assert.throws(() => parseConflictUri("conflict://-5"), /≥ 1|positive integer/i);
	});

	it("throws for invalid scope", () => {
		assert.throws(() => parseConflictUri("conflict://1/invalid"), /scope must be/i);
	});

	it("throws for wildcard with scope", () => {
		assert.throws(() => parseConflictUri("conflict://*/ours"), /wildcard.*does not accept/i);
	});
});

describe("spliceConflict", () => {
	it("replaces conflict block with replacement", () => {
		const original = "start\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feat\nend";
		const entry = {
			id: 1,
			absolutePath: "/a.txt",
			displayPath: "a.txt",
			startLine: 2,
			separatorLine: 4,
			endLine: 6,
			oursLabel: "HEAD",
			theirsLabel: "feat",
			oursLines: ["ours"],
			theirsLines: ["theirs"],
		};
		const result = spliceConflict(original, entry, "resolved\nline2");
		assert.strictEqual(result, "start\nresolved\nline2\nend");
	});

	it("handles replacement without trailing newline", () => {
		const original = "<<<<<<<\nours\n=======\ntheirs\n>>>>>>>\n";
		const entry = {
			id: 1,
			absolutePath: "/a.txt",
			displayPath: "a.txt",
			startLine: 1,
			separatorLine: 3,
			endLine: 5,
			oursLines: ["ours"],
			theirsLines: ["theirs"],
		};
		const result = spliceConflict(original, entry, "resolved");
		assert.strictEqual(result, "resolved\n");
	});

	it("preserves CRLF line endings when splicing", () => {
		const original = "start\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> feat\r\nend";
		const entry = {
			id: 1,
			absolutePath: "/a.txt",
			displayPath: "a.txt",
			startLine: 2,
			separatorLine: 4,
			endLine: 6,
			oursLabel: "HEAD",
			theirsLabel: "feat",
			oursLines: ["ours"],
			theirsLines: ["theirs"],
		};
		const result = spliceConflict(original, entry, "resolved");
		assert.strictEqual(result, "start\r\nresolved\r\nend");
	});

	it("throws when block not found", () => {
		const original = "some other content";
		const entry = {
			id: 1,
			absolutePath: "/a.txt",
			displayPath: "a.txt",
			startLine: 2,
			separatorLine: 4,
			endLine: 6,
			oursLines: ["ours"],
			theirsLines: ["theirs"],
		};
		assert.throws(() => spliceConflict(original, entry, "resolved"), /no longer present/i);
	});
});

describe("expandContentTokens", () => {
	const entry = {
		id: 1,
		absolutePath: "/a.txt",
		displayPath: "a.txt",
		startLine: 1,
		separatorLine: 3,
		endLine: 5,
		oursLines: ["ours-a", "ours-b"],
		theirsLines: ["theirs-a", "theirs-b"],
		baseLines: ["base-x", "base-y"],
	};

	it("@ours expands to oursLines", () => {
		const result = expandContentTokens("@ours\n", entry);
		assert.strictEqual(result, "ours-a\nours-b\n");
	});

	it("@theirs expands to theirsLines", () => {
		const result = expandContentTokens("@theirs\n", entry);
		assert.strictEqual(result, "theirs-a\ntheirs-b\n");
	});

	it("@base expands to baseLines", () => {
		const result = expandContentTokens("@base\n", entry);
		assert.strictEqual(result, "base-x\nbase-y\n");
	});

	it("@both expands to ours then theirs", () => {
		const result = expandContentTokens("@both\n", entry);
		assert.strictEqual(result, "ours-a\nours-b\ntheirs-a\ntheirs-b\n");
	});

	it("non-token lines pass through", () => {
		const result = expandContentTokens("hello world\n@ours\nafter\n", entry);
		assert.strictEqual(result, "hello world\nours-a\nours-b\nafter\n");
	});

	it("@ours without base throws", () => {
		const noBase = { ...entry, baseLines: undefined };
		assert.throws(() => expandContentTokens("@base\n", noBase), /no base section/i);
	});

	it("partial token does not expand", () => {
		const result = expandContentTokens("let @ours = 1;\n", entry);
		assert.strictEqual(result, "let @ours = 1;\n");
	});

	it("handles CRLF line endings", () => {
		const result = expandContentTokens("@ours\r\n", entry);
		assert.ok(result.startsWith("ours-a"), "should expand @ours");
	});
});

describe("renderConflictRegion", () => {
	const entry = {
		id: 1,
		absolutePath: "/a.txt",
		displayPath: "a.txt",
		startLine: 2,
		separatorLine: 5,
		endLine: 8,
		oursLabel: "HEAD",
		baseLabel: "base",
		theirsLabel: "feat",
		oursLines: ["ours"],
		baseLine: 4,
		baseLines: ["base"],
		theirsLines: ["theirs"],
	};

	it("renders full region without scope", () => {
		const { lines, startLine } = renderConflictRegion(entry, undefined);
		assert.strictEqual(startLine, 2);
		assert.deepStrictEqual(lines, ["<<<<<<< HEAD", "ours", "||||||| base", "base", "=======", "theirs", ">>>>>>> feat"]);
	});

	it("renders /ours scope", () => {
		const { lines, startLine } = renderConflictRegion(entry, "ours");
		assert.strictEqual(startLine, 3);
		assert.deepStrictEqual(lines, ["ours"]);
	});

	it("renders /theirs scope", () => {
		const { lines, startLine } = renderConflictRegion(entry, "theirs");
		assert.strictEqual(startLine, 6);
		assert.deepStrictEqual(lines, ["theirs"]);
	});

	it("renders /base scope", () => {
		const { lines, startLine } = renderConflictRegion(entry, "base");
		// startLine is baseLine + 1 (line after ||||||| marker)
		assert.strictEqual(startLine, 5);
		assert.deepStrictEqual(lines, ["base"]);
	});

	it("/base throws for 2-way conflict", () => {
		const twoWay = {
			...entry,
			baseLines: undefined,
			baseLine: undefined,
			baseLabel: undefined,
		};
		assert.throws(() => renderConflictRegion(twoWay, "base"), /no base section/i);
	});
});

describe("formatConflictWarning", () => {
	it("returns empty string for no conflicts", () => {
		assert.strictEqual(formatConflictWarning([]), "");
	});

	it("formats single conflict", () => {
		const entry = {
			id: 1,
			absolutePath: "/a.txt",
			displayPath: "a.txt",
			startLine: 2,
			separatorLine: 4,
			endLine: 6,
			oursLabel: "HEAD",
			theirsLabel: "feat",
			oursLines: ["ours-line"],
			theirsLines: ["theirs-line"],
		};
		const out = formatConflictWarning([entry]);
		assert.ok(out.includes("conflict"), "should mention conflict");
		assert.ok(out.includes("ours"), "should show ours label");
		assert.ok(out.includes("theirs"), "should show theirs label");
	});

	it("shows partial count when truncated", () => {
		const entry = {
			id: 1,
			absolutePath: "/a.txt",
			displayPath: "a.txt",
			startLine: 2,
			separatorLine: 4,
			endLine: 6,
			oursLines: [],
			theirsLines: [],
		};
		const out = formatConflictWarning([entry], { totalInFile: 5 });
		assert.ok(out.includes("1 of 5 unresolved conflicts"));
	});
});

describe("formatConflictSummary", () => {
	it("formats conflict index", () => {
		const entries = [
			{
				id: 1,
				absolutePath: "/a.txt",
				displayPath: "a.txt",
				startLine: 2,
				separatorLine: 4,
				endLine: 6,
				oursLines: [],
				theirsLines: [],
			},
			{
				id: 2,
				absolutePath: "/a.txt",
				displayPath: "a.txt",
				startLine: 10,
				separatorLine: 12,
				endLine: 14,
				baseLines: ["base"],
				oursLines: [],
				theirsLines: [],
			},
		];
		const out = formatConflictSummary(entries, { displayPath: "a.txt" });
		assert.ok(out.includes("#1  L2-6"));
		assert.ok(out.includes("#2  L10-14  (3-way)"));
	});
});
