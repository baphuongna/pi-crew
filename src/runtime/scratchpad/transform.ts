/**
 * Cell transform: TypeScript cell → sloppy-mode async body run under
 * `with (proxy)` against the persistent namespace.
 *
 * - Types are stripped with esbuild's transform (pi-crew's runtime
 *   dependency; Bun.Transpiler is not available here). esbuild does not run
 *   dead-code elimination in transform mode, so side-effect-free trailing
 *   expressions — exactly what this transform captures as the cell result —
 *   survive untouched.
 * - Top-level imports become awaited dynamic imports, since the body is a
 *   function body rather than a module. They are rewritten from the ORIGINAL
 *   source before type stripping: esbuild elides unused imports, and the
 *   reference behaviour binds every imported name into the namespace so it
 *   persists across cells. (The pipeline's ImportDeclaration branch is kept
 *   for fidelity and as a fallback for any import that survives.)
 * - Top-level declarations become plain assignments, so each binding reaches
 *   the namespace at its own statement site. Two behaviours depend on this:
 *   a closure must observe later rebinding of a name, and names bound before a
 *   cell throws or is cancelled must survive. Copying the bindings out once at
 *   the end of the cell delivers neither — that copy never runs on the paths
 *   that matter.
 * - A trailing expression statement is captured as the cell result.
 */

import type { ClassDeclaration, FunctionDeclaration, ImportDeclaration, Node, Pattern, Program, VariableDeclaration } from "acorn";
import { parse, tokenizer } from "acorn";
import { transformSync } from "esbuild";

export interface TransformedCell {
	/** Body statements to run inside the async `with` wrapper. */
	body: string;
	/** Top-level names this cell binds into the namespace. */
	declaredNames: string[];
	/**
	 * P6: line-based position map — for each body line (1-based), the
	 * corresponding SOURCE line (1-based) the model wrote. Used to remap the
	 * V8-reported error line (relative to `body`) back to the cell's original
	 * line so stack traces point at the source the user wrote, not the
	 * transformed body. Built WITHOUT a source-map dependency by tracking
	 * replacement newline shifts against the source (acorn `locations`).
	 */
	lineMap: { sourceLine: number; bodyLine: number }[];
}

export interface TransformOptions {
	/** Identifier the wrapper binds the cell context to. */
	ctxName?: string;
}

