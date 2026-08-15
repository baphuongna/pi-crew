/**
 * b9 worker — child-process helper for bench/b9-eventlog-dual-namespace.bench.ts.
 *
 * NOT a bench itself (does not match the `b*.bench.ts` glob in
 * scripts/run-bench.mjs). Spawned with `node --experimental-strip-types`
 * so it can import the real event-log append paths.
 *
 * Usage: node --experimental-strip-types bench/b9-worker.ts <sync|async> <eventsPath> <count>
 */

import { appendEvent, appendEventAsync } from "../src/state/event-log/event-log.ts";

async function main(): Promise<void> {
	const [mode, eventsPath, countArg] = process.argv.slice(2);
	const count = Number.parseInt(countArg ?? "0", 10);
	if ((mode !== "sync" && mode !== "async") || !eventsPath || !Number.isFinite(count) || count <= 0) {
		throw new Error(`usage: b9-worker.ts <sync|async> <eventsPath> <count> (got: ${process.argv.slice(2).join(" ")})`);
	}
	const makeEvent = (i: number) => ({
		type: "task.progress",
		runId: "b9-run",
		taskId: `${mode}-${i}`,
		data: { i, mode },
	});
	if (mode === "sync") {
		for (let i = 0; i < count; i++) appendEvent(eventsPath, makeEvent(i));
	} else {
		for (let i = 0; i < count; i++) await appendEventAsync(eventsPath, makeEvent(i));
	}
	process.stdout.write(`done:${mode}:${count}\n`);
}

main().then(
	() => undefined,
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
