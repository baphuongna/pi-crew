/**
 * Dual-gate loop control — determines whether a task should auto-resume
 * based on meaningful progress and turn limits.
 *
 * Gate 1: At least one signal of meaningful progress must be true.
 * Gate 2: The auto-resume turn count must be below the maximum.
 *
 * Distilled from pi-autoresearch's dual-gate loop pattern.
 */
import * as fs from "node:fs";
import type { TeamTaskState } from "../state/types.ts";

/**
 * Signal indicating what kind of progress a task has made.
 */
export interface TaskProgressSignal {
	/** Whether the task has edited files or produced non-empty results. */
	editedFiles: boolean;
	/** Whether the task has produced artifacts in the artifacts directory. */
	producedArtifacts: boolean;
	/** Whether the task has run tests (detected via result text). */
	ranTests: boolean;
}

/**
 * Runtime state for auto-resume turn tracking.
 */
export interface AutoResumeRuntime {
	/** Current number of auto-resume turns taken. */
	autoResumeTurns: number;
	/** Maximum allowed auto-resume turns. */
	maxTurns: number;
}

/** Keywords in result text that indicate tests were run. */
const TEST_KEYWORDS = [
	"test passed",
	"test failed",
	"tests passed",
	"tests failed",
	"test results",
	"jest",
	"vitest",
	"mocha",
	"pytest",
	"npx test",
	"npm test",
	"cargo test",
	"all tests",
	"test suite",
	"✓",
	"✗",
	"PASS ",
	" FAIL ",
] as const;

/**
 * Determine whether a task should auto-resume based on dual-gate logic.
 *
 * Gate 1 (meaningful progress): at least one of editedFiles, producedArtifacts,
 *   or ranTests must be true.
 * Gate 2 (turn limit): autoResumeTurns must be strictly less than maxTurns.
 *
 * Both gates must pass for auto-resume to be allowed.
 */
export function shouldAutoResume(runtime: AutoResumeRuntime, taskProgress: TaskProgressSignal): boolean {
	// Gate 2: Turn limit check (check first — cheaper)
	if (runtime.autoResumeTurns >= runtime.maxTurns) {
		return false;
	}

	// Gate 1: Meaningful progress check
	const hasProgress = taskProgress.editedFiles || taskProgress.producedArtifacts || taskProgress.ranTests;
	if (!hasProgress) {
		return false;
	}

	return true;
}

/**
 * Compute the task progress signal from a task's state and artifacts directory.
 *
 * - editedFiles: true if task has artifact files or a non-empty result
 * - producedArtifacts: true if artifacts directory contains task-specific files
 * - ranTests: true if result text contains test-related keywords
 *
 * @param task - The task state to analyze
 * @param artifactsDir - Path to the artifacts directory
 * @returns TaskProgressSignal indicating what progress was made
 */
export function computeTaskProgressSignal(task: TeamTaskState, artifactsDir: string): TaskProgressSignal {
	// editedFiles: check if task has artifact descriptors or a non-empty result
	const hasResultArtifact = task.resultArtifact !== undefined;
	const hasNonEmptyResult = task.resultArtifact?.path !== undefined;
	const editedFiles = hasResultArtifact || hasNonEmptyResult;

	// producedArtifacts: check artifacts directory for task-specific files
	let producedArtifacts = false;
	if (artifactsDir && fs.existsSync(artifactsDir)) {
		try {
			const entries = fs.readdirSync(artifactsDir);
			// Look for files/directories that START with the task ID prefix.
			// Using startsWith instead of includes to avoid false positives
			// from short task IDs like "01" matching unrelated entries.
			const taskPrefix = task.id.replace(/[^a-zA-Z0-9_-]/g, "");
			producedArtifacts = entries.some((entry) => {
				const baseName = entry.split(".")[0] ?? entry;
				return baseName.startsWith(taskPrefix);
			});
		} catch {
			producedArtifacts = false;
		}
	}

	// ranTests: check if result-related fields contain test keywords
	let ranTests = false;
	const textToSearch = [
		task.error ?? "",
		task.terminalEvidence ? JSON.stringify(task.terminalEvidence) : "",
		task.diagnostics ? JSON.stringify(task.diagnostics) : "",
	].join(" ");

	const lowerText = textToSearch.toLowerCase();
	ranTests = TEST_KEYWORDS.some((keyword) => lowerText.includes(keyword.toLowerCase()));

	return { editedFiles, producedArtifacts, ranTests };
}