// esbuild's transform strips types but never drops side-effect-free trailing
// expressions (no DCE in transform mode) — the exact thing we capture as the
// cell result.
// P6: `sourcemap: 'inline'` so we can map the stripped `js` lines back to the
// `rewritten` (pre-strip) lines — esbuild does NOT preserve line numbers
// across type stripping (probe: 7 input lines → 5 output lines). The inline
// sourcemap is stripped from the output (it would otherwise leak into the cell
// body as a trailing comment); we only keep the decoded line map.
function stripTypes(code: string): { code: string; lineMap: number[] } {
	const out = transformSync(code, { loader: "ts", sourcemap: "inline" });
	const lineMap = esbuildLineMap(out.code);
	const codeWithoutMap = out.code.replace(/\/\/# sourceMappingURL=data:application\/json;base64,[A-Za-z0-9+/=]+\s*$/, "");
	return { code: codeWithoutMap, lineMap };
}

// ── top-level import extraction ──────────────────────────────────────────────
// esbuild elides unused imports during transform, which would silently drop
// `import { a } from "m"` cells that bind a name without using it in the same
// cell (names must persist across cells). So imports are rewritten into
// awaited dynamic imports BEFORE type stripping, using acorn's tokenizer to
// find them robustly (strings, regexes, templates, and dynamic import() /
// import.meta never produce a false statement).

interface LexToken {
	label: string;
	start: number;
	end: number;
	/** Raw source text (token.value is the parsed value; the raw slice is what
	 * the fragment rebuild needs). */
	value: string;
}

interface ImportStatement {
	/** Start of the `import` keyword. */
	start: number;
	/** End of the statement (module specifier, or trailing `;` when present). */
	end: number;
	/** First and last token indices (inclusive) in the global token array. */
	firstToken: number;
	lastToken: number;
	/** Whole-statement `import type …` — erased, binds nothing at runtime. */
	typeOnly: boolean;
}

function lexTopLevel(code: string): LexToken[] {
	const tokens: LexToken[] = [];
	const tok = tokenizer(code, { ecmaVersion: "latest" });
	let current: { type: { label: string }; start: number; end: number };
	while ((current = tok.getToken() as { type: { label: string }; start: number; end: number }).type.label !== "eof") {
		tokens.push({
			label: String(current.type.label),
			start: current.start,
			end: current.end,
			value: code.slice(current.start, current.end),
		});
	}
	return tokens;
}

function findImportStatements(tokens: LexToken[]): ImportStatement[] {
	const found: ImportStatement[] = [];
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].label !== "import") continue;
		const prev = i > 0 ? tokens[i - 1].label : null;
		const next = i + 1 < tokens.length ? tokens[i + 1].label : null;
		// Dynamic import(...), import.meta, and property access `x.import` are
		// expressions, not statements.
		if (prev === "." || next === null || next === "(" || next === ".") continue;

		const j = i + 1;
		let lastToken = -1;
		let typeOnly = false;
		// Whole-statement `import type …` — `type` followed by a string, `{`,
		// or `*` (a default binding named `type` is followed by `from`).
		if (tokens[j].label === "name" && tokens[j].value === "type") {
			const after = j + 1 < tokens.length ? tokens[j + 1].label : null;
			if (after === "string" || after === "{" || after === "*") typeOnly = true;
		}
		if (tokens[j].label === "string") {
			// Side-effect import: `import "mod";`
			lastToken = j;
		} else {
			// Scan for `from` at bracket depth 0, then the module specifier.
			let depth = 0;
			for (let k = j; k < tokens.length; k++) {
				const label = tokens[k].label;
				if (label === "{" || label === "(" || label === "[") depth++;
				else if (label === "}" || label === ")" || label === "]") depth--;
				else if (depth === 0 && label === "name" && tokens[k].value === "from") {
					const spec = k + 1;
					if (spec < tokens.length && tokens[spec].label === "string") lastToken = spec;
					break;
				}
			}
		}
		if (lastToken === -1) continue; // malformed — leave for the pipeline to surface
		// Consume an optional trailing semicolon into the statement.
		const afterString = lastToken + 1;
		if (afterString < tokens.length && tokens[afterString].label === ";") lastToken = afterString;

		found.push({ start: tokens[i].start, end: tokens[lastToken].end, firstToken: i, lastToken, typeOnly });
	}
	return found;
}

/**
 * Token indices to drop from a named-import fragment for inline `type`
 * specifiers: `import { type X, join } from "m"` → `import { join } from "m"`.
 * The skipped specifier (plus its optional `as` alias) has no runtime binding,
 * exactly like TypeScript's own type-specifier erasure.
 */
function inlineTypeSkipIndices(tokens: LexToken[], firstToken: number, lastToken: number): Set<number> {
	const skip = new Set<number>();
	let depth = 0;
	for (let k = firstToken + 1; k <= lastToken; k++) {
		const tk = tokens[k];
		if (tk.label === "{") depth++;
		else if (tk.label === "}") depth--;
		if (depth < 1) continue;
		// Only a `type` followed by a binding name is a modifier; `{ type }` and
		// `{ type as x }` import a binding literally named `type`.
		if (tk.label !== "name" || tk.value !== "type") continue;
		const nxt = k + 1 <= lastToken ? tokens[k + 1] : undefined;
		if (nxt?.label !== "name" || nxt.value === "as") continue;
		skip.add(k);
		skip.add(k + 1);
		let m = k + 2;
		// `type X as Y`
		if (m <= lastToken && tokens[m].label === "name" && tokens[m].value === "as") {
			skip.add(m);
			if (m + 1 <= lastToken) skip.add(m + 1);
			m += 2;
		}
		// Drop the separator only when more specifiers follow; a trailing comma
		// after the last kept specifier stays valid.
		if (m <= lastToken && tokens[m].label === ",") {
			const after = m + 1 <= lastToken ? tokens[m + 1] : undefined;
			if (after && after.label !== "}") skip.add(m);
		}
	}
	return skip;
}

