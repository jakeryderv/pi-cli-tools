import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLI_MAX_RETURNED_OUTPUT_BYTES, CLI_MAX_RETURNED_OUTPUT_LINES, removeCliOutputSpool } from "../src/runner.js";
import type { CliExecutionResult } from "../src/types.js";
import { encode, outputSpoolDirectories, runFake } from "./helpers/runner.js";

const describePosix = process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip;

describePosix("runCli output projection", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-cli-tools-output-test-"));
	});

	afterEach(async () => {
		await rm(root, { force: true, recursive: true });
	});

	it("keeps bounded output exact without creating an unneeded spool", async () => {
		const result = await runFake(root, ["streams", encode("alpha\n"), encode("beta")]);

		expect(result.truncation).toMatchObject({
			truncated: false,
			original: { bytes: 10, lines: 2 },
			returned: { bytes: 10, lines: 2 },
			stdout: {
				rawBytesReceived: 6,
				original: { bytes: 6, lines: 1 },
				returned: { bytes: 6, lines: 1 },
				truncated: false,
			},
			stderr: {
				rawBytesReceived: 4,
				original: { bytes: 4, lines: 1 },
				returned: { bytes: 4, lines: 1 },
				truncated: false,
			},
		});
		expect(result).toMatchObject({
			capture: { complete: true, cutOff: false, reason: null },
			spool: { status: "not_needed", path: null, retainedPaths: [], cleanupError: null },
		});
		expect(await outputSpoolDirectories(root)).toEqual([]);
	});

	it("enforces exact combined byte and line boundaries", async () => {
		const exactBytes = await runFake(root, ["bytes", String(CLI_MAX_RETURNED_OUTPUT_BYTES), "0", "A", "B"]);
		const overBytes = await runFake(root, ["bytes", String(CLI_MAX_RETURNED_OUTPUT_BYTES + 1), "0", "A", "B"]);
		const exactLines = await runFake(root, ["lines", String(CLI_MAX_RETURNED_OUTPUT_LINES), "0"]);
		const overLines = await runFake(root, ["lines", String(CLI_MAX_RETURNED_OUTPUT_LINES + 1), "0"]);

		expect(exactBytes.truncation).toMatchObject({
			truncated: false,
			returned: { bytes: CLI_MAX_RETURNED_OUTPUT_BYTES },
		});
		expect(overBytes.truncation).toMatchObject({
			truncated: true,
			original: { bytes: CLI_MAX_RETURNED_OUTPUT_BYTES + 1 },
			returned: { bytes: CLI_MAX_RETURNED_OUTPUT_BYTES },
			reasons: { bytes: true, lines: false },
		});
		expect(exactLines.truncation).toMatchObject({
			truncated: false,
			returned: { lines: CLI_MAX_RETURNED_OUTPUT_LINES },
		});
		expect(overLines.truncation).toMatchObject({
			truncated: true,
			original: { lines: CLI_MAX_RETURNED_OUTPUT_LINES + 1 },
			returned: { lines: CLI_MAX_RETURNED_OUTPUT_LINES },
			reasons: { bytes: false, lines: true },
		});
		await cleanupResults([overBytes, overLines]);
	});

	it("applies one deterministic combined byte budget for head and tail", async () => {
		const outputBytes = 30 * 1024;
		const expectedRemainder = CLI_MAX_RETURNED_OUTPUT_BYTES - outputBytes;
		const head = await runFake(
			root,
			["bytes", String(outputBytes), String(outputBytes), "A", "B"],
			{},
			{
				outputStrategy: "head",
			},
		);
		const tail = await runFake(
			root,
			["bytes", String(outputBytes), String(outputBytes), "A", "B"],
			{},
			{
				outputStrategy: "tail",
			},
		);

		expect(head.stdout).toBe("A".repeat(outputBytes));
		expect(head.stderr).toBe("B".repeat(expectedRemainder));
		expect(tail.stdout).toBe("A".repeat(expectedRemainder));
		expect(tail.stderr).toBe("B".repeat(outputBytes));
		for (const result of [head, tail]) {
			expect(result.truncation).toMatchObject({
				truncated: true,
				original: { bytes: outputBytes * 2, lines: 2 },
				returned: { bytes: CLI_MAX_RETURNED_OUTPUT_BYTES, lines: 2 },
				reasons: { bytes: true, lines: false },
			});
		}
		await cleanupResults([head, tail]);
	});

	it("applies one deterministic combined line budget while retaining stream identity", async () => {
		const head = await runFake(root, ["lines", "1000", "1000"], {}, { outputStrategy: "head" });
		const tail = await runFake(root, ["lines", "1000", "1000"], {}, { outputStrategy: "tail" });

		expect(head.stdout.split("\n").filter(Boolean)).toHaveLength(1_000);
		expect(head.stderr.split("\n").filter(Boolean)).toHaveLength(980);
		expect(head.stderr).toContain("stderr-0000\n");
		expect(head.stderr).not.toContain("stderr-0980\n");
		expect(tail.stdout.split("\n").filter(Boolean)).toHaveLength(980);
		expect(tail.stdout).not.toContain("stdout-0019\n");
		expect(tail.stdout).toContain("stdout-0020\n");
		expect(tail.stderr.split("\n").filter(Boolean)).toHaveLength(1_000);
		for (const result of [head, tail]) {
			expect(result.truncation).toMatchObject({
				truncated: true,
				original: { lines: 2_000 },
				returned: { lines: CLI_MAX_RETURNED_OUTPUT_LINES },
				reasons: { bytes: false, lines: true },
			});
		}
		await cleanupResults([head, tail]);
	});

	it("uses streaming UTF-8 decoding and preserves invalid-byte accounting", async () => {
		const split = await runFake(root, ["split-utf8"]);
		const invalid = await runFake(root, ["invalid-utf8"]);
		const oversized = await runFake(root, ["unicode", "20000", "stdout"], {}, { outputStrategy: "tail" });

		expect(split.stdout).toBe("A€B");
		expect(split.truncation.stdout).toMatchObject({ rawBytesReceived: 5, original: { bytes: 5, lines: 1 } });
		expect(invalid.stdout).toBe("f�o");
		expect(invalid.truncation.stdout).toMatchObject({ rawBytesReceived: 3, original: { bytes: 5, lines: 1 } });
		expect(oversized.stdout).toBe("€".repeat(CLI_MAX_RETURNED_OUTPUT_BYTES / 3));
		expect(Buffer.byteLength(oversized.stdout)).toBe(CLI_MAX_RETURNED_OUTPUT_BYTES);
		expect(oversized.stdout).not.toContain("�");
		expect(oversized.truncation.boundaryLinePartial).toBe(true);
		await cleanupResults([oversized]);
	});

	for (const strategy of ["head", "tail"] as const) {
		it(`is invariant to UTF-8 chunking and stream scheduling for ${strategy}`, async () => {
			const fixtureArguments = ["chunked-generated", "A€B", "36000", "xβy", "36000"] as const;
			const singleWrites = await runFake(
				root,
				[...fixtureArguments, "65536", "65536", "stdout-first"],
				{},
				{ outputStrategy: strategy },
			);
			const byteWrites = await runFake(
				root,
				[...fixtureArguments, "1", "1", "stderr-first"],
				{},
				{ outputStrategy: strategy },
			);
			const staggered = await runFake(
				root,
				[...fixtureArguments, "7", "11", "concurrent"],
				{},
				{ outputStrategy: strategy },
			);

			expect(stableProjection(byteWrites)).toEqual(stableProjection(singleWrites));
			expect(stableProjection(staggered)).toEqual(stableProjection(singleWrites));
			expect(singleWrites.stdout).not.toContain("�");
			expect(singleWrites.stderr).not.toContain("�");
			await cleanupResults([singleWrites, byteWrites, staggered]);
		});
	}

	async function cleanupResults(results: readonly CliExecutionResult[]): Promise<void> {
		for (const result of results) {
			if (result.spool.status !== "not_needed") await removeCliOutputSpool(result.spool);
		}
	}
});

function stableProjection(result: CliExecutionResult): unknown {
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		truncation: result.truncation,
		capture: result.capture,
		spool: {
			status: result.spool.status,
			bytesWritten: result.spool.bytesWritten,
			maxBytes: result.spool.maxBytes,
			error: result.spool.error,
			cleanupError: result.spool.cleanupError,
		},
	};
}
