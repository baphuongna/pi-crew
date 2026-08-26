/**
 * launch-script builder — boot script cho tier-1 surface worker (spec §5.2)
 *
 * Host không thể spawn TUI worker bằng argv (Pi từ chối flag lạ và `--mode
 * json -p` là chế độ headless), nên pane chạy `bash <script>`: script export
 * đầy đủ env worker, cd vào cwd, chạy dòng lệnh pi TUI, rồi tự xóa bằng
 * `rm -f -- "$0"`. Script là file one-shot tuổi thọ vài giây — TTL registry
 * dọn script mồ côi (worker chưa kịp chạy đã chết) sau 60s.
 *
 * Depth guard lớp 2: builder throw khi env input cho thấy đây là worker lồng
 * (PI_CREW_DEPTH > 0). Lớp 1 là resolveSurface trả null (spec §3) — lớp 2 bảo
 * vệ đường gọi trực tiếp builder mà bỏ qua resolveSurface.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { atomicWriteFile } from "../../state/atomic-write.ts";
import { currentCrewDepth } from "../model/pi-args.ts";

/**
 * Thrown khi buildLaunchScript nhận env có PI_CREW_DEPTH > 0 — surface panes
 * là tier-1 only, không pane-in-pane (spec §3/§5.2).
 */
export class SurfaceDepthGuardError extends Error {
	constructor(depth: number) {
		super(`Refusing to build surface launch script at PI_CREW_DEPTH=${depth}: surface panes are tier-1 only`);
		this.name = "SurfaceDepthGuardError";
	}
}

export interface BuildLaunchScriptInput {
	taskId: string;
	/** Env worker cần có trong pane (broker, steering, surface, parent-guard). */
	env: Record<string, string>;
	/** Dòng lệnh pi TUI (đã build, không `--mode json -p`). */
	command: string;
	/** Working directory của worker (được cd với shell-escape). */
	cwd: string;
	/** Thư mục chứa script — dùng getPiTempBase() từ pi-args.ts. */
	baseDir: string;
}

/** TTL cho launch script (spec §5.2): sweep xóa script cũ hơn 60s. */
export const LAUNCH_SCRIPT_TTL_MS = 60_000;

/**
 * Module-level TTL registry — path script → createdAt (epoch ms). Sweep trước
 * mỗi spawn và khi run kết thúc (caller truyền registry này vào
 * sweepLaunchScripts). Export cho test và cho caller Task 6.
 */
export const launchScriptRegistry = new Map<string, number>();

/**
 * Shell single-quote escape: bọc giá trị trong '...' và biến nháy đơn thành
 * '\'' — bên trong single-quote KHÔNG có expansion, nên $(), backtick, $VAR
 * đều nguyên vẹn.
 */
export function shellEscape(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Viết launch script ra {baseDir}/pi-crew-launch-{taskId}-{pid}.sh (mode 0600,
 * symlink-safe qua atomicWriteFile), đăng ký vào TTL registry, trả path.
 *
 * Mọi giá trị env và cwd đều qua shellEscape — env chứa token broker, đường
 * dẫn, và dữ liệu từ task không tin cậy được để raw vào file bash.
 */
export function buildLaunchScript(input: BuildLaunchScriptInput): string {
	const depth = currentCrewDepth(input.env);
	if (depth > 0) throw new SurfaceDepthGuardError(depth);

	const scriptPath = path.join(input.baseDir, `pi-crew-launch-${input.taskId}-${process.pid}.sh`);
	const lines: string[] = ["#!/bin/bash"];
	for (const [key, value] of Object.entries(input.env)) {
		lines.push(`export ${key}=${shellEscape(value)}`);
	}
	lines.push(`cd ${shellEscape(input.cwd)}`);
	lines.push(input.command);
	lines.push('rm -f -- "$0"');
	atomicWriteFile(scriptPath, `${lines.join("\n")}\n`, { mode: 0o600 });
	launchScriptRegistry.set(scriptPath, Date.now());
	return scriptPath;
}

/**
 * Xóa mọi entry cũ hơn LAUNCH_SCRIPT_TTL_MS khỏi đĩa và registry, trả số entry
 * đã dọn. Idempotent: entry mà file đã biến mất (worker tự rm) vẫn bị dọn khỏi
 * registry; lỗi đĩa không throw — registry vẫn drop để không leak entry.
 */
export function sweepLaunchScripts(registry: Map<string, number>, now: number): number {
	let swept = 0;
	for (const [scriptPath, createdAt] of [...registry.entries()]) {
		if (now - createdAt <= LAUNCH_SCRIPT_TTL_MS) continue;
		try {
			fs.rmSync(scriptPath, { force: true });
		} catch {
			// best-effort — entry vẫn bị drop khỏi registry bên dưới
		}
		registry.delete(scriptPath);
		swept++;
	}
	return swept;
}
