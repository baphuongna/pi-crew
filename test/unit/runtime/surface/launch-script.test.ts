/**
 * launch-script builder tests (spec §5.2)
 *
 * Contract:
 * - buildLaunchScript viết {baseDir}/pi-crew-launch-{taskId}-{pid}.sh, mode
 *   0600, symlink-safe (qua atomicWriteFile), đăng ký TTL registry.
 * - Nội dung: shebang bash → export mọi cặp env input (single-quote escaped)
 *   → cd <escaped cwd> → dòng lệnh → `rm -f -- "$0"` cuối (tự dọn).
 * - Depth guard lớp 2: env input PI_CREW_DEPTH > 0 → throw
 *   SurfaceDepthGuardError (lớp 1 là resolveSurface trả null, §3).
 * - sweepLaunchScripts xóa entry cũ hơn 60s (đĩa + registry), giữ entry mới.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	buildLaunchScript,
	LAUNCH_SCRIPT_TTL_MS,
	launchScriptRegistry,
	SurfaceDepthGuardError,
	sweepLaunchScripts,
} from "../../../../src/runtime/surface/launch-script.ts";

let baseDir: string;

test.before(() => {
	baseDir = mkdtempSync(join(tmpdir(), "launch-script-test-"));
});

test.after(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

/** Env chuẩn của một tier-1 surface worker (spec §5.2) — 5 biến surface + infra. */
function surfaceEnv(): Record<string, string> {
	return {
		PI_CREW_RUN_ID: "run-42",
		PI_CREW_TASK_ID: "03_implement",
		PI_CREW_BROKER_SOCKET: "/tmp/crew-broker-test.sock",
		PI_CREW_BROKER_TOKEN: "tok-abc123",
		PI_CREW_STEERING_FILE: "/tmp/steer-03.md",
		PI_CREW_EVENTS_PATH: "/tmp/events-03.jsonl",
		PI_CREW_DEPTH: "0",
		PI_CREW_SURFACE: "tmux",
		// Pane id chỉ biết sau createSurface — caller (Task 6) thay placeholder.
		PI_CREW_SURFACE_PANE: "%12",
		PI_CREW_AUTO_EXIT: "1",
		PI_CREW_PARENT_PID: "12345",
		PI_CREW_PARENT_START_TIME: "9876543",
	};
}

test("buildLaunchScript writes 0600 script at {baseDir}/pi-crew-launch-{taskId}-{pid}.sh", () => {
	const scriptPath = buildLaunchScript({
		taskId: "03_implement",
		env: surfaceEnv(),
		command: 'pi --model glm-4.7:medium "Task: do work"',
		cwd: "/home/user/repo",
		baseDir,
	});
	assert.equal(scriptPath, join(baseDir, `pi-crew-launch-03_implement-${process.pid}.sh`));
	assert.ok(existsSync(scriptPath), "script phải tồn tại trên đĩa");
	assert.equal(statSync(scriptPath).mode & 0o777, 0o600, "mode phải là 0600");
});

test("script content: shebang, surface exports, command line, self-cleanup tail", () => {
	const scriptPath = buildLaunchScript({
		taskId: "01_explore",
		env: surfaceEnv(),
		command: 'pi --model glm-4.7:medium "Task: explore"',
		cwd: "/home/user/repo",
		baseDir,
	});
	const content = readFileSync(scriptPath, "utf-8");
	const lines = content.split("\n");
	assert.equal(lines[0], "#!/bin/bash");
	// 5 biến surface bắt buộc phải có mặt trong script (spec §5.2).
	assert.ok(content.includes("export PI_CREW_SURFACE="));
	assert.ok(content.includes("export PI_CREW_SURFACE_PANE="));
	assert.ok(content.includes("export PI_CREW_AUTO_EXIT="));
	assert.ok(content.includes("export PI_CREW_PARENT_PID="));
	assert.ok(content.includes("export PI_CREW_PARENT_START_TIME="));
	// Infra env cũng đi qua script (không hardcode — nhận từ env input map).
	assert.ok(content.includes("export PI_CREW_RUN_ID="));
	assert.ok(content.includes("export PI_CREW_BROKER_SOCKET="));
	assert.ok(content.includes("export PI_CREW_STEERING_FILE="));
	// Dòng lệnh + cd vào cwd + tự dọn cuối file.
	assert.ok(content.includes('pi --model glm-4.7:medium "Task: explore"'));
	assert.ok(content.includes("cd '/home/user/repo'"));
	assert.equal(lines[lines.length - 2], 'rm -f -- "$0"', 'dòng cuối (trước \\n kết file) phải là rm -f -- "$0"');
});

test("throws SurfaceDepthGuardError when env PI_CREW_DEPTH > 0 (guard lớp 2)", () => {
	for (const depth of ["1", "2", "4"]) {
		assert.throws(
			() =>
				buildLaunchScript({
					taskId: "nested",
					env: { ...surfaceEnv(), PI_CREW_DEPTH: depth },
					command: "pi",
					cwd: "/home/user/repo",
					baseDir,
				}),
			SurfaceDepthGuardError,
			`PI_CREW_DEPTH=${depth} phải throw`,
		);
	}
	// Không ghi gì xuống đĩa khi guard chặn.
	assert.ok(!existsSync(join(baseDir, `pi-crew-launch-nested-${process.pid}.sh`)));
});

