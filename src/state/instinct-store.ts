import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { assertSafePathId } from "../utils/safe-paths.ts";

/**
 * Represents a learned instinct that guides agent behavior.
 * Instincts can be project-scoped or global.
 */
export interface Instinct {
	/** Unique identifier for this instinct */
	id: string;
	/** What triggers this instinct */
	trigger: string;
	/** What action to take when triggered */
	action: string;
	/** Confidence level: 0.3 (low), 0.6 (medium), 0.9 (high) */
	confidence: 0.3 | 0.6 | 0.9;
	/** Whether this instinct applies to a project or globally */
	scope: "project" | "global";
	/** Project identifier (undefined for global instincts) */
	projectId?: string;
	/** ISO timestamp of when this instinct was created */
	createdAt: string;
	/** Examples/evidence supporting this instinct */
	evidence: string[];
}

/** Input type for creating a new instinct (excludes auto-generated fields) */
export type NewInstinct = Omit<Instinct, "id" | "createdAt">;

const INSTINCT_FILE = "instincts.jsonl";

/**
 * InstinctStore manages persistence of learned instincts using JSONL files.
 * - Project instincts: `.crew/instincts/projects/{projectId}/instincts.jsonl`
 * - Global instincts: `.crew/instincts/global/instincts.jsonl`
 */
export class InstinctStore {
	private readonly crewRoot: string;

	constructor(crewRoot: string) {
		this.crewRoot = crewRoot;
	}

	/**
	 * Get the file path for project instincts
	 */
	private getProjectInstinctPath(projectId: string): string {
		return path.join(this.crewRoot, "instincts", "projects", projectId, INSTINCT_FILE);
	}

	/**
	 * Get the file path for global instincts
	 */
	private getGlobalInstinctPath(): string {
		return path.join(this.crewRoot, "instincts", "global", INSTINCT_FILE);
	}

	/**
	 * Ensure a directory exists, creating it recursively if needed
	 */
	private ensureDir(dirPath: string): void {
		fs.mkdirSync(dirPath, { recursive: true });
	}

