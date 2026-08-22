import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import Value from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	activatePiCliTools,
	CliToolParameters,
	createNativeCliTool,
	createPiCliToolsState,
	createSpoolCleanupOwnership,
	createToolDescription,
	formatCliExecutionForModel,
	formatCliToolsDiagnostics,
	isCliToolResultError,
	mapCliExecutionRequest,
	PI_DIAGNOSTIC_MAX_BYTES,
	PI_DIAGNOSTIC_MAX_LINES,
	PI_MODEL_OUTPUT_MAX_BYTES,
	PI_MODEL_OUTPUT_MAX_LINES,
	type CliToolResultDetails,
} from "../extensions/pi-adapter.js";
import { CLI_MAX_ARGUMENT_BYTES, CLI_MAX_ARGUMENT_COUNT } from "../src/limits.js";
import type { CliErrorDetails, CliExecutionResult } from "../src/types.js";
import { removeCliOutputSpool } from "../src/runner.js";
import {
	expectProcessGone,
	fixturePath,
	isProcessAlive,
	killProcess,
	outputSpoolDirectories,
	readReadyPids,
	runFake,
	waitForFile,
	withWatchdog,
} from "./helpers/runner.js";
import {
	createAvailableDiscovery,
	createDefinition,
	createMockPi,
	createRegistry,
	createToolInfo,
	loadDefinition,
} from "./helpers/pi-adapter.js";

const describePosix = process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip;

function asContext(cwd: string): ExtensionContext {
	return { cwd } as ExtensionContext;
}

function resultDetails(result: Awaited<ReturnType<ToolDefinition["execute"]>>): CliToolResultDetails {
	const details = result.details;
	if (!details || typeof details !== "object" || !("adapter" in details)) {
		throw new Error("expected pi-cli-tools details");
	}
	return details as CliToolResultDetails;
}

function resultText(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
	const content: unknown = result.content[0];
	if (!content || typeof content !== "object" || !("type" in content) || !("text" in content)) return "";
	return content.type === "text" && typeof content.text === "string" ? content.text : "";
}

function countLogicalLines(value: string): number {
	if (!value) return 0;
	let newlines = 0;
	for (const character of value) if (character === "\n") newlines += 1;
	return newlines + (value.endsWith("\n") ? 0 : 1);
}

describe("native CLI tool contract", () => {
	it("exposes exactly one strict args array and leaves byte-total validation to the runner", () => {
		const schema = CliToolParameters as typeof CliToolParameters & {
			additionalProperties: boolean;
			required: string[];
			properties: {
				args: { maxItems: number; items: { maxLength: number } };
			};
		};
		expect(Object.keys(schema.properties)).toEqual(["args"]);
		expect(schema.additionalProperties).toBe(false);
		expect(schema.required).toEqual(["args"]);
		expect(schema.properties.args.maxItems).toBe(CLI_MAX_ARGUMENT_COUNT);
		expect(schema.properties.args.items.maxLength).toBe(CLI_MAX_ARGUMENT_BYTES);
		expect(Value.Check(CliToolParameters, { args: ["", "a b", "$(touch nope)", ";", "`id`"] })).toBe(true);
		expect(Value.Check(CliToolParameters, { args: [], cwd: "/tmp" })).toBe(false);
		expect(Value.Check(CliToolParameters, { executablePath: "/bin/echo", args: [] })).toBe(false);
		expect(Value.Check(CliToolParameters, { args: "--help" })).toBe(false);
	});

	it("creates deterministic Pi metadata without prompt or execution-mode extras", () => {
		const definition = createDefinition();
		const tool = createNativeCliTool(createAvailableDiscovery(process.execPath, definition));

		expect(Object.keys(tool).sort()).toEqual(
			["description", "execute", "label", "name", "parameters", "renderCall", "renderResult"].sort(),
		);
		expect(tool).toMatchObject({
			name: "cli_fixture",
			label: "cli_fixture",
			parameters: CliToolParameters,
		});
		expect(tool.description).toBe(
			"Use fixture. Prefer for: controlled CLI operations. Avoid for: unrelated local file edits. Arguments are passed as literal argv without a shell; output is bounded using tail selection.",
		);
		expect(tool.promptSnippet).toBeUndefined();
		expect(tool.promptGuidelines).toBeUndefined();
		expect(tool.executionMode).toBeUndefined();
	});

	it("bounds generated descriptions while retaining the shell-free and tail-selection contract", () => {
		const definition = createDefinition("large", "cli_large", {
			routing: {
				description: "x".repeat(2_048),
				prefer_for: Array.from({ length: 32 }, () => "p".repeat(500)),
				avoid_for: Array.from({ length: 32 }, () => "a".repeat(500)),
			},
		});
		const description = createToolDescription(definition);
		expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(2_048);
		expect(description).toContain("without a shell");
		expect(description).toContain("tail selection");
	});

	it("maps only trusted discovery, registry policy, and the current session cwd", () => {
		const definition = createDefinition("mapped", "cli_mapped", {
			execution: { timeout_ms: 12_345, cwd: "session", inherit_env: true },
		});
		const discovery = createAvailableDiscovery("/resolved/exact-cli", definition);
		const args = ["", "a b", "*", "$()", ";"];
		expect(mapCliExecutionRequest(discovery, { args }, { cwd: "/session/current" })).toEqual({
			executablePath: "/resolved/exact-cli",
			args,
			cwd: "/session/current",
			timeoutMs: 12_345,
			environment: "inherit",
			outputStrategy: "tail",
		});
	});
});