function importFragment(code: string, stmt: ImportStatement, tokens: LexToken[], skip: Set<number>): string {
	if (skip.size === 0) return code.slice(stmt.start, stmt.end);
	// Rebuild without the skipped tokens; whitespace/comments are dropped but
	// single spaces keep the fragment parseable.
	const parts: string[] = [];
	for (let k = stmt.firstToken; k <= stmt.lastToken; k++) {
		if (skip.has(k)) continue;
		parts.push(tokens[k].value);
	}
	return parts.join(" ");
}

function rewriteImport(code: string, stmt: ImportStatement, tokens: LexToken[]): { replacement: string; declaredNames: string[] } {
	if (stmt.typeOnly) return { replacement: "", declaredNames: [] };
	const skip = inlineTypeSkipIndices(tokens, stmt.firstToken, stmt.lastToken);
	const fragment = importFragment(code, stmt, tokens, skip);
	let node: ImportDeclaration;
	try {
		const program: Program = parse(fragment, { ecmaVersion: "latest", sourceType: "module" });
		node = program.body[0] as ImportDeclaration;
	} catch {
		// Unparseable — leave the original text for the pipeline to surface.
		return { replacement: code.slice(stmt.start, stmt.end), declaredNames: [] };
	}
	const declaredNames: string[] = [];
	for (const spec of node.specifiers) declaredNames.push(spec.local.name);
	// The block wrapper keeps the assignment from being mistaken for the cell's
	// trailing expression: the trailing-expression capture must not treat an
	// import's dynamic-import assignment as a result.
	return { replacement: `{ ${importReplacement(node)} }`, declaredNames };
}

function collectPatternNames(pattern: Pattern, into: string[]): void {
	switch (pattern.type) {
		case "Identifier":
			into.push(pattern.name);
			break;
		case "ObjectPattern":
			for (const prop of pattern.properties) {
				if (prop.type === "RestElement") collectPatternNames(prop.argument, into);
				else collectPatternNames(prop.value, into);
			}
			break;
		case "ArrayPattern":
			for (const element of pattern.elements) if (element) collectPatternNames(element, into);
			break;
		case "AssignmentPattern":
			collectPatternNames(pattern.left, into);
			break;
		case "RestElement":
			collectPatternNames(pattern.argument, into);
			break;
		default:
			break;
	}
}

function importReplacement(node: ImportDeclaration): string {
	const moduleText = JSON.stringify(String(node.source.value));
	const namespaceSpecifier = node.specifiers.find((s) => s.type === "ImportNamespaceSpecifier");
	const defaultSpecifier = node.specifiers.find((s) => s.type === "ImportDefaultSpecifier");
	const namedSpecifiers = node.specifiers.filter((s) => s.type === "ImportSpecifier");

	// Assignments, not declarations: imported bindings must land in the
	// namespace so they persist across cells like any other name.
	const parts: string[] = [];
	if (namespaceSpecifier) parts.push(`${namespaceSpecifier.local.name} = await import(${moduleText});`); // LAZY: codegen emits guest-cell import syntax, not a pi-crew dynamic import
	const destructured: string[] = [];
	if (defaultSpecifier) destructured.push(`default: ${defaultSpecifier.local.name}`);
	for (const spec of namedSpecifiers) {
		const imported = spec.imported.type === "Identifier" ? spec.imported.name : String(spec.imported.value);
		destructured.push(imported === spec.local.name ? imported : `${JSON.stringify(imported)}: ${spec.local.name}`);
	}
	if (destructured.length > 0) parts.push(`({ ${destructured.join(", ")} } = await import(${moduleText}));`); // LAZY: codegen emits guest-cell import syntax
	if (parts.length === 0) parts.push(`await import(${moduleText});`); // LAZY: codegen emits guest-cell import syntax
	return parts.join(" ");
}

