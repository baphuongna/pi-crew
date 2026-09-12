#!/usr/bin/env node
/**
 * Release smoke test — verifies packed tarball loads correctly in a temp project.
 * Run: node scripts/release-smoke.mjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

function log(msg) {
	console.log(`[release-smoke] ${msg}`);
}

function run(cmd, cwd) {
	log(`  $ ${cmd}`);
	execSync(cmd, { cwd, stdio: "pipe", timeout: 60_000 });
}

try {
	// 1. Read version from package.json
	const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
	const version = rootPkg.version;
	log(`Package version: ${version}`);

	// 2. Pack tarball
	log("Packing tarball...");
	execSync("npm pack", { cwd: root, stdio: "pipe", timeout: 60_000 });
	const tarballName = `pi-crew-${version}.tgz`;
	const tarballPath = path.join(root, tarballName);
	if (!fs.existsSync(tarballPath)) throw new Error(`Tarball not found: ${tarballPath}`);
	log(`  Tarball: ${tarballName}`);

	// 3. Create temp project
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-smoke-"));
	log(`Temp project: ${tmpDir}`);
	try {
		run("npm init -y", tmpDir);

		// 4. Install packed tarball
		run(`npm install ${tarballPath}`, tmpDir);

		// 4b. Provide the optional pi peers the bundle keeps external — in real
		// deployments the pi HOST supplies these; a naked install legitimately
		// lacks them. Installing the devDep-pinned versions simulates the host
		// so the import smoke (6b) tests the tarball artifact, not peer absence.
		run(
			"npm install @earendil-works/pi-agent-core@^0.84.0 @earendil-works/pi-ai@^0.84.0 @earendil-works/pi-coding-agent@^0.84.0 @earendil-works/pi-tui@^0.84.0",
			tmpDir,
		);

		// 5. Verify extension loads
		const pkgPath = path.join(tmpDir, "node_modules", "pi-crew", "package.json");
		if (!fs.existsSync(pkgPath)) throw new Error("pi-crew package not found in node_modules");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
		log(`  Installed version: ${pkg.version}`);

		// 6. Verify key entrypoints exist
		const srcRegister = path.join(tmpDir, "node_modules", "pi-crew", "src", "extension", "register.ts");
		if (fs.existsSync(srcRegister)) {
			log(`  Extension register entrypoint found: ${srcRegister}`);
		} else {
			throw new Error("Could not find extension register entrypoint");
		}

		// 6b. ARCH-6: clean-install import smoke — actually import the installed
		// bundle and shape-check its exports. Ports bundle-load.test.ts from the
		// in-repo dist to the tarball-installed artifact, catching CJS-shim /
		// external-resolution / tree-shaking breaks that "file exists" checks
		// cannot. A green in-repo test can coexist with a broken packed tarball
		// (files excluded from npm pack, postinstall drift) — this closes that gap.
		const installedBundle = path.join(tmpDir, "node_modules", "pi-crew", "dist", "index.mjs");
		if (!fs.existsSync(installedBundle)) throw new Error(`Installed bundle missing: ${installedBundle}`);
		const mod = await import(pathToFileURL(installedBundle).href);
		for (const name of ["registerPiTeams", "waitForRun", "runPostInitSkillCheck"]) {
			if (typeof mod[name] !== "function") throw new Error(`installed bundle: ${name} export missing/broken`);
		}
		if (typeof mod.default !== "function") throw new Error("installed bundle: default export (Pi extension entry) missing");
		log("  Import smoke: tarball-installed bundle loads; exports OK (registerPiTeams/waitForRun/runPostInitSkillCheck/default)");

		// 7. Verify version consistency
		if (pkg.version !== version) {
			throw new Error(`Version mismatch: root=${version} installed=${pkg.version}`);
		}
		log(`  Version consistency: OK ${pkg.version}`);

		log("Release smoke test PASSED!");
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		// Clean up tarball
		try { fs.unlinkSync(tarballPath); } catch {}
	}
} catch (error) {
	console.error("Release smoke test FAILED:", error instanceof Error ? error.message : String(error));
	process.exit(1);
}