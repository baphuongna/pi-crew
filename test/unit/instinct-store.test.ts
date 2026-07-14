import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { InstinctStore, type NewInstinct } from "../../src/state/instinct-store.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

const BASE_INSTINCT: NewInstinct = {
	trigger: "test-trigger",
	action: "test-action",
	confidence: 0.6,
	scope: "project",
	projectId: "proj-1",
	evidence: ["evidence-1"],
};

describe("InstinctStore", () => {
	let tmpDir: string;
	let store: InstinctStore;

	beforeEach(() => {
		tmpDir = createTrackedTempDir("pi-crew-instinct-");
		store = new InstinctStore(tmpDir);
	});

	afterEach(() => {
		removeTrackedTempDir(tmpDir);
	});

	describe("saveInstinct", () => {
		it("saves a project-scoped instinct and returns it with id and createdAt", () => {
			const saved = store.saveInstinct({ ...BASE_INSTINCT });
			assert.ok(saved.id, "should have an id");
			assert.ok(saved.createdAt, "should have a createdAt");
			assert.equal(saved.trigger, "test-trigger");
			assert.equal(saved.scope, "project");
		});

		it("saves a global-scoped instinct without projectId", () => {
			const saved = store.saveInstinct({
				...BASE_INSTINCT,
				scope: "global",
				projectId: undefined,
			});
			assert.equal(saved.scope, "global");
			assert.equal(saved.projectId, undefined);
		});

		it("throws if project-scoped instinct has no projectId", () => {
			assert.throws(
				() =>
					store.saveInstinct({
						...BASE_INSTINCT,
						scope: "project",
						projectId: undefined,
					}),
				/projectId/,
			);
		});

		it("throws if projectId contains path traversal characters", () => {
			assert.throws(
				() =>
					store.saveInstinct({
						...BASE_INSTINCT,
						scope: "project",
						projectId: "../../etc/passwd",
					}),
				/Invalid projectId/,
			);
		});

		it("throws if projectId contains other unsafe characters", () => {
			assert.throws(
				() =>
					store.saveInstinct({
						...BASE_INSTINCT,
						scope: "project",
						projectId: "../secret",
					}),
				/Invalid projectId/,
			);
		});
	});

	describe("getInstincts", () => {
		it("returns empty array when no instincts exist", () => {
			assert.deepEqual(store.getInstincts(), []);
		});

		it("returns all instincts when no scope filter", () => {
			store.saveInstinct({ ...BASE_INSTINCT });
			store.saveInstinct({
				...BASE_INSTINCT,
				scope: "global",
				projectId: undefined,
			});
			const all = store.getInstincts();
			assert.equal(all.length, 2);
		});

		it("filters by project scope", () => {
			store.saveInstinct({ ...BASE_INSTINCT });
			store.saveInstinct({
				...BASE_INSTINCT,
				scope: "global",
				projectId: undefined,
			});
			const projects = store.getInstincts("project");
			assert.equal(projects.length, 1);
			assert.equal(projects[0]!.scope, "project");
		});

		it("filters by global scope", () => {
			store.saveInstinct({ ...BASE_INSTINCT });
			store.saveInstinct({
				...BASE_INSTINCT,
				scope: "global",
				projectId: undefined,
			});
			const globals = store.getInstincts("global");
			assert.equal(globals.length, 1);
			assert.equal(globals[0]!.scope, "global");
		});
	});

	describe("getProjectInstincts", () => {
		it("returns project + global instincts for a given project", () => {
			store.saveInstinct({ ...BASE_INSTINCT, projectId: "proj-1" });
			store.saveInstinct({
				...BASE_INSTINCT,
				scope: "global",
				projectId: undefined,
			});
			store.saveInstinct({ ...BASE_INSTINCT, projectId: "proj-2" });
			const result = store.getProjectInstincts("proj-1");
			assert.equal(result.length, 2);
		});

		it("returns only global instincts if no project instincts exist", () => {
			store.saveInstinct({
				...BASE_INSTINCT,
				scope: "global",
				projectId: undefined,
			});
			const result = store.getProjectInstincts("proj-1");
			assert.equal(result.length, 1);
		});

		it("returns empty if nothing exists", () => {
			assert.deepEqual(store.getProjectInstincts("proj-x"), []);
		});

		it("throws if projectId contains path traversal characters", () => {
			assert.throws(() => store.getProjectInstincts("../../etc/passwd"), /Invalid projectId/);
		});
	});

	describe("deleteInstinct", () => {
		it("deletes a global instinct by id", () => {
			const saved = store.saveInstinct({
				...BASE_INSTINCT,
				scope: "global",
				projectId: undefined,
			});
			assert.ok(store.deleteInstinct(saved.id));
			assert.equal(store.getInstincts("global").length, 0);
		});

		it("deletes a project instinct by id", () => {
			const saved = store.saveInstinct({ ...BASE_INSTINCT });
			assert.ok(store.deleteInstinct(saved.id));
			assert.equal(store.getInstincts("project").length, 0);
		});

		it("returns false for non-existent id", () => {
			assert.equal(store.deleteInstinct("nonexistent"), false);
		});
	});

	describe("promoteInstinct", () => {
		it("promotes a project instinct to global", () => {
			const saved = store.saveInstinct({
				...BASE_INSTINCT,
				projectId: "proj-1",
			});
			const promoted = store.promoteInstinct(saved.id);
			assert.ok(promoted);
			assert.equal(promoted!.scope, "global");
			assert.equal(promoted!.projectId, undefined);
			assert.ok(promoted!.id !== saved.id, "promoted should get new id");
		});

		it("returns null if instinct not found", () => {
			assert.equal(store.promoteInstinct("nonexistent"), null);
		});

		it("removes instinct from project after promotion", () => {
			const saved = store.saveInstinct({
				...BASE_INSTINCT,
				projectId: "proj-1",
			});
			store.promoteInstinct(saved.id);
			const project = store.getInstincts("project");
			assert.equal(project.length, 0, "project instinct should be removed");
			const globals = store.getInstincts("global");
			assert.equal(globals.length, 1, "global instinct should exist");
		});
	});
});
