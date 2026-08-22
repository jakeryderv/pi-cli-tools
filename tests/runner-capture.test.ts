import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCliCapture } from "../src/runner.js";
import { expectProcessGone, fixturePath, outputSpoolDirectories, readReadyPids } from "./helpers/runner.js";

const describePosix = process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip;

describePosix("non-retaining bounded capture boundary", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-cli-tools-capture-"));
	});

	afterEach(async () => {
		await rm(root, { force: true, recursive: true });
	});

	it("preserves exact argv/cwd/environment and ignores stdin without a shell", async () => {
		const literal = ["", "a b", "*", ";", "$(touch nope)", "`id`"];
		const result = await runCliCapture(
			{
				executablePath: process.execPath,
				args: [fixturePath, "inspect", "CAPTURE_SENTINEL", ...literal],
				cwd: root,
				timeoutMs: 5_000,
				environment: "inherit",
				outputStrategy: "head",
			},
			{
				inheritedEnvironment: { CAPTURE_SENTINEL: "controlled" },
				maxOutputBytes: 4_096,
				maxOutputLines: 20,
			},
		);
		const payload = JSON.parse(result.stdout) as {
			args: string[];
			cwd: string;
			environmentValue: string;
			stdinEnded: boolean;
			tty: Record<string, boolean>;
		};
		expect(payload).toMatchObject({
			args: literal,
			environmentValue: "controlled",
			stdinEnded: true,
			tty: { stdin: false, stdout: false, stderr: false },
		});
		expect(result.spool).toMatchObject({ status: "not_needed", retainedPaths: [] });
	});

	it("discards overflow under custom head limits and never creates a spool", async () => {
		const result = await runCliCapture(
			{
				executablePath: process.execPath,
				args: [fixturePath, "bytes", "10000", "10000", "O", "E"],
				cwd: root,
				timeoutMs: 5_000,
				environment: "empty",
				outputStrategy: "head",
			},
			{ temporaryDirectory: root, maxOutputBytes: 1_024, maxOutputLines: 10 },
		);
		expect(result).toMatchObject({
			status: "exited",
			truncation: { truncated: true, limits: { bytes: 1_024, lines: 10 } },
			spool: { status: "not_needed", path: null, retainedPaths: [] },
		});
		expect(Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8")).toBe(1_024);
		expect(await outputSpoolDirectories(root)).toEqual([]);
	});

	it("propagates cancellation through bounded process-group cleanup and does not cache or retain output", async () => {
		const ready = join(root, "ready.json");
		const controller = new AbortController();
		const pending = runCliCapture(
			{
				executablePath: process.execPath,
				args: [fixturePath, "tree", ready, "ignore"],
				cwd: root,
				timeoutMs: 5_000,
				environment: "empty",
				outputStrategy: "head",
			},
			{ signal: controller.signal, maxOutputBytes: 1_024, maxOutputLines: 20 },
		);
		const pids = await readReadyPids(ready);
		controller.abort();
		const result = await pending;
		expect(result).toMatchObject({
			status: "cancelled",
			termination: { attempted: true, forced: true, confirmed: true },
			spool: { status: "not_needed" },
		});
		await expectProcessGone(pids.parentPid);
		await expectProcessGone(pids.descendantPid);

		const marker = join(root, "pre-abort");
		const aborted = new AbortController();
		aborted.abort();
		const preAborted = await runCliCapture(
			{
				executablePath: process.execPath,
				args: [fixturePath, "marker", marker],
				cwd: root,
				timeoutMs: 1_000,
				environment: "empty",
				outputStrategy: "head",
			},
			{ signal: aborted.signal, maxOutputBytes: 1_024, maxOutputLines: 20 },
		);
		expect(preAborted.status).toBe("cancelled");
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
