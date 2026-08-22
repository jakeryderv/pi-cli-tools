import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { getAcceptedExitCodes, loadRegistry } from "../src/registry.js";
import type { RegistryDefinition, RegistryLayer, RegistryLoadResult } from "../src/types.js";

describe("loadRegistry", () => {
	let root: string;
	let bundledDirectory: string;
	let userDirectory: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-cli-tools-registry-"));
		bundledDirectory = join(root, "bundled");
		userDirectory = join(root, "user");
		await mkdir(bundledDirectory);
	});

	afterEach(async () => {
		await rm(root, { force: true, recursive: true });
	});

	it("loads the bundled production registry", async () => {
		const productionDirectory = fileURLToPath(new URL("../tools/", import.meta.url));

		const result = await loadRegistry([
			{ name: "bundled", kind: "bundled", directory: productionDirectory, required: true },
		]);

		expect(result.definitions.map(({ definition }) => definition.id)).toEqual(["github", "ripgrep"]);
		expect(getAcceptedExitCodes(requireDefinition(result, 0))).toEqual([0]);
		const ripgrep = requireDefinition(result, 1);
		expect(ripgrep).toMatchObject({
			id: "ripgrep",
			tool_name: "cli_rg",
			binary: { candidates: ["rg"] },
			introspection: { version: { args: ["--version"] }, help: { args: ["--help"] }, man: false },
			execution: {
				timeout_ms: 120_000,
				cwd: "session",
				inherit_env: false,
				accepted_exit_codes: [0, 1],
			},
		});
		expect(getAcceptedExitCodes(ripgrep)).toEqual([0, 1]);
		expect(result.issues).toEqual([]);
	});

	it("loads a valid definition and treats a missing optional layer as normal", async () => {
		await writeYaml(bundledDirectory, "github.yaml", createDefinition());

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.definitions).toHaveLength(1);
		expect(result.definitions[0]?.definition.id).toBe("github");
		expect(result.definitions[0]?.source.layer).toBe("bundled");
		expect(result.layers).toMatchObject([
			{ name: "bundled", exists: true, files: [join(bundledDirectory, "github.yaml")] },
			{ name: "user", exists: false, files: [] },
		]);
		expect(result.issues).toEqual([]);
	});

	it("defaults an omitted accepted-exit policy to only zero", async () => {
		await writeYaml(bundledDirectory, "github.yaml", createDefinition());

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.definitions[0]?.definition.execution.accepted_exit_codes).toBeUndefined();
		expect(getAcceptedExitCodes(requireDefinition(result))).toEqual([0]);
	});

	it("accepts portable exit-code boundaries and treats an explicit list as authoritative", async () => {
		const definition = createDefinition();
		definition.execution.accepted_exit_codes = [255, 0];
		await writeYaml(bundledDirectory, "github.yaml", definition);

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(getAcceptedExitCodes(requireDefinition(result))).toEqual([255, 0]);
		expect(result.issues).toEqual([]);
	});

	it("accepts the bounded maximum of every portable exit code", async () => {
		const definition = createDefinition();
		definition.execution.accepted_exit_codes = Array.from({ length: 256 }, (_unused, code) => code);
		await writeYaml(bundledDirectory, "github.yaml", definition);

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(getAcceptedExitCodes(requireDefinition(result))).toEqual(
			Array.from({ length: 256 }, (_unused, code) => code),
		);
		expect(result.issues).toEqual([]);
	});

	it.each([
		["empty", []],
		["duplicate", [0, 0]],
		["negative zero", [-0]],
		["negative-zero duplicate", [-0, 0]],
		["negative", [-1]],
		["above portable range", [256]],
		["fractional", [1.5]],
		["non-finite", [Number.POSITIVE_INFINITY]],
		["string", ["1"]],
		["over item bound", Array.from({ length: 257 }, () => 0)],
	])("rejects the %s accepted-exit policy", async (_name, acceptedExitCodes) => {
		const definition = createDefinition() as unknown as Record<string, unknown>;
		const execution = definition.execution as Record<string, unknown>;
		execution.accepted_exit_codes = acceptedExitCodes;
		await writeYaml(bundledDirectory, "invalid.yaml", definition);

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.definitions).toEqual([]);
		expect(result.issues).toEqual([
			expect.objectContaining({
				code: "invalid_definition",
				layer: "bundled",
				path: join(bundledDirectory, "invalid.yaml"),
			}),
		]);
	});

	it.each([
		["negative zero", "[-0]"],
		["negative-zero duplicate", "[-0,0]"],
	])("rejects %s in a JSON accepted-exit policy", async (_name, encodedPolicy) => {
		const definition = createDefinition();
		definition.execution.accepted_exit_codes = [0];
		const serialized = JSON.stringify(definition);
		const contents = serialized.replace('"accepted_exit_codes":[0]', `"accepted_exit_codes":${encodedPolicy}`);
		if (contents === serialized) throw new Error("failed to construct negative-zero JSON fixture");
		await writeFile(join(bundledDirectory, "invalid.json"), contents, "utf8");

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.definitions).toEqual([]);
		expect(result.issues).toEqual([
			expect.objectContaining({
				code: "invalid_definition",
				layer: "bundled",
				path: join(bundledDirectory, "invalid.json"),
			}),
		]);
	});

	it("rejects unknown fields with source provenance", async () => {
		const definition = createDefinition();
		await writeYaml(bundledDirectory, "invalid.yaml", {
			...definition,
			execution: { ...definition.execution, unexpected: true },
		});

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.definitions).toEqual([]);
		expect(result.issues).toEqual([
			expect.objectContaining({
				code: "invalid_definition",
				layer: "bundled",
				path: join(bundledDirectory, "invalid.yaml"),
			}),
		]);
	});

	it("replaces a bundled definition with the complete user definition", async () => {
		const bundled = createDefinition();
		bundled.execution.accepted_exit_codes = [0, 1];
		await writeYaml(bundledDirectory, "github.yaml", bundled);
		await mkdir(userDirectory);
		await writeYaml(userDirectory, "github.yaml", createDefinition("github", "custom_gh"));

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.definitions).toHaveLength(1);
		expect(result.definitions[0]).toMatchObject({
			definition: { id: "github", tool_name: "custom_gh" },
			source: { layer: "user", path: join(userDirectory, "github.yaml") },
		});
		expect(getAcceptedExitCodes(requireDefinition(result))).toEqual([0]);
	});

	it("quarantines a bundled definition behind an attributable negative-zero accepted-exit override", async () => {
		const bundled = createDefinition("ripgrep", "cli_rg");
		bundled.execution.accepted_exit_codes = [0, 1];
		await writeYaml(bundledDirectory, "ripgrep.yaml", bundled);
		await mkdir(userDirectory);
		const invalidOverride = createDefinition("ripgrep", "custom_rg") as unknown as Record<string, unknown>;
		(invalidOverride.execution as Record<string, unknown>).accepted_exit_codes = [-0, 0];
		await writeYaml(userDirectory, "ripgrep.yaml", invalidOverride);

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.definitions[0]?.definition.tool_name).toBe("cli_rg");
		expect(result.quarantined).toEqual([
			{
				id: "ripgrep",
				layer: "user",
				paths: [join(userDirectory, "ripgrep.yaml")],
				reason: "invalid_override",
			},
		]);
		expect(result.issues).toEqual([expect.objectContaining({ code: "invalid_definition", layer: "user" })]);
	});

	it("allows a user tombstone to disable a bundled definition", async () => {
		await writeYaml(bundledDirectory, "github.yaml", createDefinition());
		await mkdir(userDirectory);
		await writeYaml(userDirectory, "github.yaml", { id: "github", disabled: true });

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.definitions).toEqual([]);
		expect(result.disabled).toEqual([
			{
				entry: { id: "github", disabled: true },
				source: { layer: "user", path: join(userDirectory, "github.yaml") },
			},
		]);
	});

	it("rejects duplicate IDs within one layer without hiding a lower-layer definition", async () => {
		await writeYaml(bundledDirectory, "github.yaml", createDefinition());
		await mkdir(userDirectory);
		await writeYaml(userDirectory, "first.yaml", createDefinition("github", "first_gh"));
		await writeYaml(userDirectory, "second.yaml", createDefinition("github", "second_gh"));

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.definitions).toHaveLength(1);
		expect(result.definitions[0]?.definition.tool_name).toBe("cli_gh");
		expect(result.issues).toEqual([expect.objectContaining({ code: "duplicate_id", layer: "user" })]);
	});

	it("quarantines a lower definition when a higher layer has duplicate IDs", async () => {
		await writeYaml(bundledDirectory, "github.yaml", createDefinition());
		await mkdir(userDirectory);
		await writeYaml(userDirectory, "first.yaml", createDefinition("github", "first_gh"));
		await writeYaml(userDirectory, "second.yaml", createDefinition("github", "second_gh"));

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.quarantined).toEqual([
			{
				id: "github",
				layer: "user",
				paths: [join(userDirectory, "first.yaml"), join(userDirectory, "second.yaml")],
				reason: "duplicate_id",
			},
		]);
	});

	it("quarantines an attributable malformed higher-layer tombstone", async () => {
		await writeYaml(bundledDirectory, "github.yaml", createDefinition());
		await mkdir(userDirectory);
		await writeFile(join(userDirectory, "malformed.yaml"), "id: github\ndisabled: true\ndisabled: false\n", "utf8");

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.definitions[0]?.definition.tool_name).toBe("cli_gh");
		expect(result.quarantined).toEqual([
			{
				id: "github",
				layer: "user",
				paths: [join(userDirectory, "malformed.yaml")],
				reason: "invalid_override",
			},
		]);
		expect(result.issues).toEqual([expect.objectContaining({ code: "yaml_parse_error" })]);
	});

	it("does not attribute a malformed document with duplicate top-level IDs", async () => {
		await writeYaml(bundledDirectory, "github.yaml", createDefinition());
		await mkdir(userDirectory);
		await writeFile(join(userDirectory, "ambiguous.yaml"), "id: github\nid: another\ndisabled: true\n", "utf8");

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.quarantined).toEqual([]);
		expect(result.definitions[0]?.definition.id).toBe("github");
	});

	it("quarantines an attributable invalid higher-layer override", async () => {
		await writeYaml(bundledDirectory, "github.yaml", createDefinition());
		await mkdir(userDirectory);
		await writeYaml(userDirectory, "invalid.yaml", { id: "github", disabled: true, unexpected: true });

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.definitions[0]?.definition.tool_name).toBe("cli_gh");
		expect(result.quarantined).toEqual([
			{
				id: "github",
				layer: "user",
				paths: [join(userDirectory, "invalid.yaml")],
				reason: "invalid_override",
			},
		]);
	});

	it("excludes quarantined IDs before final tool-name conflict calculation", async () => {
		await writeYaml(bundledDirectory, "a.yaml", createDefinition("a", "cli_shared"));
		await writeYaml(bundledDirectory, "b.yaml", createDefinition("b", "cli_shared"));
		await mkdir(userDirectory);
		await writeYaml(userDirectory, "invalid-a.yaml", {
			...createDefinition("a", "cli_invalid"),
			unexpected: true,
		});

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.definitions.map(({ definition }) => definition.id)).toEqual(["a", "b"]);
		expect(result.quarantined.map(({ id }) => id)).toEqual(["a"]);
		expect(result.issues.map(({ code }) => code)).toEqual(["invalid_definition"]);
	});

	it("removes all executable definitions that share a final Pi tool name", async () => {
		await writeYaml(bundledDirectory, "github.yaml", createDefinition("github", "cli_remote"));
		await writeYaml(bundledDirectory, "gitlab.yaml", createDefinition("gitlab", "cli_remote"));

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.definitions).toEqual([]);
		expect(result.issues).toEqual([expect.objectContaining({ code: "duplicate_tool_name", layer: "merged" })]);
	});

	it("reports duplicate YAML mapping keys as parse errors", async () => {
		await writeFile(join(bundledDirectory, "duplicate.yaml"), "id: first\nid: second\n", "utf8");

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.definitions).toEqual([]);
		expect(result.issues).toEqual([expect.objectContaining({ code: "yaml_parse_error" })]);
	});

	it("loads JSON definitions and rejects unsupported documentation URL protocols", async () => {
		const definition = createDefinition();
		definition.docs.official = ["file:///tmp/manual"];
		await writeFile(join(bundledDirectory, "github.json"), JSON.stringify(definition), "utf8");

		const result = await loadRegistry(createLayers(bundledDirectory, userDirectory));

		expect(result.definitions).toEqual([]);
		expect(result.issues).toEqual([expect.objectContaining({ code: "invalid_url" })]);
	});
});

function requireDefinition(result: RegistryLoadResult, index = 0): RegistryDefinition {
	const loaded = result.definitions[index];
	if (!loaded) throw new Error(`expected registry definition at index ${String(index)}`);
	return loaded.definition;
}

function createLayers(bundledDirectory: string, userDirectory: string): RegistryLayer[] {
	return [
		{ name: "bundled", kind: "bundled", directory: bundledDirectory, required: true },
		{ name: "user", kind: "user", directory: userDirectory, required: false },
	];
}

function createDefinition(id = "github", toolName = "cli_gh"): RegistryDefinition {
	return {
		id,
		tool_name: toolName,
		binary: { candidates: ["gh"] },
		routing: { description: `Use ${id}` },
		introspection: {
			version: { args: ["--version"] },
			help: { args: ["--help"] },
			subcommand_help: { append_args: ["--help"] },
			man: false,
		},
		docs: { official: ["https://example.com/docs"] },
		execution: { timeout_ms: 120_000, cwd: "session", inherit_env: true },
	};
}

async function writeYaml(directory: string, name: string, value: unknown): Promise<void> {
	await writeFile(join(directory, name), stringify(value), "utf8");
}
