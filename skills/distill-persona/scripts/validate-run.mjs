#!/usr/bin/env node
// validate-run.mjs — machine-checked RUN-completion gate for distillation runs.
//
// Complements validate-skill-structure.mjs (which checks the OUTPUT skill's STRUCTURE —
// frontmatter, sections, anti-drift tables). This checks the RUN: did the agent produce
// every required process artifact + fire every gate? Both must pass before claiming done:
//   validate-skill-structure.mjs <skill-dir>   →  output skill structure
//   validate-run.mjs <run-dir>                 →  run completeness (this script)
//
// ALSO checks Phase 4 APPLY evidence (software + persona flavors): APPLY-LOG.md must
// exist at run-dir root, documenting what was edited in the TARGET (SKILL.md is the
// intermediate essence, not the deliverable — distillation = source → essence → APPLY).
//
// Run BEFORE claiming done. If you feel tempted to skip a phase to save effort,
// THAT is exactly when you must run the gate. A skipped gate = a failed run.
//
// Usage:
//   node validate-run.mjs <run-dir>                          →  distillation run completeness
//   node validate-run.mjs <skill-dir> --build                →  engine-skill build completeness
//                                                              (--build: skips APPLY-LOG, alias-tolerant evidence,
//                                                               AND Phase 2.7/5.5 checks — engine builds have no target-apply)
//
// Exit codes: 0 = ALL-GREEN (run complete — may ship); 1 = NOT READY (produce missing artifacts, re-run).

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const runDir = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);
if (!runDir || !existsSync(runDir) || !statSync(runDir).isDirectory()) {
	console.error('Usage: validate-run.mjs <run-dir>');
	console.error('  <run-dir> = directory holding the distillation artifacts (SKILL.md, FIDELITY.md, …)');
	process.exit(2);
}

const isBuild = process.argv.includes('--build');
// Mode auto-detection (default mode; --build stays Capture and skips these):
//   APPLY mode   = APPLY-LOG.md present at run-dir root → SKILL.md optional (deliverable = target transformed)
//   CAPTURE mode = no APPLY-LOG.md                    → SKILL.md + FIDELITY required (current behavior)
const applyLogExists = existsSync(join(runDir, 'APPLY-LOG.md'));
const isApplyMode = !isBuild && applyLogExists;
const isCaptureMode = !isBuild && !applyLogExists;

const failures = [];
const passes = [];
const check = (label, ok, detail = '') => {
	(ok ? passes : failures).push(ok ? `  ✓ ${label}` : `  ✗ ${label}${detail ? ' — ' + detail : ''}`);
};

const readText = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

// count list/table items under a heading (mirrors validate-skill-structure.mjs)
function countListItems(haystack, headingRe, windowChars = 2000) {
	const m = haystack.match(headingRe);
	if (!m) return { found: false, count: 0 };
	const after = haystack.slice(m.index);
	const section = after.match(/([\s\S]*?)\n##(?=[^#])/);
	const block = section ? section[1] : after.slice(0, windowChars);
	const listItems = (block.match(/^\s*(?:\d+[.)]|[-*])\s+\S/gm) || []).length;
	const tableRows = (block.match(/^\s*\|(?![\s:|-]+\|?\s*$).+\|/gm) || []).length;
	return { found: true, count: listItems + tableRows };
}

// hint: does a file exist at the flat research/ path? (artifact-scattering signal)
const flatHint = (name) => existsSync(join(runDir, 'research', name)) ? ' (found at research/ — artifact scattering; canonical path is references/research/)' : '';

// --- SKILL.md ---
// Apply mode: optional (deliverable = target transformed + APPLY-LOG, NOT a skill file).
// Capture/build mode: required at run-dir root (NOT scattered elsewhere).
const skillPath = join(runDir, 'SKILL.md');
const skillText = readText(skillPath);
if (isApplyMode && !skillText) {
	passes.push('  ℹ no SKILL.md — correct for Apply mode (deliverable = target transformed + APPLY-LOG)');
} else {
	check('SKILL.md exists at run-dir root (NOT scattered elsewhere)', !!skillText,
		!skillText ? 'missing — did you install it to ~/.pi/agent/skills/ early? Keep it in run-dir until ALL-GREEN' : '');
}

