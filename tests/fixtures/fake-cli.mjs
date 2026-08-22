import { spawn } from "node:child_process";
import { once } from "node:events";
import { rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(import.meta.url);
const [mode, ...args] = process.argv.slice(2);

switch (mode) {
	case "inspect": {
		const environmentName = args.shift() ?? "RUNNER_SENTINEL";
		process.stdin.resume();
		await once(process.stdin, "end");
		process.stdout.write(
			JSON.stringify({
				args,
				cwd: process.cwd(),
				environmentValue: process.env[environmentName] ?? null,
				environment: Object.fromEntries(
					Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right)),
				),
				stdinEnded: true,
				tty: {
					stdin: Boolean(process.stdin.isTTY),
					stdout: Boolean(process.stdout.isTTY),
					stderr: Boolean(process.stderr.isTTY),
				},
			}),
		);
		break;
	}
	case "streams": {
		process.stdout.write(Buffer.from(args[0] ?? "", "base64"));
		process.stderr.write(Buffer.from(args[1] ?? "", "base64"));
		break;
	}
	case "exit": {
		process.exitCode = Number(args[0] ?? "0");
		break;
	}
	case "signal": {
		process.kill(process.pid, args[0] ?? "SIGTERM");
		break;
	}
	case "marker": {
		const path = args.shift();
		if (!path) throw new Error("marker path is required");
		await writeFile(path, "launched", "utf8");
		process.stdout.write(JSON.stringify(args));
		break;
	}
	case "tree": {
		await startTree(args, { detachedDescendant: false, inheritOutput: false });
		break;
	}
	case "tree-escape": {
		await startTree(args, { detachedDescendant: true, inheritOutput: false });
		break;
	}
	case "tree-escaped-pipes": {
		await startTree(args, { detachedDescendant: true, inheritOutput: true });
		break;
	}
	case "descendant": {
		if (args[0] === "ignore") process.on("SIGTERM", () => undefined);
		setInterval(() => undefined, 1_000);
		break;
	}
	case "exit-with-open-pipes": {
		await exitWithOpenPipes(args, false);
		break;
	}
	case "exit-with-escaped-open-pipes": {
		await exitWithOpenPipes(args, true);
		break;
	}
	case "bytes": {
		const stdoutBytes = Number(args[0] ?? "0");
		const stderrBytes = Number(args[1] ?? "0");
		await Promise.all([
			writeRepeated(process.stdout, Buffer.from(args[2] ?? "o"), stdoutBytes),
			writeRepeated(process.stderr, Buffer.from(args[3] ?? "e"), stderrBytes),
		]);
		break;
	}
	case "lines": {
		const stdoutLines = Number(args[0] ?? "0");
		const stderrLines = Number(args[1] ?? "0");
		await Promise.all([
			writeLines(process.stdout, "stdout", stdoutLines),
			writeLines(process.stderr, "stderr", stderrLines),
		]);
		break;
	}
	case "bytes-wait": {
		const outputBytes = Number(args[0] ?? "0");
		const readyPath = args[1];
		if (!readyPath) throw new Error("ready path is required");
		await writeRepeated(process.stdout, Buffer.from("W"), outputBytes);
		await writeFile(readyPath, String(process.pid), "utf8");
		setInterval(() => undefined, 1_000);
		break;
	}
	case "chunked-generated": {
		const stdout = repeatedBuffer(Buffer.from(args[0] ?? "stdout"), Number(args[1] ?? "0"));
		const stderr = repeatedBuffer(Buffer.from(args[2] ?? "stderr"), Number(args[3] ?? "0"));
		const stdoutChunkSize = Number(args[4] ?? "65536");
		const stderrChunkSize = Number(args[5] ?? "65536");
		const schedule = args[6] ?? "concurrent";
		if (schedule === "stdout-first") {
			await writeChunks(process.stdout, stdout, stdoutChunkSize);
			await writeChunks(process.stderr, stderr, stderrChunkSize);
		} else if (schedule === "stderr-first") {
			await writeChunks(process.stderr, stderr, stderrChunkSize);
			await writeChunks(process.stdout, stdout, stdoutChunkSize);
		} else {
			await Promise.all([
				writeChunks(process.stdout, stdout, stdoutChunkSize),
				writeChunks(process.stderr, stderr, stderrChunkSize),
			]);
		}
		break;
	}
	case "unicode": {
		const count = Number(args[0] ?? "0");
		const stream = args[1] === "stderr" ? process.stderr : process.stdout;
		await writeRepeated(stream, Buffer.from("€"), count * Buffer.byteLength("€"));
		break;
	}
	case "split-utf8": {
		const bytes = Buffer.from("A€B");
		process.stdout.write(bytes.subarray(0, 2));
		await new Promise((resolve) => setImmediate(resolve));
		process.stdout.write(bytes.subarray(2));
		break;
	}
	case "invalid-utf8": {
		process.stdout.write(Buffer.from([0x66, 0x80, 0x6f]));
		break;
	}
	case "raw-repeat": {
		const pattern = Buffer.from(args[0] ?? "80", "hex");
		const bytes = Number(args[1] ?? "0");
		const stream = args[2] === "stderr" ? process.stderr : process.stdout;
		await writeRepeated(stream, pattern, bytes);
		break;
	}
	default:
		throw new Error(`unknown fake CLI mode: ${String(mode)}`);
}

