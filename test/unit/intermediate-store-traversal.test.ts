import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeIntermediate } from "../../src/workflows/intermediate-store.ts";

const tmp = fs.realpathSync(os.tmpdir());

let dir: string;

describe("writeIntermediate path-traversal guard", () => {
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(tmp, "pi-crew-intstore-"));
	});

	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("throws when phase='../etc'", () => {
		let observed: string | undefined;
		const fn = () => {
			try {
				writeIntermediate({ intermediateDir: dir }, "../etc", "cron", { x: 1 });
			} catch (e) {
				observed = e instanceof Error ? e.message : String(e);
				throw e;
			}
		};
		assert.throws(fn, /Invalid phase or stepId/);
		assert.ok(
			observed !== undefined && observed.includes("Invalid phase or stepId"),
			`expected message to include 'Invalid phase or stepId', got: ${observed}`,
		);
	});

	it("throws when stepId='../passwd'", () => {
		let observed: string | undefined;
		const fn = () => {
			try {
				writeIntermediate({ intermediateDir: dir }, "explore", "../passwd", { x: 1 });
			} catch (e) {
				observed = e instanceof Error ? e.message : String(e);
				throw e;
			}
		};
		assert.throws(fn, /Invalid phase or stepId/);
		assert.ok(
			observed !== undefined && observed.includes("Invalid phase or stepId"),
			`expected message to include 'Invalid phase or stepId', got: ${observed}`,
		);
	});

	it("writes <dir>/explore-step1.json on valid input", () => {
		const returned = writeIntermediate({ intermediateDir: dir }, "explore", "step1", { valid: true });
		const expectedPath = path.join(dir, "explore-step1.json");
		assert.equal(returned, expectedPath);
		assert.ok(fs.existsSync(returned), `expected file to exist at ${returned}`);
		const content = JSON.parse(fs.readFileSync(returned, "utf-8"));
		assert.equal(content.data.valid, true);
	});
});
