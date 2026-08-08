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
}

export interface TransformOptions {
	/** Identifier the wrapper binds the cell context to. */
	ctxName?: string;
}

// esbuild's transform strips types but never drops side-effect-free trailing
// expressions (no DCE in transform mode) — the exact thing we capture as the
// cell result.
function stripTypes(code: string): string {
	return transformSync(code, { loader: "ts" }).code;
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
	if (namespaceSpecifier) parts.push(`${namespaceSpecifier.local.name} = await import(${moduleText});`);
	const destructured: string[] = [];
	if (defaultSpecifier) destructured.push(`default: ${defaultSpecifier.local.name}`);
	for (const spec of namedSpecifiers) {
		const imported = spec.imported.type === "Identifier" ? spec.imported.name : String(spec.imported.value);
		destructured.push(imported === spec.local.name ? imported : `${JSON.stringify(imported)}: ${spec.local.name}`);
	}
	if (destructured.length > 0) parts.push(`({ ${destructured.join(", ")} } = await import(${moduleText}));`);
	if (parts.length === 0) parts.push(`await import(${moduleText});`);
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

export function transformCell(code: string, options: TransformOptions = {}): TransformedCell {
	const ctxName = options.ctxName ?? "__ctx";

	// Top-level imports are rewritten into awaited dynamic imports BEFORE type
	// stripping: esbuild elides unused imports, and the reference behaviour
	// binds every imported name into the namespace so it persists across cells.
	let importDeclared: string[] = [];
	let rewritten = code;
	try {
		const tokens = lexTopLevel(code);
		const imports = findImportStatements(tokens);
		if (imports.length > 0) {
			importDeclared = [];
			const pieces: string[] = [];
			let cursor = 0;
			for (const stmt of imports) {
				pieces.push(rewritten.slice(cursor, stmt.start));
				const rewrite = rewriteImport(code, stmt, tokens);
				importDeclared.push(...rewrite.declaredNames);
				pieces.push(rewrite.replacement);
				cursor = stmt.end;
			}
			pieces.push(rewritten.slice(cursor));
			rewritten = pieces.join("");
		}
	} catch {
		// Tokenizing the original source failed (genuine syntax error). Skip
		// the pre-rewrite; type stripping below surfaces the error.
	}

	const js = stripTypes(rewritten);
	const program: Program = parse(js, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true });

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
	for (const replacement of replacements) {
		body += js.slice(cursor, replacement.start) + replacement.text;
		cursor = replacement.end;
	}
	body += js.slice(cursor);

	return { body, declaredNames: [...new Set([...importDeclared, ...declaredNames])] };
}
