import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiTeams } from "./src/extension/register.ts";
export { waitForRun } from "./src/runtime/run-tracker.ts";

export default function (pi: ExtensionAPI): void {
	registerPiTeams(pi);
}
