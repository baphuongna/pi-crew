import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { isSensitivePath } from "../../../../src/runtime/sensitive-paths.ts";

describe("sensitive-paths", () => {
	describe("isSensitivePath", () => {
		it("detects .env files", () => {
			assert.equal(isSensitivePath(".env"), true);
			assert.equal(isSensitivePath(".env.local"), true);
			assert.equal(isSensitivePath(".env.production"), true);
		});

		it("detects credential files", () => {
			assert.equal(isSensitivePath("credentials.json"), true);
			assert.equal(isSensitivePath("credentials"), true);
		});

		it("detects secret files", () => {
			assert.equal(isSensitivePath("secrets.yaml"), true);
			assert.equal(isSensitivePath("secret.txt"), true);
		});

		it("detects password files", () => {
			assert.equal(isSensitivePath("passwords.txt"), true);
			assert.equal(isSensitivePath("passwd"), true);
		});

		it("detects SSH keys", () => {
			assert.equal(isSensitivePath("id_rsa"), true);
			assert.equal(isSensitivePath("id_ed25519.pub"), true);
			assert.equal(isSensitivePath("id_ecdsa"), true);
		});

		it("detects .ssh directory", () => {
			assert.equal(isSensitivePath(path.join(".ssh", "config")), true);
			assert.equal(isSensitivePath(path.join("home", ".ssh", "id_rsa")), true);
		});

		it("detects .aws directory", () => {
			assert.equal(isSensitivePath(path.join(".aws", "credentials")), true);
		});

		it("detects PEM/key files", () => {
			assert.equal(isSensitivePath("server.pem"), true);
			assert.equal(isSensitivePath("private.key"), true);
			assert.equal(isSensitivePath("cert.p12"), true);
			assert.equal(isSensitivePath("ca.crt"), true);
		});

		it("detects apikey in compound names", () => {
			assert.equal(isSensitivePath("my-apikey.json"), true);
			assert.equal(isSensitivePath("API_KEY.config"), true);
			assert.equal(isSensitivePath("api-key.txt"), true);
			assert.equal(isSensitivePath("api_key.yaml"), true);
		});

		it("detects token in names", () => {
			assert.equal(isSensitivePath("access-token.json"), true);
			assert.equal(isSensitivePath("ACCESS_TOKEN"), true);
		});

		it("allows normal source files", () => {
			assert.equal(isSensitivePath("src/main.ts"), false);
			assert.equal(isSensitivePath("package.json"), false);
			assert.equal(isSensitivePath("README.md"), false);
			assert.equal(isSensitivePath("test/unit/state-store.test.ts"), false);
		});

		it("allows config files that are not sensitive", () => {
			assert.equal(isSensitivePath("tsconfig.json"), false);
			assert.equal(isSensitivePath(".gitignore"), false);
			assert.equal(isSensitivePath("biome.json"), false);
		});
	});
});
