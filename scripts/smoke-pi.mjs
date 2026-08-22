import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { stringify } from "yaml";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "pi-cli-tools-smoke-"));
const cwd = join(root, "session");
const agentDir = join(root, "agent");
const binDir = join(cwd, "bin");
const markerPath = join(root, "invoked.json");
const consumerDir = join(root, "consumer");
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
	await mkdir(join(agentDir, "cli-tools"), { recursive: true });
	const executablePath = join(binDir, "smoke-cli");
	await writeFile(
		executablePath,
		`#!${process.execPath}\nimport { writeFile } from "node:fs/promises";\nconst args = process.argv.slice(2);\nawait writeFile(${JSON.stringify(markerPath)}, JSON.stringify({ args, cwd: process.cwd(), sentinel: process.env.PI_CLI_TOOLS_SMOKE_SENTINEL ?? null }));\nprocess.stdout.write("smoke stdout");\nprocess.stderr.write("smoke stderr");\n`,
		"utf8",
	);
	await chmod(executablePath, 0o755);
	await writeFile(
		join(agentDir, "cli-tools", "github.yaml"),
		stringify({
			id: "github",
			tool_name: "cli_gh",
			binary: { candidates: ["smoke-cli"] },
			routing: { description: "Smoke-test the native Pi CLI adapter." },
			introspection: { man: false },
			docs: { official: [] },
			execution: { timeout_ms: 5_000, cwd: "session", inherit_env: true },
		}),
		"utf8",
	);

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
	if (!session.getActiveToolNames().includes("cli_gh")) throw new Error("cli_gh was not active after session_start");
	const tool = session.getToolDefinition("cli_gh");
	if (!tool) throw new Error("cli_gh native definition was not registered");

	try {
		await readFile(markerPath);
		throw new Error("Startup discovery invoked the configured executable");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}

	const result = await tool.execute(
		"smoke-call",
		{ args: ["literal arg", "$(not-a-shell)", ""] },
		undefined,
		undefined,
		{ cwd },
	);
	const marker = JSON.parse(await readFile(markerPath, "utf8"));
	if (JSON.stringify(marker.args) !== JSON.stringify(["literal arg", "$(not-a-shell)", ""])) {
		throw new Error(`Native tool changed argv: ${JSON.stringify(marker.args)}`);
	}
	if (marker.cwd !== (await realpath(cwd)) || marker.sentinel !== "inherited") {
		throw new Error(`Native tool policy mapping failed: ${JSON.stringify(marker)}`);
	}
	if (result.details?.adapter !== "pi-cli-tools" || result.details.kind !== "execution") {
		throw new Error("Native tool did not return typed pi-cli-tools details");
	}
	if (result.details.execution.status !== "exited" || result.details.execution.exitCode !== 0) {
		throw new Error(`Native execution failed: ${JSON.stringify(result.details.execution)}`);
	}
	if (result.details.execution.stdout !== "smoke stdout" || result.details.execution.stderr !== "smoke stderr") {
		throw new Error("Native execution did not preserve stream identity");
	}
	const modelText = result.content.find(({ type }) => type === "text")?.text ?? "";
	if (!modelText.includes("stdout:\nsmoke stdout\nstderr:\nsmoke stderr")) {
		throw new Error(`Unexpected model-facing native result: ${modelText}`);
	}
	if (Buffer.byteLength(modelText, "utf8") > 50 * 1024) throw new Error("Native result exceeded Pi's byte limit");

	process.stdout.write(
		"Packed production install, real Pi lifecycle, and native CLI registration smoke test passed.\n",
	);
} finally {
	session?.dispose();
	await rm(root, { force: true, recursive: true });
}