test("depth 0 / absent env builds fine (guard chỉ chặn worker lồng)", () => {
	for (const depthCase of [undefined, "0"]) {
		const env = surfaceEnv();
		if (depthCase === undefined) delete env.PI_CREW_DEPTH;
		else env.PI_CREW_DEPTH = depthCase;
		const scriptPath = buildLaunchScript({
			taskId: "top",
			env,
			command: "pi",
			cwd: "/home/user/repo",
			baseDir,
		});
		assert.ok(existsSync(scriptPath));
	}
});

test("shell-escapes hostile values (single quote, $, backtick) in env and cwd — verified by running the script", (t) => {
	const workDir = mkdtempSync(join(tmpdir(), "launch-script-run-"));
	t.after(() => rmSync(workDir, { recursive: true, force: true }));
	const evil = 'it\'s $(echo pwned) `echo pwned` "dq" $HOME';
	const resultPath = join(workDir, "result.txt");
	const scriptPath = buildLaunchScript({
		taskId: "evil",
		env: { ...surfaceEnv(), PI_CREW_EVIL: evil },
		command: `printf '%s' "$PI_CREW_EVIL" > ${resultPath}`,
		cwd: workDir,
		baseDir,
	});
	// Nội dung file phải chứa dạng escaped: nháy đơn → '\''  (không có đoạn
	// $() hay backtick nào nằm ngoài single-quote).
	const content = readFileSync(scriptPath, "utf-8");
	assert.ok(content.includes("it'\\''s $(echo pwned) `echo pwned` \"dq\" $HOME'"), "giá trị phải được bọc '...' với '\\'' cho nháy đơn");
	// Chạy script thật: bash phải set env với giá trị NGUYÊN VẸN (không thực thi
	// $(), backtick), cd đúng cwd, rồi tự rm -f -- "$0".
	execFileSync("bash", [scriptPath], { stdio: "ignore" });
	assert.equal(readFileSync(resultPath, "utf-8"), evil, "bash phải thấy giá trị env nguyên vẹn");
	assert.ok(!existsSync(scriptPath), 'script phải tự xóa qua rm -f -- "$0"');
});

test("registers built script in the module-level TTL registry", () => {
	const before = launchScriptRegistry.size;
	const scriptPath = buildLaunchScript({
		taskId: "reg",
		env: surfaceEnv(),
		command: "pi",
		cwd: "/home/user/repo",
		baseDir,
	});
	assert.ok(launchScriptRegistry.has(scriptPath), "registry phải chứa path script vừa build");
	assert.equal(launchScriptRegistry.size, before + 1);
	assert.equal(typeof launchScriptRegistry.get(scriptPath), "number", "createdAt phải là epoch ms");
});

test("sweepLaunchScripts deletes entries older than TTL from disk and registry, keeps fresh ones", () => {
	const sweepBase = mkdtempSync(join(tmpdir(), "launch-script-sweep-"));
	try {
		const oldPath = join(sweepBase, "pi-crew-launch-old-1.sh");
		const freshPath = join(sweepBase, "pi-crew-launch-fresh-1.sh");
		const edgePath = join(sweepBase, "pi-crew-launch-edge-1.sh");
		for (const p of [oldPath, freshPath, edgePath]) {
			writeFileSync(p, "#!/bin/bash\ntrue\n");
			chmodSync(p, 0o600);
		}
		const now = 1_000_000_000_000;
		const registry = new Map<string, number>([
			[oldPath, now - LAUNCH_SCRIPT_TTL_MS - 1_000], // 61s — quá TTL, xóa
			[edgePath, now - LAUNCH_SCRIPT_TTL_MS], // đúng 60s — chưa "cũ hơn", giữ
			[freshPath, now - 1_000], // 1s — giữ
		]);
		const swept = sweepLaunchScripts(registry, now);
		assert.equal(swept, 1, "chỉ entry cũ hơn 60s bị xóa");
		assert.ok(!existsSync(oldPath), "script cũ phải bị xóa khỏi đĩa");
		assert.ok(existsSync(edgePath), "entry đúng 60s phải được giữ (chỉ > TTL mới xóa)");
		assert.ok(existsSync(freshPath), "script mới phải được giữ");
		assert.ok(!registry.has(oldPath));
		assert.ok(registry.has(edgePath));
		assert.ok(registry.has(freshPath));
	} finally {
		rmSync(sweepBase, { recursive: true, force: true });
	}
});

test("sweepLaunchScripts cũng dọn entry có file đã biến mất (idempotent, không throw)", () => {
	const now = 5_000_000_000_000;
	const gonePath = join(baseDir, "pi-crew-launch-gone-999.sh");
	const registry = new Map<string, number>([[gonePath, now - LAUNCH_SCRIPT_TTL_MS - 5_000]]);
	assert.equal(sweepLaunchScripts(registry, now), 1);
	assert.equal(registry.size, 0);
});
