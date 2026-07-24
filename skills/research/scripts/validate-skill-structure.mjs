#!/usr/bin/env node
// validate-skill-structure.mjs — structural invariant checker for generated distill skills.
// Implements F10 (awesome-persona-distill-skills finding): hard-fail if any structural assertion fails.
// Run AFTER Phase 3 build, BEFORE Phase 4 behavioral fidelity. Self-contained (stdlib only).
//
// Usage:
//   node validate-skill-structure.mjs <path-to-SKILL.md>
//   node validate-skill-structure.mjs <skill-dir>
//
// Exit codes: 0 = all assertions pass (all-green → may ship); 1 = one or more failed (iterate).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

const target = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);
if (!target) {
	console.error('Usage: validate-skill-structure.mjs <path-to-SKILL.md | skill-dir> [--engine]');
	process.exit(2);
}

// Resolve to a SKILL.md path
let skillPath = target;
if (statSync(target).isDirectory()) {
	skillPath = join(target, 'SKILL.md');
}
if (!existsSync(skillPath)) {
	console.error(`✗ Not found: ${skillPath}`);
	process.exit(2);
}

const src = readFileSync(skillPath, 'utf8');
const dir = dirname(skillPath);
const name = basename(dir);
const isEngine = process.argv.includes('--engine');
const PLACEHOLDERS = [/<person>/i, /<target>/i, /<topic>/i, /<field>/i, /TODO/i, /TBD/i, /XXX/i, /YYYY-MM-DD/i, /\.\.\.\s*<\/?/i];

const failures = [];
const passes = [];
const check = (label, ok, detail = '') => {
	(ok ? passes : failures).push(ok ? `  ✓ ${label}` : `  ✗ ${label}${detail ? ' — ' + detail : ''}`);
};

// --- Frontmatter ---
const fm = src.match(/^---\n([\s\S]*?)\n---/);
check('frontmatter block present', !!fm, 'no --- block at top');
const fmText = fm ? fm[1] : '';
const fmField = (key) => {
	const m = fmText.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
	return m ? m[1].trim() : null;
};
const hasFm = (key) => new RegExp(`^${key}:`, 'm').test(fmText);

check('frontmatter: name', hasFm('name'));
check('frontmatter: description', hasFm('description'));
const desc = fmField('description');
check('frontmatter: description ≤1 sentence (one terminal punct or one clause)',
	desc ? desc.split(/[.。!！?？]/).filter(Boolean).length <= 2 : false,
	desc ? `got: "${desc.slice(0, 60)}…"` : 'missing');
check('frontmatter: triggers', hasFm('triggers') || hasFm('trigger'), 'no triggers field');
if (!isEngine) check('frontmatter: distilled (staleness date)', hasFm('distilled') || hasFm('调研时间'), 'no distilled/调研时间 staleness anchor');
const distilled = fmField('distilled') || fmField('调研时间');
check('frontmatter: distilled is valid date (YYYY-MM-DD)',
	!distilled || /^\d{4}-\d{2}-\d{2}/.test(distilled),
	distilled ? `got "${distilled}"` : '');
if (!isEngine) check('frontmatter: target (person|topic|software)', hasFm('target'), 'no target field');

