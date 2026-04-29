import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { validateResources } from "../../src/extension/validate-resources.ts";

test("validateResources warns about suspicious model references", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-model-validation-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew", "agents"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".crew", "agents", "bad-model.md"), "---\nname: bad-model\ndescription: Bad model\nmodel: bad model\n---\nPrompt\n", "utf-8");
		const report = validateResources(cwd);
		assert.ok(report.issues.some((issue) => issue.level === "warning" && issue.message.includes("whitespace")));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
