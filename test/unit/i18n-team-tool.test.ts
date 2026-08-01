import assert from "node:assert/strict";
import test from "node:test";
import { __test__resetI18n, addTranslations, listLocales, t } from "../../src/i18n.ts";

/**
 * PR-F12 (EXT-12): the team tool's user-facing strings must resolve through the
 * shared i18n `t()` function — the same channel the subagent tools
 * (Agent / get_subagent_result) use — so UX is consistent across both tools.
 *
 * These tests assert the team tool's core action labels / result messages
 * resolve via `t()` in the default (English) locale, with template params
 * substituted correctly. A registry check confirms the keys are typed as part
 * of the i18n Key union and wired into the built-in translation bundle.
 */

// Reset i18n state between tests so each starts from the default locale.
test("i18n-team-tool: setup — reset state", () => {
	__test__resetI18n();
});

// ─── Default locale (English fallback) — core run result messages ──────────

test("team.run.created: resolves scaffold banner with runId", () => {
	__test__resetI18n();
	assert.equal(t("team.run.created", { runId: "team_abc" }), "Created pi-crew run team_abc.");
});

test("team.run.completed: resolves the main run-completion banner", () => {
	__test__resetI18n();
	assert.equal(
		t("team.run.completed", { status: "completed", runId: "team_abc", team: "default" }),
		"pi-crew run completed: team_abc (default)",
	);
});

test("team.run.allCompleted: resolves success message", () => {
	__test__resetI18n();
	assert.equal(t("team.run.allCompleted"), "All tasks completed successfully.");
});

test("team.run.tasksFailed: resolves failure message with count + ids", () => {
	__test__resetI18n();
	assert.equal(
		t("team.run.tasksFailed", { count: 2, ids: "01_a, 02_b" }),
		"2 task(s) failed: 01_a, 02_b. Consider retrying.",
	);
});

test("team.unknownAction: resolves unknown-action error label", () => {
	__test__resetI18n();
	assert.equal(t("team.unknownAction", { action: "bogus" }), "Unknown action: bogus");
});

// ─── Template param edge cases ─────────────────────────────────────────────

test("team.run.tasksFailed: numeric count is stringified", () => {
	__test__resetI18n();
	assert.equal(
		t("team.run.tasksFailed", { count: 0, ids: "" }),
		"0 task(s) failed: . Consider retrying.",
	);
});

test("team.run.created: unsubstituted param preserved when omitted", () => {
	__test__resetI18n();
	const result = t("team.run.created");
	assert.match(result, /\{runId\}/);
});

// ─── Registry: keys are part of the i18n bundle + Key type ─────────────────
// addTranslations() is typed as Partial<Record<Key, string>> — passing the
// team.* keys here both type-checks them as valid Key values and confirms the
// runtime merge accepts them without clobbering the built-in English fallback.

test("team.* keys are valid i18n keys (addTranslations accepts them)", () => {
	__test__resetI18n();
	addTranslations("es", {
		"team.run.created": "Ejecución de pi-crew creada {runId}.",
		"team.run.completed": "Ejecución de pi-crew {status}: {runId} ({team})",
		"team.run.allCompleted": "Todas las tareas se completaron con éxito.",
		"team.run.tasksFailed": "{count} tarea(s) fallaron: {ids}. Considera reintentar.",
		"team.unknownAction": "Acción desconocida: {action}",
	});
	assert.ok(listLocales().includes("es"));
	// Default locale still returns English (currentLocale unset in unit tests).
	assert.equal(t("team.run.allCompleted"), "All tasks completed successfully.");
});
