import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Write JSON data to a file atomically.
 * Uses write-to-temp + rename to avoid torn writes on crash.
 */
export function writeAtomicJson(filePath: string, data: unknown, pretty = false): void {
	const dir = path.dirname(filePath);
	const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
	const tmpPath = filePath + ".tmp";
	fs.writeFileSync(tmpPath, content, "utf-8");
	fs.renameSync(tmpPath, filePath);
}

/**
 * Read and parse JSON from a file. Returns undefined on any error.
 */
export function readJsonFile<T = unknown>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

/**
 * Append a JSON line to a JSONL file atomically per line.
 */
export function appendJsonlLine(filePath: string, data: unknown): void {
	const line = JSON.stringify(data) + "\n";
	fs.appendFileSync(filePath, line, "utf-8");
}
