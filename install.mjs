#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const configDir = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-crew");
const configPath = path.join(configDir, "config.json");
fs.mkdirSync(configDir, { recursive: true });
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, `${JSON.stringify({ asyncByDefault: false, executeWorkers: false, notifierIntervalMs: 5000, requireCleanWorktreeLeader: true, autonomous: { enabled: true, injectPolicy: true, preferAsyncForLongTasks: false, allowWorktreeSuggestion: true }, limits: { maxConcurrentWorkers: 3, maxTaskDepth: 2, maxChildrenPerTask: 5, maxRunMinutes: 60, maxRetriesPerTask: 1, heartbeatStaleMs: 60000 } }, null, 2)}\n`, "utf-8");
  console.log(`Created default pi-crew config: ${configPath}`);
} else {
  console.log(`pi-crew config already exists: ${configPath}`);
}

console.log("\nInstall the published package in Pi with:");
console.log("  pi install npm:pi-crew");
console.log("\nFor local development from a cloned repo:");
console.log("  pi install .");
console.log("\nEnable real child workers by setting either config executeWorkers=true or environment:");
console.log("  PI_TEAMS_EXECUTE_WORKERS=1 pi");
