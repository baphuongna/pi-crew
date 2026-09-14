#!/usr/bin/env node
// Watch a pi session transcript (JSONL stream events) and print one readable
// line per message — the "session subagent" pane companion for the Agents &
// Jobs browser (`p` key). Unlike `tail -F` on the raw file, every line here is
// a formatted summary (role badge + preview), so a tmux/herdr pane shows WHAT
// the agent is doing, not walls of JSON.
//
// Usage: node watch-agent-transcript.mjs <transcript.jsonl>
import { open as openFile } from "node:fs/promises";
import { basename } from "node:path";

const path = process.argv[2];
if (!path) {
	console.error("usage: node watch-agent-transcript.mjs <transcript.jsonl>");
	process.exit(1);
}

const WIDTH = Math.min(200, Number(process.env.COLUMNS || 160) || 160);

function oneLine(text) {
	return String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function clip(text, max = WIDTH - 10) {
	const s = oneLine(text);
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function stamp(iso) {
	const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso ?? "");
	return m ? `${m[2]}` : "";
}

function renderEvent(evt) {
	if (evt.type === "session") return "── session start ──";
	if (evt.type === "agent_start") return "── agent start ──";
	if (evt.type !== "message_end" || !evt.message) return null;
	const msg = evt.message;
	const who =
		msg.role === "assistant" ? "🤖" : msg.role === "user" ? "👤" : msg.role === "toolResult" ? "📤" : (msg.role ?? "?");
	const parts = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }];
	const out = [];
	for (const part of parts) {
		if (part.type === "thinking") out.push(`💭 ${clip(part.thinking, 120)}`);
		else if (part.type === "text") out.push(`💬 ${clip(part.text)}`);
		else if (part.type === "tool_use") {
			const input = typeof part.input === "object" ? JSON.stringify(part.input) : String(part.input ?? "");
			out.push(`🔧 ${part.name ?? "tool"} ${clip(input, 100)}`);
		} else if (part.type === "tool_result") {
			const content = typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "");
			out.push(`📤 ${clip(content, 120)}`);
		}
	}
	if (out.length === 0) return null;
	return `${stamp(evt.timestamp ?? msg.timestamp) || "        "} ${who} ${out.join(" │ ")}`;
}

console.log(`── watching ${basename(path)} ──`);

let offset = 0;
let buffer = "";
const POLL_MS = 400;

async function pump() {
	try {
		const fh = await openFile(path, "r");
		try {
			const stat = await fh.stat();
			if (stat.size < offset) offset = 0; // truncated/rotated
			if (stat.size > offset) {
				const len = stat.size - offset;
				const buf = Buffer.alloc(len);
				await fh.read(buf, 0, len, offset);
				offset += len;
				buffer += buf.toString("utf8");
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					try {
						const rendered = renderEvent(JSON.parse(trimmed));
						if (rendered) console.log(rendered);
					} catch {
						console.log(`· ${clip(trimmed)}`);
					}
				}
			}
		} finally {
			await fh.close();
		}
	} catch {
		/* file not there yet — retry on next tick */
	}
}

setInterval(pump, POLL_MS);
await pump();