/**
 * Rewrite `let/const/var` into assignments so each binding reaches the
 * namespace as it executes. Patterns keep their shape; object patterns need
 * parentheses to stay expressions.
 */
function variableReplacement(decl: VariableDeclaration, source: string): string {
	const statements: string[] = [];
	for (const declarator of decl.declarations) {
		const target = source.slice(declarator.id.start, declarator.id.end);
		if (!declarator.init) {
			// `let x;` — bind the name so later reads resolve.
			statements.push(`${target} = undefined;`);
			continue;
		}
		const init = source.slice(declarator.init.start, declarator.init.end);
		statements.push(declarator.id.type === "ObjectPattern" ? `(${target} = ${init});` : `${target} = ${init};`);
	}
	return statements.join(" ");
}

// ── P6: line-based position map ─────────────────────────────────────────────
// V8 reports a cell error's line as 1-based relative to the TRANSFORMED `body`.
// The model wrote `code`; between them sit 3 transforms:
//   1. import pre-rewrite (acorn)      — collapses multi-line imports to 1 line
//   2. esbuild strip-types             — collapses type annotations/signatures
//   3. declaration → assignment + trailing-expr capture — may add/remove lines
// We build a map { sourceLine (1-based, in `code`) → bodyLine (1-based) } by
// tracking line deltas across each stage with acorn `locations` + newline
// counts. No source-map dependency (probe: esbuild strip-types does NOT
// preserve lines — 7→5 — so a naive single-layer sourcemap would be wrong).

function countNewlines(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
	return n;
}

/** 1-based line of `pos` (char offset) in `text`. */
function lineAt(text: string, pos: number): number {
	let line = 1;
	for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

// ── P6: esbuild inline sourcemap → line map (js → rewritten) ───────────────
// esbuild `sourcemap: 'inline'` emits a base64 VLQ sourcemap whose `mappings`
// field encodes, per generated line, segments mapping back to source
// positions. We only need LINE fidelity (column is overkill for the bug), so
// we decode each generated line's first segment's source line. VLQ is the
// standard base64-variable-length encoding (no dependency needed).

const BASE64: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VLQ: Map<string, number> = new Map([...BASE64].map((c, i) => [c, i]));

function decodeVlqSegment(segment: string): number[] {
	const values: number[] = [];
	let shift = 0;
	let value = 0;
	for (let i = 0; i < segment.length; i++) {
		const digit = VLQ.get(segment[i]);
		if (digit === undefined) break;
		value |= (digit & 31) << shift;
		if (digit & 32) {
			shift += 5;
		} else {
			values.push(value & 1 ? -(value >>> 1) : value >>> 1);
			value = 0;
			shift = 0;
		}
	}
	return values;
}

/**
 * Decode an esbuild inline sourcemap's `mappings` into an array where
 * `lineMapGenerated[generatedLine-1]` = the source LINE (1-based) that
 * generated line originates from (first segment per generated line; falls back
 * to the previous mapped line for continuation lines).
 */
function esbuildLineMap(codeWithInlineMap: string): number[] {
	const m = codeWithInlineMap.match(/\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/);
	if (!m) return [];
	let sm: { mappings?: string };
	try {
		sm = JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) as { mappings?: string };
	} catch {
		return [];
	}
	if (!sm.mappings) return [];
	const result: number[] = [];
	let srcLine = 1;
	let lastSrcLine = 1;
	for (const genLine of sm.mappings.split(";")) {
		const segs = genLine.split(",").filter(Boolean);
		if (segs.length > 0) {
			const vals = decodeVlqSegment(segs[0]);
			// values: [genColDelta, srcIdxDelta, srcLineDelta, srcColDelta, ...]
			if (vals.length >= 3) {
				srcLine += vals[2];
				lastSrcLine = srcLine;
			}
		}
		result.push(lastSrcLine);
	}
	return result;
}

