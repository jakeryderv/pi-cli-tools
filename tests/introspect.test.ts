import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverRegistry, resolveExecutable } from "../src/introspect.js";
import type { LoadedRegistryDefinition, RegistryDefinition } from "../src/types.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("executable discovery", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-cli-tools-discovery-"));
	});

	afterEach(async () => {
		await rm(root, { force: true, recursive: true });
	});

	it("preserves candidate precedence and never launches inspected files", async () => {
		const firstDirectory = join(root, "first");
		const secondDirectory = join(root, "second");
		const marker = join(root, "executed");
		await mkdir(firstDirectory);
		await mkdir(secondDirectory);
		await writeExecutable(join(firstDirectory, "fallback"), marker);
		await writeExecutable(join(secondDirectory, "primary"), marker);

		const result = await resolveExecutable(["primary", "fallback"], {
			env: { PATH: [firstDirectory, secondDirectory].join(delimiter) },
		});

		expect(result).toEqual({
			candidate: "primary",
			executablePath: await realpath(join(secondDirectory, "primary")),
			checkedPaths: [join(firstDirectory, "primary"), join(secondDirectory, "primary")],
		});
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("ignores non-executable files and reports every checked path", async () => {
		const directory = join(root, "bin");
		await mkdir(directory);
		await writeFile(join(directory, "first"), "not executable", "utf8");

		const result = await resolveExecutable(["first", "second"], {
			env: { PATH: directory },
		});

		expect(result).toEqual({
			checkedPaths: [join(directory, "first"), join(directory, "second")],
		});
	});

	it("returns the real path behind an executable symlink", async () => {
		const directory = join(root, "bin");
		const target = join(root, "target");
		await mkdir(directory);
		await writeExecutable(target, join(root, "executed"));
		await symlink(target, join(directory, "tool"));

		const result = await resolveExecutable(["tool"], {
			env: { PATH: directory },
		});

		expect(result).toMatchObject({
			candidate: "tool",
			executablePath: await realpath(target),
		});
	});

	it("resolves every registry definition in stable input order", async () => {
		const directory = join(root, "bin");
		await mkdir(directory);
		await writeExecutable(join(directory, "available"), join(root, "executed"));
		const definitions = [
			createLoadedDefinition("available", "cli_available"),
			createLoadedDefinition("missing", "cli_missing"),
		];

		const result = await discoverRegistry(definitions, {
			env: { PATH: directory },
		});

		expect(result.map(({ status, registry }) => [registry.definition.id, status])).toEqual([
			["available", "available"],
			["missing", "missing"],
		]);
	});

	it("returns no checked paths when PATH is absent", async () => {
		await expect(resolveExecutable(["tool"], { env: {} })).resolves.toEqual({ checkedPaths: [] });
	});
});

async function writeExecutable(path: string, marker: string): Promise<void> {
	await writeFile(path, `#!/bin/sh\nprintf executed > "${marker}"\n`, "utf8");
	await chmod(path, 0o755);
}

function createLoadedDefinition(id: string, toolName: string): LoadedRegistryDefinition {
	const definition: RegistryDefinition = {
		id,
		tool_name: toolName,
		binary: { candidates: [id] },
		routing: { description: `Use ${id}` },
		introspection: { man: false },
		docs: { official: [] },
		execution: { timeout_ms: 1000, cwd: "session", inherit_env: true },
	};
	return {
		definition,
		source: { layer: "test", path: `/registry/${id}.yaml` },
	};
}
