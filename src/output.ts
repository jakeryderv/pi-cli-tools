import { StringDecoder } from "node:string_decoder";

import { CLI_MAX_RETURNED_OUTPUT_BYTES, CLI_MAX_RETURNED_OUTPUT_LINES } from "./limits.js";
import type { CliOutputExtent, CliOutputStrategy, CliOutputTruncation, CliStreamOutputStats } from "./types.js";

interface TextSelection {
	text: string;
	extent: CliOutputExtent;
	consumedAll: boolean;
	boundaryLinePartial: boolean;
}

interface StreamProjection {
	text: string;
	stats: CliStreamOutputStats;
	boundaryLinePartial: boolean;
}

export interface OutputProjection {
	stdout: string;
	stderr: string;
	truncation: CliOutputTruncation;
}

/** Streaming, bounded stdout/stderr text projection under one deterministic budget. */
export class CombinedOutputCollector {
	readonly #stdout: StreamTextCollector;
	readonly #stderr: StreamTextCollector;
	readonly #strategy: CliOutputStrategy;
	readonly #maxBytes: number;
	readonly #maxLines: number;
	#finished: OutputProjection | null = null;

	constructor(
		strategy: CliOutputStrategy,
		limits: { readonly maxBytes: number; readonly maxLines: number } = {
			maxBytes: CLI_MAX_RETURNED_OUTPUT_BYTES,
			maxLines: CLI_MAX_RETURNED_OUTPUT_LINES,
		},
	) {
		this.#strategy = strategy;
		this.#maxBytes = limits.maxBytes;
		this.#maxLines = limits.maxLines;
		this.#stdout = new StreamTextCollector(strategy, limits.maxBytes, limits.maxLines);
		this.#stderr = new StreamTextCollector(strategy, limits.maxBytes, limits.maxLines);
	}

	add(stream: "stdout" | "stderr", chunk: Buffer): boolean {
		this.#getStream(stream).add(chunk);
		return this.truncated;
	}

