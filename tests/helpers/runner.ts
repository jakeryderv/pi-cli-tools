import { access, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { CLI_MAX_ARGUMENT_BYTES, runCli } from "../../src/runner.js";
import type { CliExecutionOptions, CliExecutionRequest, CliExecutionResult } from "../../src/types.js";

export const fixturePath = fileURLToPath(new URL("../fixtures/fake-cli.mjs", import.meta.url));

export function createRequest(
	root: string,
	fixtureArguments: readonly string[],
	overrides: Partial<CliExecutionRequest> = {},
): CliExecutionRequest {
	return {
		executablePath: process.execPath,
		args: [fixturePath, ...fixtureArguments],
		cwd: root,
		timeoutMs: 5_000,
		environment: "empty",
		outputStrategy: "tail",
		...overrides,
	};
}

export function runFake(
	root: string,
	fixtureArguments: readonly string[],
	options: CliExecutionOptions = {},
	overrides: Partial<CliExecutionRequest> = {},
): Promise<CliExecutionResult> {
	return runCli(createRequest(root, fixtureArguments, overrides), {
		temporaryDirectory: root,
		...options,
	});
}

export function encode(value: string): string {
	return Buffer.from(value).toString("base64");
}

export function buildArgumentsOfTotalBytes(prefix: readonly string[], targetBytes: number): string[] {
	const args = [...prefix];
	let current = args.reduce((total, argument) => total + Buffer.byteLength(argument) + 1, 0);
	while (current < targetBytes) {
		const argumentBytes = Math.min(CLI_MAX_ARGUMENT_BYTES, targetBytes - current - 1);
		args.push("x".repeat(Math.max(0, argumentBytes)));
		current += argumentBytes + 1;
	}
	if (current !== targetBytes) throw new Error("unable to construct exact argument boundary");
	return args;
}

export async function outputSpoolDirectories(root: string): Promise<string[]> {
	return (await readdir(root)).filter((name) => name.startsWith("pi-cli-tools-output-"));
}

export async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await access(path);
			return;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		await delay(20);
	}
	throw new Error(`file did not appear: ${path}`);
}

export interface ReadyPids {
	parentPid: number;
	descendantPid: number;
}

export async function readReadyPids(path: string): Promise<ReadyPids> {
	await waitForFile(path);
	const value = JSON.parse(await readFile(path, "utf8")) as Partial<ReadyPids>;
	if (typeof value.parentPid !== "number" || typeof value.descendantPid !== "number") {
		throw new Error(`fixture readiness file is invalid: ${path}`);
	}
	return { parentPid: value.parentPid, descendantPid: value.descendantPid };
}

export async function expectProcessGone(pid: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return;
		await delay(20);
	}
	throw new Error(`process ${String(pid)} should be gone`);
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

export function killProcessGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
	}
}

export function killProcess(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
	}
}

export async function withWatchdog<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => {
					reject(new Error(`runner exceeded ${String(timeoutMs)}ms watchdog`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