describePosix("registration planning and discovery", () => {
	let root: string;
	let bin: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-cli-tools-adapter-registration-"));
		bin = join(root, "bin");
		await mkdir(bin);
		await symlink(process.execPath, join(bin, "available"));
		await symlink(process.execPath, join(bin, "available-two"));
		await symlink(process.execPath, join(bin, "colliding"));
		await symlink(process.execPath, join(bin, "quarantined"));
		vi.stubEnv("PATH", bin);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(root, { force: true, recursive: true });
	});

	it("registers only available, non-colliding, non-quarantined definitions", async () => {
		const definitions = [
			createDefinition("available", "cli_available"),
			createDefinition("available-two", "cli_available_two"),
			createDefinition("missing", "cli_missing"),
			createDefinition("colliding", "cli_collision"),
			createDefinition("quarantined", "cli_quarantined"),
		];
		const registry = createRegistry(definitions, {
			disabled: [{ entry: { id: "disabled", disabled: true }, source: { layer: "user", path: "/disabled.yaml" } }],
			quarantined: [{ id: "quarantined", layer: "user", paths: ["/bad.yaml"], reason: "invalid_override" }],
		});
		const harness = createMockPi({ existingTools: [createToolInfo("cli_collision", "sdk")] });
		const state = createPiCliToolsState(registry);

		await activatePiCliTools(harness.api, state, root);

		expect(harness.tools.map(({ name }) => name)).toEqual(["cli_available", "cli_available_two"]);
		expect(state.discoveries.map(({ registry: entry, status }) => [entry.definition.id, status])).toEqual([
			["available", "available"],
			["available-two", "available"],
			["missing", "missing"],
			["colliding", "available"],
		]);
		expect(state.collisions).toHaveLength(1);
		expect(state.collisions[0]).toMatchObject({
			code: "tool_name_collision",
			registryId: "colliding",
			toolName: "cli_collision",
		});
		expect(state.collisions[0]?.owner.source).toBe("sdk");
		expect(state.registered[0]?.activeAtRegistration).toBe(true);
		expect(formatCliToolsDiagnostics(state, [...harness.activeNames])).toContain("Quarantined:");
		expect(formatCliToolsDiagnostics(state, [...harness.activeNames])).not.toContain("inactive or filtered by Pi");
	});

	it("keeps Pi-filtered registrations visible as inactive", async () => {
		const harness = createMockPi({ activateRegisteredTools: false });
		const state = createPiCliToolsState(createRegistry([createDefinition("available", "cli_available")]));
		await activatePiCliTools(harness.api, state, root);

		expect(harness.tools).toHaveLength(1);
		expect(state.registered[0]?.activeAtRegistration).toBe(false);
		expect(formatCliToolsDiagnostics(state, [])).toContain("[inactive or filtered by Pi]");
	});

	it("does not register callable tools on unsupported platforms", async () => {
		const harness = createMockPi();
		const state = createPiCliToolsState(createRegistry([createDefinition("available", "cli_available")]));
		await activatePiCliTools(harness.api, state, root, "win32");

		expect(harness.tools).toEqual([]);
		expect(state.unsupported).toHaveLength(1);
		expect(formatCliToolsDiagnostics(state, [])).toContain("Unsupported platform:");
	});

	it("records per-tool registration failures without hiding diagnostics", async () => {
		const harness = createMockPi({ registerToolError: new Error("mock registration failed") });
		const state = createPiCliToolsState(createRegistry([createDefinition("available", "cli_available")]));
		await activatePiCliTools(harness.api, state, root);

		expect(state.registered).toEqual([]);
		expect(state.registrationErrors).toEqual([
			expect.objectContaining({ registryId: "available", message: "mock registration failed" }),
		]);
	});

	it("discovers an executable without invoking version, help, network, or the executable itself", async () => {
		const marker = join(root, "executed");
		const executable = join(bin, "startup-only");
		await writeFile(executable, `#!/bin/sh\nprintf launched > "${marker}"\n`, "utf8");
		await chmod(executable, 0o755);
		const harness = createMockPi();
		const state = createPiCliToolsState(createRegistry([createDefinition("startup-only", "cli_startup")]));

		await activatePiCliTools(harness.api, state, root);

		expect(harness.tools.map(({ name }) => name)).toEqual(["cli_startup"]);
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("bounded human diagnostics", () => {
	it("includes loaded sources and globally bounds worst-case nested diagnostics", () => {
		const definitions = Array.from({ length: 50 }, (_, index) =>
			createDefinition(`missing-${String(index)}`, `cli_missing_${String(index)}`, {
				binary: {
					candidates: Array.from(
						{ length: 32 },
						(_unused, candidateIndex) => `candidate-${String(index)}-${String(candidateIndex)}-${"x".repeat(200)}`,
					),
				},
			}),
		);
		const registry = createRegistry(definitions, {
			layers: [
				{
					name: "user",
					kind: "user",
					directory: `/registry/${"d".repeat(2_000)}`,
					required: false,
					exists: true,
					files: Array.from({ length: 50 }, (_, index) => `/registry/${String(index)}.yaml`),
				},
			],
			issues: Array.from({ length: 50 }, (_, index) => ({
				code: "invalid_definition" as const,
				layer: "user",
				path: `/registry/${"p".repeat(2_000)}-${String(index)}`,
				message: `invalid ${"m".repeat(4_000)}`,
			})),
		});
		const state = createPiCliToolsState(registry);
		state.phase = "ready";
		state.discoveries = definitions.map((definition) => ({
			status: "missing",
			registry: loadDefinition(definition),
			resolution: {
				checkedPaths: Array.from({ length: 100 }, (_unused, index) => `/checked/${String(index)}/${"z".repeat(2_000)}`),
			},
		}));

		const diagnostics = formatCliToolsDiagnostics(state, []);
		expect(diagnostics).toContain("Sources:");
		expect(diagnostics).toContain("user:");
		expect(diagnostics).toContain("… 24 more");
		expect(diagnostics).toContain("[Diagnostics truncated to the pi-cli-tools notification limit.]");
		expect(Buffer.byteLength(diagnostics, "utf8")).toBeLessThanOrEqual(PI_DIAGNOSTIC_MAX_BYTES);
		expect(countLogicalLines(diagnostics)).toBeLessThanOrEqual(PI_DIAGNOSTIC_MAX_LINES);
	});

	it("distinguishes an invalid ID with no lower definition from a withheld override", () => {
		const registry = createRegistry([], {
			quarantined: [{ id: "orphan", layer: "user", paths: ["/registry/orphan.yaml"], reason: "invalid_override" }],
		});
		const diagnostics = formatCliToolsDiagnostics(createPiCliToolsState(registry), []);
		expect(diagnostics).toContain("no lower-precedence executable definition existed");
		expect(diagnostics).not.toContain("lower-precedence definition withheld");
	});

	it("reports changed dynamic ownership instead of treating the adapter registration as effective", () => {
		const discovery = createAvailableDiscovery("/resolved/fixture");
		const state = createPiCliToolsState(createRegistry([discovery.registry.definition]));
		state.phase = "ready";
		state.registered = [
			{
				discovery,
				activeAtRegistration: true,
				ownerAtRegistration: createToolInfo("cli_fixture", "extension:pi-cli-tools").sourceInfo,
			},
		];
		const current = createToolInfo("cli_fixture", "extension:late-owner");
		const diagnostics = formatCliToolsDiagnostics(state, ["cli_fixture"], [current]);
		expect(diagnostics).toContain("Ownership changes: 1");
		expect(diagnostics).toContain("[ownership_changed]");
		expect(diagnostics).toContain("extension:late-owner");
		expect(diagnostics).toContain("Active: 0");
	});
});

describePosix("registered runner adaptation", () => {
	let root: string;
	const retainedSpools: CliExecutionResult[] = [];

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-cli-tools-adapter-execution-"));
	});

	afterEach(async () => {
		for (const execution of retainedSpools) await removeCliOutputSpool(execution.spool);
		retainedSpools.length = 0;
		vi.unstubAllEnvs();
		await rm(root, { force: true, recursive: true });
	});

	it("preserves exact argv, stream identity, current cwd, empty environment, and typed details", async () => {
		const definition = createDefinition();
		const tool = createNativeCliTool(createAvailableDiscovery(process.execPath, definition));
		const literalArgs = ["", "a b", "*", "$(touch marker)", ";", "'", '"', "`id`", "line\nbreak"];
		const result = await tool.execute(
			"call-1",
			{ args: [fixturePath, "inspect", "ADAPTER_SENTINEL", ...literalArgs] },
			undefined,
			undefined,
			asContext(root),
		);
		const details = resultDetails(result);
		if (details.kind !== "execution") throw new Error("expected execution details");
		const payload = JSON.parse(details.execution.stdout) as {
			args: string[];
			cwd: string;
			environment: Record<string, string>;
		};

		expect(payload.args).toEqual(literalArgs);
		expect(payload.cwd).toBe(root);
		expect(payload.environment).toEqual({});
		expect(details.execution).toMatchObject({
			status: "exited",
			exitCode: 0,
			executablePath: process.execPath,
			args: [fixturePath, "inspect", "ADAPTER_SENTINEL", ...literalArgs],
			cwd: root,
			stderr: "",
		});
		expect(details.execution.stdout).toBeTypeOf("string");
		expect(details.spoolCleanup).toEqual({
			applicable: false,
			owner: "none",
			lifecycle: "not_retained",
			method: null,
		});
		expect(() => JSON.stringify(details)).not.toThrow();
		expect(resultText(result)).toContain("stdout:");
	});

	it("renders bounded JSON-style calls and compact, partial, and expanded results", async () => {
		const tool = createNativeCliTool(createAvailableDiscovery(process.execPath));
		const result = await tool.execute(
			"render",
			{ args: [fixturePath, "exit", "0"] },
			undefined,
			undefined,
			asContext(root),
		);
		const renderCall = tool.renderCall;
		const renderResult = tool.renderResult;
		if (!renderCall || !renderResult) throw new Error("expected native renderers");
		const theme = {
			fg(color: unknown, text: string) {
				void color;
				return text;
			},
			bold(text: string) {
				return text;
			},
		} as unknown as Theme;
		const callContext = { argsComplete: true } as Parameters<typeof renderCall>[2];
		const resultContext = {} as Parameters<typeof renderResult>[3];

		expect(
			renderCall({ args: ["a b", "$(no-shell)"] }, theme, callContext)
				.render(500)
				.join("\n"),
		).toContain('["a b","$(no-shell)"]');
		expect(
			renderCall({} as { args: string[] }, theme, { argsComplete: false } as Parameters<typeof renderCall>[2])
				.render(500)
				.join("\n"),
		).toContain("(arguments pending)");
		expect(
			renderResult(result, { expanded: false, isPartial: true }, theme, resultContext)
				.render(500)
				.map((line) => line.trimEnd()),
		).toEqual(["Running…"]);
		expect(
			renderResult(result, { expanded: false, isPartial: false }, theme, resultContext).render(500).join("\n"),
		).toContain("exit 0");
		expect(
			renderResult(result, { expanded: true, isPartial: false }, theme, resultContext).render(500).join("\n"),
		).toContain("Status: exited; code=0");
	});

	it("snapshots the inherited environment at invocation time", async () => {
		vi.stubEnv("ADAPTER_SENTINEL", "inherited-value");
		const definition = createDefinition("inherit", "cli_inherit", {
			execution: { timeout_ms: 5_000, cwd: "session", inherit_env: true },
		});
		const tool = createNativeCliTool(createAvailableDiscovery(process.execPath, definition));
		const result = await tool.execute(
			"call-2",
			{ args: [fixturePath, "inspect", "ADAPTER_SENTINEL"] },
			undefined,
			undefined,
			asContext(root),
		);
		const details = resultDetails(result);
		if (details.kind !== "execution") throw new Error("expected execution details");
		const payload = JSON.parse(details.execution.stdout) as { environmentValue: string | null };
		expect(payload.environmentValue).toBe("inherited-value");
	});

	it.each([
		[
			"zero",
			[fixturePath, "streams", Buffer.from("out").toString("base64"), Buffer.from("err").toString("base64")],
			"exited",
			0,
		],
		["nonzero", [fixturePath, "exit", "17"], "exited", 17],
		["signal", [fixturePath, "signal", "SIGTERM"], "exited", null],
	] as const)("preserves the %s result status and exit metadata", async (_name, args, status, exitCode) => {
		const tool = createNativeCliTool(createAvailableDiscovery(process.execPath));
		const result = await tool.execute("matrix", { args: [...args] }, undefined, undefined, asContext(root));
		const details = resultDetails(result);
		if (details.kind !== "execution") throw new Error("expected execution details");
		expect(details.execution.status).toBe(status);
		expect(details.execution.exitCode).toBe(exitCode);
		if (_name === "zero") {
			expect(details.execution.stdout).toBe("out");
			expect(details.execution.stderr).toBe("err");
			expect(resultText(result)).toContain("stdout:\nout\nstderr:\nerr");
		}
		expect(isCliToolResultError(details)).toBe(_name !== "zero");
	});

	it("passes Pi's AbortSignal through and reports confirmed cancellation cleanup", async () => {
		const readyPath = join(root, "ready.json");
		const controller = new AbortController();
		const tool = createNativeCliTool(createAvailableDiscovery(process.execPath));
		const pending = tool.execute(
			"cancel",
			{ args: [fixturePath, "tree", readyPath, "ignore"] },
			controller.signal,
			undefined,
			asContext(root),
		);
		const pids = await readReadyPids(readyPath);
		controller.abort();
		const result = await pending;
		const details = resultDetails(result);
		if (details.kind !== "execution") throw new Error("expected execution details");
		expect(details.execution.status).toBe("cancelled");
		expect(isCliToolResultError(details)).toBe(true);
		expect(details.execution.termination).toMatchObject({ attempted: true, forced: true, confirmed: true });
		await expectProcessGone(pids.parentPid);
		await expectProcessGone(pids.descendantPid);
	});

	it("does not spawn when Pi's signal is already aborted", async () => {
		const marker = join(root, "pre-abort-marker");
		const controller = new AbortController();
		controller.abort();
		const tool = createNativeCliTool(createAvailableDiscovery(process.execPath));
		const result = await tool.execute(
			"pre-cancel",
			{ args: [fixturePath, "marker", marker] },
			controller.signal,
			undefined,
			asContext(root),
		);
		const details = resultDetails(result);
		if (details.kind !== "execution") throw new Error("expected execution details");
		if (details.execution.status !== "cancelled") throw new Error("expected cancelled execution");
		expect(details.execution.termination.attempted).toBe(false);
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("preserves timeout, spawn-error, and request-validation outcomes", async () => {
		const timeoutDefinition = createDefinition("timeout", "cli_timeout", {
			execution: { timeout_ms: 100, cwd: "session", inherit_env: false },
		});
		const timeoutTool = createNativeCliTool(createAvailableDiscovery(process.execPath, timeoutDefinition));
		const timeoutResult = await timeoutTool.execute(
			"timeout",
			{ args: [fixturePath, "tree", join(root, "timeout-ready.json"), "ignore"] },
			undefined,
			undefined,
			asContext(root),
		);
		const timeoutDetails = resultDetails(timeoutResult);
		expect(timeoutDetails.kind === "execution" && timeoutDetails.execution.status).toBe("timed_out");
		expect(isCliToolResultError(timeoutDetails)).toBe(true);

		const spawnTool = createNativeCliTool(createAvailableDiscovery(join(root, "removed-executable")));
		const spawnResult = await spawnTool.execute("spawn", { args: [] }, undefined, undefined, asContext(root));
		const spawnDetails = resultDetails(spawnResult);
		expect(spawnDetails.kind === "execution" && spawnDetails.execution.status).toBe("spawn_error");
		expect(isCliToolResultError(spawnDetails)).toBe(true);
		expect(resultText(spawnResult)).toContain("configured executable");

		const requestTool = createNativeCliTool(createAvailableDiscovery(process.execPath));
		const marker = join(root, "mutated-marker");
		const requestResult = await requestTool.execute(
			"request",
			{ args: [fixturePath, "marker", marker, "bad\0argument"] },
			undefined,
			undefined,
			asContext(root),
		);
		const requestDetails = resultDetails(requestResult);
		expect(requestDetails).toMatchObject({
			kind: "request_error",
			error: { code: "invalid_arguments" },
		});
		expect(isCliToolResultError(requestDetails)).toBe(true);
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects post-validation argument mutations before spawn", async () => {
		const marker = join(root, "mutation-marker");
		const tool = createNativeCliTool(createAvailableDiscovery(process.execPath));
		const invalidInputs: unknown[] = [
			"not-an-array",
			[fixturePath, "marker", marker, ...Array.from({ length: CLI_MAX_ARGUMENT_COUNT }, () => "x")],
			[fixturePath, "marker", marker, "€".repeat(CLI_MAX_ARGUMENT_BYTES)],
			[fixturePath, "marker", marker, ...Array.from({ length: 5 }, () => "x".repeat(CLI_MAX_ARGUMENT_BYTES))],
		];

		for (const args of invalidInputs) {
			const result = await tool.execute(
				"mutated",
				{ args } as unknown as { args: string[] },
				undefined,
				undefined,
				asContext(root),
			);
			expect(resultDetails(result)).toMatchObject({
				kind: "request_error",
				error: { code: "invalid_arguments" },
			});
		}
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("returns a bounded spawn error for a deleted cwd without falling back", async () => {
		const deletedCwd = join(root, "deleted-cwd");
		await mkdir(deletedCwd);
		await rm(deletedCwd, { recursive: true });
		const tool = createNativeCliTool(createAvailableDiscovery(process.execPath));
		const result = await tool.execute(
			"deleted-cwd",
			{ args: [fixturePath, "exit", "0"] },
			undefined,
			undefined,
			asContext(deletedCwd),
		);
		const details = resultDetails(result);
		expect(details.kind === "execution" && details.execution.status).toBe("spawn_error");
		if (details.kind !== "execution") throw new Error("expected execution details");
		expect(details.execution.cwd).toBe(deletedCwd);
		expect(Buffer.byteLength(resultText(result), "utf8")).toBeLessThanOrEqual(PI_MODEL_OUTPUT_MAX_BYTES);
	});

	it("retains raw stream details while bounding and sanitizing model-facing text", async () => {
		const raw = "\u001b[31mred\u001b[0m\u001b]52;c;secret\u0007safe\u0000\u0008\rprogress\u202E";
		const result = await runFake(root, [
			"streams",
			Buffer.from(raw).toString("base64"),
			Buffer.from("stderr-value").toString("base64"),
		]);
		const content = formatCliExecutionForModel(result);
		expect(result.stdout).toBe(raw);
		expect(content).toContain("redsafeprogress");
		expect(content).toContain("stderr:\nstderr-value");
		expect(
			Array.from(content).some((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return codePoint <= 0x08 || codePoint === 0x1b || codePoint === 0x202e;
			}),
		).toBe(false);
	});

	it("uses actual runner outcomes for no-spool and failed-spool metadata", async () => {
		const bounded = await runFake(root, ["streams", Buffer.from("small").toString("base64"), ""]);
		expect(createSpoolCleanupOwnership(bounded)).toEqual({
			applicable: false,
			owner: "none",
			lifecycle: "not_retained",
			method: null,
		});

		const failed = await runFake(root, ["bytes", String(48 * 1024 + 1), "0", "F", "x"], {
			temporaryDirectory: join(root, "missing-spool-parent"),
		});
		expect(failed.spool.status).toBe("failed");
		expect(createSpoolCleanupOwnership(failed).applicable).toBe(false);
		expect(formatCliExecutionForModel(failed)).toContain("Raw output retention failed");
		const details: CliToolResultDetails = {
			adapter: "pi-cli-tools",
			kind: "execution",
			registryId: "fixture",
			execution: failed,
			spoolCleanup: createSpoolCleanupOwnership(failed),
		};
		expect(isCliToolResultError(details)).toBe(false);
	});

	it("uses an actual capture-cutoff runner outcome for a partial spool notice", async () => {
		const readyPath = join(root, "partial-spool-ready.json");
		const pending = runFake(root, ["exit-with-escaped-open-pipes", readyPath], {}, { timeoutMs: 10_000 });
		const pids = await readReadyPids(readyPath);
		try {
			const result = await withWatchdog(pending, 8_000);
			expect(result).toMatchObject({
				capture: { complete: false, cutOff: true, reason: "output_drain_timeout" },
				spool: { status: "partial" },
			});
			expect(createSpoolCleanupOwnership(result)).toMatchObject({
				applicable: true,
				owner: "pi-cli-tools",
			});
			const content = formatCliExecutionForModel(result);
			expect(content).toContain("process output capture is incomplete (output_drain_timeout)");
			expect(content).toContain("Partial raw output:");
			await removeCliOutputSpool(result.spool);
		} finally {
			if (isProcessAlive(pids.descendantPid)) killProcess(pids.descendantPid);
			await expectProcessGone(pids.descendantPid);
		}
	}, 10_000);

	it("warns about retained artifacts from an actual failed spool", async () => {
		const readyPath = join(root, "failed-spool-ready");
		const controller = new AbortController();
		const pending = runFake(
			root,
			["bytes-wait", String(48 * 1024 + 1), readyPath],
			{ signal: controller.signal },
			{ timeoutMs: 10_000 },
		);
		await waitForFile(readyPath);
		const processId = Number(await readFile(readyPath, "utf8"));
		const spoolDirectoryName = (await outputSpoolDirectories(root))[0];
		if (!spoolDirectoryName) throw new Error("expected an active spool directory");
		const stdoutPath = join(root, spoolDirectoryName, "stdout.raw");
		await waitForFile(stdoutPath);
		await unlink(stdoutPath);
		controller.abort();
		try {
			const result = await withWatchdog(pending, 8_000);
			expect(result.spool.status).toBe("failed");
			expect(result.spool.retainedPaths.length).toBeGreaterThan(0);
			expect(createSpoolCleanupOwnership(result)).toMatchObject({
				applicable: true,
				owner: "pi-cli-tools",
			});
			expect(formatCliExecutionForModel(result)).toContain(
				"partial raw-output artifacts remain and require explicit pi-cli-tools cleanup",
			);
			await removeCliOutputSpool(result.spool);
		} finally {
			if (isProcessAlive(processId)) killProcess(processId);
			await expectProcessGone(processId);
		}
	});

	it("formats sidecar cleanup errors without changing a successful exit classification", async () => {
		const base = await runFake(root, ["streams", "", ""]);
		if (base.status !== "exited") throw new Error("expected exited base result");
		const error: CliErrorDetails = { name: "Error", message: "failure", code: "ENOSPC", syscall: "unlink" };
		const execution: CliExecutionResult = {
			...base,
			spool: {
				status: "complete",
				path: "/tmp/pi-cli-tools-output-a/full-output.log",
				bytesWritten: 10,
				maxBytes: 100,
				error: null,
				retainedPaths: ["/tmp/pi-cli-tools-output-a/full-output.log"],
				cleanupError: error,
			},
		};
		expect(formatCliExecutionForModel(execution)).toContain("sidecar cleanup failed (ENOSPC)");
		const details: CliToolResultDetails = {
			adapter: "pi-cli-tools",
			kind: "execution",
			registryId: "fixture",
			execution,
			spoolCleanup: createSpoolCleanupOwnership(execution),
		};
		expect(isCliToolResultError(details)).toBe(false);
	});

	it("keeps maximum runner output plus all framing within Pi's byte and line limits", async () => {
		const base = await runFake(root, ["streams", "", ""]);
		const error: CliErrorDetails = {
			name: "Error",
			message: "m".repeat(10_000),
			code: "E".repeat(10_000),
			syscall: "write",
		};
		if (base.status !== "exited") throw new Error("expected exited base result");
		const longSpoolPath = `/tmp/${"p".repeat(4_096)}`;
		const executions: CliExecutionResult[] = [
			{
				...base,
				stdout: "x".repeat(48 * 1024),
				spool: {
					status: "partial",
					path: longSpoolPath,
					bytesWritten: 64,
					maxBytes: 64,
					error: null,
					retainedPaths: [longSpoolPath],
					cleanupError: error,
				},
				processGroupCleanup: {
					reason: "natural_exit",
					attempted: true,
					forced: true,
					confirmed: false,
					error,
				},
			},
			{ ...base, stdout: "line\n".repeat(1_980) },
		];

		for (const execution of executions) {
			const content = formatCliExecutionForModel(execution);
			expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(PI_MODEL_OUTPUT_MAX_BYTES);
			expect(countLogicalLines(content)).toBeLessThanOrEqual(PI_MODEL_OUTPUT_MAX_LINES);
		}
	});

	it("surfaces real truncation and complete spool details from the v0.1b runner", async () => {
		const tool = createNativeCliTool(createAvailableDiscovery(process.execPath));
		const result = await tool.execute(
			"truncate",
			{ args: [fixturePath, "bytes", String(80 * 1024), "0", "T", "E"] },
			undefined,
			undefined,
			asContext(root),
		);
		const details = resultDetails(result);
		if (details.kind !== "execution") throw new Error("expected execution details");
		retainedSpools.push(details.execution);
		expect(details.execution.truncation).toMatchObject({ truncated: true, strategy: "tail" });
		expect(details.execution.spool.status).toBe("complete");
		expect(details.spoolCleanup).toMatchObject({ applicable: true, owner: "pi-cli-tools" });
		expect(details.execution.stdout).toHaveLength(48 * 1024);
		expect(resultText(result)).toContain("Output truncated using tail selection");
		expect(resultText(result)).toContain("Complete raw output:");
		if (details.execution.spool.path) await waitForFile(details.execution.spool.path);
	});
});
