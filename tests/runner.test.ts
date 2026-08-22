import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLI_OUTPUT_DRAIN_GRACE_MS, removeCliOutputSpool, runCli } from "../src/runner.js";
import {
	createRequest,
	delay,
	encode,
	expectProcessGone,
	isProcessAlive,
	killProcess,
	killProcessGroup,
	readReadyPids,
	runFake,
	withWatchdog,
} from "./helpers/runner.js";

const describePosix = process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip;

describePosix("runCli process execution", () => {
	let root: string;
	const emergencyProcessGroups = new Set<number>();
	const emergencyProcesses = new Set<number>();

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-cli-tools-runner-"));
	});

	afterEach(async () => {
		for (const processGroup of emergencyProcessGroups) killProcessGroup(processGroup);
		for (const pid of emergencyProcesses) killProcess(pid);
		emergencyProcessGroups.clear();
		emergencyProcesses.clear();
		await rm(root, { force: true, recursive: true });
	});

	it("preserves exact arguments and never interprets shell syntax", async () => {
		const shellMarker = join(root, "shell-interpreted");
		const literalArguments = [
			"",
			"two words",
			'"quoted"',
			"'single'",
			"*",
			"$HOME",
			`$(touch ${shellMarker})`,
			"semi;colon",
			"back`tick",
			"line one\nline two",
			"back\\slash",
		];

		const result = await runFake(root, ["inspect", "RUNNER_SENTINEL", ...literalArguments], {
			inheritedEnvironment: { PATH: join(root, "untrusted-bin") },
		});

		expect(result).toMatchObject({ status: "exited", exitCode: 0, signal: null });
		expect(JSON.parse(result.stdout)).toMatchObject({
			args: literalArguments,
			cwd: await realpath(root),
			environmentValue: null,
			stdinEnded: true,
			tty: { stdin: false, stdout: false, stderr: false },
		});
		await expect(access(shellMarker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("uses the exact top-level path even when inherited PATH contains a substitute", async () => {
		const binDirectory = join(root, "bin");
		const marker = join(root, "substitute-launched");
		await mkdir(binDirectory);
		const substitute = join(binDirectory, "node");
		await writeFile(substitute, `#!/bin/sh\nprintf launched > "${marker}"\n`, "utf8");
		await chmod(substitute, 0o755);

		const result = await runFake(root, ["streams", encode("exact"), encode("")], {
			inheritedEnvironment: { PATH: binDirectory },
		});

		expect(result.stdout).toBe("exact");
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("applies concrete cwd, exact environment snapshots, ignored stdin, and no TTY", async () => {
		const cwd = join(root, "working directory");
		await mkdir(cwd);
		const inheritedEnvironment = { RUNNER_SENTINEL: "present", SECOND_VALUE: "two" };

		const inherited = await runFake(
			root,
			["inspect", "RUNNER_SENTINEL"],
			{ inheritedEnvironment },
			{ cwd, environment: "inherit" },
		);
		const empty = await runFake(
			root,
			["inspect", "RUNNER_SENTINEL"],
			{ inheritedEnvironment: { RUNNER_SENTINEL: "must-not-leak" } },
			{ cwd, environment: "empty" },
		);

		expect(JSON.parse(inherited.stdout)).toMatchObject({
			cwd: await realpath(cwd),
			environmentValue: "present",
			environment: inheritedEnvironment,
			stdinEnded: true,
			tty: { stdin: false, stdout: false, stderr: false },
		});
		expect(JSON.parse(empty.stdout)).toMatchObject({
			cwd: await realpath(cwd),
			environmentValue: null,
			environment: {},
			stdinEnded: true,
			tty: { stdin: false, stdout: false, stderr: false },
		});
	});

	it("preserves separate streams, zero/nonzero exits, and natural signals", async () => {
		const success = await runFake(root, ["streams", encode("out\n"), encode("err\n")]);
		const nonzero = await runFake(root, ["exit", "23"]);
		const signalled = await runFake(root, ["signal", "SIGTERM"]);

		expect(success).toMatchObject({ status: "exited", exitCode: 0, stdout: "out\n", stderr: "err\n" });
		expect(nonzero).toMatchObject({ status: "exited", exitCode: 23, signal: null });
		expect(signalled).toMatchObject({ status: "exited", exitCode: null, signal: "SIGTERM" });
	});

	it("returns bounded structured spawn errors", async () => {
		const missingExecutable = await runCli(
			createRequest(root, ["exit", "0"], { executablePath: join(root, "missing") }),
			{
				temporaryDirectory: root,
			},
		);
		const missingCwd = await runFake(root, ["exit", "0"], {}, { cwd: join(root, "missing-cwd") });

		expect(missingExecutable).toMatchObject({
			status: "spawn_error",
			exitCode: null,
			signal: null,
			spawnError: { code: "ENOENT" },
		});
		expect(missingCwd).toMatchObject({ status: "spawn_error", spawnError: { code: "ENOENT" } });
		expect(missingExecutable.spawnError?.message.length).toBeLessThanOrEqual(2_048);
	});

	it("cancels before spawn when the signal is already aborted", async () => {
		const marker = join(root, "must-not-launch");
		const controller = new AbortController();
		controller.abort();

		const result = await runFake(root, ["marker", marker], { signal: controller.signal });

		expect(result).toMatchObject({
			status: "cancelled",
			termination: { reason: "cancelled", attempted: false, forced: false, confirmed: false },
		});
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("cancels a cooperative process group without escalation", async () => {
		const readyPath = join(root, "cancel-ready.json");
		const controller = new AbortController();
		const execution = runFake(root, ["tree", readyPath, "exit"], { signal: controller.signal }, { timeoutMs: 10_000 });
		const pids = await readReadyPids(readyPath);
		emergencyProcessGroups.add(pids.parentPid);

		controller.abort();
		const result = await withWatchdog(execution, 8_000);

		expect(result).toMatchObject({
			status: "cancelled",
			signal: "SIGTERM",
			termination: { reason: "cancelled", attempted: true, forced: false, confirmed: true },
		});
		await expectProcessGone(pids.parentPid);
		await expectProcessGone(pids.descendantPid);
		emergencyProcessGroups.delete(pids.parentPid);
	});

	it("times out a cooperative process group without escalation", async () => {
		const readyPath = join(root, "timeout-ready.json");
		const execution = runFake(root, ["tree", readyPath, "exit"], {}, { timeoutMs: 800 });
		const pids = await readReadyPids(readyPath);
		emergencyProcessGroups.add(pids.parentPid);

		const result = await withWatchdog(execution, 8_000);

		expect(result).toMatchObject({
			status: "timed_out",
			signal: "SIGTERM",
			termination: { reason: "timed_out", attempted: true, forced: false, confirmed: true },
		});
		await expectProcessGone(pids.parentPid);
		await expectProcessGone(pids.descendantPid);
		emergencyProcessGroups.delete(pids.parentPid);
	});

	it("keeps cancellation as the first cause while escalating during the timeout window", async () => {
		const readyPath = join(root, "cancel-first-ready.json");
		const controller = new AbortController();
		const execution = runFake(root, ["tree", readyPath, "ignore"], { signal: controller.signal }, { timeoutMs: 800 });
		const pids = await readReadyPids(readyPath);
		emergencyProcessGroups.add(pids.parentPid);
		controller.abort();

		const result = await withWatchdog(execution, 8_000);

		expect(result).toMatchObject({
			status: "cancelled",
			signal: "SIGKILL",
			termination: { reason: "cancelled", forced: true, confirmed: true },
		});
		expect(result.durationMs).toBeGreaterThanOrEqual(500);
		emergencyProcessGroups.delete(pids.parentPid);
	});

	it("keeps timeout as the first cause when cancellation arrives during escalation", async () => {
		const readyPath = join(root, "timeout-first-ready.json");
		const controller = new AbortController();
		const execution = runFake(root, ["tree", readyPath, "ignore"], { signal: controller.signal }, { timeoutMs: 300 });
		const pids = await readReadyPids(readyPath);
		emergencyProcessGroups.add(pids.parentPid);
		await delay(350);
		controller.abort();

		const result = await withWatchdog(execution, 8_000);

		expect(result).toMatchObject({
			status: "timed_out",
			signal: "SIGKILL",
			termination: { reason: "timed_out", forced: true, confirmed: true },
		});
		expect(result.durationMs).toBeGreaterThanOrEqual(800);
		emergencyProcessGroups.delete(pids.parentPid);
	});

	it(
		"cleans the original process group after a natural direct-child exit",
		async () => {
			const readyPath = join(root, "natural-cleanup-ready.json");
			const execution = runFake(root, ["exit-with-open-pipes", readyPath], {}, { timeoutMs: 10_000 });
			const pids = await readReadyPids(readyPath);
			emergencyProcessGroups.add(pids.parentPid);

			const result = await withWatchdog(execution, CLI_OUTPUT_DRAIN_GRACE_MS + 3_000);

			expect(result).toMatchObject({
				status: "exited",
				exitCode: 0,
				capture: { complete: true, cutOff: false, reason: null },
				processGroupCleanup: { reason: "natural_exit", forced: false, confirmed: true },
			});
			await expectProcessGone(pids.descendantPid);
			emergencyProcessGroups.delete(pids.parentPid);
		},
		CLI_OUTPUT_DRAIN_GRACE_MS + 5_000,
	);

	it("uses cancellation during natural drain to accelerate cleanup without changing exited status", async () => {
		const readyPath = join(root, "natural-abort-ready.json");
		const controller = new AbortController();
		const execution = runFake(
			root,
			["exit-with-open-pipes", readyPath],
			{ signal: controller.signal },
			{ timeoutMs: 10_000 },
		);
		const pids = await readReadyPids(readyPath);
		emergencyProcessGroups.add(pids.parentPid);
		await expectProcessGone(pids.parentPid);
		controller.abort();

		const result = await withWatchdog(execution, 3_000);

		expect(result.status).toBe("exited");
		expect(result.processGroupCleanup).toMatchObject({ confirmed: true });
		expect(result.durationMs).toBeLessThan(CLI_OUTPUT_DRAIN_GRACE_MS);
		await expectProcessGone(pids.descendantPid);
		emergencyProcessGroups.delete(pids.parentPid);
	});

	it("documents that a descendant in a new process group can escape", async () => {
		const readyPath = join(root, "escaped-ready.json");
		const execution = runFake(root, ["tree-escape", readyPath, "exit"], {}, { timeoutMs: 500 });
		const pids = await readReadyPids(readyPath);
		emergencyProcessGroups.add(pids.parentPid);
		emergencyProcesses.add(pids.descendantPid);

		const result = await withWatchdog(execution, 8_000);

		expect(result).toMatchObject({ status: "timed_out", termination: { confirmed: true } });
		expect(isProcessAlive(pids.descendantPid)).toBe(true);
		killProcess(pids.descendantPid);
		await expectProcessGone(pids.descendantPid);
		emergencyProcesses.delete(pids.descendantPid);
		emergencyProcessGroups.delete(pids.parentPid);
	});

	it("marks capture partial at the termination confirmation ceiling", async () => {
		const readyPath = join(root, "escaped-pipes-ready.json");
		const execution = runFake(root, ["tree-escaped-pipes", readyPath, "exit"], {}, { timeoutMs: 300 });
		const pids = await readReadyPids(readyPath);
		emergencyProcessGroups.add(pids.parentPid);
		emergencyProcesses.add(pids.descendantPid);

		const result = await withWatchdog(execution, 8_000);

		expect(result).toMatchObject({
			status: "timed_out",
			termination: { confirmed: true },
			capture: { complete: false, cutOff: true, reason: "termination_confirmation_timeout" },
			spool: { status: "partial" },
		});
		expect(result.durationMs).toBeGreaterThanOrEqual(5_200);
		await removeCliOutputSpool(result.spool);
		killProcess(pids.descendantPid);
		await expectProcessGone(pids.descendantPid);
		emergencyProcesses.delete(pids.descendantPid);
		emergencyProcessGroups.delete(pids.parentPid);
	}, 10_000);

	it("marks natural output-drain cutoff separately from model truncation", async () => {
		const readyPath = join(root, "natural-escaped-pipes-ready.json");
		const execution = runFake(root, ["exit-with-escaped-open-pipes", readyPath], {}, { timeoutMs: 10_000 });
		const pids = await readReadyPids(readyPath);
		emergencyProcesses.add(pids.descendantPid);

		const result = await withWatchdog(execution, 8_000);

		expect(result).toMatchObject({
			status: "exited",
			truncation: { truncated: false },
			capture: { complete: false, cutOff: true, reason: "output_drain_timeout" },
			spool: { status: "partial" },
		});
		await removeCliOutputSpool(result.spool);
		killProcess(pids.descendantPid);
		await expectProcessGone(pids.descendantPid);
		emergencyProcesses.delete(pids.descendantPid);
	}, 10_000);
});