/**
 * Build a `code`-line → `js`-line map across the import pre-rewrite.
 * For each import replacement, its `code` span [codeStart, codeEnd] collapses
 * to `js` lines [jsStart, jsEnd] (usually 1). Lines outside any replacement
 * are identity-shifted by the cumulative delta.
 */
function buildImportLineMap(
	code: string,
	rewritten: string,
	importSpans: { codeStart: number; codeEnd: number; jsStart: number; jsEnd: number }[],
): (src: number) => number {
	if (importSpans.length === 0) return (src) => src;
	// P6 (final): map a `rewritten` (post-import) LINE to the original `code`
	// line. `rewritten` = code with each import statement replaced by its
	// (usually 1-line) dynamic-import fragment. We walk both strings tracking
	// newline counts: between imports the line numbers advance identically;
	// inside an import span, all its code lines map to the replacement's first
	// rewritten line (collapsed).
	const rewrittenLines: string[] = rewritten.split("\n");
	const codeLines: string[] = code.split("\n");
	const map = new Map<number, number>(); // rewrittenLine → codeLine (1-based)
	let codeIdx = 1;
	let rewIdx = 1;
	for (const span of importSpans) {
		// Advance both to the span start, emitting identity mapping for the
		// untouched lines between the previous span end and this span start.
		const spanStartCodeLine = lineAt(code, span.codeStart);
		const spanStartRewLine = lineAt(rewritten, span.jsStart);
		for (; codeIdx < spanStartCodeLine && rewIdx < spanStartRewLine; codeIdx++, rewIdx++) {
			map.set(rewIdx, codeIdx);
		}
		// Lines inside the import span (in code) collapse to the replacement's
		// single starting rewritten line.
		const spanEndCodeLine = lineAt(code, span.codeEnd);
		for (; codeIdx <= spanEndCodeLine; codeIdx++) {
			map.set(spanStartRewLine, spanStartCodeLine);
		}
		rewIdx = spanStartRewLine + 1;
	}
	// Tail: identity from wherever we stopped.
	for (; rewIdx <= rewrittenLines.length; rewIdx++, codeIdx++) {
		map.set(rewIdx, Math.min(codeIdx, codeLines.length));
	}
	return (rewLine: number) => {
		const mapped = map.get(rewLine);
		return mapped ?? Math.min(rewLine, codeLines.length);
	};
}