let isSoftware = false;
let isPersona = false;
let isTopic = false; // research/topic flavor — its 'apply' is a validated report; no APPLY-LOG required

if (skillText) {
	const fm = skillText.match(/^---\n([\s\S]*?)\n---/);
	check('SKILL.md: frontmatter --- block present', !!fm, 'no --- block at top');
	const fmText = fm ? fm[1] : '';

	const PLACEHOLDERS = [/<person>/i, /<target>/i, /<topic>/i, /<field>/i, /TODO/i, /TBD/i, /XXX/i, /YYYY-MM-DD/i, /\.\.\.\s*<\/?/i];
	const found = PLACEHOLDERS.filter((re) => re.test(skillText));
	check('SKILL.md: no unresolved placeholder text', found.length === 0,
		found.map((re) => skillText.match(re)?.[0]).filter(Boolean).join(', '));

	// flavor auto-detect
	isSoftware = /target:\s*(software|codebase|engineer)/i.test(fmText) || /code-?dna|代码表达DNA|code expression/i.test(skillText);
	isPersona = !isSoftware && (/target:\s*(person|topic)/i.test(fmText) || /mental.?model/i.test(skillText));
	isTopic = /target:\s*topic/i.test(fmText); // exclude topic/research flavor from APPLY checks

	if (isSoftware) {
		check('[software] Code-DNA section present', /代码表达DNA|Code Expression-DNA|code.?dna/i.test(skillText), 'missing 代码表达DNA/code-DNA section');
		check('[software] toolchain matrix present', /toolchain|eslint|oxlint|biome|tsconfig|deno|rustfmt/i.test(skillText), 'no toolchain detection');
		check('[software] distilled_against anchor present', /distilled_against/i.test(fmText) || /distilled_against/i.test(skillText), 'no distilled_against staleness anchor');
	}

	if (isPersona) {
		check('[persona] mental-models section present', /mental.?model|心智模型|核心心智模型/i.test(skillText), 'no mental-models section');
		const boundary = countListItems(skillText, /诚实边界|honest boundar(?:y|ies)/i);
		check('[persona] honest-boundaries ≥3 items', boundary.count >= 3, boundary.found ? `found ${boundary.count} items` : 'section missing');
	}
}

// --- Fallback flavor detection (when SKILL.md is absent/scattered) ---
// Needed because isSoftware/isPersona are only set inside if(skillText); a run that
// skipped APPLY often also has no SKILL.md at the run-dir root (it was installed early
// or never written there). Detect software flavor from research/CODE-DNA.md so the
// APPLY-evidence checks still fire for the all-too-common 'wrote SKILL, skipped APPLY' case.
if (!isSoftware && !isPersona && !isTopic) {
	if (existsSync(join(runDir, 'references', 'research', 'CODE-DNA.md')) ||
	    existsSync(join(runDir, 'research', 'CODE-DNA.md')) ||
	    /code-?dna/i.test(basename(runDir))) {
		isSoftware = true;
	}
}

