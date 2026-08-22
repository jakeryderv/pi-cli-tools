import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import Type from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import cliToolsExtension from "../extensions/cli-tools.js";
import type { CliToolResultDetails } from "../extensions/pi-adapter.js";
import { fixturePath, waitForFile } from "./helpers/runner.js";
import { createDefinition } from "./helpers/pi-adapter.js";

const describePosix = process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip;

describePosix("real Pi lifecycle", () => {
	let root: string;
	let agentDirectory: string;
	let binDirectory: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-cli-tools-real-lifecycle-"));
		agentDirectory = join(root, "agent");
		binDirectory = join(root, "bin");
		await mkdir(join(agentDirectory, "cli-tools"), { recursive: true });
		await mkdir(binDirectory);
		await symlink(process.execPath, join(binDirectory, "fixture-cli"));
		await symlink(process.execPath, join(binDirectory, "rg"));
		await writeFile(
			join(agentDirectory, "cli-tools", "github.yaml"),
			stringify(createDefinition("github", "cli_gh", { binary: { candidates: ["fixture-cli"] } })),
			"utf8",
		);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
		vi.stubEnv("PATH", binDirectory);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(root, { force: true, recursive: true });
	});

	it("loads with an uninitialized runtime, then registers and executes after session_start", async () => {
		const loader = createLoader([{ name: "pi-cli-tools", factory: cliToolsExtension }]);
		await expect(loader.reload()).resolves.toBeUndefined();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions[0]?.tools.size).toBe(0);

		const { session } = await createAgentSession({
			cwd: root,
			agentDir: agentDirectory,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			noTools: "builtin",
		});
		try {
			expect(session.getToolDefinition("cli_gh")).toBeUndefined();
			const lifecycleErrors: string[] = [];
			await session.bindExtensions({
				mode: "print",
				onError: (error) => lifecycleErrors.push(`${error.event}: ${error.error}`),
			});

			expect(lifecycleErrors).toEqual([]);
			expect(session.getActiveToolNames()).toContain("cli_gh");
			expect(session.getAllTools().find(({ name }) => name === "cli_gh")?.sourceInfo.source).toBe("inline");
			const tool = session.getToolDefinition("cli_gh");
			if (!tool) throw new Error("expected cli_gh definition after session_start");
			const result = await tool.execute("real-pi", { args: [fixturePath, "exit", "0"] }, undefined, undefined, {
				cwd: root,
			} as ExtensionContext);
			const details = result.details as CliToolResultDetails;
			expect(details.kind === "execution" && details.execution.status).toBe("exited");
			expect(details.kind === "execution" && details.execution.exitCode).toBe(0);
		} finally {
			session.dispose();
		}
	});

	it("registers cli_docs lazily and resets its in-memory cache across public reload", async () => {
		await writeFile(
			join(agentDirectory, "cli-tools", "github.yaml"),
			stringify(
				createDefinition("github", "cli_gh", {
					binary: { candidates: ["fixture-cli"] },
					introspection: {
						version: {
							args: [fixturePath, "streams", Buffer.from("real version").toString("base64")],
						},
						help: {
							args: [fixturePath, "streams", Buffer.from("real help").toString("base64")],
						},
						man: false,
					},
				}),
			),
			"utf8",
		);
		const loader = createLoader([{ name: "pi-cli-tools", factory: cliToolsExtension }]);
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: agentDirectory,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			noTools: "builtin",
		});
		try {
			const lifecycleErrors: unknown[] = [];
			await session.bindExtensions({ mode: "print", onError: (error) => lifecycleErrors.push(error) });
			const docs = session.getToolDefinition("cli_docs");
			if (!docs) throw new Error("expected cli_docs");
			const first = await docs.execute("first", { tool: "cli_gh" }, undefined, undefined, {
				cwd: root,
			} as ExtensionContext);
			const second = await docs.execute("second", { tool: "cli_gh" }, undefined, undefined, {
				cwd: root,
			} as ExtensionContext);
			expect(first.details).toMatchObject({
				kind: "docs",
				status: "ok",
				version: { cache: "miss" },
				documentation: { cache: "miss" },
			});
			expect(second.details).toMatchObject({
				kind: "docs",
				version: { cache: "hit" },
				documentation: { cache: "hit" },
			});

			await session.reload();
			expect(lifecycleErrors).toEqual([]);
			const reloadedDocs = session.getToolDefinition("cli_docs");
			if (!reloadedDocs) throw new Error("expected reloaded cli_docs");
			const reloaded = await reloadedDocs.execute("reloaded", { tool: "cli_gh" }, undefined, undefined, {
				cwd: root,
			} as ExtensionContext);
			expect(reloaded.details).toMatchObject({
				kind: "docs",
				version: { cache: "miss" },
				documentation: { cache: "miss" },
			});
		} finally {
			session.dispose();
		}
	});

	it("awaits blocked introspection cleanup before public reload completes", async () => {
		const readyPath = join(root, "blocked-introspection.pid");
		await writeFile(
			join(agentDirectory, "cli-tools", "github.yaml"),
			stringify(
				createDefinition("github", "cli_gh", {
					binary: { candidates: ["fixture-cli"] },
					introspection: {
						help: { args: [fixturePath, "bytes-wait", "1", readyPath] },
						man: false,
					},
				}),
			),
			"utf8",
		);
		const loader = createLoader([{ name: "pi-cli-tools", factory: cliToolsExtension }]);
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: agentDirectory,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			noTools: "builtin",
		});
		try {
			await session.bindExtensions({ mode: "print" });
			const docs = session.getToolDefinition("cli_docs");
			if (!docs) throw new Error("expected cli_docs");
			let introspectionSettled = false;
			const pending = docs
				.execute("blocked", { tool: "cli_gh" }, undefined, undefined, {
					cwd: root,
				} as ExtensionContext)
				.then((result) => {
					introspectionSettled = true;
					return result;
				});
			await waitForFile(readyPath);
			expect(Number(await readFile(readyPath, "utf8"))).toBeGreaterThan(0);
			await session.reload();
			expect(introspectionSettled).toBe(true);
			const result = await pending;
			expect(result.details).toMatchObject({
				kind: "docs",
				status: "failed",
				documentation: {
					status: "failed",
					code: "cancelled",
					execution: { cleanup: { reason: "cancelled", confirmed: true } },
				},
			});
		} finally {
			session.dispose();
		}
	}, 15_000);

	it("executes through Pi's provider/tool pipeline and preserves nonzero error classification", async () => {
		const faux = fauxProvider({ provider: "pi-cli-tools-test" });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("cli_gh", { args: [fixturePath, "exit", "7"] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("finished"),
		]);
		const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
		modelRuntime.registerNativeProvider(faux.provider);
		const loader = createLoader([{ name: "pi-cli-tools", factory: cliToolsExtension }]);
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: agentDirectory,
			model: faux.getModel(),
			modelRuntime,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			noTools: "builtin",
		});
		const completedTools: { toolName: string; isError: boolean; details: unknown }[] = [];
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_end") {
				const result = event.result as { details?: unknown };
				completedTools.push({
					toolName: event.toolName,
					isError: event.isError,
					details: result.details,
				});
			}
		});
		try {
			await session.bindExtensions({ mode: "print" });
			await session.prompt("Run the configured fixture.");

			expect(faux.state.callCount).toBe(2);
			expect(completedTools).toHaveLength(1);
			expect(completedTools[0]).toMatchObject({
				toolName: "cli_gh",
				isError: true,
				details: {
					adapter: "pi-cli-tools",
					kind: "execution",
					registryId: "github",
					execution: { status: "exited", exitCode: 7 },
				},
			});
			const toolResult = session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "cli_gh",
			);
			expect(toolResult).toMatchObject({ role: "toolResult", isError: true });
		} finally {
			unsubscribe();
			session.dispose();
		}
	});

	it.each([
		[1, false],
		[2, true],
	] as const)("classifies bundled ripgrep exit %i through Pi's provider/tool pipeline", async (exitCode, isError) => {
		const faux = fauxProvider({ provider: `pi-cli-tools-ripgrep-${String(exitCode)}` });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("cli_rg", { args: [fixturePath, "exit", String(exitCode)] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("finished"),
		]);
		const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
		modelRuntime.registerNativeProvider(faux.provider);
		const loader = createLoader([{ name: "pi-cli-tools", factory: cliToolsExtension }]);
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: agentDirectory,
			model: faux.getModel(),
			modelRuntime,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			noTools: "builtin",
		});
		const completedTools: { isError: boolean; details: unknown }[] = [];
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === "cli_rg") {
				const result = event.result as { details?: unknown };
				completedTools.push({ isError: event.isError, details: result.details });
			}
		});
		try {
			await session.bindExtensions({ mode: "print" });
			await session.prompt("Run the configured ripgrep fixture.");

			expect(completedTools).toHaveLength(1);
			expect(completedTools[0]?.isError).toBe(isError);
			const details = completedTools[0]?.details as CliToolResultDetails;
			expect(details).toMatchObject({
				adapter: "pi-cli-tools",
				kind: "execution",
				registryId: "ripgrep",
				acceptedExitCodes: [0, 1],
				execution: { status: "exited", exitCode },
			});
			const toolResult = session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "cli_rg",
			);
			expect(toolResult).toMatchObject({ role: "toolResult", isError });
		} finally {
			unsubscribe();
			session.dispose();
		}
	});

	it("preserves an earlier Pi middleware error for bundled ripgrep exit 1", async () => {
		const faux = fauxProvider({ provider: "pi-cli-tools-ripgrep-earlier-error" });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("cli_rg", { args: [fixturePath, "exit", "1"] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("finished"),
		]);
		const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
		modelRuntime.registerNativeProvider(faux.provider);
		const loader = createLoader([
			{
				name: "earlier-error-middleware",
				factory(pi) {
					pi.on("tool_result", (event) => {
						if (event.toolName === "cli_rg") return { isError: true };
						return;
					});
				},
			},
			{ name: "pi-cli-tools", factory: cliToolsExtension },
		]);
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: agentDirectory,
			model: faux.getModel(),
			modelRuntime,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			noTools: "builtin",
		});
		const completedTools: boolean[] = [];
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === "cli_rg") {
				completedTools.push(event.isError);
			}
		});
		try {
			await session.bindExtensions({ mode: "print" });
			await session.prompt("Run the configured ripgrep fixture.");
			expect(completedTools).toEqual([true]);
		} finally {
			unsubscribe();
			session.dispose();
		}
	});

	it("reloads through the public session lifecycle when an executable appears or disappears", async () => {
		await writeFile(
			join(agentDirectory, "cli-tools", "github.yaml"),
			stringify(createDefinition("github", "cli_gh", { binary: { candidates: ["reload-cli"] } })),
			"utf8",
		);
		const loader = createLoader([{ name: "pi-cli-tools", factory: cliToolsExtension }]);
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: agentDirectory,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			noTools: "builtin",
		});
		const reloadPath = join(binDirectory, "reload-cli");
		try {
			const lifecycleErrors: string[] = [];
			await session.bindExtensions({
				mode: "print",
				onError: (error) => lifecycleErrors.push(error.error),
			});
			expect(session.getToolDefinition("cli_gh")).toBeUndefined();

			await symlink(process.execPath, reloadPath);
			await session.reload();
			expect(session.getToolDefinition("cli_gh")).toBeDefined();
			expect(session.getActiveToolNames()).toContain("cli_gh");

			await rm(reloadPath);
			await session.reload();
			expect(session.getToolDefinition("cli_gh")).toBeUndefined();
			expect(session.getActiveToolNames()).not.toContain("cli_gh");
			expect(lifecycleErrors).toEqual([]);
		} finally {
			session.dispose();
		}
	});

	it("does not override a tool registered by an earlier extension", async () => {
		const earlierTool: ToolDefinition = {
			name: "cli_gh",
			label: "Earlier owner",
			description: "Earlier test tool",
			parameters: Type.Object({}),
			execute() {
				return Promise.resolve({ content: [{ type: "text", text: "earlier" }], details: {} });
			},
		};
		const loader = createLoader([
			{
				name: "earlier",
				factory(pi) {
					pi.registerTool(earlierTool);
				},
			},
			{ name: "pi-cli-tools", factory: cliToolsExtension },
		]);
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: agentDirectory,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			noTools: "builtin",
		});
		try {
			await session.bindExtensions({ mode: "print" });
			expect(session.getToolDefinition("cli_gh")?.label).toBe("Earlier owner");
			const adapterExtension = loader.getExtensions().extensions.find(({ path }) => path.includes("pi-cli-tools"));
			expect([...(adapterExtension?.tools.keys() ?? [])]).toEqual(["cli_rg", "cli_docs"]);
		} finally {
			session.dispose();
		}
	});

	it("reports ownership changes caused by a later dynamic registration from an earlier extension", async () => {
		const lateTool: ToolDefinition = {
			name: "cli_gh",
			label: "Late owner",
			description: "Late test owner",
			parameters: Type.Object({}),
			execute() {
				return Promise.resolve({ content: [{ type: "text", text: "late" }], details: {} });
			},
		};
		const loader = createLoader([
			{
				name: "earlier-late-owner",
				factory(pi) {
					pi.on("resources_discover", () => {
						pi.registerTool(lateTool);
					});
				},
			},
			{ name: "pi-cli-tools", factory: cliToolsExtension },
		]);
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: agentDirectory,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			noTools: "builtin",
		});
		try {
			await session.bindExtensions({ mode: "print" });
			expect(session.getToolDefinition("cli_gh")?.label).toBe("Late owner");
			const adapterExtension = loader.getExtensions().extensions.find(({ path }) => path.includes("pi-cli-tools"));
			const command = adapterExtension?.commands.get("cli-tools");
			if (!command) throw new Error("expected adapter diagnostics command");
			let notification = "";
			let severity = "";
			await command.handler("", {
				ui: {
					notify(message: string, type: string) {
						notification = message;
						severity = type;
					},
				},
			} as unknown as ExtensionCommandContext);
			expect(severity).toBe("warning");
			expect(notification).toContain("Ownership changes: 1");
			expect(notification).toContain("[ownership_changed]");
			expect(notification).toContain("earlier-late-owner");
		} finally {
			session.dispose();
		}
	});

	function createLoader(
		extensionFactories: NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"]>,
	) {
		return new DefaultResourceLoader({
			cwd: root,
			agentDir: agentDirectory,
			extensionFactories,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
	}
});