// --- Body sections ---
check('Agentic Protocol section present', /回答工作流|Agentic Protocol/i.test(src));
check('Agentic Protocol Step 1', /Step 1|第一步|步骤 1|### 1\b/i.test(src));
check('Agentic Protocol Step 2', /Step 2|第二步|步骤 2|### 2\b/i.test(src));
check('Agentic Protocol Step 3', /Step 3|第三步|步骤 3|### 3\b/i.test(src));

// honest boundaries: count items (numbered list or bullets) under an honest-boundaries heading
function countListItems(haystack, headingRe, windowChars = 2000) {
	const m = haystack.match(headingRe);
	if (!m) return { found: false, count: 0, block: '' };
	const after = haystack.slice(m.index);
	const section = after.match(/([\s\S]*?)\n##(?=[^#])/);
	const block = section ? section[1] : after.slice(0, windowChars);
	// count BOTH list items AND table data rows (rows with | content |, excluding separator rows)
	const listItems = (block.match(/^\s*(?:\d+[.)]|[-*])\s+\S/gm) || []).length;
	const tableRows = (block.match(/^\s*\|(?![\s:|-]+\|?\s*$).+\|/gm) || []).length;
	return { found: true, count: listItems + tableRows, block };
}
if (!isEngine) {
	const boundary = countListItems(src, /诚实边界|honest boundar(?:y|ies)/i);
	check('honest boundaries (M11) ≥3', boundary.count >= 3, `found ${boundary.count} items`);
}

// --- Anti-drift tables (M9a 内在张力, M9b 反例黑名单, M12 fallback tree) — Darwin gap #2: validator previously skipped these
if (!isEngine) {
	const tension = countListItems(src, /M9a|内在张力|inner tension|internal tension/i);
	check('内在张力 (M9a) ≥3 tension pairs', tension.count >= 3, tension.found ? `found ${tension.count} items` : 'section missing');

	const blacklist = countListItems(src, /M9b|反例黑名单|anti.?pattern blacklist/i);
	check('反例黑名单 (M9b) ≥7 rows', blacklist.count >= 7, blacklist.found ? `found ${blacklist.count} rows` : 'section missing');

	const fallback = countListItems(src, /M12|失败模式.*[Ff]allback|[Ff]allback\s*树/i);
	check('失败模式Fallback树 (M12) ≥8 rows', fallback.count >= 8, fallback.found ? `found ${fallback.count} rows` : 'section missing');
}

// --- FIDELITY.md companion artifact (Darwin gap #3: ship-gate requires it but nothing checked)
const fidelityPath = join(dir, 'FIDELITY.md');
if (existsSync(fidelityPath)) {
	const fm2 = readFileSync(fidelityPath, 'utf8');
	const totalMatch = fm2.match(/(?:总分|total)[：:\s*]*\*{0,2}([0-9]+)\s*\*?\s*(?:\/|／|\sout\sof\s)\s*\*?\s*100/i);
	check('FIDELITY.md total score present', !!totalMatch, totalMatch ? `=${totalMatch[1]}/100` : 'no /100 score found');
	const qCount = (fm2.match(/(?:Q[1-5]|问题[1-5]|question\s*[1-5])/gi) || []).length;
	check('FIDELITY.md ≥5 test questions', qCount >= 5, `found ${qCount} question refs`);
	check('FIDELITY.md flags single-agent/self-score caveat', /单\s*agent|single.?agent|self.?score|upper.?bound|independent/i.test(fm2), 'add single-agent upper-bound caveat');
} else if (!isEngine) {
	check('FIDELITY.md companion present', false, 'no FIDELITY.md in skill dir');
}

// --- EXCAVATION-CHECKLIST.md (Phase 1 protocol: track + verify each part was really read)
const checklistPath = join(dir, 'EXCAVATION-CHECKLIST.md');
if (existsSync(checklistPath)) {
	const cl = readFileSync(checklistPath, 'utf8');
	// dangling rows: status ⬜ not-started or ⏳ reading left at ship time = silently skipped/forgotten
	const dangling = (cl.match(/\|\s*[⬜⏳][^|]*\|/gu) || []).length;
	check('checklist: no dangling ⬜/⏳ rows (every part resolved)', dangling === 0, dangling ? `${dangling} row(s) not-started/reading — resolve to ✅📄/⏭/🧠` : '');
	// memory ratio: parse "memory-ratio: NN%" if declared
	const ratioMatch = cl.match(/memory-ratio[:\s]*([0-9]+)\s*%/i);
	if (ratioMatch) {
		const ratio = parseInt(ratioMatch[1], 10);
		check('checklist: 🧠 memory-ratio ≤30%', ratio <= 30, `declared ${ratio}% (>30% = recap, not distillation)`);
	} else {
		check('checklist: declares memory-ratio', false, 'add "🧠 memory-ratio: NN% (X/Y findings)" header line');
	}
	// proof-of-read present: at least one verbatim-quote-with-location cell (heuristic — a ✅ row should carry a quote)
	const proofCells = (cl.match(/"[^"]{8,}"[^|]*/g) || []).length;
	check('checklist: ≥1 proof-of-read (verbatim quote in a ✅ row)', proofCells >= 1, `${proofCells} quote cell(s) found`);
} else if (!isEngine) {
	check('EXCAVATION-CHECKLIST.md present', false, 'no excavation checklist — Phase 1 protocol requires one');
}

// --- DISTILLATION-PROCESS-CHECKLIST.md (whole-pipeline tracking + the 3-empty-rounds deep-dive gate)
const procPath = join(dir, 'DISTILLATION-PROCESS-CHECKLIST.md');
if (existsSync(procPath)) {
	const pc = readFileSync(procPath, 'utf8');
	// dangling phases: ⬜/⏳ left in the phase-progress table at ship = a phase skipped
	const danglingPhases = (pc.match(/\|\s*[⬜⏳][^|]*\|/gu) || []).length;
	check('process: no dangling ⬜/⏳ phases (every phase completed)', danglingPhases === 0, danglingPhases ? `${danglingPhases} phase(s) not done` : '');
	// deep-dive round log present
	check('process: deep-dive round log present', /round log|\| *Round.*New findings/i.test(pc), 'add the round-log table');
	// 3-empty-rounds gate recorded (≥3 consecutive zero-new rounds before leaving a phase)
	const gateFired = /gate fires|3 consecutive (empty|zero)|GATE FIRES/i.test(pc);
	check('process: 3-empty-rounds gate recorded (≥3 zero-new rounds)', gateFired, 'record a round-log row marked gate-fired before declaring any research phase done');
} else if (!isEngine) {
	check('DISTILLATION-PROCESS-CHECKLIST.md present', false, 'no process checklist — every phase + the 3-round deep-dive gate must be tracked');
}

// --- Placeholders ---
const foundPlaceholders = PLACEHOLDERS.filter((re) => re.test(src));
if (!isEngine) check('no unresolved placeholder text', foundPlaceholders.length === 0,
	foundPlaceholders.map((re) => src.match(re)?.[0]).filter(Boolean).join(', '));

// --- Self-containment (F9): references/sources should not dangle outside the dir ---
const refsDir = join(dir, 'references');
if (!isEngine) check('self-contained: no external repo paths in body (e.g. 07-调研/)',
	!/[\w/-]*调研与分析?\/|src\/|source\//i.test(src.replace(/```[\s\S]*?```/g, '')),
	'body references paths outside skill dir');

// --- Software-specific assertions (if target: software) ---
if (/target:\s*software/i.test(fmText) || /code-dna|代码表达DNA|code expression/i.test(src)) {
	check('[software] Code Expression-DNA section present', /代码表达DNA|Code Expression-DNA|code.?dna/i.test(src));
	check('[software] toolchain matrix present', /toolchain|eslint|oxlint|biome|tsconfig/i.test(src));
	check('[software] distilled_against commit anchor', hasFm('distilled_against') || /distilled_against/i.test(src));
}

// --- Report ---
console.log(`\nvalidate-skill-structure: ${name}`);
console.log(`path: ${skillPath}\n`);
passes.forEach((l) => console.log(l));
failures.forEach((l) => console.log(l));
console.log(`\n${passes.length} pass, ${failures.length} fail — ${failures.length === 0 ? '✅ ALL-GREEN (may ship)' : '🔴 NOT READY (iterate Phase 2→3)'}${isEngine ? ' [engine mode — generated-skill checks skipped]' : ''}\n`);
process.exit(failures.length === 0 ? 0 : 1);
