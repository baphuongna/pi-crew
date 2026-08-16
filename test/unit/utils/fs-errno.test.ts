/**
 * bug-026 sub-issue B — fatal-fs errno classifier unit tests.
 *
 * The 2026-08-15 disk-full incident only surfaced the errno inside
 * stderr-tail strings (E007 ChildTimeout appends "Stderr tail: ..."), never
 * as a raw errno object in the parent. The classifier must therefore match
 * both shapes: `.code` (case-insensitive) and message text.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { classifyFatalFsError, type FatalFsCause, failureCauseForAttempt, fsFailureLabel } from "../../../src/utils/fs-errno.ts";

function errnoError(code: string, message = "write failed"): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

test("classifyFatalFsError matches .code case-insensitively", () => {
	assert.equal(classifyFatalFsError(errnoError("ENOSPC")), "enospc");
	assert.equal(classifyFatalFsError(errnoError("enospc")), "enospc");
	assert.equal(classifyFatalFsError(errnoError("Edquot")), "edquot");
	assert.equal(classifyFatalFsError(errnoError("EMFILE")), "emfile");
	assert.equal(classifyFatalFsError(errnoError("enfile")), "enfile");
});

test("classifyFatalFsError matches errno codes embedded in message text", () => {
	assert.equal(classifyFatalFsError(new Error("ENOSPC: no space left on device, write")), "enospc");
	assert.equal(classifyFatalFsError(new Error("EDQUOT: disk quota exceeded")), "edquot");
	assert.equal(classifyFatalFsError(new Error("EMFILE: too many open files")), "emfile");
	// The incident shape: errno only inside an E007 stderr-tail string.
	assert.equal(
		classifyFatalFsError(
			new Error(
				"Child Pi worker became unresponsive after 300000ms of no output and was terminated. Stderr tail: Error: ENOSPC: no space left on device, write",
			),
		),
		"enospc",
	);
});

test("classifyFatalFsError matches a raw string (stderr-tail seam)", () => {
	assert.equal(classifyFatalFsError("[MOCK] failure: ENOSPC: no space left on device, write"), "enospc");
	assert.equal(classifyFatalFsError("errno -28 ENFILE reached"), "enfile");
	assert.equal(classifyFatalFsError("clean stderr"), undefined);
});

test("classifyFatalFsError prefers .code over message text when both match", () => {
	const both = Object.assign(new Error("ENOSPC: no space left on device"), { code: "EDQUOT" });
	assert.equal(classifyFatalFsError(both), "edquot");
});

test("classifyFatalFsError returns undefined for non-fs errors and edge inputs", () => {
	assert.equal(classifyFatalFsError(new Error("connection refused")), undefined);
	assert.equal(classifyFatalFsError(errnoError("EACCES")), undefined);
	assert.equal(classifyFatalFsError(errnoError("ENOENT")), undefined);
	assert.equal(classifyFatalFsError(undefined), undefined);
	assert.equal(classifyFatalFsError(null), undefined);
	assert.equal(classifyFatalFsError(42), undefined);
	assert.equal(classifyFatalFsError(""), undefined);
});

test("failureCauseForAttempt combines error and stderr (child-executor seam)", () => {
	assert.equal(failureCauseForAttempt(undefined, "… ENOSPC: no space left …"), "enospc");
	assert.equal(failureCauseForAttempt("plain failure", "… EMFILE …"), "emfile");
	assert.equal(failureCauseForAttempt(undefined, undefined), undefined);
	assert.equal(failureCauseForAttempt("no errno here", "also clean"), undefined);
	// Error wins over stderr when both carry different codes.
	assert.equal(failureCauseForAttempt("EDQUOT: quota exceeded", "… ENOSPC …"), "edquot");
});

test("fsFailureLabel maps causes to human labels", () => {
	const expected: Record<FatalFsCause, string> = {
		enospc: "disk full",
		edquot: "disk full",
		emfile: "too many open files",
		enfile: "too many open files",
	};
	for (const [cause, label] of Object.entries(expected)) {
		assert.equal(fsFailureLabel(cause as FatalFsCause), label);
	}
});