export function transformCell(code: string, options: TransformOptions = {}): TransformedCell {
	const ctxName = options.ctxName ?? "__ctx";
	let importDeclared: string[] = [];
	let rewritten = code;
	const importSpans: { codeStart: number; codeEnd: number; jsStart: number; jsEnd: number }[] = [];
	try {
		const tokens = lexTopLevel(code);
		const imports = findImportStatements(tokens);
		if (imports.length > 0) {
			importDeclared = [];
			const pieces: string[] = [];
			let cursor = 0;
			let jsCursor = 0;
			for (const stmt of imports) {
				const pre = rewritten.slice(cursor, stmt.start);
				pieces.push(pre);
				jsCursor += pre.length;
				const rewrite = rewriteImport(code, stmt, tokens);
				importDeclared.push(...rewrite.declaredNames);
				pieces.push(rewrite.replacement);
				importSpans.push({
					codeStart: stmt.start,
					codeEnd: stmt.end,
					jsStart: jsCursor,
					jsEnd: jsCursor + rewrite.replacement.length - 1,
				});
				jsCursor += rewrite.replacement.length;
				cursor = stmt.end;
			}
			pieces.push(rewritten.slice(cursor));
			rewritten = pieces.join("");
		}
	} catch {
		// Tokenizing the original source failed (genuine syntax error). Skip
		// the pre-rewrite; type stripping below surfaces the error.
	}

	const { code: js, lineMap: esbLineMap } = stripTypes(rewritten);
	const rewToCode = buildImportLineMap(code, rewritten, importSpans);
	const program: Program = parse(js, {
		ecmaVersion: "latest",
		sourceType: "module",
		allowAwaitOutsideFunction: true,
		// P6: locations needed to know each top-level node's source lines.
		locations: true,
	});

	const declaredNames: string[] = [];
	const replacements: { start: number; end: number; text: string }[] = [];
	const topLevel = program.body;

	for (const node of topLevel) {
		switch (node.type) {
			case "ImportDeclaration": {
				const decl = node as ImportDeclaration;
				for (const spec of decl.specifiers) declaredNames.push(spec.local.name);
				replacements.push({ start: decl.start, end: decl.end, text: importReplacement(decl) });
				break;
			}
			case "ExportNamedDeclaration":
			case "ExportDefaultDeclaration":
			case "ExportAllDeclaration":
				throw new SyntaxError("export statements are not supported in cells");
			case "VariableDeclaration": {
				const decl = node as VariableDeclaration;
				for (const declarator of decl.declarations) collectPatternNames(declarator.id, declaredNames);
				replacements.push({ start: decl.start, end: decl.end, text: variableReplacement(decl, js) });
				break;
			}
			case "FunctionDeclaration":
			case "ClassDeclaration": {
				const decl = node as FunctionDeclaration | ClassDeclaration;
				if (!decl.id) break;
				declaredNames.push(decl.id.name);
				// A named function/class expression keeps self-reference (recursion)
				// while making the binding proxy-backed and failure-surviving.
				const sourceText = js.slice(decl.start, decl.end);
				replacements.push({ start: decl.start, end: decl.end, text: `${decl.id.name} = ${sourceText};` });
				break;
			}
			default:
				break;
		}
	}

	// Capture a trailing expression statement as the cell result.
	const last = topLevel[topLevel.length - 1] as Node | undefined;
	if (last && last.type === "ExpressionStatement") {
		const expression = (last as unknown as { expression: Node }).expression;
		const expressionText = js.slice(expression.start, expression.end);
		replacements.push({ start: last.start, end: last.end, text: `${ctxName}.setResult((${expressionText}));` });
	}

	replacements.sort((a, b) => a.start - b.start);
	let body = "";
	let cursor = 0;
	// P6: build bodyLine → sourceLine map while splicing. `body` is what V8
	// reports error lines against; `js` is the esbuild-stripped source; the map
	// composes: bodyLine → jsLine (via newline deltas) → rewrittenLine (via
	// esbuild inline sourcemap) → codeLine (via import pre-rewrite).
	const lineMap: { sourceLine: number; bodyLine: number }[] = [];
	let bodyLine = 1;
	let jsLine = 1;
	// jsLineOfBodyStart maps the js line at each body boundary; we track the
	// cumulative js-line delta as body lines are emitted.
	for (const replacement of replacements) {
		const pre = js.slice(cursor, replacement.start);
		body += pre;
		bodyLine += countNewlines(pre);
		jsLine += countNewlines(pre);
		// The replacement's first body line maps from the js line at its start.
		const repJsStartLine = lineAt(js, replacement.start);
		// Source line = compose: js → rewritten (esbuild) → code (imports).
		const rewLine = esbLineMap.length > 0 ? esbLineMap[Math.min(repJsStartLine - 1, esbLineMap.length - 1)] : repJsStartLine;
		const srcLine = rewToCode(rewLine);
		lineMap.push({ sourceLine: srcLine, bodyLine: bodyLine });
		body += replacement.text;
		bodyLine += countNewlines(replacement.text);
		// js line after the replacement: replacements are in js coordinate, so
		// jsLine advances by the replacement's text newlines too.
		jsLine += countNewlines(replacement.text);
		cursor = replacement.end;
	}
	const tail = js.slice(cursor);
	body += tail;
	bodyLine += countNewlines(tail);
	// Any body line not covered by a replacement maps identity.
	lineMap.sort((a, b) => a.bodyLine - b.bodyLine);

	return { body, declaredNames: [...new Set([...importDeclared, ...declaredNames])], lineMap };
}
