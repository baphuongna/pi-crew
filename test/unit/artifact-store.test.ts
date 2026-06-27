import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { writeArtifact } from "../../src/state/artifact-store.ts";

// Use realpath to resolve symlinks (macOS /var/folders → /private/var/folders).
// atomicWriteFile refuses to write through untrusted symlink paths.
const realTmp = fs.realpathSync(os.tmpdir());

test("writeArtifact: contentHash matches sha256 of bytes on disk", () => {
	const root = fs.mkdtempSync(path.join(realTmp, "pi-crew-art-"));
	const desc = writeArtifact(root, {
		kind: "log",
		relativePath: "x.log",
		content: "api_key=AKIA0123456789ABCDEF\nplain text",
		producer: "test",
	});
	const onDisk = fs.readFileSync(desc.path);
	const expected = createHash("sha256").update(onDisk).digest("hex");
	assert.strictEqual(desc.contentHash, expected);
	assert.strictEqual(desc.sizeBytes, onDisk.length);
	assert.ok(!onDisk.toString("utf-8").includes("AKIA0123456789ABCDEF"));
	fs.rmSync(root, { recursive: true, force: true });
});

test("writeArtifact: rejects path traversal", () => {
	const root = fs.mkdtempSync(path.join(realTmp, "pi-crew-art-"));
	assert.throws(() => writeArtifact(root, {
		kind: "log",
		relativePath: "../escape.log",
		content: "x",
		producer: "t",
	}), /Invalid artifact path/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("writeArtifact: creates nested directories", () => {
	const root = fs.mkdtempSync(path.join(realTmp, "pi-crew-art-"));
	const desc = writeArtifact(root, {
		kind: "log",
		relativePath: "a/b/c.log",
		content: "nested",
		producer: "test",
	});
	assert.ok(fs.existsSync(desc.path));
	fs.rmSync(root, { recursive: true, force: true });
});

test("M2 regression: writeArtifact redacts quoted-JSON & nested secrets via structural pass", () => {
	// Flat redactSecretString misses JSON-quoted keys ("api_key":"...") because
	// the char after the key run is '"' not ':'/'='. The structural JSON pass
	// added in writeArtifact (security review M2) must catch these.
	const root = fs.mkdtempSync(path.join(realTmp, "pi-crew-art-m2-"));
	const payload = JSON.stringify({
		api_key: "sk-abc123-not-a-real-key",
		nested: { token: "ghp_0123456789abcdef0123456789abcdef" },
		authorization: "Basic c2VjcmV0",
	});
	const desc = writeArtifact(root, {
		kind: "metadata",
		relativePath: "evidence.json",
		content: payload,
		producer: "test",
	});
	const onDisk = fs.readFileSync(desc.path, "utf-8");
	assert.ok(!onDisk.includes("sk-abc123-not-a-real-key"), "api_key value must be redacted (M2)");
	assert.ok(!onDisk.includes("ghp_0123456789abcdef0123456789abcdef"), "nested token must be redacted (M2)");
	assert.ok(!onDisk.includes("c2VjcmV0"), "authorization Basic value must be redacted (M2)");
	// Structure preserved (still valid JSON).
	assert.doesNotThrow(() => JSON.parse(onDisk));
	fs.rmSync(root, { recursive: true, force: true });
});