async function startTree(treeArgs, options) {
	const readyPath = treeArgs[0];
	const ignoreTermination = treeArgs[1] === "ignore";
	if (!readyPath) throw new Error("ready path is required");
	const descendant = spawn(process.execPath, [fixturePath, "descendant", treeArgs[1] ?? "exit"], {
		detached: options.detachedDescendant,
		stdio: options.inheritOutput ? ["ignore", "inherit", "inherit"] : "ignore",
	});
	if (options.detachedDescendant) descendant.unref();
	if (ignoreTermination) process.on("SIGTERM", () => undefined);
	await writeReady(readyPath, descendant.pid);
	setInterval(() => undefined, 1_000);
}

async function exitWithOpenPipes(exitArgs, detachedDescendant) {
	const readyPath = exitArgs[0];
	if (!readyPath) throw new Error("ready path is required");
	const descendant = spawn(process.execPath, [fixturePath, "descendant", "exit"], {
		detached: detachedDescendant,
		stdio: ["ignore", "inherit", "inherit"],
	});
	descendant.unref();
	await writeReady(readyPath, descendant.pid);
}

async function writeReady(path, descendantPid) {
	const temporaryPath = `${path}.${String(process.pid)}.tmp`;
	await writeFile(temporaryPath, JSON.stringify({ parentPid: process.pid, descendantPid }), "utf8");
	await rename(temporaryPath, path);
}

async function writeRepeated(stream, pattern, totalBytes) {
	if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || pattern.byteLength === 0) {
		throw new Error("invalid repeated-output request");
	}
	const block = repeatedBuffer(pattern, Math.min(64 * 1024, Math.max(pattern.byteLength, totalBytes)));
	let remaining = totalBytes;
	while (remaining > 0) {
		const chunk = block.subarray(0, Math.min(block.byteLength, remaining));
		if (!stream.write(chunk)) await once(stream, "drain");
		remaining -= chunk.byteLength;
	}
}

function repeatedBuffer(pattern, totalBytes) {
	if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || pattern.byteLength === 0) {
		throw new Error("invalid repeated-buffer request");
	}
	const buffer = Buffer.allocUnsafe(totalBytes);
	for (let offset = 0; offset < buffer.byteLength; offset += pattern.byteLength) {
		pattern.copy(buffer, offset, 0, Math.min(pattern.byteLength, buffer.byteLength - offset));
	}
	return buffer;
}

async function writeChunks(stream, bytes, chunkSize) {
	if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error("invalid chunk size");
	for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
		if (!stream.write(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)))) {
			await once(stream, "drain");
		}
	}
}

async function writeLines(stream, prefix, count) {
	for (let index = 0; index < count; index += 1) {
		if (!stream.write(`${prefix}-${String(index).padStart(4, "0")}\n`)) await once(stream, "drain");
	}
}