	get truncated(): boolean {
		const original = addExtents(this.#stdout.originalExtent, this.#stderr.originalExtent);
		return original.bytes > this.#maxBytes || original.lines > this.#maxLines;
	}

	finish(): OutputProjection {
		if (this.#finished) return this.#finished;
		this.#stdout.end();
		this.#stderr.end();

		let remainingBytes = this.#maxBytes;
		let remainingLines = this.#maxLines;
		const projections = new Map<"stdout" | "stderr", StreamProjection>();
		const order: readonly ("stdout" | "stderr")[] =
			this.#strategy === "head" ? ["stdout", "stderr"] : ["stderr", "stdout"];

		for (const streamName of order) {
			const stream = this.#getStream(streamName);
			const selected = selectText(stream.reservoir, this.#strategy, remainingBytes, remainingLines);
			remainingBytes -= selected.extent.bytes;
			remainingLines -= selected.extent.lines;
			const original = stream.originalExtent;
			const reservoirExtent = measureText(stream.reservoir);
			const reservoirTruncated = exceedsExtent(original, reservoirExtent);
			projections.set(streamName, {
				text: selected.text,
				stats: {
					rawBytesReceived: stream.rawBytesReceived,
					original,
					returned: selected.extent,
					truncated: exceedsExtent(original, selected.extent),
				},
				boundaryLinePartial: selected.consumedAll
					? reservoirTruncated && selected.text.length > 0 && stream.boundaryLinePartial
					: selected.boundaryLinePartial,
			});
		}

		const stdout = projections.get("stdout") ?? emptyStreamProjection(this.#stdout.rawBytesReceived);
		const stderr = projections.get("stderr") ?? emptyStreamProjection(this.#stderr.rawBytesReceived);
		const original = addExtents(stdout.stats.original, stderr.stats.original);
		const returned = addExtents(stdout.stats.returned, stderr.stats.returned);
		const reasons = {
			bytes: original.bytes > this.#maxBytes,
			lines: original.lines > this.#maxLines,
		};

		this.#finished = {
			stdout: stdout.text,
			stderr: stderr.text,
			truncation: {
				truncated: reasons.bytes || reasons.lines,
				strategy: this.#strategy,
				limits: {
					bytes: this.#maxBytes,
					lines: this.#maxLines,
				},
				original,
				returned,
				reasons,
				stdout: stdout.stats,
				stderr: stderr.stats,
				boundaryLinePartial: stdout.boundaryLinePartial || stderr.boundaryLinePartial,
			},
		};
		return this.#finished;
	}

	#getStream(stream: "stdout" | "stderr"): StreamTextCollector {
		return stream === "stdout" ? this.#stdout : this.#stderr;
	}
}

class StreamTextCollector {
	readonly #decoder = new StringDecoder("utf8");
	readonly #strategy: CliOutputStrategy;
	readonly #maxBytes: number;
	readonly #maxLines: number;
	#ended = false;
	#originalBytes = 0;
	#newlineCount = 0;
	#hasText = false;
	#endsWithNewline = false;
	#reservoir = "";
	#boundaryLinePartial = false;
	#headSaturated = false;
	rawBytesReceived = 0;

	constructor(strategy: CliOutputStrategy, maxBytes: number, maxLines: number) {
		this.#strategy = strategy;
		this.#maxBytes = maxBytes;
		this.#maxLines = maxLines;
	}

	get reservoir(): string {
		return this.#reservoir;
	}

	get boundaryLinePartial(): boolean {
		return this.#boundaryLinePartial;
	}

	get originalExtent(): CliOutputExtent {
		return {
			bytes: this.#originalBytes,
			lines: this.#hasText ? this.#newlineCount + (this.#endsWithNewline ? 0 : 1) : 0,
		};
	}

	add(chunk: Buffer): void {
		if (this.#ended) return;
		this.rawBytesReceived += chunk.byteLength;
		this.#processDecoded(this.#decoder.write(chunk));
	}

	end(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#processDecoded(this.#decoder.end());
	}

	#processDecoded(text: string): void {
		if (text.length === 0) return;
		this.#originalBytes += Buffer.byteLength(text, "utf8");
		this.#newlineCount += countNewlines(text);
		this.#hasText = true;
		this.#endsWithNewline = text.endsWith("\n");
		if (this.#strategy === "head" && this.#headSaturated) return;

		const selected = selectText(`${this.#reservoir}${text}`, this.#strategy, this.#maxBytes, this.#maxLines);
		this.#reservoir = selected.text;
		if (!selected.consumedAll) {
			this.#boundaryLinePartial = selected.boundaryLinePartial;
			if (this.#strategy === "head") this.#headSaturated = true;
		}
	}
}

function selectText(text: string, strategy: CliOutputStrategy, maxBytes: number, maxLines: number): TextSelection {
	return strategy === "head" ? selectTextHead(text, maxBytes, maxLines) : selectTextTail(text, maxBytes, maxLines);
}

function selectTextHead(text: string, maxBytes: number, maxLines: number): TextSelection {
	const characters: string[] = [];
	let bytes = 0;
	let newlines = 0;
	let endsWithNewline = false;
	let consumedCharacters = 0;
	let boundaryLinePartial = false;

	for (const character of text) {
		const nextBytes = bytes + Buffer.byteLength(character, "utf8");
		const nextNewlines = newlines + (character === "\n" ? 1 : 0);
		const nextEndsWithNewline = character === "\n";
		const nextLines = nextNewlines + (nextEndsWithNewline ? 0 : 1);
		if (nextBytes > maxBytes || nextLines > maxLines) {
			boundaryLinePartial = nextBytes > maxBytes && characters.length > 0 && !endsWithNewline;
			break;
		}
		characters.push(character);
		bytes = nextBytes;
		newlines = nextNewlines;
		endsWithNewline = nextEndsWithNewline;
		consumedCharacters += character.length;
	}

	const selected = characters.join("");
	return {
		text: selected,
		extent: { bytes, lines: selected.length === 0 ? 0 : newlines + (endsWithNewline ? 0 : 1) },
		consumedAll: consumedCharacters === text.length,
		boundaryLinePartial,
	};
}

function selectTextTail(text: string, maxBytes: number, maxLines: number): TextSelection {
	const source = Array.from(text);
	const characters: string[] = [];
	let bytes = 0;
	let newlines = 0;
	let endsWithNewline = false;
	let boundaryLinePartial = false;
	let consumed = 0;

	for (let index = source.length - 1; index >= 0; index -= 1) {
		const character = source[index];
		if (character === undefined) continue;
		const nextBytes = bytes + Buffer.byteLength(character, "utf8");
		const nextNewlines = newlines + (character === "\n" ? 1 : 0);
		const nextEndsWithNewline: boolean = consumed === 0 ? character === "\n" : endsWithNewline;
		const nextLines = nextNewlines + (nextEndsWithNewline ? 0 : 1);
		if (nextBytes > maxBytes || nextLines > maxLines) {
			boundaryLinePartial = nextBytes > maxBytes && characters.length > 0 && character !== "\n";
			break;
		}
		characters.push(character);
		bytes = nextBytes;
		newlines = nextNewlines;
		endsWithNewline = nextEndsWithNewline;
		consumed += 1;
	}

	characters.reverse();
	const selected = characters.join("");
	return {
		text: selected,
		extent: { bytes, lines: selected.length === 0 ? 0 : newlines + (endsWithNewline ? 0 : 1) },
		consumedAll: consumed === source.length,
		boundaryLinePartial,
	};
}

function measureText(text: string): CliOutputExtent {
	if (text.length === 0) return { bytes: 0, lines: 0 };
	const newlines = countNewlines(text);
	return {
		bytes: Buffer.byteLength(text, "utf8"),
		lines: newlines + (text.endsWith("\n") ? 0 : 1),
	};
}

function countNewlines(text: string): number {
	let count = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) === 10) count += 1;
	}
	return count;
}

function addExtents(left: CliOutputExtent, right: CliOutputExtent): CliOutputExtent {
	return { bytes: left.bytes + right.bytes, lines: left.lines + right.lines };
}

function exceedsExtent(original: CliOutputExtent, returned: CliOutputExtent): boolean {
	return original.bytes > returned.bytes || original.lines > returned.lines;
}

function emptyStreamProjection(rawBytesReceived: number): StreamProjection {
	return {
		text: "",
		stats: {
			rawBytesReceived,
			original: { bytes: 0, lines: 0 },
			returned: { bytes: 0, lines: 0 },
			truncated: false,
		},
		boundaryLinePartial: false,
	};
}
