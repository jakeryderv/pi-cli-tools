import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { access, chmod, lstat, mkdtemp, open, readdir, rm, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { hasErrorCode, toErrorDetails } from "./errors.js";
import {
	CLI_MAX_RETAINED_SPOOL_BYTES,
	CLI_MAX_RETAINED_SPOOL_DIRECTORIES,
	CLI_MAX_SPOOL_PAYLOAD_BYTES,
	CLI_SPOOL_DISK_RESERVATION_BYTES,
} from "./limits.js";
import type { CliErrorDetails, CliOutputSpool } from "./types.js";

const SPOOL_DIRECTORY_PREFIX = "pi-cli-tools-output-";

type OutputStreamName = "stdout" | "stderr";

interface SpoolReceivedBytes {
	stdout: number;
	stderr: number;
}

interface QuotaReservation {
	parentDirectory: string;
	released: boolean;
}

const activeReservations = new Map<string, number>();
let quotaLock: Promise<void> = Promise.resolve();

/** Lazy, bounded raw-output capture. No filesystem object is created unless retention becomes necessary. */
export class RawOutputSpool {
	readonly #parentDirectory: string;
	readonly #prefix: Record<OutputStreamName, Buffer[]> = { stdout: [], stderr: [] };
	readonly #writtenByStream: SpoolReceivedBytes = { stdout: 0, stderr: 0 };
	#inputs: { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream } | null = null;
	#directory: string | null = null;
	#stdoutPath: string | null = null;
	#stderrPath: string | null = null;
	#stdoutWriter: WriteStream | null = null;
	#stderrWriter: WriteStream | null = null;
	#activation: Promise<void> | null = null;
	#ready = false;
	#preparationError: CliErrorDetails | null = null;
	#writerError: CliErrorDetails | null = null;
	#reservation: QuotaReservation | null = null;
	#bytesWritten = 0;
	#capped = false;
	#finished = false;
	#paused = false;

	constructor(parentDirectory: string) {
		this.#parentDirectory = parentDirectory;
	}

	attachInputs(stdout: NodeJS.ReadableStream, stderr: NodeJS.ReadableStream): void {
		this.#inputs = { stdout, stderr };
	}

	capture(stream: OutputStreamName, chunk: Buffer, retainRequested: boolean): void {
		if (this.#finished) return;
		if (!this.#activation || !this.#ready) {
			this.#prefix[stream].push(chunk);
			if (retainRequested) this.#startActivation();
			return;
		}
		if (!this.#preparationError) this.#write(stream, chunk);
	}

	async finish(retain: boolean, captureComplete: boolean, received: SpoolReceivedBytes): Promise<CliOutputSpool> {
		if (this.#finished) throw new Error("Output spool was finalized more than once");
		if (!retain) {
			this.#finished = true;
			this.#prefix.stdout.length = 0;
			this.#prefix.stderr.length = 0;
			return createNotNeededSpool();
		}

		this.#startActivation();
		await this.#activation;
		this.#finished = true;
		this.#resumeInputs();

		try {
			await Promise.all([endWriteStream(this.#stdoutWriter), endWriteStream(this.#stderrWriter)]);
			if (this.#preparationError) {
				return createFailedSpool(0, this.#preparationError, await this.#existingPaths());
			}
			if (this.#writerError || !this.#directory || !this.#stdoutPath || !this.#stderrPath) {
				return createFailedSpool(
					this.#bytesWritten,
					this.#writerError ?? toErrorDetails(new Error("Output spool is incomplete")),
					await this.#existingPaths(),
				);
			}

			const status = this.#capped || !captureComplete ? "partial" : "complete";
			const outputPath = join(this.#directory, status === "complete" ? "full-output.log" : "partial-output.log");
			try {
				await recoverPermissions(this.#directory);
				await assembleSpoolFile(
					outputPath,
					this.#stdoutPath,
					this.#stderrPath,
					received,
					this.#writtenByStream,
					status,
				);
			} catch (error) {
				return createFailedSpool(this.#bytesWritten, toErrorDetails(error), await this.#existingPaths(outputPath));
			}

			const cleanupError = await removeSidecars([this.#stdoutPath, this.#stderrPath]);
			return {
				status,
				path: outputPath,
				bytesWritten: this.#bytesWritten,
				maxBytes: CLI_MAX_SPOOL_PAYLOAD_BYTES,
				error: null,
				retainedPaths: await this.#existingPaths(outputPath),
				cleanupError,
			};
		} finally {
			this.#releaseReservation();
		}
	}

	#startActivation(): void {
		if (this.#activation) return;
		this.#pauseInputs();
		this.#activation = this.#prepareAndFlush().finally(() => {
			this.#resumeInputs();
		});
	}

	async #prepareAndFlush(): Promise<void> {
		try {
			this.#reservation = await reserveQuota(this.#parentDirectory);
			this.#directory = await mkdtemp(join(this.#parentDirectory, SPOOL_DIRECTORY_PREFIX));
			await chmod(this.#directory, 0o700);
			this.#stdoutPath = join(this.#directory, "stdout.raw");
			this.#stderrPath = join(this.#directory, "stderr.raw");
			this.#stdoutWriter = await openWriteStream(this.#stdoutPath);
			this.#stderrWriter = await openWriteStream(this.#stderrPath);
			this.#stdoutWriter.on("error", (error) => {
				this.#handleWriterError(error);
			});
			this.#stderrWriter.on("error", (error) => {
				this.#handleWriterError(error);
			});
			while (this.#prefix.stdout.length > 0 || this.#prefix.stderr.length > 0) {
				await this.#flushPrefix("stdout", this.#stdoutWriter);
				await this.#flushPrefix("stderr", this.#stderrWriter);
			}
			this.#ready = true;
		} catch (error) {
			this.#preparationError = toErrorDetails(error);
			this.#stdoutWriter?.destroy();
			this.#stderrWriter?.destroy();
			this.#prefix.stdout.length = 0;
			this.#prefix.stderr.length = 0;
		}
	}

	async #flushPrefix(stream: OutputStreamName, writer: WriteStream): Promise<void> {
		const chunks = this.#prefix[stream].splice(0);
		for (const chunk of chunks) {
			if (!this.#write(stream, chunk, true)) await waitForDrain(writer);
			if (this.#writerError) break;
		}
	}

	#write(stream: OutputStreamName, chunk: Buffer, flushing = false): boolean {
		if (this.#writerError || this.#preparationError) return true;
		const writer = stream === "stdout" ? this.#stdoutWriter : this.#stderrWriter;
		if (!writer) return true;

		const available = CLI_MAX_SPOOL_PAYLOAD_BYTES - this.#bytesWritten;
		if (available <= 0) {
			this.#capped = true;
			return true;
		}
		const bytesToWrite = Math.min(available, chunk.byteLength);
		if (bytesToWrite < chunk.byteLength) this.#capped = true;
		if (bytesToWrite === 0) return true;

		const accepted = writer.write(bytesToWrite === chunk.byteLength ? chunk : chunk.subarray(0, bytesToWrite));
		this.#bytesWritten += bytesToWrite;
		this.#writtenByStream[stream] += bytesToWrite;
		if (!accepted && !flushing) this.#pauseUntilDrain(writer);
		return accepted;
	}

	#pauseUntilDrain(writer: WriteStream): void {
		this.#pauseInputs();
		writer.once("drain", () => {
			this.#resumeInputs();
		});
	}

	#pauseInputs(): void {
		if (this.#paused) return;
		this.#paused = true;
		this.#inputs?.stdout.pause();
		this.#inputs?.stderr.pause();
	}

	#resumeInputs(): void {
		if (!this.#paused) return;
		this.#paused = false;
		this.#inputs?.stdout.resume();
		this.#inputs?.stderr.resume();
	}

	#handleWriterError(error: unknown): void {
		this.#writerError ??= toErrorDetails(error);
		this.#resumeInputs();
	}

	async #existingPaths(additionalPath?: string): Promise<string[]> {
		const candidates = [additionalPath, this.#stdoutPath, this.#stderrPath, this.#directory].filter(
			(path): path is string => Boolean(path),
		);
		const existing: string[] = [];
		for (const path of candidates) {
			try {
				await access(path);
				existing.push(path);
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT")) existing.push(path);
			}
		}
		return [...new Set(existing)];
	}

	#releaseReservation(): void {
		if (!this.#reservation || this.#reservation.released) return;
		this.#reservation.released = true;
		const current = activeReservations.get(this.#reservation.parentDirectory) ?? 0;
		if (current <= CLI_SPOOL_DISK_RESERVATION_BYTES) activeReservations.delete(this.#reservation.parentDirectory);
		else activeReservations.set(this.#reservation.parentDirectory, current - CLI_SPOOL_DISK_RESERVATION_BYTES);
	}
}

/** Remove package-owned retained output represented by a runner result. */
export async function removeCliOutputSpool(spool: CliOutputSpool): Promise<void> {
	const directories = new Set<string>();
	for (const path of spool.retainedPaths) {
		const candidate = basename(path).startsWith(SPOOL_DIRECTORY_PREFIX) ? path : dirname(path);
		if (!basename(candidate).startsWith(SPOOL_DIRECTORY_PREFIX)) {
			throw new Error(`Refusing to remove a non-package spool path: ${path}`);
		}
		directories.add(candidate);
	}

	for (const directory of directories) {
		await recoverPermissions(directory);
		await rm(directory, { force: true, recursive: true });
	}
}

function createNotNeededSpool(): CliOutputSpool {
	return {
		status: "not_needed",
		path: null,
		bytesWritten: 0,
		maxBytes: CLI_MAX_SPOOL_PAYLOAD_BYTES,
		error: null,
		retainedPaths: [],
		cleanupError: null,
	};
}

function createFailedSpool(bytesWritten: number, error: CliErrorDetails, retainedPaths: string[]): CliOutputSpool {
	return {
		status: "failed",
		path: null,
		bytesWritten,
		maxBytes: CLI_MAX_SPOOL_PAYLOAD_BYTES,
		error,
		retainedPaths,
		cleanupError: null,
	};
}

async function reserveQuota(parentDirectory: string): Promise<QuotaReservation> {
	const normalizedParent = resolve(parentDirectory);
	let releaseLock: (() => void) | undefined;
	const previousLock = quotaLock;
	quotaLock = new Promise<void>((resolveLock) => {
		releaseLock = resolveLock;
	});
	await previousLock;

	try {
		const retained = await measureRetainedUsage(normalizedParent);
		const activeBytes = activeReservations.get(normalizedParent) ?? 0;
		const activeCount = Math.ceil(activeBytes / CLI_SPOOL_DISK_RESERVATION_BYTES);
		if (
			retained.bytes + activeBytes + CLI_SPOOL_DISK_RESERVATION_BYTES > CLI_MAX_RETAINED_SPOOL_BYTES ||
			retained.directories + activeCount >= CLI_MAX_RETAINED_SPOOL_DIRECTORIES
		) {
			const error = new Error(
				`Retained CLI output quota (${String(CLI_MAX_RETAINED_SPOOL_BYTES)} bytes or ${String(CLI_MAX_RETAINED_SPOOL_DIRECTORIES)} directories) would be exceeded`,
			) as NodeJS.ErrnoException;
			error.code = "ENOSPC";
			throw error;
		}
		activeReservations.set(normalizedParent, activeBytes + CLI_SPOOL_DISK_RESERVATION_BYTES);
		return { parentDirectory: normalizedParent, released: false };
	} finally {
		releaseLock?.();
	}
}

async function measureRetainedUsage(parentDirectory: string): Promise<{ bytes: number; directories: number }> {
	const entries = await readdir(parentDirectory, { withFileTypes: true });
	let bytes = 0;
	let directories = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(SPOOL_DIRECTORY_PREFIX)) continue;
		directories += 1;
		bytes += await measurePathBytes(join(parentDirectory, entry.name));
		if (bytes > CLI_MAX_RETAINED_SPOOL_BYTES || directories >= CLI_MAX_RETAINED_SPOOL_DIRECTORIES) break;
	}
	return { bytes, directories };
}

async function measurePathBytes(path: string): Promise<number> {
	const metadata = await lstat(path);
	if (!metadata.isDirectory()) return metadata.size;
	let total = 0;
	for (const entry of await readdir(path)) total += await measurePathBytes(join(path, entry));
	return total;
}

async function openWriteStream(path: string): Promise<WriteStream> {
	const writer = createWriteStream(path, { flags: "wx", mode: 0o600 });
	await new Promise<void>((resolveOpen, reject) => {
		const onOpen = (): void => {
			writer.off("error", onError);
			resolveOpen();
		};
		const onError = (error: Error): void => {
			writer.off("open", onOpen);
			reject(error);
		};
		writer.once("open", onOpen);
		writer.once("error", onError);
	});
	return writer;
}

async function waitForDrain(writer: WriteStream): Promise<void> {
	if (writer.destroyed || !writer.writableNeedDrain) return;
	await new Promise<void>((resolveDrain) => {
		writer.once("drain", resolveDrain);
		writer.once("error", () => {
			resolveDrain();
		});
	});
}

async function endWriteStream(writer: WriteStream | null): Promise<void> {
	if (!writer || writer.closed) return;
	await new Promise<void>((resolveClose) => {
		writer.once("close", resolveClose);
		writer.end();
	});
}

async function assembleSpoolFile(
	outputPath: string,
	stdoutPath: string,
	stderrPath: string,
	received: SpoolReceivedBytes,
	written: SpoolReceivedBytes,
	status: "complete" | "partial",
): Promise<void> {
	const output = await open(outputPath, "wx", 0o600);
	try {
		await writeAll(output, Buffer.from(createSpoolHeader("stdout", received.stdout, written.stdout, status)));
		await copyFileInto(stdoutPath, output);
		await writeAll(output, Buffer.from(`\n${createSpoolHeader("stderr", received.stderr, written.stderr, status)}`));
		await copyFileInto(stderrPath, output);
	} finally {
		await output.close();
	}
	await chmod(outputPath, 0o600);
}

function createSpoolHeader(
	stream: OutputStreamName,
	received: number,
	written: number,
	status: "complete" | "partial",
): string {
	const extent =
		status === "complete"
			? `${String(received)} raw bytes`
			: `${String(received)} raw bytes; ${String(written)} spooled`;
	return `===== ${stream} (${extent}) =====\n`;
}

async function copyFileInto(path: string, destination: FileHandle): Promise<void> {
	for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) await writeAll(destination, chunk);
}

async function writeAll(destination: FileHandle, bytes: Buffer): Promise<void> {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const result = await destination.write(bytes, offset, bytes.byteLength - offset);
		offset += result.bytesWritten;
	}
}

async function removeSidecars(paths: readonly string[]): Promise<CliErrorDetails | null> {
	let firstError: CliErrorDetails | null = null;
	for (const path of paths) {
		try {
			await unlink(path);
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) firstError ??= toErrorDetails(error);
		}
	}
	return firstError;
}

async function recoverPermissions(directory: string): Promise<void> {
	try {
		await chmod(directory, 0o700);
		for (const entry of await readdir(directory)) await chmod(join(directory, entry), 0o600).catch(() => undefined);
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) throw error;
	}
}
