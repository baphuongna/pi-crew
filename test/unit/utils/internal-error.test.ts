/**
 * internal-error.test.ts — Tests for logInternalError severity tiers (FIX-01).
 *
 * Verifies that:
 * - severity="error" emits to stderr even without PI_TEAMS_DEBUG set
 * - severity="warn" emits to stderr even without PI_TEAMS_DEBUG set
 * - severity="debug" (default) is silent without PI_TEAMS_DEBUG
 * - severity="debug" emits when PI_TEAMS_DEBUG is set
 */

import assert from "node:assert/strict";
import test from "node:test";
import { logInternalError } from "../../../src/utils/internal-error.ts";

test("FIX-01: severity='error' emits to stderr without PI_TEAMS_DEBUG", () => {
	delete process.env.PI_TEAMS_DEBUG;
	const original = process.stderr.write.bind(process.stderr);
	const captured: string[] = [];
	process.stderr.write = ((chunk: string | Uint8Array) => {
		captured.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const err = new Error("boom");
		logInternalError("test-scope", err, undefined, "error");
	} finally {
		process.stderr.write = original;
	}
	assert.ok(captured.length > 0, "expected stderr output for severity=error");
	assert.ok(captured.join("").includes("[pi-crew:test-scope]"), "expected scope prefix in output");
	assert.ok(captured.join("").includes("boom"), "expected error message in output");
});

test("FIX-01: severity='warn' emits to stderr without PI_TEAMS_DEBUG", () => {
	delete process.env.PI_TEAMS_DEBUG;
	const original = process.stderr.write.bind(process.stderr);
	const captured: string[] = [];
	process.stderr.write = ((chunk: string | Uint8Array) => {
		captured.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const err = new Error("warning issue");
		logInternalError("test-scope-warn", err, "some detail", "warn");
	} finally {
		process.stderr.write = original;
	}
	assert.ok(captured.length > 0, "expected stderr output for severity=warn");
	assert.ok(captured.join("").includes("[pi-crew:test-scope-warn]"), "expected scope prefix");
	assert.ok(captured.join("").includes("warning issue"), "expected error message");
	assert.ok(captured.join("").includes("some detail"), "expected details suffix");
});

test("FIX-01: severity='debug' (default) is silent without PI_TEAMS_DEBUG", () => {
	delete process.env.PI_TEAMS_DEBUG;
	const original = process.stderr.write.bind(process.stderr);
	const captured: string[] = [];
	process.stderr.write = ((chunk: string | Uint8Array) => {
		captured.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const err = new Error("debug issue");
		// Explicit severity="debug"
		logInternalError("test-scope-debug", err, undefined, "debug");
		// Also test the default (no 4th arg) — backward compat
		logInternalError("test-scope-default", err);
	} finally {
		process.stderr.write = original;
	}
	assert.equal(captured.length, 0, "expected no stderr output without PI_TEAMS_DEBUG for debug severity");
});

test("FIX-01: severity='debug' (default) emits when PI_TEAMS_DEBUG is set", () => {
	process.env.PI_TEAMS_DEBUG = "1";
	const original = process.stderr.write.bind(process.stderr);
	const captured: string[] = [];
	process.stderr.write = ((chunk: string | Uint8Array) => {
		captured.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const err = new Error("debug with env");
		logInternalError("test-scope-env", err);
	} finally {
		process.stderr.write = original;
		delete process.env.PI_TEAMS_DEBUG;
	}
	assert.ok(captured.length > 0, "expected stderr output with PI_TEAMS_DEBUG set");
	assert.ok(captured.join("").includes("debug with env"), "expected error message");
});
