import * as fs from "node:fs/promises";
import * as path from "node:path";

// ── Public types ───────────────────────────────────────────────────────

export interface WorkspaceTree {
	rootPath: string;
	rendered: string;
	truncated: boolean;
	totalLines: number;
}

export interface WorkspaceTreeOptions {
	/** Directory depth below root. Root is depth 0. Default: 3 */
	maxDepth?: number;
	/** Max entries per directory. Default: 12 */
	dirLimit?: number;
	/** Hard line limit for the rendered output. Default: 120 */
	lineCap?: number;
	/** Directory names to skip entirely. Default: node_modules, .git, .next, dist, build, target, .venv, .cache, .turbo */
	excludedDirs?: Set<string>;
}

// ── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_DIR_LIMIT = 12;
const DEFAULT_LINE_CAP = 120;
const DEFAULT_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	".next",
	"dist",
	"build",
	"target",
	".venv",
	".cache",
	".turbo",
]);

// ── Internal types ─────────────────────────────────────────────────────

interface TreeNode {
	name: string;
	relativePath: string;
	depth: number;
	isDirectory: boolean;
	mtimeMs: number;
	size: number;
	children: TreeNode[];
	droppedChildCount: number;
}

interface RenderLine {
	text: string;
	depth: number;
	isRoot: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

export function formatAge(seconds: number): string {
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	if (seconds < 86400 * 14) return `${Math.floor(seconds / 86400)}d`;
	return `${Math.floor(seconds / (86400 * 7))}w`;
}

// ── Tree building ──────────────────────────────────────────────────────

function compareByRecency(a: TreeNode, b: TreeNode): number {
	const diff = b.mtimeMs - a.mtimeMs;
	if (diff !== 0) return diff;
	return a.name.localeCompare(b.name);
}

function applyDirLimit(
	children: TreeNode[],
	limit: number,
): { visible: TreeNode[]; dropped: number } {
	if (children.length <= limit) {
		return { visible: children, dropped: 0 };
	}
	if (limit <= 1) {
		return { visible: children.slice(0, limit), dropped: children.length - limit };
	}
	// Keep first (limit-1) by recency + always keep the oldest (last after sort)
	const recent = children.slice(0, limit - 1);
	const oldest = children[children.length - 1];
	const visible = oldest ? [...recent, oldest] : recent;
	return { visible, dropped: children.length - limit };
}

async function readChildren(
	rootPath: string,
	parent: TreeNode,
	excludedDirs: ReadonlySet<string>,
): Promise<TreeNode[]> {
	const dirPath = parent.relativePath
		? path.join(rootPath, parent.relativePath)
		: rootPath;

	let names: string[];
	try {
		names = await fs.readdir(dirPath);
	} catch {
		return [];
	}

	const nodes = await Promise.all(
		names.map(async (name): Promise<TreeNode | null> => {
			// Skip hidden entries
			if (name.startsWith(".")) return null;
			const relativePath = parent.relativePath
				? `${parent.relativePath}/${name}`
				: name;
			const absolutePath = path.join(rootPath, relativePath);
			try {
				const stat = await fs.stat(absolutePath);
				if (stat.isDirectory() && excludedDirs.has(name)) return null;
				return {
					name,
					relativePath,
					depth: parent.depth + 1,
					isDirectory: stat.isDirectory(),
					mtimeMs: stat.mtimeMs,
					size: stat.size,
					children: [],
					droppedChildCount: 0,
				};
			} catch {
				return null;
			}
		}),
	);

	return nodes.filter((n): n is TreeNode => n !== null).sort(compareByRecency);
}

async function collectTree(
	rootPath: string,
	maxDepth: number,
	dirLimit: number,
	excludedDirs: ReadonlySet<string>,
): Promise<{ root: TreeNode; truncated: boolean }> {
	const rootStat = await fs.stat(rootPath);
	const root: TreeNode = {
		name: ".",
		relativePath: "",
		depth: 0,
		isDirectory: true,
		mtimeMs: rootStat.mtimeMs,
		size: rootStat.size,
		children: [],
		droppedChildCount: 0,
	};

	let truncated = false;
	const queue: TreeNode[] = [root];
	let cursor = 0;

	while (cursor < queue.length) {
		const parent = queue[cursor];
		cursor += 1;
		if (!parent || parent.depth >= maxDepth) continue;

		const children = await readChildren(rootPath, parent, excludedDirs);
		const { visible, dropped } = applyDirLimit(children, dirLimit);
		parent.children = visible;
		parent.droppedChildCount = dropped;
		if (dropped > 0) truncated = true;

		for (const child of visible) {
			if (child.isDirectory) queue.push(child);
		}
	}

	return { root, truncated };
}

// ── Rendering ──────────────────────────────────────────────────────────

function collectLines(node: TreeNode, nowMs: number, lines: RenderLine[]): void {
	if (node.depth === 0) {
		lines.push({ text: ".", depth: 0, isRoot: true });
	} else {
		const indent = "  ".repeat(node.depth);
		const suffix = node.isDirectory ? "/" : "";
		const label = `${indent}- ${node.name}${suffix}`;
		if (node.isDirectory) {
			lines.push({ text: label, depth: node.depth, isRoot: false });
		} else {
			const ageSeconds = Math.max(0, Math.floor((nowMs - node.mtimeMs) / 1000));
			const size = formatBytes(node.size);
			const age = formatAge(ageSeconds);
			lines.push({ text: `${label}  ${size}  ${age}`, depth: node.depth, isRoot: false });
		}
	}

	if (node.droppedChildCount > 0) {
		// When we kept recent + oldest, render recent children, then truncation line, then oldest
		const recentChildren = node.children.slice(0, -1);
		const oldestChild = node.children[node.children.length - 1];
		for (const child of recentChildren) collectLines(child, nowMs, lines);

		const childDepth = node.depth + 1;
		const indent = "  ".repeat(childDepth);
		lines.push({
			text: `${indent}- … ${node.droppedChildCount} more`,
			depth: childDepth,
			isRoot: false,
		});

		if (oldestChild) collectLines(oldestChild, nowMs, lines);
	} else {
		for (const child of node.children) collectLines(child, nowMs, lines);
	}
}

function applyLineCap(
	lines: RenderLine[],
	cap: number,
): { lines: RenderLine[]; elided: number } {
	if (lines.length <= cap) return { lines, elided: 0 };

	const target = Math.max(1, cap - 1);
	const removeCount = lines.length - target;
	// Remove deepest non-root entries first
	const removable = lines
		.map((line, index) => ({ line, index }))
		.filter((item) => !item.line.isRoot)
		.sort((a, b) => b.line.depth - a.line.depth || b.index - a.index)
		.slice(0, removeCount);

	if (removable.length === 0) return { lines, elided: 0 };

	const removedIndexes = new Set(removable.map((item) => item.index));
	const kept = lines.filter((_, index) => !removedIndexes.has(index));
	kept.push({
		text: `… (${removable.length} lines elided)`,
		depth: 0,
		isRoot: false,
	});
	return { lines: kept, elided: removable.length };
}

// ── Public API ────────────────────────────────────────────────────────

const emptyResult = (rootPath: string): WorkspaceTree => ({
	rootPath,
	rendered: "",
	truncated: false,
	totalLines: 0,
});

/**
 * Per-cwd TTL cache for the rendered workspace tree. Workers in the same run
 * share a cwd, so the recursive walk was previously repeated once per task
 * (Round 15 P4). The tree is informational context for the worker; short-lived
 * staleness is acceptable, so a 30s TTL is safe and keeps prompts fresh during
 * long active runs while eliminating redundant walks.
 */
const TREE_CACHE_TTL_MS = 30_000;
interface CachedTree {
	tree: WorkspaceTree;
	expiresAt: number;
}
const treeCache = new Map<string, CachedTree>();

function treeCacheKey(cwd: string, options?: WorkspaceTreeOptions): string {
	// Cache is keyed on the inputs that affect the walk output.
	return `${path.resolve(cwd)}|${options?.maxDepth ?? ""}|${options?.dirLimit ?? ""}|${options?.lineCap ?? ""}`;
}

export async function buildWorkspaceTree(
	cwd: string,
	options?: WorkspaceTreeOptions,
): Promise<WorkspaceTree> {
	const rootPath = path.resolve(cwd);
	const cacheKey = treeCacheKey(cwd, options);
	const cached = treeCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.tree;
	}
	try {
		const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
		const dirLimit = options?.dirLimit ?? DEFAULT_DIR_LIMIT;
		const lineCap = options?.lineCap ?? DEFAULT_LINE_CAP;
		const excludedDirs = options?.excludedDirs ?? DEFAULT_EXCLUDED_DIRS;

		const { root, truncated: dirTruncated } = await collectTree(
			rootPath,
			maxDepth,
			dirLimit,
			excludedDirs,
		);

		const nowMs = Date.now();
		const lines: RenderLine[] = [];
		collectLines(root, nowMs, lines);

		const { lines: capped, elided } = applyLineCap(lines, lineCap);
		const rendered = capped.map((l) => l.text).join("\n");

		const result: WorkspaceTree = {
			rootPath,
			rendered,
			truncated: dirTruncated || elided > 0,
			totalLines: capped.length,
		};
		treeCache.set(cacheKey, { tree: result, expiresAt: Date.now() + TREE_CACHE_TTL_MS });
		return result;
	} catch {
		return emptyResult(rootPath);
	}
}