// --- APPLY-LOG.md (Phase 3 APPLY evidence — Apply mode only) ---
// Apply mode (APPLY-LOG.md present): the deliverable is the target transformed — these
// checks are REQUIRED. Capture mode (--build or no APPLY-LOG): skipped (no target-apply).
// Gated on isApplyMode (not flavor) so it fires even when SKILL.md is absent in Apply mode.
if (isApplyMode) {
	const applyLogPath = join(runDir, 'APPLY-LOG.md');
	const applyText = readText(applyLogPath);
	check('APPLY-LOG.md exists at run-dir root', !!applyText,
		!applyText ? 'Phase 4 APPLY missing — SKILL.md is intermediate, not the deliverable. Distillation = source → essence → APPLY to target. A standalone SKILL.md = NOT complete.' : '');
	if (applyText) {
		// count list items + table rows across the whole file (mirrors countListItems)
		const applyItems = (applyText.match(/^\s*(?:\d+[.)]|[-*])\s+\S/gm) || []).length
			+ (applyText.match(/^\s*\|(?![\s:|-]+\|?\s*$).+\|/gm) || []).length;
		check('APPLY-LOG: ≥3 applied items', applyItems >= 3, `found ${applyItems} item(s) — need ≥3 concrete edits in the target`);
		const pathRefs = /\/[\w.-]+\.\w{1,4}|src\/|AGENTS\.md|scripts\/|package\.json|tsconfig/i.test(applyText);
		check('APPLY-LOG: references target file paths', pathRefs, 'no file-path-like tokens found — add paths proving real edits (not just claims)');
		const verified = /test|typecheck|build|bundle|lint|pass|green|✅|97\/97|all-green/i.test(applyText);
		check('APPLY-LOG: verification evidence (test/typecheck/bundle/lint pass)', verified, 'no verification keyword found — add test/build/lint pass evidence');
	}
}

// --- FIDELITY.md ---
// --build mode: accept references/fidelity.md as an alias (workflow produces it there)
const fidText = isBuild
	? (readText(join(runDir, 'FIDELITY.md')) || readText(join(runDir, 'references', 'fidelity.md')))
	: readText(join(runDir, 'FIDELITY.md'));
const fidLabel = isBuild ? 'FIDELITY.md exists (root or references/fidelity.md)' : 'FIDELITY.md exists at run-dir root';
check(fidLabel, !!fidText, !fidText ? 'missing' : '');
if (fidText) {
	const totalMatch = fidText.match(/(?:总分|total)[：:\s*]*\*{0,2}([0-9]+)\s*\*?\s*(?:\/|／|\sout\sof\s)\s*\*?\s*100/i);
	check('FIDELITY.md: /100 total score present', !!totalMatch, totalMatch ? `=${totalMatch[1]}/100` : 'no /100 score found');
	const qCount = (fidText.match(/(?:Q[1-5]|问题[1-5]|question\s*[1-5])/gi) || []).length;
	check('FIDELITY.md: ≥5 test-question references', qCount >= 5, `found ${qCount} question refs`);
	check('FIDELITY.md: flags single-agent/self-score caveat',
		/单\s*agent|single.?agent|self.?score|upper.?bound|independent/i.test(fidText),
		'add single-agent upper-bound caveat');
}

// --- DISTILLATION-PROCESS-CHECKLIST.md ---
const procText = readText(join(runDir, 'DISTILLATION-PROCESS-CHECKLIST.md'));
check('DISTILLATION-PROCESS-CHECKLIST.md exists', !!procText, !procText ? 'missing — every phase + the 3-round deep-dive gate must be tracked' : '');
if (procText) {
	const dangling = (procText.match(/\|\s*[⬜⏳][^|]*\|/gu) || []).length;
	check('process: no dangling ⬜/⏳ phase rows (every phase completed)', dangling === 0, dangling ? `${dangling} phase(s) not done` : '');
	check('process: deep-dive round-log table present', /round log|\| *Round.*New findings/i.test(procText), 'add the round-log table');
	check('process: 3-empty-rounds gate fired', /gate fires|3 consecutive (empty|zero)|GATE FIRES/i.test(procText),
		'record ≥3 consecutive zero-new rounds before declaring a phase done');
}

