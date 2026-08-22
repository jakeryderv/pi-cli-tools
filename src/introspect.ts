import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

import type {
	CliDiscovery,
	ExecutableResolution,
	LoadedRegistryDefinition,
	MissingExecutableResolution,
} from "./types.js";

const WINDOWS_EXECUTABLE_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];

export interface ExecutableDiscoveryOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

/** Resolve the first executable candidate found on PATH without launching it. */
export async function resolveExecutable(
	candidates: readonly string[],
	options: ExecutableDiscoveryOptions = {},
): Promise<ExecutableResolution | MissingExecutableResolution> {
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const directories = getSearchDirectories(env, cwd);
	const checkedPaths: string[] = [];

	for (const candidate of candidates) {
		const candidateNames = getCandidateNames(candidate, env);
		for (const directory of directories) {
			for (const candidateName of candidateNames) {
				const path = join(directory, candidateName);
				checkedPaths.push(path);

				if (!(await isExecutableFile(path))) continue;
				try {
					return {
						candidate,
						executablePath: await realpath(path),
						checkedPaths,
					};
				} catch {
					// The path changed after it was checked; continue discovery.
				}
			}
		}
	}

	return { checkedPaths };
}

/** Resolve executables for each merged registry definition in stable registry order. */
export async function discoverRegistry(
	definitions: readonly LoadedRegistryDefinition[],
	options: ExecutableDiscoveryOptions = {},
): Promise<CliDiscovery[]> {
	const discoveries: CliDiscovery[] = [];

	for (const registry of definitions) {
		const resolution = await resolveExecutable(registry.definition.binary.candidates, options);
		if ("executablePath" in resolution) {
			discoveries.push({ status: "available", registry, resolution });
		} else {
			discoveries.push({ status: "missing", registry, resolution });
		}
	}

	return discoveries;
}

function getSearchDirectories(env: NodeJS.ProcessEnv, cwd: string): string[] {
	const pathValue = getEnvironmentValue(env, "PATH");
	if (!pathValue) return [];

	const directories = pathValue.split(delimiter).flatMap((entry) => {
		if (entry.length === 0) return [];
		return [isAbsolute(entry) ? entry : resolve(cwd, entry)];
	});
	return [...new Set(directories)];
}

function getCandidateNames(candidate: string, env: NodeJS.ProcessEnv): string[] {
	if (process.platform !== "win32" || extname(candidate).length > 0) return [candidate];

	const pathExt = getEnvironmentValue(env, "PATHEXT");
	const extensions = pathExt
		? pathExt
				.split(";")
				.map((extension) => extension.trim())
				.filter(Boolean)
		: WINDOWS_EXECUTABLE_EXTENSIONS;
	return extensions.map((extension) => `${candidate}${extension}`);
}

function getEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	if (process.platform !== "win32") return env[name];

	const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
	return key ? env[key] : undefined;
}

async function isExecutableFile(path: string): Promise<boolean> {
	try {
		const metadata = await stat(path);
		if (!metadata.isFile()) return false;
		await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
