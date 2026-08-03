import assert from "node:assert/strict";
import test from "node:test";
import { renderOutputSchemaBlock } from "../../../../src/runtime/task-runner/prompt-builder.ts";
import type { TaskOutputSchema, TaskPacket } from "../../../../src/state/types.ts";

test("renderOutputSchemaBlock includes format instruction", () => {
	const schema: TaskOutputSchema = { format: "text" };
	const block = renderOutputSchemaBlock(schema);
	assert.ok(block.includes("## Expected Output Format"));
	assert.ok(block.includes("Your final output must be text."));
});

test("renderOutputSchemaBlock includes description when provided", () => {
	const schema: TaskOutputSchema = {
		format: "text",
		description: "A summary of findings.",
	};
	const block = renderOutputSchemaBlock(schema);
	assert.ok(block.includes("A summary of findings."));
});

test("renderOutputSchemaBlock includes JSON schema block for json format", () => {
	const jsonSchema: Record<string, unknown> = {
		type: "object",
		properties: { name: { type: "string" } },
		required: ["name"],
	};
	const schema: TaskOutputSchema = { format: "json", schema: jsonSchema };
	const block = renderOutputSchemaBlock(schema);
	assert.ok(block.includes("The output must match this schema:"));
	assert.ok(block.includes("```json"));
	assert.ok(block.includes('"type": "object"'));
	assert.ok(block.includes('"name"'));
});

test("renderOutputSchemaBlock omits JSON schema block for markdown format", () => {
	const schema: TaskOutputSchema = { format: "markdown" };
	const block = renderOutputSchemaBlock(schema);
	assert.ok(!block.includes("The output must match this schema:"));
	assert.ok(!block.includes("```json"));
});

test("renderOutputSchemaBlock includes example when provided", () => {
	const schema: TaskOutputSchema = {
		format: "json",
		example: '{"name": "Alice"}',
	};
	const block = renderOutputSchemaBlock(schema);
	assert.ok(block.includes("Example output:"));
	assert.ok(block.includes('{"name": "Alice"}'));
});

test("renderOutputSchemaBlock omits example when not provided", () => {
	const schema: TaskOutputSchema = { format: "text" };
	const block = renderOutputSchemaBlock(schema);
	assert.ok(!block.includes("Example output:"));
});

test("TaskPacket accepts optional outputSchema field", () => {
	const packet: TaskPacket = {
		objective: "Do something",
		scope: "workspace",
		repo: "test-repo",
		branchPolicy: "Use current checkout",
		acceptanceTests: [],
		commitPolicy: "Do not commit",
		reportingContract: "Report changes",
		escalationPolicy: "Stop and report",
		constraints: ["Stay in scope"],
		expectedArtifacts: ["result"],
		verification: {
			requiredGreenLevel: "none",
			commands: [],
			allowManualEvidence: true,
		},
	};
	assert.equal(packet.outputSchema, undefined);

	const packetWithSchema: TaskPacket = {
		...packet,
		outputSchema: {
			format: "json",
			schema: { type: "object" },
			description: "JSON output",
			example: "{}",
		},
	};
	assert.equal(packetWithSchema.outputSchema?.format, "json");
	assert.equal(packetWithSchema.outputSchema?.description, "JSON output");
});