// --- EXCAVATION-CHECKLIST.md ---
const excText = readText(join(runDir, 'EXCAVATION-CHECKLIST.md'));
check('EXCAVATION-CHECKLIST.md exists', !!excText, !excText ? 'missing — Phase 1 protocol requires one' : '');
if (excText) {
	const danglingExc = (excText.match(/\|\s*[⬜⏳][^|]*\|/gu) || []).length;
	check('excavation: no dangling ⬜/⏳ rows (every part resolved)', danglingExc === 0, danglingExc ? `${danglingExc} row(s) not resolved` : '');
	const ratioMatch = excText.match(/memory-ratio[:\s]*([0-9]+)\s*%/i);
	if (ratioMatch) {
		const ratio = parseInt(ratioMatch[1], 10);
		check('excavation: 🧠 memory-ratio ≤30%', ratio <= 30, `declared ${ratio}% (>30% = recap, not distillation)`);
	} else {
		check('excavation: declares memory-ratio', false, 'add "🧠 memory-ratio: NN% (X/Y)" header');
	}
	const proofCells = (excText.match(/"[^"]{8,}"/g) || []).length;
	check('excavation: ≥1 proof-of-read (verbatim quote cell)', proofCells >= 1, `${proofCells} quote cell(s)`);
}

// --- references/research/ artifacts (canonical path — solves scattering) ---
const researchDir = join(runDir, 'references', 'research');

if (isBuild) {
	// --- BUILD MODE: alias-tolerant evidence checks ---
	// Engine skills use different file names than distillation runs.
	// Accept canonical names OR common aliases OR name/content regex matches.
	const refsDir = join(runDir, 'references');

	// Helper: find a file under references/ or references/research/ by name regex or content regex
	function findRef(nameRe, contentRe) {
		const dirs = [refsDir, researchDir].filter((d) => existsSync(d) && statSync(d).isDirectory());
		for (const d of dirs) {
			for (const f of readdirSync(d)) {
				const fp = join(d, f);
				if (!existsSync(fp) || !statSync(fp).isFile()) continue;
				if (nameRe && nameRe.test(f)) return fp;
				if (contentRe) {
					const txt = readText(fp);
					if (txt && contentRe.test(txt)) return fp;
				}
			}
		}
		return null;
	}

	// 1. Coverage evidence
	const covPath =
		existsSync(join(researchDir, 'COVERAGE-MANIFEST.md')) ? join(researchDir, 'COVERAGE-MANIFEST.md')
		: existsSync(join(refsDir, 'source-inventory.md')) ? join(refsDir, 'source-inventory.md')
		: existsSync(join(refsDir, 'coverage-manifest.md')) ? join(refsDir, 'coverage-manifest.md')
		: findRef(null, /UNCOVERED.*COVERED|covered.*parts/i);
	const covTextB = covPath ? readText(covPath) : null;
	check('coverage evidence present (COVERAGE-MANIFEST | source-inventory | coverage-manifest | content-match)',
		!!covTextB, !covTextB ? 'missing — no coverage evidence found under references/' : `found: ${covPath}`);
	if (covTextB) {
		const uncovered = (covTextB.match(/\|\s*UNCOVERED[^|]*\|/gi) || []).length;
		check('coverage: no dangling UNCOVERED rows', uncovered === 0, uncovered ? `${uncovered} part(s) not covered` : '');
	}

	// 2. V5/citation-verify evidence
	const v5Path =
		existsSync(join(researchDir, 'V5-VERIFICATION.md')) ? join(researchDir, 'V5-VERIFICATION.md')
		: existsSync(join(refsDir, 'verified-models.md')) ? join(refsDir, 'verified-models.md')
		: findRef(/v5|verified|citation/i, null);
	check('V5/citation-verify evidence present (V5-VERIFICATION | verified-models | name-match)',
		!!v5Path, !v5Path ? 'missing — no V5/citation evidence found under references/' : `found: ${v5Path}`);

	// 3. Effectiveness-gate evidence
	const effPath =
		existsSync(join(researchDir, 'EFFECTIVENESS-VERIFICATION.md')) ? join(researchDir, 'EFFECTIVENESS-VERIFICATION.md')
		: existsSync(join(refsDir, 'effectiveness-gate.md')) ? join(refsDir, 'effectiveness-gate.md')
		: existsSync(join(refsDir, 'three-filter.md')) ? join(refsDir, 'three-filter.md')
		: findRef(/effectiveness|three-filter|gate/i, null);
	// FIDELITY.md validates the built skill reproduces the target — for an engine-skill BUILD that IS effectiveness
	// evidence. The pre-apply effectiveness-gate.md is a forward-looking workflow artifact, not retroactively required
	// for hand-built engine skills (research/persona/software predate Phase 2.6).
	const effViaFidelity = !effPath && !!fidText;
	check('effectiveness-gate evidence present (EFFECTIVENESS-VERIFICATION | effectiveness-gate | three-filter | FIDELITY.md)',
		!!effPath || effViaFidelity, (!effPath && !effViaFidelity) ? 'missing — no effectiveness evidence found under references/ or FIDELITY.md' : `found: ${effPath || 'FIDELITY.md'}`);
} else {
	// --- DEFAULT MODE: strict canonical paths (UNCHANGED — byte-for-byte equivalent) ---
	const covText = readText(join(researchDir, 'COVERAGE-MANIFEST.md'));
	check('references/research/COVERAGE-MANIFEST.md exists', !!covText, !covText ? 'missing' + flatHint('COVERAGE-MANIFEST.md') : '');
	if (covText) {
		const uncovered = (covText.match(/\|\s*UNCOVERED[^|]*\|/gi) || []).length;
		check('coverage: no dangling UNCOVERED rows', uncovered === 0, uncovered ? `${uncovered} part(s) not covered` : '');
	}

	const v5Exists = existsSync(join(researchDir, 'V5-VERIFICATION.md'));
	check('references/research/V5-VERIFICATION.md exists', v5Exists, !v5Exists ? 'missing' + flatHint('V5-VERIFICATION.md') : '');

	const effExists = existsSync(join(researchDir, 'EFFECTIVENESS-VERIFICATION.md'));
	check('references/research/EFFECTIVENESS-VERIFICATION.md exists', effExists, !effExists ? 'missing' + flatHint('EFFECTIVENESS-VERIFICATION.md') : '');
}

// --- Phase 2.7 + 5.5 anti-lazy gate checks (APPLY mode only) ---
// apply-plan + scrutinize are APPLY-mode artifacts (they assume a target to apply to).
// CAPTURE mode (skill-build: --build, or no APPLY-LOG = persona/workflow) has no target-apply → skip.
if (isApplyMode) {
	// Phase 2.7 output: references/apply-plan.md
	const applyPlanPath = join(runDir, 'references', 'apply-plan.md');
	const applyPlanText = readText(applyPlanPath);
	check('references/apply-plan.md exists (Phase 2.7 plan-approval gate output)', !!applyPlanText,
		!applyPlanText ? 'missing — Phase 2.7 requires a plan table output' : '');
	if (applyPlanText) {
		const hasApproval = /APPROVED|LOW-YIELD DEFENSE/i.test(applyPlanText);
		check('apply-plan: approval or defense present (APPROVED | LOW-YIELD DEFENSE)', hasApproval,
			!hasApproval ? 'Phase 2.7 plan-approval gate not respected — present the plan and get approval (interactive) or write a LOW-YIELD DEFENSE (autonomous).' : '');
	}

	// Phase 5.5 output: SCRUTINIZE-REPORT.md at run-dir root
	check('SCRUTINIZE-REPORT.md exists at run-dir root (Phase 5.5 adversarial scrutinize)', existsSync(join(runDir, 'SCRUTINIZE-REPORT.md')),
		!existsSync(join(runDir, 'SCRUTINIZE-REPORT.md')) ? 'Phase 5.5 adversarial scrutinize not run — laziness unaudited.' : '');
}

// --- Report ---
console.log(`\nvalidate-run: ${basename(runDir)}`);
console.log(`path: ${runDir}\n`);
passes.forEach((l) => console.log(l));
failures.forEach((l) => console.log(l));
const flavorTag = isSoftware ? ' [software]' : isPersona ? (isTopic ? ' [topic]' : ' [persona]') : '';
const modeTag = isBuild
	? ' [build mode — APPLY-LOG + strict-run checks skipped]'
	: isApplyMode
		? ' [apply mode — SKILL.md optional]'
		: ' [capture mode]';
console.log(`\n${passes.length} pass, ${failures.length} fail — ${failures.length === 0 ? '✅ ALL-GREEN (may ship)' : '🔴 NOT READY (produce the missing artifacts, then re-run)'}${flavorTag}${modeTag}\n`);
process.exit(failures.length === 0 ? 0 : 1);
