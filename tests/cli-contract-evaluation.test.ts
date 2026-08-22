import { access, chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import cliToolsExtension from "../extensions/cli-tools.js";
import {
	CliToolParameters,
	PI_MODEL_OUTPUT_MAX_BYTES,
	PI_MODEL_OUTPUT_MAX_LINES,
	type CliToolResultDetails,
} from "../extensions/pi-adapter.js";
import { removeCliOutputSpool } from "../src/runner.js";

const describePosix = process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip;

interface FixtureInvocation {
	readonly source: string;
	readonly args: string[];
	readonly cwd: string;
	readonly sentinel: string | null;
}

describePosix("bundled CLI contract evaluation", () => {
	let root: string;
	let cwd: string;
	let agentDirectory: string;
	let binDirectory: string;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-cli-tools-contract-evaluation-"));
		cwd = join(root, "session");
		agentDirectory = join(root, "agent");
		binDirectory = join(root, "bin");
		await mkdir(cwd);
		await mkdir(agentDirectory);
		await mkdir(binDirectory);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
		vi.stubEnv("PATH", binDirectory);
		vi.stubEnv("CLI_CONTRACT_SENTINEL", "inherited-sentinel");
	});

	afterEach(async () => {
		session?.dispose();
		session = undefined;
		vi.unstubAllEnvs();
		await rm(root, { force: true, recursive: true });
	});

	it("evaluates both production definitions through discovery, registration, execution, and output bounds", async () => {
		await installFixture("gh");
		await installFixture("rg");
		const loader = await createBoundSession();

		expect(session?.getActiveToolNames().sort()).toEqual(["cli_gh", "cli_rg"]);
		const gh = requireTool("cli_gh");
		const rg = requireTool("cli_rg");
		expect(gh.parameters).toEqual(CliToolParameters);
		expect(rg.parameters).toEqual(CliToolParameters);
		expect(gh.parameters).toEqual(rg.parameters);
		await expectNotExists(invocationPath("gh"));
		await expectNotExists(invocationPath("rg"));

		const diagnostics = await runDiagnostics(loader);
		expect(diagnostics).toContain("Configured: 2 | Available: 2 | Registered: 2 | Active: 2");
		expect(diagnostics).toContain("cli_gh (github)");
		expect(diagnostics).toContain("env=inherit");
		expect(diagnostics).toContain("cli_rg (ripgrep)");
		expect(diagnostics).toContain("env=empty");
		expect(diagnostics).toContain("accepted exit codes: 0, 1");

		const shellMarker = join(root, "shell-marker");
		const literalArgs = ["", "a b", "*", ";", "'", '"', "`touch ignored`", `$(touch ${shellMarker})`];
		const ghResult = await execute(gh, ["inspect", ...literalArgs]);
		const rgResult = await execute(rg, ["inspect", ...literalArgs]);
		const ghDetails = executionDetails(ghResult);
		const rgDetails = executionDetails(rgResult);
		const ghPayload = JSON.parse(ghDetails.execution.stdout) as FixtureInvocation;
		const rgPayload = JSON.parse(rgDetails.execution.stdout) as FixtureInvocation;
		const resolvedCwd = await realpath(cwd);

		expect(ghPayload).toEqual({
			source: "gh",
			args: literalArgs,
			cwd: resolvedCwd,
			sentinel: "inherited-sentinel",
		});
		expect(rgPayload).toEqual({ source: "rg", args: literalArgs, cwd: resolvedCwd, sentinel: null });
		expect(ghDetails.execution).toMatchObject({ args: ["inspect", ...literalArgs], cwd, status: "exited" });
		expect(rgDetails.execution).toMatchObject({ args: ["inspect", ...literalArgs], cwd, status: "exited" });
		await expectNotExists(shellMarker);

		await writeFile(join(cwd, "search.txt"), "first line\nneedle here\nlast line\n", "utf8");
		const match = await execute(rg, ["search", "needle", "search.txt"]);
		expect(executionDetails(match).execution).toMatchObject({
			status: "exited",
			exitCode: 0,
			stdout: "search.txt:needle here\n",
		});

		const noMatch = await execute(rg, ["search", "absent", "search.txt"]);
		const noMatchDetails = executionDetails(noMatch);
		expect(noMatchDetails).toMatchObject({
			acceptedExitCodes: [0, 1],
			execution: { status: "exited", exitCode: 1, signal: null, stdout: "", stderr: "" },
		});
		expect(resultText(noMatch)).toContain("Status: exited; code=1; accepted=true");
		expect(resultText(noMatch)).toContain("(no output)");

		const trueError = await execute(rg, ["exit", "2", "invalid fixture query"]);
		expect(executionDetails(trueError).execution).toMatchObject({
			status: "exited",
			exitCode: 2,
			stderr: "invalid fixture query",
		});
		expect(resultText(trueError)).toContain("code=2; accepted=false");

		const large = await execute(rg, ["large", String(80 * 1024)]);
		const largeDetails = executionDetails(large);
		try {
			expect(largeDetails.execution.truncation).toMatchObject({ truncated: true, strategy: "tail" });
			expect(largeDetails.execution.stdout).toHaveLength(48 * 1024);
			expect(largeDetails.execution.spool.status).toBe("complete");
			if (!largeDetails.execution.spool.path) throw new Error("expected retained complete output");
			expect((await stat(largeDetails.execution.spool.path)).size).toBeGreaterThan(80 * 1024);
			expect(Buffer.byteLength(resultText(large), "utf8")).toBeLessThanOrEqual(PI_MODEL_OUTPUT_MAX_BYTES);
			expect(logicalLineCount(resultText(large))).toBeLessThanOrEqual(PI_MODEL_OUTPUT_MAX_LINES);
		} finally {
			await removeCliOutputSpool(largeDetails.execution.spool);
		}
	});

	it("evaluates available and missing combinations across the public reload lifecycle", async () => {
		await installFixture("gh");
		const loader = await createBoundSession();

		expect(session?.getToolDefinition("cli_gh")).toBeDefined();
		expect(session?.getToolDefinition("cli_rg")).toBeUndefined();
		let diagnostics = await runDiagnostics(loader);
		expect(diagnostics).toContain("Available: 1");
		expect(diagnostics).toContain("Missing: 1");
		expect(diagnostics).toContain("cli_rg (ripgrep)");
		await expectNotExists(invocationPath("gh"));

		await installFixture("rg");
		await session?.reload();
		expect(session?.getActiveToolNames().sort()).toEqual(["cli_gh", "cli_rg"]);
		await expectNotExists(invocationPath("rg"));

		await rm(join(binDirectory, "gh"));
		await session?.reload();
		expect(session?.getToolDefinition("cli_gh")).toBeUndefined();
		expect(session?.getToolDefinition("cli_rg")).toBeDefined();
		diagnostics = await runDiagnostics(loader);
		expect(diagnostics).toContain("Available: 1");
		expect(diagnostics).toContain("Missing: 1");
		expect(diagnostics).toContain("cli_gh (github)");
	});

	async function installFixture(name: "gh" | "rg"): Promise<void> {
		const executablePath = join(binDirectory, name);
		const logPath = invocationPath(name);
		await writeFile(
			executablePath,
			`#!${process.execPath}\nimport { appendFile, readFile } from "node:fs/promises";\nconst source = ${JSON.stringify(name)};\nconst args = process.argv.slice(2);\nawait appendFile(${JSON.stringify(logPath)}, JSON.stringify({ source, args, cwd: process.cwd(), sentinel: process.env.CLI_CONTRACT_SENTINEL ?? null }) + "\\n");\nswitch (args[0]) {\n  case "inspect":\n    process.stdout.write(JSON.stringify({ source, args: args.slice(1), cwd: process.cwd(), sentinel: process.env.CLI_CONTRACT_SENTINEL ?? null }));\n    break;\n  case "search": {\n    const pattern = args[1] ?? "";\n    const path = args[2] ?? ".";\n    const contents = await readFile(path, "utf8");\n    const matches = contents.split("\\n").filter((line) => line.includes(pattern));\n    if (matches.length === 0) process.exitCode = 1;\n    else process.stdout.write(matches.map((line) => path + ":" + line).join("\\n") + "\\n");\n    break;\n  }\n  case "exit":\n    if (args[2]) process.stderr.write(args[2]);\n    process.exitCode = Number(args[1] ?? "0");\n    break;\n  case "large":\n    process.stdout.write("L".repeat(Number(args[1] ?? "0")));\n    break;\n  default:\n    process.stderr.write("unknown fixture command");\n    process.exitCode = 2;\n}\n`,
			"utf8",
		);
		await chmod(executablePath, 0o755);
	}

	async function createBoundSession(): Promise<DefaultResourceLoader> {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: agentDirectory,
			extensionFactories: [{ name: "pi-cli-tools", factory: cliToolsExtension }],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions[0]?.tools.size).toBe(0);
		({ session } = await createAgentSession({
			cwd,
			agentDir: agentDirectory,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd),
			noTools: "builtin",
		}));
		const lifecycleErrors: string[] = [];
		await session.bindExtensions({
			mode: "print",
			onError: (error) => lifecycleErrors.push(`${error.event}: ${error.error}`),
		});
		expect(lifecycleErrors).toEqual([]);
		return loader;
	}

	function requireTool(name: string): ToolDefinition {
		const tool = session?.getToolDefinition(name);
		if (!tool) throw new Error(`expected ${name} to be registered`);
		return tool;
	}

	async function execute(tool: ToolDefinition, args: string[]) {
		return tool.execute("contract-evaluation", { args }, undefined, undefined, { cwd } as ExtensionContext);
	}

	async function runDiagnostics(loader: DefaultResourceLoader): Promise<string> {
		const extension = loader.getExtensions().extensions.find(({ path }) => path.includes("pi-cli-tools"));
		const command = extension?.commands.get("cli-tools");
		if (!command) throw new Error("expected /cli-tools command");
		let notification = "";
		await command.handler("", {
			ui: {
				notify(message: string) {
					notification = message;
				},
			},
		} as unknown as ExtensionCommandContext);
		return notification;
	}

	function invocationPath(name: string): string {
		return join(root, `${name}-invocations.jsonl`);
	}
});

function executionDetails(
	result: Awaited<ReturnType<ToolDefinition["execute"]>>,
): Extract<CliToolResultDetails, { kind: "execution" }> {
	const details = result.details as CliToolResultDetails;
	if (details.kind !== "execution") throw new Error("expected execution details");
	return details;
}

function resultText(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
	const content = result.content.find(({ type }) => type === "text");
	return content?.type === "text" ? content.text : "";
}

function logicalLineCount(value: string): number {
	if (!value) return 0;
	let newlines = 0;
	for (const character of value) if (character === "\n") newlines += 1;
	return newlines + (value.endsWith("\n") ? 0 : 1);
}

async function expectNotExists(path: string): Promise<void> {
	await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}
