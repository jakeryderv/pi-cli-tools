import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmCommand, ["pack", "--dry-run", "--json"], {
	encoding: "utf8",
});

if (result.error) {
	throw result.error;
}

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

if (!report || !Array.isArray(report.files)) {
	throw new Error("npm pack did not return a file manifest");
}

const packagedFiles = new Set(report.files.map((file) => file.path));
const requiredFiles = ["LICENSE", "README.md", "extensions/cli-tools.ts", "package.json"];
const forbiddenPrefixes = [".github/", "coverage/", "docs/", "node_modules/", "scripts/", "tests/"];

for (const requiredFile of requiredFiles) {
	if (!packagedFiles.has(requiredFile)) {
		throw new Error(`Required package file is missing: ${requiredFile}`);
	}
}

for (const file of packagedFiles) {
	if (forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) {
		throw new Error(`Development-only file was included in the package: ${file}`);
	}
}

process.stdout.write(`Package contents verified (${packagedFiles.size} files).\n`);
