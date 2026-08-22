import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import cliToolsExtension from "../extensions/cli-tools.js";
import type { CliToolResultDetails } from "../extensions/pi-adapter.js";
import { fixturePath } from "./helpers/runner.js";
import { createDefinition, createMockPi, createToolInfo } from "./helpers/pi-adapter.js";

const describePosix = process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip;

function resultDetails(result: Awaited<ReturnType<ToolDefinition["execute"]>>): CliToolResultDetails {
	return result.details as CliToolResultDetails;
}

describePosix("Pi extension lifecycle adaptation", () => {
	let root: string;
	let agentDirectory: string;
	let binDirectory: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-cli-tools-extension-"));
		agentDirectory = join(root, "agent");
		binDirectory = join(root, "bin");
		await mkdir(join(agentDirectory, "cli-tools"), { recursive: true });
		await mkdir(binDirectory);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(root, { force: true, recursive: true });
	});

	it("discovers from session cwd, registers once, and classifies tool results", async () => {
		await symlink(process.execPath, join(binDirectory, "fixture-cli"));
		vi.stubEnv("PATH", "bin");
		await writeDefinition(createDefinition("github", "cli_gh", { binary: { candidates: ["fixture-cli"] } }));
		const harness = createMockPi();

		await cliToolsExtension(harness.api);
		expect(harness.tools).toEqual([]);

		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.context(root));
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.context(root));

		expect(harness.tools.map(({ name }) => name)).toEqual(["cli_gh"]);
		const tool = harness.tools[0];
		if (!tool) throw new Error("expected registered tool");
		const nonzero = await tool.execute(
			"nonzero",
			{ args: [fixturePath, "exit", "9"] },
			undefined,
			undefined,
			harness.context(root) as unknown as Parameters<typeof tool.execute>[4],
		);
		const nonzeroDetails = resultDetails(nonzero);
		const nonzeroPatches = await harness.emit("tool_result", {
			type: "tool_result",
			toolName: "cli_gh",
			details: nonzeroDetails,
		});
		expect(nonzeroPatches).toEqual([{ isError: true }]);

		const zero = await tool.execute(
			"zero",
			{ args: [fixturePath, "exit", "0"] },
			undefined,
			undefined,
			harness.context(root) as unknown as Parameters<typeof tool.execute>[4],
		);
		const zeroPatches = await harness.emit("tool_result", {
			type: "tool_result",
			toolName: "cli_gh",
			details: resultDetails(zero),
		});
		expect(zeroPatches).toEqual([undefined]);
		const mismatchedPatches = await harness.emit("tool_result", {
			type: "tool_result",
			toolName: "cli_gh",
			details: { ...resultDetails(zero), registryId: "another-registry-id" },
		});
		expect(mismatchedPatches).toEqual([undefined]);

		const unrelatedPatches = await harness.emit("tool_result", {
			type: "tool_result",
			toolName: "another_tool",
			details: nonzeroDetails,
		});
		expect(unrelatedPatches).toEqual([undefined]);
	});

	it("preserves an earlier middleware error decision for a successful CLI exit", async () => {
		await symlink(process.execPath, join(binDirectory, "fixture-cli"));
		vi.stubEnv("PATH", binDirectory);
		await writeDefinition(createDefinition("github", "cli_gh", { binary: { candidates: ["fixture-cli"] } }));
		const harness = createMockPi();
		harness.handlers.set("tool_result", [() => ({ isError: true })]);
		await cliToolsExtension(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.context(root));
		const tool = harness.tools[0];
		if (!tool) throw new Error("expected registered tool");
		const result = await tool.execute(
			"zero",
			{ args: [fixturePath, "exit", "0"] },
			undefined,
			undefined,
			harness.context(root) as unknown as Parameters<typeof tool.execute>[4],
		);

		const patches = await harness.emit("tool_result", {
			type: "tool_result",
			toolName: "cli_gh",
			details: resultDetails(result),
		});
		expect(patches).toEqual([{ isError: true }, undefined]);
	});

	it("uses a fresh extension instance to rediscover relative PATH entries for a replacement cwd", async () => {
		vi.stubEnv("PATH", "bin");
		await writeDefinition(createDefinition("github", "cli_gh", { binary: { candidates: ["fixture-cli"] } }));
		const firstCwd = join(root, "first-session");
		const secondCwd = join(root, "second-session");
		await writeSessionExecutable(firstCwd, "first");
		await writeSessionExecutable(secondCwd, "second");

		const firstHarness = createMockPi();
		await cliToolsExtension(firstHarness.api);
		await firstHarness.emit(
			"session_start",
			{ type: "session_start", reason: "startup" },
			firstHarness.context(firstCwd),
		);
		const secondHarness = createMockPi();
		await cliToolsExtension(secondHarness.api);
		await secondHarness.emit(
			"session_start",
			{ type: "session_start", reason: "resume" },
			secondHarness.context(secondCwd),
		);

		const firstTool = firstHarness.tools[0];
		const secondTool = secondHarness.tools[0];
		if (!firstTool || !secondTool) throw new Error("expected tools in both extension instances");
		const firstResult = await firstTool.execute(
			"first",
			{ args: [] },
			undefined,
			undefined,
			firstHarness.context(firstCwd) as unknown as Parameters<typeof firstTool.execute>[4],
		);
		const secondResult = await secondTool.execute(
			"second",
			{ args: [] },
			undefined,
			undefined,
			secondHarness.context(secondCwd) as unknown as Parameters<typeof secondTool.execute>[4],
		);
		const firstDetails = resultDetails(firstResult);
		const secondDetails = resultDetails(secondResult);
		if (firstDetails.kind !== "execution" || secondDetails.kind !== "execution") {
			throw new Error("expected execution details");
		}
		expect(firstDetails.execution.executablePath).toBe(join(firstCwd, "bin", "fixture-cli"));
		expect(secondDetails.execution.executablePath).toBe(join(secondCwd, "bin", "fixture-cli"));
		expect(firstDetails.execution).toMatchObject({ cwd: firstCwd, stdout: "first" });
		expect(secondDetails.execution).toMatchObject({ cwd: secondCwd, stdout: "second" });
	});

	it("stores collision provenance and never reports its own registered tool as a collision", async () => {
		await symlink(process.execPath, join(binDirectory, "fixture-cli"));
		vi.stubEnv("PATH", binDirectory);
		await writeDefinition(createDefinition("github", "cli_gh", { binary: { candidates: ["fixture-cli"] } }));
		const collisionHarness = createMockPi({ existingTools: [createToolInfo("cli_gh", "extension:earlier")] });
		await cliToolsExtension(collisionHarness.api);
		await collisionHarness.emit(
			"session_start",
			{ type: "session_start", reason: "startup" },
			collisionHarness.context(root),
		);

		expect(collisionHarness.tools).toEqual([]);
		await runDiagnostics(collisionHarness, root);
		expect(collisionHarness.notifications.at(-1)).toMatchObject({ severity: "warning" });
		expect(collisionHarness.notifications.at(-1)?.message).toContain("[tool_name_collision]");
		expect(collisionHarness.notifications.at(-1)?.message).toContain("extension:earlier");

		const successfulHarness = createMockPi();
		await cliToolsExtension(successfulHarness.api);
		await successfulHarness.emit(
			"session_start",
			{ type: "session_start", reason: "startup" },
			successfulHarness.context(root),
		);
		await runDiagnostics(successfulHarness, root);
		expect(successfulHarness.notifications.at(-1)?.message).toContain("Collisions: 0");
		expect(successfulHarness.notifications.at(-1)?.message).not.toContain("tool_name_collision");
	});

	it("withholds a bundled tool behind an attributable malformed tombstone", async () => {
		await symlink(process.execPath, join(binDirectory, "gh"));
		vi.stubEnv("PATH", binDirectory);
		await writeFile(
			join(agentDirectory, "cli-tools", "malformed.yaml"),
			"id: github\ndisabled: true\ndisabled: false\n",
			"utf8",
		);
		const harness = createMockPi();
		await cliToolsExtension(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.context(root));

		expect(harness.tools).toEqual([]);
		await runDiagnostics(harness, root);
		expect(harness.notifications.at(-1)).toMatchObject({ severity: "warning" });
		expect(harness.notifications.at(-1)?.message).toContain("github: invalid_override");
		expect(harness.notifications.at(-1)?.message).toContain("lower-precedence definition withheld");
	});

	it("keeps missing executables visible and provides reload-based refresh guidance", async () => {
		vi.stubEnv("PATH", binDirectory);
		await writeDefinition(createDefinition("github", "cli_gh", { binary: { candidates: ["missing-cli"] } }));
		const harness = createMockPi();
		await cliToolsExtension(harness.api);
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.context(root));

		expect(harness.tools).toEqual([]);
		await runDiagnostics(harness, root);
		expect(harness.notifications.at(-1)).toMatchObject({ severity: "info" });
		expect(harness.notifications.at(-1)?.message).toContain("Missing: 1");
		expect(harness.notifications.at(-1)?.message).toContain("Run /reload after installing");
	});

	async function writeDefinition(definition: ReturnType<typeof createDefinition>): Promise<void> {
		await writeFile(join(agentDirectory, "cli-tools", "github.yaml"), stringify(definition), "utf8");
	}

	async function writeSessionExecutable(cwd: string, output: string): Promise<void> {
		const sessionBin = join(cwd, "bin");
		await mkdir(sessionBin, { recursive: true });
		const executable = join(sessionBin, "fixture-cli");
		await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`, "utf8");
		await chmod(executable, 0o755);
	}
});

async function runDiagnostics(harness: ReturnType<typeof createMockPi>, cwd: string): Promise<void> {
	const command = harness.commands.get("cli-tools");
	if (!command) throw new Error("expected /cli-tools command");
	await command.handler("", harness.context(cwd) as unknown as ExtensionCommandContext);
}
