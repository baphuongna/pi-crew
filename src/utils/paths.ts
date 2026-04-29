import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function packageRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function userPiRoot(): string {
	const home = process.env.PI_TEAMS_HOME?.trim() || os.homedir();
	return path.join(home, ".pi", "agent");
}

const PROJECT_DIR_MARKERS = [".git", ".pi", ".crew", ".hg", ".svn", ".factory", ".omc"];
const PROJECT_FILE_MARKERS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "composer.json", "build.gradle", "build.gradle.kts"];

function hasProjectMarker(dir: string): boolean {
	for (const marker of PROJECT_DIR_MARKERS) {
		if (fs.existsSync(path.join(dir, marker))) return true;
	}
	for (const file of PROJECT_FILE_MARKERS) {
		if (fs.existsSync(path.join(dir, file))) return true;
	}
	return false;
}

export function findRepoRoot(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	const root = path.parse(current).root;
	const home = path.resolve(os.homedir());
	while (current !== root) {
		if (current === home) return undefined;
		if (hasProjectMarker(current)) return current;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	if (current === home) return undefined;
	if (hasProjectMarker(root)) return root;
	return undefined;
}

export function projectPiRoot(cwd: string): string {
	return path.join(findRepoRoot(cwd) ?? cwd, ".pi");
}

export function projectCrewRoot(cwd: string): string {
	const repoRoot = findRepoRoot(cwd) ?? cwd;
	// Legacy reuse: if .pi/ already exists for the project, namespace under .pi/teams/
	// to avoid creating a parallel .crew/ alongside an existing pi project layout.
	const piDir = path.join(repoRoot, ".pi");
	if (fs.existsSync(piDir)) return path.join(piDir, "teams");
	// Otherwise default to .crew/ (also kept stable if it already exists).
	return path.join(repoRoot, ".crew");
}

export function userCrewRoot(): string {
	return path.join(userPiRoot(), "extensions", "pi-crew");
}