	/**
	 * Parse a JSONL file and return all instincts
	 */
	private readInstinctsFromFile(filePath: string): Instinct[] {
		if (!fs.existsSync(filePath)) {
			return [];
		}
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const lines = content.split("\n").filter((line) => line.trim() !== "");
			return lines.map((line) => JSON.parse(line) as Instinct);
		} catch {
			// If file is corrupted, return empty array
			return [];
		}
	}

	/**
	 * Append a single instinct to a JSONL file
	 */
	private appendInstinctToFile(filePath: string, instinct: Instinct): void {
		const dir = path.dirname(filePath);
		this.ensureDir(dir);
		fs.appendFileSync(filePath, `${JSON.stringify(instinct)}\n`, "utf-8");
	}

	/**
	 * Rewrite a JSONL file with the given instincts
	 */
	private rewriteFile(filePath: string, instincts: Instinct[]): void {
		const dir = path.dirname(filePath);
		this.ensureDir(dir);
		const content = instincts.map((i) => JSON.stringify(i)).join("\n") + "\n";
		fs.writeFileSync(filePath, content, "utf-8");
	}

	/**
	 * Save a new instinct with auto-generated id and timestamp.
	 * Direct scope is determined by the instinct's scope field.
	 *
	 * @param instinct - The instinct to save (without id and createdAt)
	 * @returns The saved instinct with generated id and createdAt
	 */
	saveInstinct(instinct: NewInstinct): Instinct {
		const savedInstinct: Instinct = {
			...instinct,
			id: randomUUID(),
			createdAt: new Date().toISOString(),
		};

		if (savedInstinct.scope === "global") {
			savedInstinct.projectId = undefined;
			this.appendInstinctToFile(this.getGlobalInstinctPath(), savedInstinct);
		} else {
			if (!savedInstinct.projectId) {
				throw new Error("Project-scoped instinct requires a projectId");
			}
			assertSafePathId("projectId", savedInstinct.projectId);
			this.appendInstinctToFile(this.getProjectInstinctPath(savedInstinct.projectId), savedInstinct);
		}

		return savedInstinct;
	}

	/**
	 * Get all instincts, optionally filtered by scope.
	 *
	 * @param scope - Optional filter: 'project' or 'global'
	 * @returns Array of instincts matching the filter
	 */
	getInstincts(scope?: "project" | "global"): Instinct[] {
		const results: Instinct[] = [];

		if (!scope || scope === "project") {
			const projectsDir = path.join(this.crewRoot, "instincts", "projects");
			if (fs.existsSync(projectsDir)) {
				for (const projectId of fs
					.readdirSync(projectsDir, { withFileTypes: true })
					.filter((e) => e.isDirectory())
					.map((e) => e.name)) {
					const filePath = path.join(projectsDir, projectId, INSTINCT_FILE);
					results.push(...this.readInstinctsFromFile(filePath));
				}
			}
		}

		if (!scope || scope === "global") {
			results.push(...this.readInstinctsFromFile(this.getGlobalInstinctPath()));
		}

		return results;
	}

	/**
	 * Get all instincts for a specific project.
	 * Includes both project-scoped instincts and global instincts.
	 *
	 * @param projectId - The project identifier
	 * @returns Array of instincts for the project
	 */
	getProjectInstincts(projectId: string): Instinct[] {
		assertSafePathId("projectId", projectId);
		const projectInstincts = this.readInstinctsFromFile(this.getProjectInstinctPath(projectId));
		const globalInstincts = this.readInstinctsFromFile(this.getGlobalInstinctPath());
		return [...projectInstincts, ...globalInstincts];
	}

	/**
	 * Promote a project-scoped instinct to global scope.
	 * Creates a copy in global instincts and removes from project.
	 *
	 * @param instinctId - The instinct id to promote
	 * @returns The promoted instinct, or null if not found
	 */
	promoteInstinct(instinctId: string): Instinct | null {
		// Search in all project instinct files
		const projectsDir = path.join(this.crewRoot, "instincts", "projects");
		if (fs.existsSync(projectsDir)) {
			for (const projectId of fs
				.readdirSync(projectsDir, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name)) {
				assertSafePathId("projectId", projectId);
				const filePath = path.join(projectsDir, projectId, INSTINCT_FILE);
				const instincts = this.readInstinctsFromFile(filePath);
				const index = instincts.findIndex((i) => i.id === instinctId);

				if (index !== -1) {
					const instinct = instincts[index];

					// Create promoted version (global)
					const promotedInstinct: Instinct = {
						...instinct,
						id: randomUUID(), // New id for promoted instinct
						scope: "global",
						projectId: undefined,
						createdAt: new Date().toISOString(),
					};

					// Add to global instincts
					this.appendInstinctToFile(this.getGlobalInstinctPath(), promotedInstinct);

					// Remove from project instincts
					const updatedInstincts = instincts.filter((i) => i.id !== instinctId);
					this.rewriteFile(filePath, updatedInstincts);

					return promotedInstinct;
				}
			}
		}

		return null;
	}

	/**
	 * Delete an instinct by id.
	 *
	 * @param instinctId - The instinct id to delete
	 * @returns true if deleted, false if not found
	 */
	deleteInstinct(instinctId: string): boolean {
		// Search in global instincts first
		const globalPath = this.getGlobalInstinctPath();
		let instincts = this.readInstinctsFromFile(globalPath);
		let index = instincts.findIndex((i) => i.id === instinctId);

		if (index !== -1) {
			const updatedInstincts = instincts.filter((i) => i.id !== instinctId);
			this.rewriteFile(globalPath, updatedInstincts);
			return true;
		}

		// Search in project instincts
		const projectsDir = path.join(this.crewRoot, "instincts", "projects");
		if (fs.existsSync(projectsDir)) {
			for (const projectId of fs
				.readdirSync(projectsDir, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name)) {
				assertSafePathId("projectId", projectId);
				const filePath = path.join(projectsDir, projectId, INSTINCT_FILE);
				instincts = this.readInstinctsFromFile(filePath);
				index = instincts.findIndex((i) => i.id === instinctId);

				if (index !== -1) {
					const updatedInstincts = instincts.filter((i) => i.id !== instinctId);
					this.rewriteFile(filePath, updatedInstincts);
					return true;
				}
			}
		}

		return false;
	}
}

export {
	getGlobalStorageDir,
	getProjectStorageDir,
} from "../utils/project-detector.ts";
