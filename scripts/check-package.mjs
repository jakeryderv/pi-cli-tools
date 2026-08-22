import { posix } from "node:path";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmCommand, ["pack", "--dry-run", "--json"], {
	encoding: "utf8",
});

if (result.error) throw result.error;
if (result.status !== 0) {
	process.stderr.write(result.stderr);
	process.exit(result.status ?? 1);
}

let reports;
try {
	reports = JSON.parse(result.stdout);
} catch (error) {
	throw new Error("npm pack returned invalid JSON", { cause: error });
}

const report = reports[0];
if (!report || !Array.isArray(report.files)) throw new Error("npm pack did not return a file manifest");

const packagedFiles = new Set(report.files.map((file) => file.path));
const expectedFiles = new Set([
	"LICENSE",
	"README.md",
	"extensions/cli-tools.ts",
	"extensions/pi-adapter.ts",
	"package.json",
	"src/errors.ts",
	"src/introspect.ts",
	"src/limits.ts",
	"src/output.ts",
	"src/process-lifecycle.ts",
	"src/registry.ts",
	"src/runner.ts",
	"src/spool.ts",
	"src/types.ts",
	"tools/github.yaml",
]);

for (const expectedFile of expectedFiles) {
	if (!packagedFiles.has(expectedFile)) throw new Error(`Required package file is missing: ${expectedFile}`);
}
for (const packagedFile of packagedFiles) {
	if (!expectedFiles.has(packagedFile)) throw new Error(`Unexpected package file was included: ${packagedFile}`);
}

const packageManifestText = await readFile(new URL("../package.json", import.meta.url), "utf8");
let packageManifest;
try {
	packageManifest = JSON.parse(packageManifestText);
} catch (error) {
	throw new Error("package.json contains invalid JSON", { cause: error });
}
for (const peer of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
	if (packageManifest.peerDependencies?.[peer] !== "*") {
		throw new Error(`Pi host package must be a wildcard peer dependency: ${peer}`);
	}
}
if (packageManifest.dependencies?.yaml !== "2.9.0") {
	throw new Error("The YAML runtime dependency must be present in production dependencies");
}

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
for (const match of readme.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
	const target = match[1];
	if (!target || /^(?:https?:|mailto:|#)/u.test(target)) continue;
	const packagedTarget = posix.normalize(posix.join(posix.dirname("README.md"), target.split("#", 1)[0] ?? ""));
	if (!packagedFiles.has(packagedTarget)) {
		throw new Error(`README relative link target is not packaged: ${target}`);
	}
}

process.stdout.write(`Package contents and README links verified (${String(packagedFiles.size)} files).\n`);
