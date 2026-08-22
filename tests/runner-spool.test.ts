import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	open,
	readFile,
	readdir,
	rm,
	stat,
	truncate,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	CLI_MAX_RETAINED_SPOOL_BYTES,
	CLI_MAX_RETURNED_OUTPUT_BYTES,
	CLI_MAX_SPOOL_PAYLOAD_BYTES,
	removeCliOutputSpool,
} from "../src/runner.js";
import { killProcess, outputSpoolDirectories, runFake, waitForFile, withWatchdog } from "./helpers/runner.js";

const describePosix = process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip;

describePosix("runCli raw output spooling", () => {
	let root: string;
	const emergencyProcesses = new Set<number>();

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-cli-tools-spool-test-"));
	});

	afterEach(async () => {
		for (const pid of emergencyProcesses) killProcess(pid);
		emergencyProcesses.clear();
		await rm(root, { force: true, recursive: true });
	});

	it("assembles complete raw streams privately and removes sidecars", async () => {
		const stdout = "A".repeat(32 * 1024);
		const stderr = "B".repeat(32 * 1024);
		const result = await runFake(root, ["bytes", String(stdout.length), String(stderr.length), "A", "B"]);

		expect(result.spool).toMatchObject({
			status: "complete",
			bytesWritten: stdout.length + stderr.length,
			error: null,
			cleanupError: null,
		});
		if (result.spool.status !== "complete") throw new Error("expected a complete spool");
		const expected = Buffer.concat([
			Buffer.from(`===== stdout (${String(stdout.length)} raw bytes) =====\n`),
			Buffer.from(stdout),
			Buffer.from(`\n===== stderr (${String(stderr.length)} raw bytes) =====\n`),
			Buffer.from(stderr),
		]);
		expect(await readFile(result.spool.path)).toEqual(expected);
		expect((await stat(result.spool.path)).mode & 0o777).toBe(0o600);
		const directory = join(result.spool.path, "..");
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect(await readdir(directory)).toEqual(["full-output.log"]);

		await removeCliOutputSpool(result.spool);
		await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("preserves invalid UTF-8 bytes exactly in a complete spool", async () => {
		const rawBytes = 20_000;
		const result = await runFake(root, ["raw-repeat", "80", String(rawBytes), "stdout"]);

		expect(result.truncation).toMatchObject({ truncated: true, original: { bytes: rawBytes * 3 } });
		if (result.spool.status !== "complete") throw new Error("expected a complete spool");
		const contents = await readFile(result.spool.path);
		const header = Buffer.from(`===== stdout (${String(rawBytes)} raw bytes) =====\n`);
		expect(contents.subarray(0, header.length)).toEqual(header);
		expect(contents.subarray(header.length, header.length + rawBytes)).toEqual(Buffer.alloc(rawBytes, 0x80));
		await removeCliOutputSpool(result.spool);
	});

	it("does not attempt spool setup for bounded output", async () => {
		const result = await runFake(root, ["streams", Buffer.from("small").toString("base64"), ""], {
			temporaryDirectory: join(root, "missing-parent"),
		});

		expect(result.status).toBe("exited");
		expect(result.spool).toMatchObject({ status: "not_needed", error: null, retainedPaths: [] });
	});

	it("reports lazy spool setup failure without replacing process status", async () => {
		const result = await runFake(root, ["bytes", String(CLI_MAX_RETURNED_OUTPUT_BYTES + 1), "0", "A", "B"], {
			temporaryDirectory: join(root, "missing-parent"),
		});

		expect(result.status).toBe("exited");
		expect(result.truncation.truncated).toBe(true);
		expect(result.spool).toMatchObject({ status: "failed", path: null, bytesWritten: 0 });
		expect(result.spool.error).not.toBeNull();
	});

	it("reports sidecar loss as spool failure without replacing cancellation", async () => {
		const readyPath = join(root, "spool-failure-ready");
		const controller = new AbortController();
		const execution = runFake(
			root,
			["bytes-wait", String(CLI_MAX_RETURNED_OUTPUT_BYTES + 1), readyPath],
			{ signal: controller.signal },
			{ timeoutMs: 10_000 },
		);
		await waitForFile(readyPath);
		emergencyProcesses.add(Number(await readFile(readyPath, "utf8")));
		const spoolDirectories = await outputSpoolDirectories(root);
		expect(spoolDirectories).toHaveLength(1);
		const spoolDirectory = spoolDirectories[0];
		if (!spoolDirectory) throw new Error("expected a spool directory");
		const stdoutPath = join(root, spoolDirectory, "stdout.raw");
		await waitForFile(stdoutPath);
		await unlink(stdoutPath);

		controller.abort();
		const result = await withWatchdog(execution, 8_000);

		expect(result.status).toBe("cancelled");
		expect(result.spool).toMatchObject({ status: "failed", error: { code: "ENOENT" } });
		expect(result.spool.retainedPaths).toEqual(
			expect.arrayContaining([join(root, spoolDirectory), join(root, spoolDirectory, "stderr.raw")]),
		);
		await removeCliOutputSpool(result.spool);
		emergencyProcesses.clear();
	});

	it("recovers owner permissions before assembly and sidecar cleanup", async () => {
		const readyPath = join(root, "permission-recovery-ready");
		const controller = new AbortController();
		const execution = runFake(
			root,
			["bytes-wait", String(CLI_MAX_RETURNED_OUTPUT_BYTES + 1), readyPath],
			{ signal: controller.signal },
			{ timeoutMs: 10_000 },
		);
		await waitForFile(readyPath);
		emergencyProcesses.add(Number(await readFile(readyPath, "utf8")));
		const spoolDirectoryName = (await outputSpoolDirectories(root))[0];
		if (!spoolDirectoryName) throw new Error("expected a spool directory");
		const spoolDirectory = join(root, spoolDirectoryName);
		await waitForFile(join(spoolDirectory, "stdout.raw"));
		await waitForFile(join(spoolDirectory, "stderr.raw"));
		await chmod(spoolDirectory, 0o500);
		controller.abort();

		const result = await withWatchdog(execution, 8_000);

		expect(result.status).toBe("cancelled");
		expect(result.spool).toMatchObject({ status: "complete", cleanupError: null });
		expect(await readdir(spoolDirectory)).toEqual(["full-output.log"]);
		await removeCliOutputSpool(result.spool);
		emergencyProcesses.clear();
	});

	it("keeps exactly 64 MiB complete and marks one byte over partial", async () => {
		const exact = await runFake(
			root,
			["bytes", String(CLI_MAX_SPOOL_PAYLOAD_BYTES), "0", "E", "x"],
			{},
			{ outputStrategy: "head", timeoutMs: 60_000 },
		);
		const over = await runFake(
			root,
			["bytes", String(CLI_MAX_SPOOL_PAYLOAD_BYTES + 1), "0", "P", "x"],
			{},
			{ outputStrategy: "head", timeoutMs: 60_000 },
		);

		expect(exact.spool).toMatchObject({ status: "complete", bytesWritten: CLI_MAX_SPOOL_PAYLOAD_BYTES });
		expect(over.spool).toMatchObject({ status: "partial", bytesWritten: CLI_MAX_SPOOL_PAYLOAD_BYTES });
		if (over.spool.status !== "partial") throw new Error("expected partial spool");
		expect((await stat(over.spool.path)).mode & 0o777).toBe(0o600);
		expect((await stat(over.spool.path)).size).toBeGreaterThan(CLI_MAX_SPOOL_PAYLOAD_BYTES);
		await removeCliOutputSpool(exact.spool);
		await removeCliOutputSpool(over.spool);
	}, 70_000);

	it("applies the spool cap across both raw streams and labels partial contents", async () => {
		const stdoutBytes = 32 * 1024 * 1024;
		const stderrBytes = stdoutBytes + 1;
		const result = await runFake(
			root,
			["chunked-generated", "S", String(stdoutBytes), "E", String(stderrBytes), "65536", "65536", "stdout-first"],
			{},
			{ outputStrategy: "head", timeoutMs: 60_000 },
		);

		expect(result.spool).toMatchObject({ status: "partial", bytesWritten: CLI_MAX_SPOOL_PAYLOAD_BYTES });
		if (result.spool.status !== "partial") throw new Error("expected partial spool");
		const stdoutHeader = `===== stdout (${String(stdoutBytes)} raw bytes; ${String(stdoutBytes)} spooled) =====\n`;
		const secondHeaderOffset = Buffer.byteLength(stdoutHeader) + stdoutBytes + 1;
		const file = await open(result.spool.path, "r");
		try {
			const headerBuffer = Buffer.alloc(160);
			const { bytesRead } = await file.read(headerBuffer, 0, headerBuffer.length, secondHeaderOffset);
			expect(headerBuffer.subarray(0, bytesRead).toString("utf8")).toContain(
				`===== stderr (${String(stderrBytes)} raw bytes; ${String(stdoutBytes)} spooled) =====\n`,
			);
		} finally {
			await file.close();
		}
		await removeCliOutputSpool(result.spool);
	}, 70_000);

	it("enforces an aggregate retained-output quota without deleting retained files", async () => {
		const retainedDirectory = join(root, "pi-cli-tools-output-quota-fixture");
		await mkdir(retainedDirectory);
		const retainedFile = join(retainedDirectory, "full-output.log");
		await writeFile(retainedFile, "", "utf8");
		await truncate(retainedFile, CLI_MAX_RETAINED_SPOOL_BYTES);

		const result = await runFake(root, ["bytes", String(CLI_MAX_RETURNED_OUTPUT_BYTES + 1), "0", "Q", "x"]);

		expect(result.status).toBe("exited");
		expect(result.spool).toMatchObject({ status: "failed", error: { code: "ENOSPC" } });
		await expect(access(retainedFile)).resolves.toBeUndefined();
	});
});
