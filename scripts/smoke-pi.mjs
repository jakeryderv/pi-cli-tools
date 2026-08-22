import { spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
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
const markerPaths = {
	gh: join(root, "gh-invoked.json"),
	rg: join(root, "rg-invoked.json"),
	lazy: join(root, "lazy-invoked.json"),
};
const manMarkerPath = join(root, "man-invoked.jsonl");
const introspectionMarkerPaths = Object.fromEntries(
	Object.entries(markerPaths).flatMap(([name, path]) => [
		[`${name}:version`, `${path}.version`],
		[`${name}:help`, `${path}.help`],
	]),
);
let session;
const networkGuardCalls = [];

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

	installNetworkDenyGuard(networkGuardCalls);

	await mkdir(binDir, { recursive: true });
	await mkdir(join(agentDir, "cli-tools"), { recursive: true });
	for (const name of ["gh", "rg", "lazy"]) {
		const executablePath = join(binDir, name);
		await writeFile(
			executablePath,
			`#!${process.execPath}\nimport { appendFile, writeFile } from "node:fs/promises";\nconst args = process.argv.slice(2);\nconst record = JSON.stringify({ args, cwd: process.cwd(), sentinel: process.env.PI_CLI_TOOLS_SMOKE_SENTINEL ?? null });\nif (args[0] === "--version") { await appendFile(${JSON.stringify(`${markerPaths[name]}.version`)}, record + "\\n"); process.stdout.write(${JSON.stringify(`${name} fixture version`)}); }\nelse if (args[0] === "--help") { await appendFile(${JSON.stringify(`${markerPaths[name]}.help`)}, record + "\\n"); if (${JSON.stringify(name)} === "rg") process.exitCode = 2; else process.stdout.write(${JSON.stringify(`${name} fixture help`)}); }\nelse if (args[0] === "--fixture-exit-1") process.exitCode = 1;\nelse {\n  await writeFile(${JSON.stringify(markerPaths[name])}, record);\n  process.stdout.write(${JSON.stringify(`${name} smoke stdout`)});\n  process.stderr.write(${JSON.stringify(`${name} smoke stderr`)});\n}\n`,
			"utf8",
		);
		await chmod(executablePath, 0o755);
	}
	const manPath = join(binDir, "man");
	await writeFile(
		manPath,
		`#!${process.execPath}\nimport { appendFile } from "node:fs/promises";\nconst record = JSON.stringify({ args: process.argv.slice(2), pager: process.env.MANPAGER ?? null, term: process.env.TERM ?? null });\nawait appendFile(${JSON.stringify(manMarkerPath)}, record + "\\n");\nprocess.stdout.write("controlled rg manual");\n`,
		"utf8",
	);
	await chmod(manPath, 0o755);
	await writeFile(
		join(agentDir, "cli-tools", "lazy-smoke.yaml"),
		`id: lazy-smoke\ntool_name: cli_lazy_smoke\nactivation: lazy\nbinary:\n  candidates: [lazy]\nrouting:\n  description: Controlled lazy smoke capability.\n  keywords: [controlled, lazy, smoke]\nintrospection:\n  man: false\ndocs:\n  official:\n    - id: lazy-manual\n      title: Lazy smoke manual\n      url: https://docs.example.com/manual\n      allowed_hosts: [docs.example.com]\n      allowed_path_prefix: /manual\n      media: text\n      alignment:\n        mode: unknown\nexecution:\n  timeout_ms: 5000\n  cwd: session\n  inherit_env: false\n`,
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
	const activeCliTools = session
		.getActiveToolNames()
		.filter((name) => ["cli_docs", "cli_gh", "cli_rg", "cli_tools", "cli_lazy_smoke"].includes(name))
		.sort();
	if (JSON.stringify(activeCliTools) !== JSON.stringify(["cli_docs", "cli_gh", "cli_rg", "cli_tools"])) {
		throw new Error(`Initial native activation policy was wrong: ${JSON.stringify(activeCliTools)}`);
	}
	if (!session.getAllTools().some(({ name }) => name === "cli_lazy_smoke")) {
		throw new Error("Lazy controlled tool was not registered");
	}

	for (const markerPath of [...Object.values(markerPaths), ...Object.values(introspectionMarkerPaths), manMarkerPath]) {
		try {
			await readFile(markerPath);
			throw new Error("Startup discovery invoked a bundled executable");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}

	const command = extension.commands.get("cli-tools");
	if (!command) throw new Error("/cli-tools was not registered");
	await command.handler("", { ui: { notify() {} } });

	const catalog = session.getToolDefinition("cli_tools");
	if (!catalog) throw new Error("cli_tools shared definition was not registered");
	const search = await catalog.execute(
		"smoke-search",
		{ action: "search", query: "controlled lazy smoke", limit: 5 },
		undefined,
		undefined,
		{ cwd },
	);
	if (search.details?.kind !== "catalog_search" || search.details.matches[0]?.registryId !== "lazy-smoke") {
		throw new Error(`cli_tools search failed: ${JSON.stringify(search.details)}`);
	}
	const enable = await catalog.execute(
		"smoke-enable",
		{ action: "enable", ids: ["lazy-smoke"] },
		undefined,
		undefined,
		{ cwd },
	);
	if (enable.details?.kind !== "catalog_enable" || !enable.details.enabled.includes("lazy-smoke")) {
		throw new Error(`cli_tools enable failed: ${JSON.stringify(enable.details)}`);
	}
	if (!session.getActiveToolNames().includes("cli_lazy_smoke")) throw new Error("Lazy tool was not activated");

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

	const docs = session.getToolDefinition("cli_docs");
	if (!docs) throw new Error("cli_docs shared definition was not registered");
	const docsResult = await docs.execute("smoke-docs", { tool: "cli_gh" }, undefined, undefined, { cwd });
	if (docsResult.details?.kind !== "docs" || docsResult.details.status !== "ok") {
		throw new Error(`cli_docs did not return successful typed details: ${JSON.stringify(docsResult.details)}`);
	}
	if (docsResult.details.source !== "help" || docsResult.details.version.status !== "ok") {
		throw new Error(`cli_docs returned unexpected local sources: ${JSON.stringify(docsResult.details)}`);
	}
	const docsText = docsResult.content.find(({ type }) => type === "text")?.text ?? "";
	if (!docsText.includes("gh fixture version") || !docsText.includes("gh fixture help")) {
		throw new Error(`cli_docs did not return controlled local version/help text: ${docsText}`);
	}
	for (const [kind, expectedArgs] of [
		["version", ["--version"]],
		["help", ["--help"]],
	]) {
		const records = await readJsonLines(introspectionMarkerPaths[`gh:${kind}`]);
		if (records.length !== 1 || JSON.stringify(records[0]?.args) !== JSON.stringify(expectedArgs)) {
			throw new Error(`cli_docs changed ${kind} argv or invoked it more than once: ${JSON.stringify(records)}`);
		}
	}
	await docs.execute("smoke-docs-cached", { tool: "cli_gh" }, undefined, undefined, { cwd });
	for (const kind of ["version", "help"]) {
		const records = await readJsonLines(introspectionMarkerPaths[`gh:${kind}`]);
		if (records.length !== 1) throw new Error(`cli_docs cache missed for ${kind}`);
	}

	const rgDocs = await docs.execute("smoke-rg-docs", { tool: "cli_rg" }, undefined, undefined, { cwd });
	if (rgDocs.details?.kind !== "docs" || rgDocs.details.status !== "ok" || rgDocs.details.source !== "man") {
		throw new Error(`cli_docs did not use controlled rg man fallback: ${JSON.stringify(rgDocs.details)}`);
	}
	const rgDocsText = rgDocs.content.find(({ type }) => type === "text")?.text ?? "";
	if (!rgDocsText.includes("rg fixture version") || !rgDocsText.includes("controlled rg manual")) {
		throw new Error(`cli_docs returned unexpected rg fallback content: ${rgDocsText}`);
	}
	const rgVersionRecords = await readJsonLines(introspectionMarkerPaths["rg:version"]);
	const rgHelpRecords = await readJsonLines(introspectionMarkerPaths["rg:help"]);
	const manRecords = await readJsonLines(manMarkerPath);
	if (
		rgVersionRecords.length !== 1 ||
		JSON.stringify(rgVersionRecords[0]?.args) !== JSON.stringify(["--version"]) ||
		rgHelpRecords.length !== 1 ||
		JSON.stringify(rgHelpRecords[0]?.args) !== JSON.stringify(["--help"]) ||
		manRecords.length !== 1 ||
		JSON.stringify(manRecords[0]?.args) !== JSON.stringify(["rg"]) ||
		manRecords[0]?.pager !== "cat" ||
		manRecords[0]?.term !== "dumb"
	) {
		throw new Error(
			`cli_docs rg fallback changed argv, environment, or invocation count: ${JSON.stringify({ rgVersionRecords, rgHelpRecords, manRecords })}`,
		);
	}
	await docs.execute("smoke-rg-docs-cached", { tool: "cli_rg" }, undefined, undefined, { cwd });
	const [cachedRgVersionRecords, cachedRgHelpRecords, cachedManRecords] = await Promise.all([
		readJsonLines(introspectionMarkerPaths["rg:version"]),
		readJsonLines(introspectionMarkerPaths["rg:help"]),
		readJsonLines(manMarkerPath),
	]);
	if (cachedRgVersionRecords.length !== 1 || cachedRgHelpRecords.length !== 2 || cachedManRecords.length !== 1) {
		throw new Error("cli_docs cache isolation failed for the rg man fallback");
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

	if (networkGuardCalls.length > 0) {
		throw new Error(
			`Startup, diagnostics, local docs, or catalog work attempted direct networking: ${JSON.stringify(networkGuardCalls)}`,
		);
	}
	process.stdout.write(
		"Packed production install, registry search/enable, remote-doc laziness, local-doc cache, real Pi lifecycle, and controlled native executions passed.\n",
	);
} finally {
	session?.dispose();
	await rm(root, { force: true, recursive: true });
}

function installNetworkDenyGuard(calls) {
	const require = createRequire(import.meta.url);
	const deny = (name) =>
		function deniedNetworkPrimitive() {
			calls.push(name);
			throw new Error(`Network primitive denied by packed smoke guard: ${name}`);
		};
	const patch = (target, names, prefix) => {
		for (const name of names) {
			if (typeof target[name] === "function") target[name] = deny(`${prefix}.${name}`);
		}
	};
	const dns = require("node:dns");
	const dnsPromises = require("node:dns/promises");
	patch(dns, ["lookup", "resolve", "resolve4", "resolve6", "reverse"], "dns");
	patch(dnsPromises, ["lookup", "resolve", "resolve4", "resolve6", "reverse"], "dns/promises");
	patch(dns.Resolver.prototype, ["resolve", "resolve4", "resolve6"], "dns.Resolver");
	patch(dnsPromises.Resolver.prototype, ["resolve", "resolve4", "resolve6"], "dns/promises.Resolver");
	patch(require("node:net"), ["connect", "createConnection"], "net");
	patch(require("node:tls"), ["connect"], "tls");
	patch(require("node:http"), ["request", "get"], "http");
	patch(require("node:https"), ["request", "get"], "https");
	patch(require("node:dgram"), ["createSocket"], "dgram");
	globalThis.fetch = deny("global.fetch");
	syncBuiltinESMExports();
}

async function readJsonLines(path) {
	const content = await readFile(path, "utf8");
	const lines = content.split("\n").filter(Boolean);
	return lines.map((line, index) => {
		try {
			return JSON.parse(line);
		} catch (error) {
			throw new Error(`Invalid JSON line in ${path} at record ${String(index + 1)}`, { cause: error });
		}
	});
}
