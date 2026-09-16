/**
 * Agent picker overlay — RAIL design language (M4/E1, 2026-09-16).
 *
 *   ┏ AGENTS ▸ <runId8>
 *   ┃ › explorer · running · executor ▸ worker
 *   ┗ ↑/↓ move · Enter select · Esc cancel
 *
 * Grammar: `canopyLine` opens the surface, every body row is a `┃` line built
 * by `railLine` (which owns the width budget), the close cap carries the hint
 * built by `formatHint` (close LAST, keys through `keyToken`). The rounded
 * `╭─╮│╰─╯` frame and the hand-typed "↑/↓ move · Enter select · ESC cancel"
 * string are retired.
 *
 * Keys/behaviour are unchanged: same `overlay:*` keyspace dispatch, same
 * selection and clamping.
 *
 * File-sourced risk (audit §4): `agents.json` is NOT schema-validated at read
 * time, so every interpolated record field is guarded (`?? "?"`) before it can
 * reach a line — a missing field must never print as `undefined`.
 */

import { readCrewAgents } from "../../runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import { loadRunManifestById } from "../../state/stores/state-store.ts";
import { truncate } from "../../utils/visual.ts";
import { overlayActionForKey } from "../keybinding-map.ts";
import { ACTIVE, CURSOR, canopyLine, formatHint, RAIL, railLine, shortId } from "../rail.ts";
import { asCrewTheme, type CrewTheme } from "../theme-adapter.ts";

export interface AgentPickerSelection {
	agentId: string;
}

export class AgentPickerOverlay {
	private readonly agents: CrewAgentRecord[];
	private readonly done: (selection: AgentPickerSelection | undefined) => void;
	private readonly theme: CrewTheme;
	private readonly runId: string;
	private selected = 0;

	constructor(opts: {
		cwd: string;
		runId: string;
		done: (selection: AgentPickerSelection | undefined) => void;
		theme?: unknown;
	}) {
		const loaded = loadRunManifestById(opts.cwd, opts.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
		this.agents = loaded ? readCrewAgents(loaded.manifest) : [];
		this.done = opts.done;
		this.theme = asCrewTheme(opts.theme ?? {});
		this.runId = opts.runId;
	}

	invalidate(): void {
		// Agent list is captured at open time.
	}

	render(width: number): string[] {
		if (width < 6) return [];
		const theme = this.theme;
		const budget = width - 2;
		const lines: string[] = [
			canopyLine({ word: "AGENTS", subject: shortId(this.runId), theme, budget }),
			...this.agents.map((agent, index) =>
				railLine(
					RAIL.body,
					"border",
					truncate(
						`${index === this.selected ? CURSOR : " "} ${agent.taskId ?? "?"} · ${agent.status ?? "?"} · ${
							agent.role ?? "?"
						} ${ACTIVE} ${agent.agent ?? "?"}`,
						budget,
					),
					theme,
					budget,
				),
			),
		];
		if (!this.agents.length) {
			lines.push(railLine(RAIL.body, "border", theme.fg("dim", "No agents found."), theme, budget));
		}
		lines.push(
			railLine(
				RAIL.close,
				"border",
				theme.fg(
					"dim",
					formatHint([
						[["up", "down"], "move"],
						["enter", "select"],
						["escape", "cancel"],
					]),
				),
				theme,
				budget,
			),
		);
		return lines;
	}

	handleInput(data: string): void {
		// M2-1: keys come from the central `overlay:*` keyspace (remappable via
		// `.crew/config.json` → keybindings["overlay:agent-picker:<action>"]).
		switch (overlayActionForKey("agent-picker", data)) {
			case "close":
				this.done(undefined);
				return;
			case "up":
				this.selected = Math.max(0, this.selected - 1);
				return;
			case "down":
				this.selected = Math.min(Math.max(0, this.agents.length - 1), this.selected + 1);
				return;
			case "select": {
				const agent = this.agents[this.selected];
				this.done(agent ? { agentId: agent.taskId } : undefined);
				return;
			}
		}
	}
}
