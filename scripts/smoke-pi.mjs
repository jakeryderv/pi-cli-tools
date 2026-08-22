import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "pi-cli-tools-smoke-"));
const cwd = join(root, "session");
const agentDir = join(root, "agent");
const binDir = join(cwd, "bin");
const consumerDir = join(root, "consumer");
const markerPaths = { gh: join(root, "gh-invoked.json"), rg: join(root, "rg-invoked.json") };
let session;

try {
	await mkdir(consumerDir);
	await writeFile(join(consumerDir, "package.json"), '{"private":true}', "utf8");
	const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
	const pack = spawnSync(npmCommand, ["pack", "--json", "--pack-destination", root], {
		cwd: projectRoot,
		encoding: "utf8",
	});
	if (pack.error) throw pack.error;
	if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
	const packReport = JSON.parse(pack.stdout)[0];
	if (!packReport?.filename) throw new Error("npm pack did not report a tarball");
	const tarballPath = join(root, packReport.filename);
	const install = spawnSync(
		npmCommand,
		["install", "--ignore-scripts", "--omit=dev", "--legacy-peer-deps", "--no-package-lock", tarballPath],
		{ cwd: consumerDir, encoding: "utf8" },
	);
	if (install.error) throw install.error;
	if (install.status !== 0) throw new Error(`production tarball install failed: ${install.stderr}`);
	const installedPackageRoot = join(consumerDir, "node_modules", "pi-cli-tools");
	const installedManifest = JSON.parse(await readFile(join(installedPackageRoot, "package.json"), "utf8"));
	if (installedManifest.name !== "pi-cli-tools") throw new Error("packed package was not installed");

	await mkdir(binDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	for (const name of ["gh", "rg"]) {
		const executablePath = join(binDir, name);
		await writeFile(
			executablePath,
			`#!${process.execPath}\nimport { writeFile } from "node:fs/promises";\nconst args = process.argv.slice(2);\nif (args[0] === "--fixture-exit-1") process.exitCode = 1;\nelse {\n  await writeFile(${JSON.stringify(markerPaths[name])}, JSON.stringify({ args, cwd: process.cwd(), sentinel: process.env.PI_CLI_TOOLS_SMOKE_SENTINEL ?? null }));\n  process.stdout.write(${JSON.stringify(`${name} smoke stdout`)});\n  process.stderr.write(${JSON.stringify(`${name} smoke stderr`)});\n}\n`,
			"utf8",
		);
		await chmod(executablePath, 0o755);
	}

	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PATH = "bin";
	process.env.PI_CLI_TOOLS_SMOKE_SENTINEL = "inherited";
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		additionalExtensionPaths: [installedPackageRoot],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	if (loader.getExtensions().errors.length > 0) {
		throw new Error(`Pi extension load failed: ${JSON.stringify(loader.getExtensions().errors)}`);
	}
	const extension = loader
		.getExtensions()
		.extensions.find(({ resolvedPath }) => resolvedPath.endsWith("extensions/cli-tools.ts"));
	if (!extension) throw new Error("Pi did not load extensions/cli-tools.ts from the package");
	if (extension.tools.size !== 0) throw new Error("Native tools registered before session_start");

	({ session } = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
		noTools: "builtin",
	}));
	const lifecycleErrors = [];
	await session.bindExtensions({
		mode: "print",
		onError: (error) => lifecycleErrors.push(error),
	});
	if (lifecycleErrors.length > 0) throw new Error(`Pi lifecycle errors: ${JSON.stringify(lifecycleErrors)}`);
	const activeCliTools = session
		.getActiveToolNames()
		.filter((name) => name === "cli_gh" || name === "cli_rg")
		.sort();
	if (JSON.stringify(activeCliTools) !== JSON.stringify(["cli_gh", "cli_rg"])) {
		throw new Error(`Bundled native tools were not active after session_start: ${JSON.stringify(activeCliTools)}`);
	}

	for (const markerPath of Object.values(markerPaths)) {
		try {
			await readFile(markerPath);
			throw new Error("Startup discovery invoked a bundled executable");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}

	const literalArgs = ["literal arg", "$(not-a-shell)", ""];
	for (const [toolName, executableName, acceptedExitCodes, expectedSentinel] of [
		["cli_gh", "gh", [0], "inherited"],
		["cli_rg", "rg", [0, 1], null],
	]) {
		const tool = session.getToolDefinition(toolName);
		if (!tool) throw new Error(`${toolName} native definition was not registered`);
		const result = await tool.execute("smoke-call", { args: literalArgs }, undefined, undefined, { cwd });
		const marker = JSON.parse(await readFile(markerPaths[executableName], "utf8"));
		if (JSON.stringify(marker.args) !== JSON.stringify(literalArgs)) {
			throw new Error(`${toolName} changed argv: ${JSON.stringify(marker.args)}`);
		}
		if (marker.cwd !== (await realpath(cwd)) || marker.sentinel !== expectedSentinel) {
			throw new Error(`${toolName} policy mapping failed: ${JSON.stringify(marker)}`);
		}
		if (result.details?.adapter !== "pi-cli-tools" || result.details.kind !== "execution") {
			throw new Error(`${toolName} did not return typed pi-cli-tools details`);
		}
		if (JSON.stringify(result.details.acceptedExitCodes) !== JSON.stringify(acceptedExitCodes)) {
			throw new Error(`${toolName} returned the wrong accepted-exit policy snapshot`);
		}
		if (result.details.execution.status !== "exited" || result.details.execution.exitCode !== 0) {
			throw new Error(`${toolName} native execution failed: ${JSON.stringify(result.details.execution)}`);
		}
		if (
			result.details.execution.stdout !== `${executableName} smoke stdout` ||
			result.details.execution.stderr !== `${executableName} smoke stderr`
		) {
			throw new Error(`${toolName} did not preserve stream identity`);
		}
		const modelText = result.content.find(({ type }) => type === "text")?.text ?? "";
		if (!modelText.includes(`stdout:\n${executableName} smoke stdout\nstderr:\n${executableName} smoke stderr`)) {
			throw new Error(`Unexpected ${toolName} model-facing result: ${modelText}`);
		}
		if (Buffer.byteLength(modelText, "utf8") > 50 * 1024) {
			throw new Error(`${toolName} native result exceeded Pi's byte limit`);
		}
	}

	const rg = session.getToolDefinition("cli_rg");
	if (!rg) throw new Error("cli_rg native definition was not registered");
	const noMatch = await rg.execute("smoke-no-match", { args: ["--fixture-exit-1"] }, undefined, undefined, { cwd });
	if (noMatch.details?.kind !== "execution") throw new Error("cli_rg no-match result lacked execution details");
	if (noMatch.details.execution.status !== "exited" || noMatch.details.execution.exitCode !== 1) {
		throw new Error("cli_rg did not preserve an accepted nonzero runner outcome");
	}
	const noMatchText = noMatch.content.find(({ type }) => type === "text")?.text ?? "";
	if (!noMatchText.includes("code=1; accepted=true")) {
		throw new Error(`cli_rg did not render its accepted nonzero outcome: ${noMatchText}`);
	}

	process.stdout.write(
		"Packed production install, both bundled definitions, real Pi lifecycle, and controlled native executions passed.\n",
	);
} finally {
	session?.dispose();
	await rm(root, { force: true, recursive: true });
}
