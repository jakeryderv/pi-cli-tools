import { createHash } from "node:crypto";

import { Parser } from "htmlparser2";

import { hashCanonicalValue } from "./cache.js";
import { sanitizeLocalDocumentationText } from "./introspect.js";
import {
	CLI_OFFICIAL_AGGREGATE_TIMEOUT_MS,
	CLI_OFFICIAL_CACHE_MAX_BYTES,
	CLI_OFFICIAL_CACHE_MAX_ENTRIES,
	CLI_OFFICIAL_CACHE_MAX_FLIGHTS,
	CLI_OFFICIAL_CACHE_TTL_MS,
	CLI_OFFICIAL_MAX_AGGREGATE_BODY_BYTES,
	CLI_OFFICIAL_MAX_BODY_BYTES,
	CLI_OFFICIAL_MAX_EXCERPT_BYTES,
	CLI_OFFICIAL_MAX_EXCERPT_LINES,
	CLI_OFFICIAL_MAX_HTTP_HOPS,
	CLI_OFFICIAL_MAX_QUERY_BYTES,
	CLI_OFFICIAL_MAX_QUERY_TERMS,
	CLI_OFFICIAL_MAX_SNIPPET_BYTES,
	CLI_OFFICIAL_MAX_SNIPPET_LINES,
	CLI_OFFICIAL_MAX_SNIPPETS,
	CLI_OFFICIAL_MAX_TEXT_BYTES,
	CLI_OFFICIAL_MAX_TEXT_LINES,
} from "./limits.js";
import { findStrictSemvers, parseStrictSemver } from "./semver.js";
import {
	SecureFetchError,
	SecureHttpsTransport,
	fetchAuthoritativeDocument,
	type OfficialHttpHopBudget,
	type SecureFetchResponse,
} from "./secure-fetch.js";
import type {
	InstalledVersionEvidence,
	OfficialDocumentationAlignment,
	OfficialDocumentationCacheStatus,
	OfficialDocumentationFailureCode,
	OfficialDocumentationProvenance,
	OfficialDocumentationRequest,
	OfficialDocumentationResult,
	OfficialDocumentationSnippet,
	OfficialDocumentationSource,
	OfficialDocumentationSourceOutcome,
} from "./types.js";

export interface OfficialDocumentationCacheStats {
	readonly entries: number;
	readonly bytes: number;
	readonly inFlight: number;
	readonly hits: number;
	readonly misses: number;
	readonly deduplicated: number;
	readonly evictions: number;
}

interface CachedDocument {
	readonly text: string;
	readonly configuredUrl: string;
	readonly finalUrl: string;
	readonly redirects: readonly string[];
	readonly mediaType: string;
	readonly bodySha256: string;
	readonly bodyBytes: number;
	readonly textSha256: string;
	readonly retrievedAt: string;
	readonly cache: OfficialDocumentationCacheStatus;
}

interface CacheEntry {
	readonly document: CachedDocument;
	readonly bytes: number;
	readonly expiresAt: number;
}

interface CacheFlight {
	readonly controller: AbortController;
	readonly waiters: Set<symbol>;
	readonly promise: Promise<CachedDocument>;
}

export class OfficialDocumentationRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OfficialDocumentationRequestError";
	}
}

class OfficialDocumentationCacheConcurrencyError extends Error {
	constructor() {
		super("Official documentation concurrent-flight limit reached");
		this.name = "OfficialDocumentationCacheConcurrencyError";
	}
}

class OfficialDocumentationWaiterCancelledError extends Error {
	constructor() {
		super("Official documentation waiter cancelled");
		this.name = "OfficialDocumentationWaiterCancelledError";
	}
}

/** Session-memory success-only LRU with TTL, clone boundaries, and waiter-aware flights. */
export class OfficialDocumentationCache {
	readonly #entries = new Map<string, CacheEntry>();
	readonly #flights = new Map<string, CacheFlight>();
	readonly #tracked = new Set<CacheFlight>();
	readonly #maxEntries: number;
	readonly #maxBytes: number;
	readonly #maxFlights: number;
	readonly #ttlMs: number;
	readonly #now: () => number;
	#bytes = 0;
	#hits = 0;
	#misses = 0;
	#deduplicated = 0;
	#evictions = 0;
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(
		options: {
			readonly maxEntries?: number;
			readonly maxBytes?: number;
			readonly maxFlights?: number;
			readonly ttlMs?: number;
			readonly now?: () => number;
		} = {},
	) {
		this.#maxEntries = options.maxEntries ?? CLI_OFFICIAL_CACHE_MAX_ENTRIES;
		this.#maxBytes = options.maxBytes ?? CLI_OFFICIAL_CACHE_MAX_BYTES;
		this.#maxFlights = options.maxFlights ?? CLI_OFFICIAL_CACHE_MAX_FLIGHTS;
		this.#ttlMs = options.ttlMs ?? CLI_OFFICIAL_CACHE_TTL_MS;
		this.#now = options.now ?? Date.now;
	}

	async getOrLoad(
		key: unknown,
		signal: AbortSignal | undefined,
		loader: (signal: AbortSignal) => Promise<CachedDocument>,
	): Promise<CachedDocument> {
		if (this.#closed || signal?.aborted) throw new OfficialDocumentationWaiterCancelledError();
		const digest = hashCanonicalValue(key);
		const cached = this.#entries.get(digest);
		if (cached && cached.expiresAt > this.#now()) {
			this.#entries.delete(digest);
			this.#entries.set(digest, cached);
			this.#hits += 1;
			return clone({ ...cached.document, cache: "hit" as const });
		}
		if (cached) this.#remove(digest, cached);

		let flight = this.#flights.get(digest);
		if (flight) {
			this.#deduplicated += 1;
		} else {
			if (this.#tracked.size >= this.#maxFlights) throw new OfficialDocumentationCacheConcurrencyError();
			this.#misses += 1;
			flight = this.#createFlight(digest, loader);
			this.#flights.set(digest, flight);
		}
		return this.#wait(flight, signal);
	}

	stats(): OfficialDocumentationCacheStats {
		this.#expire();
		return {
			entries: this.#entries.size,
			bytes: this.#bytes,
			inFlight: this.#tracked.size,
			hits: this.#hits,
			misses: this.#misses,
			deduplicated: this.#deduplicated,
			evictions: this.#evictions,
		};
	}

	async clear(): Promise<void> {
		const draining = [...this.#tracked];
		for (const flight of draining) flight.controller.abort();
		this.#flights.clear();
		this.#entries.clear();
		this.#bytes = 0;
		await Promise.allSettled(draining.map(({ promise }) => promise));
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#closePromise = this.clear();
		return this.#closePromise;
	}

	#createFlight(digest: string, loader: (signal: AbortSignal) => Promise<CachedDocument>): CacheFlight {
		const controller = new AbortController();
		const flight: CacheFlight = {
			controller,
			waiters: new Set(),
			promise: Promise.resolve()
				.then(() => loader(controller.signal))
				.then((document) => {
					const stable = clone({ ...document, cache: "miss" as const });
					if (!this.#closed && !controller.signal.aborted) this.#insert(digest, stable);
					return clone(stable);
				})
				.finally(() => {
					if (this.#flights.get(digest) === flight) this.#flights.delete(digest);
					this.#tracked.delete(flight);
				}),
		};
		this.#tracked.add(flight);
		void flight.promise.catch(() => undefined);
		return flight;
	}

	#wait(flight: CacheFlight, signal: AbortSignal | undefined): Promise<CachedDocument> {
		const token = Symbol("official-doc-waiter");
		flight.waiters.add(token);
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = () => {
				if (settled) return false;
				settled = true;
				flight.waiters.delete(token);
				signal?.removeEventListener("abort", onAbort);
				return true;
			};
			const onAbort = () => {
				if (!finish()) return;
				if (flight.waiters.size === 0) {
					for (const [digest, active] of this.#flights) if (active === flight) this.#flights.delete(digest);
					flight.controller.abort();
					void flight.promise.then(
						() => {
							reject(new OfficialDocumentationWaiterCancelledError());
						},
						() => {
							reject(new OfficialDocumentationWaiterCancelledError());
						},
					);
					return;
				}
				reject(new OfficialDocumentationWaiterCancelledError());
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			flight.promise.then(
				(document) => {
					if (finish()) resolve(clone(document));
				},
				(error: unknown) => {
					if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
				},
			);
			if (signal?.aborted) onAbort();
		});
	}

	#insert(digest: string, document: CachedDocument): void {
		const bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
		if (bytes > this.#maxBytes || this.#maxEntries < 1) return;
		const previous = this.#entries.get(digest);
		if (previous) this.#remove(digest, previous);
		this.#entries.set(digest, {
			document: clone(document),
			bytes,
			expiresAt: this.#now() + this.#ttlMs,
		});
		this.#bytes += bytes;
		while (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
			const oldest = this.#entries.entries().next().value;
			if (!oldest) break;
			this.#remove(oldest[0], oldest[1]);
			this.#evictions += 1;
		}
	}

	#remove(digest: string, entry: CacheEntry): void {
		if (this.#entries.delete(digest)) this.#bytes -= entry.bytes;
	}

	#expire(): void {
		const now = this.#now();
		for (const [digest, entry] of this.#entries) if (entry.expiresAt <= now) this.#remove(digest, entry);
	}
}

/** Agent-independent official-document retrieval and focused lexical search service. */
export class OfficialDocumentationService {
	readonly #cache: OfficialDocumentationCache;
	readonly #transport: SecureHttpsTransport;
	readonly #lifecycle = new AbortController();
	readonly #aggregateTimeoutMs: number;
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(
		options: {
			readonly cache?: OfficialDocumentationCache;
			readonly transport?: SecureHttpsTransport;
			readonly aggregateTimeoutMs?: number;
		} = {},
	) {
		this.#cache = options.cache ?? new OfficialDocumentationCache();
		this.#transport = options.transport ?? new SecureHttpsTransport();
		this.#aggregateTimeoutMs = options.aggregateTimeoutMs ?? CLI_OFFICIAL_AGGREGATE_TIMEOUT_MS;
	}

	async search(request: OfficialDocumentationRequest): Promise<OfficialDocumentationResult> {
		const query = validateOfficialDocumentationQuery(request.query);
		const { definition } = request.registry;
		const definitionSha256 = hashCanonicalValue(definition);
		const sources = definition.docs.official;
		if (sources.length === 0) {
			return {
				status: "failed",
				registryId: definition.id,
				toolName: definition.tool_name,
				query: request.query,
				outcomes: [],
				snippets: [],
				definitionSha256,
			};
		}
		const deadline = new AbortController();
		const deadlineAt = performance.now() + this.#aggregateTimeoutMs;
		const timer = setTimeout(() => {
			deadline.abort();
		}, this.#aggregateTimeoutMs);
		timer.unref();
		const signal = AbortSignal.any(
			[request.signal, this.#lifecycle.signal, deadline.signal].filter(
				(candidate): candidate is AbortSignal => candidate !== undefined,
			),
		);
		const outcomes: OfficialDocumentationSourceOutcome[] = [];
		let transferredBodyBytes = 0;
		const hopBudget: OfficialHttpHopBudget = { remaining: CLI_OFFICIAL_MAX_HTTP_HOPS };
		try {
			for (const source of sources) {
				if (signal.aborted || this.#closed) {
					outcomes.push(
						failedSource(
							source.id,
							deadline.signal.aborted ? "timeout" : "cancelled",
							"Official documentation request stopped",
						),
					);
					break;
				}
				try {
					const key = {
						schemaVersion: 1,
						registryId: definition.id,
						definitionSha256,
						source,
					};
					const document = await this.#cache.getOrLoad(key, signal, async (flightSignal) => {
						const remaining = Math.min(
							CLI_OFFICIAL_MAX_BODY_BYTES,
							CLI_OFFICIAL_MAX_AGGREGATE_BODY_BYTES - transferredBodyBytes,
						);
						return this.#loadDocument(source, flightSignal, remaining, hopBudget, deadlineAt, (bytes) => {
							transferredBodyBytes += bytes;
						});
					});
					const snippets = searchOfficialDocument(document.text, query, source.id, deadlineAt);
					const alignment = classifyOfficialDocumentationAlignment(source, request.installedVersion);
					const provenance = createProvenance(source, document, alignment);
					outcomes.push({ status: "ok", sourceId: source.id, provenance, snippets });
				} catch (error) {
					outcomes.push(mapSourceFailure(source.id, error, deadline.signal.aborted));
				}
			}
		} finally {
			clearTimeout(timer);
		}
		const sourceOrder = new Map(sources.map((source, index) => [source.id, index]));
		const candidates = outcomes.flatMap((outcome) =>
			outcome.status === "ok"
				? outcome.snippets.map((snippet) => ({ ...snippet, provenance: outcome.provenance }))
				: [],
		);
		candidates.sort((left, right) => {
			if (left.score !== right.score) return right.score - left.score;
			const sourceDelta = (sourceOrder.get(left.sourceId) ?? 0) - (sourceOrder.get(right.sourceId) ?? 0);
			return sourceDelta || left.offset - right.offset || compareStrings(left.sourceId, right.sourceId);
		});
		const snippets = selectSnippetBudget(candidates);
		const selected = new Set(snippets.map(snippetIdentity));
		const boundedOutcomes = outcomes.map((outcome): OfficialDocumentationSourceOutcome =>
			outcome.status === "ok"
				? { ...outcome, snippets: outcome.snippets.filter((snippet) => selected.has(snippetIdentity(snippet))) }
				: outcome,
		);
		return {
			status: boundedOutcomes.some(({ status }) => status === "ok") ? "ok" : "failed",
			registryId: definition.id,
			toolName: definition.tool_name,
			query: request.query,
			outcomes: boundedOutcomes,
			snippets,
			definitionSha256,
		};
	}

	diagnostics(): { readonly cache: OfficialDocumentationCacheStats } {
		return { cache: this.#cache.stats() };
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#lifecycle.abort();
		this.#closePromise = this.#cache.close();
		return this.#closePromise;
	}

	async #loadDocument(
		source: OfficialDocumentationSource,
		signal: AbortSignal,
		maxBodyBytes: number,
		hopBudget: OfficialHttpHopBudget,
		deadlineAt: number,
		recordTransfer: (bytes: number) => void,
	): Promise<CachedDocument> {
		let response: SecureFetchResponse;
		try {
			response = await fetchAuthoritativeDocument(source, signal, this.#transport, maxBodyBytes, hopBudget);
		} catch (error) {
			if (error instanceof SecureFetchError && error.transferredBodyBytes > 0) {
				recordTransfer(error.transferredBodyBytes);
			}
			throw error;
		}
		recordTransfer(response.body.byteLength);
		const decoded = decodeUtf8(response.body);
		const extracted = source.media === "html" ? extractBoundedHtmlText(decoded, deadlineAt) : decoded;
		const text = sanitizeAndBoundDocumentation(extracted);
		if (text.trim().length === 0)
			throw new SecureFetchError("empty_document", "Official documentation contained no usable text");
		return {
			text,
			configuredUrl: response.configuredUrl,
			finalUrl: response.finalUrl,
			redirects: [...response.redirects],
			mediaType: response.mediaType,
			bodySha256: response.bodySha256,
			bodyBytes: response.body.byteLength,
			textSha256: sha256(text),
			retrievedAt: response.retrievedAt,
			cache: "miss",
		};
	}
}

export interface ValidatedOfficialQuery {
	readonly phrase: string;
	readonly terms: readonly string[];
}

export function validateOfficialDocumentationQuery(value: unknown): ValidatedOfficialQuery {
	if (
		typeof value !== "string" ||
		Buffer.byteLength(value, "utf8") < 1 ||
		Buffer.byteLength(value, "utf8") > CLI_OFFICIAL_MAX_QUERY_BYTES ||
		hasControlCharacter(value) ||
		/\p{Cf}/u.test(value)
	) {
		throw new OfficialDocumentationRequestError(
			`query must be printable text of at most ${String(CLI_OFFICIAL_MAX_QUERY_BYTES)} UTF-8 bytes`,
		);
	}
	const phrase = normalizeSearchText(value).trim();
	const terms = [...new Set(tokenizeSearchText(phrase))];
	if (
		terms.length < 1 ||
		terms.length > CLI_OFFICIAL_MAX_QUERY_TERMS ||
		terms.some((term) => Buffer.byteLength(term, "utf8") > 64)
	) {
		throw new OfficialDocumentationRequestError(
			`query must contain 1 through ${String(CLI_OFFICIAL_MAX_QUERY_TERMS)} lexical terms of at most 64 UTF-8 bytes each`,
		);
	}
	return { phrase, terms };
}

export function searchOfficialDocument(
	text: string,
	query: ValidatedOfficialQuery,
	sourceId: string,
	deadlineAt = Number.POSITIVE_INFINITY,
): OfficialDocumentationSnippet[] {
	const lines = text.split("\n");
	if (lines.length > CLI_OFFICIAL_MAX_TEXT_LINES) {
		throw new SecureFetchError("body_too_large", "Normalized official documentation exceeded the line limit");
	}
	interface Window {
		start: number;
		end: number;
		score: number;
		heading: string | null;
		offset: number;
		lineIndex: number;
		column: number;
	}
	const strongest: Window[] = [];
	const maximumCandidates = CLI_OFFICIAL_MAX_SNIPPETS * 4;
	const retain = (window: Window) => {
		strongest.push(window);
		strongest.sort((left, right) => right.score - left.score || left.offset - right.offset);
		if (strongest.length > maximumCandidates) strongest.pop();
	};
	let pending: Window | undefined;
	let offset = 0;
	for (let index = 0; index < lines.length; index += 1) {
		if ((index & 127) === 0 && performance.now() > deadlineAt) {
			throw new SecureFetchError("timeout", "Official documentation search deadline exceeded");
		}
		const line = lines[index] ?? "";
		const normalized = normalizeSearchText(line);
		const tokens = new Set(tokenizeSearchText(normalized));
		const covered = query.terms.filter((term) => tokens.has(term));
		if (covered.length > 0) {
			const phraseMatches = countOccurrences(normalized, query.phrase, 3);
			const occurrences = query.terms.reduce((total, term) => total + countOccurrences(normalized, term, 5), 0);
			const matchColumns = [
				normalized.indexOf(query.phrase),
				...query.terms.map((term) => normalized.indexOf(term)),
			].filter((column) => column >= 0);
			const heading = nearestHeading(lines, index);
			const next: Window = {
				start: Math.max(0, index - 2),
				end: Math.min(lines.length, index + 3),
				score: phraseMatches * 200 + covered.length * 50 + Math.min(occurrences, 10) * 5 + (heading ? 20 : 0),
				heading,
				offset,
				lineIndex: index,
				column: Math.min(...matchColumns),
			};
			if (pending && next.start <= pending.end) {
				pending.end = Math.max(pending.end, next.end);
				if (next.score > pending.score) {
					pending.score = next.score;
					pending.offset = next.offset;
					pending.lineIndex = next.lineIndex;
					pending.column = next.column;
					pending.heading = next.heading;
				}
			} else {
				if (pending) retain(pending);
				pending = next;
			}
		}
		offset += line.length + 1;
	}
	if (pending) retain(pending);
	return strongest.slice(0, CLI_OFFICIAL_MAX_SNIPPETS).map((window) => {
		const raw = lines
			.slice(window.start, Math.min(window.end, window.start + CLI_OFFICIAL_MAX_SNIPPET_LINES))
			.join("\n");
		const bounded =
			Buffer.byteLength(raw, "utf8") <= CLI_OFFICIAL_MAX_SNIPPET_BYTES
				? raw
				: boundedLineContext(lines[window.lineIndex] ?? "", window.column, CLI_OFFICIAL_MAX_SNIPPET_BYTES);
		return {
			sourceId,
			heading: window.heading,
			offset: window.offset,
			score: window.score,
			text: bounded,
			sha256: sha256(bounded),
		};
	});
}

export function parseSemverFirst(value: string): string | null {
	const firstLine = sanitizeLocalDocumentationText(value).split("\n", 1)[0] ?? "";
	const matches = findStrictSemvers(firstLine);
	return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function classifyOfficialDocumentationAlignment(
	source: OfficialDocumentationSource,
	evidence?: InstalledVersionEvidence,
): OfficialDocumentationAlignment {
	if (source.alignment.mode === "latest") {
		return alignment("unversioned", null, null, null, "declared_latest");
	}
	if (source.alignment.mode === "unversioned") {
		return alignment("unversioned", null, null, null, "declared_unversioned");
	}
	if (source.alignment.mode === "unknown") {
		return alignment("unknown", null, null, null, "unparsed");
	}
	const installed = evidence?.normalizedVersion ?? null;
	const declared = source.alignment.version;
	if (!installed) {
		return alignment(
			"unknown",
			null,
			declared,
			source.alignment.mode === "exact" ? "exact" : source.alignment.precision,
			"unparsed",
			evidence,
		);
	}
	if (source.alignment.mode === "exact") {
		return alignment(
			installed === declared ? "exact" : "mismatch",
			installed,
			declared,
			"exact",
			"fixed_exact",
			evidence,
		);
	}
	const left = parseStrictSemver(installed);
	const right = parseStrictSemver(declared);
	let state: OfficialDocumentationAlignment["state"] = "mismatch";
	if (installed === declared) {
		state = "exact";
	} else if (
		left !== null &&
		right !== null &&
		left.major !== "0" &&
		left.prerelease.length === 0 &&
		right.prerelease.length === 0 &&
		left.major === right.major
	) {
		if (source.alignment.precision === "major") state = "major_match";
		else if (left.minor === right.minor) state = "major_minor_match";
	}
	return alignment(state, installed, declared, source.alignment.precision, "fixed_version_match", evidence);
}

function createProvenance(
	source: OfficialDocumentationSource,
	document: CachedDocument,
	alignmentValue: OfficialDocumentationAlignment,
): OfficialDocumentationProvenance {
	return {
		sourceId: source.id,
		title: source.title,
		configuredUrl: document.configuredUrl,
		finalUrl: document.finalUrl,
		redirects: [...document.redirects],
		domain: new URL(document.finalUrl).hostname,
		mediaType: document.mediaType,
		cache: document.cache,
		retrievedAt: document.retrievedAt,
		bodySha256: document.bodySha256,
		textSha256: document.textSha256,
		alignment: alignmentValue,
	};
}

function decodeUtf8(body: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(body);
	} catch (error) {
		throw new SecureFetchError("invalid_utf8", "Official documentation was not valid UTF-8", { cause: error });
	}
}

function extractBoundedHtmlText(html: string, deadlineAt: number): string {
	const ignored = new Set([
		"applet",
		"audio",
		"canvas",
		"embed",
		"head",
		"iframe",
		"link",
		"meta",
		"noscript",
		"object",
		"portal",
		"script",
		"style",
		"svg",
		"template",
		"video",
	]);
	const blocks = new Set([
		"address",
		"article",
		"aside",
		"blockquote",
		"br",
		"dd",
		"div",
		"dl",
		"dt",
		"figcaption",
		"figure",
		"footer",
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"header",
		"hr",
		"li",
		"main",
		"nav",
		"ol",
		"p",
		"pre",
		"section",
		"table",
		"td",
		"th",
		"tr",
		"ul",
	]);
	let ignoredDepth = 0;
	let output = "";
	let bytes = 0;
	let events = 0;
	const checkDeadline = () => {
		events += 1;
		if ((events & 255) === 0 && performance.now() > deadlineAt) {
			throw new SecureFetchError("timeout", "Official HTML extraction deadline exceeded");
		}
	};
	const append = (value: string) => {
		const nextBytes = Buffer.byteLength(value, "utf8");
		if (bytes + nextBytes > CLI_OFFICIAL_MAX_TEXT_BYTES) {
			throw new SecureFetchError("body_too_large", "Normalized official documentation text exceeded the limit");
		}
		output += value;
		bytes += nextBytes;
	};
	try {
		if (performance.now() > deadlineAt) {
			throw new SecureFetchError("timeout", "Official HTML extraction deadline exceeded");
		}
		const parser = new Parser(
			{
				onopentag(name) {
					checkDeadline();
					if (ignored.has(name)) ignoredDepth += 1;
					else if (ignoredDepth === 0 && blocks.has(name) && !output.endsWith("\n")) append("\n");
				},
				ontext(value) {
					checkDeadline();
					if (ignoredDepth === 0) append(value);
				},
				onclosetag(name) {
					checkDeadline();
					if (ignored.has(name)) ignoredDepth = Math.max(0, ignoredDepth - 1);
					else if (ignoredDepth === 0 && blocks.has(name) && !output.endsWith("\n")) append("\n");
				},
			},
			{ decodeEntities: true, lowerCaseTags: true },
		);
		parser.end(html);
	} catch (error) {
		if (error instanceof SecureFetchError) throw error;
		throw new SecureFetchError("parse_error", "Official HTML documentation could not be parsed", { cause: error });
	}
	return output;
}

function sanitizeAndBoundDocumentation(value: string): string {
	const sanitized = sanitizeLocalDocumentationText(value)
		.replace(/[ \t]+\n/gu, "\n")
		.replace(/\n{4,}/gu, "\n\n\n")
		.trim();
	if (Buffer.byteLength(sanitized, "utf8") > CLI_OFFICIAL_MAX_TEXT_BYTES) {
		throw new SecureFetchError("body_too_large", "Normalized official documentation text exceeded the limit");
	}
	if (logicalLines(sanitized) > CLI_OFFICIAL_MAX_TEXT_LINES) {
		throw new SecureFetchError("body_too_large", "Normalized official documentation exceeded the line limit");
	}
	return sanitized;
}

function mapSourceFailure(sourceId: string, error: unknown, deadline: boolean): OfficialDocumentationSourceOutcome {
	if (error instanceof SecureFetchError) return failedSource(sourceId, error.code, error.message);
	if (error instanceof OfficialDocumentationCacheConcurrencyError) {
		return failedSource(sourceId, "concurrency_limit", error.message);
	}
	if (error instanceof OfficialDocumentationWaiterCancelledError) {
		return failedSource(sourceId, deadline ? "timeout" : "cancelled", error.message);
	}
	if (error instanceof OfficialDocumentationRequestError)
		return failedSource(sourceId, "invalid_request", error.message);
	return failedSource(sourceId, "network_error", "Official documentation retrieval failed");
}

function failedSource(
	sourceId: string,
	code: OfficialDocumentationFailureCode,
	message: string,
): OfficialDocumentationSourceOutcome {
	return { status: "failed", sourceId, code, message: clipUtf8(sanitizeLocalDocumentationText(message), 512) };
}

function snippetIdentity(value: Pick<OfficialDocumentationSnippet, "sourceId" | "offset" | "sha256">): string {
	return `${value.sourceId}\u0000${String(value.offset)}\u0000${value.sha256}`;
}

function selectSnippetBudget<T extends OfficialDocumentationSnippet>(values: readonly T[]): T[] {
	const selected: T[] = [];
	let bytes = 0;
	let lines = 0;
	for (const value of values) {
		if (selected.length >= CLI_OFFICIAL_MAX_SNIPPETS) break;
		const nextBytes = Buffer.byteLength(value.text, "utf8");
		const nextLines = logicalLines(value.text);
		if (bytes + nextBytes > CLI_OFFICIAL_MAX_EXCERPT_BYTES || lines + nextLines > CLI_OFFICIAL_MAX_EXCERPT_LINES)
			continue;
		selected.push(value);
		bytes += nextBytes;
		lines += nextLines;
	}
	return selected;
}

function alignment(
	state: OfficialDocumentationAlignment["state"],
	installedVersion: string | null,
	sourceVersion: string | null,
	precision: OfficialDocumentationAlignment["precision"],
	basis: OfficialDocumentationAlignment["basis"],
	evidence?: InstalledVersionEvidence,
): OfficialDocumentationAlignment {
	return {
		state,
		installedVersion,
		sourceVersion,
		precision,
		basis,
		evidenceSource: evidence?.source ?? null,
		evidenceDefinitionSha256: evidence?.definitionSha256 ?? null,
		evidenceExecutableIdentitySha256: evidence?.executableIdentitySha256 ?? null,
	};
}

function normalizeSearchText(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

function tokenizeSearchText(value: string): string[] {
	return value.match(/--?[\p{L}\p{N}][\p{L}\p{N}._:-]*|[\p{L}\p{N}][\p{L}\p{N}._/:-]*/gu) ?? [];
}

function countOccurrences(value: string, needle: string, maximum: number): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let offset = 0;
	while (count < maximum) {
		const found = value.indexOf(needle, offset);
		if (found < 0) break;
		count += 1;
		offset = found + Math.max(1, needle.length);
	}
	return count;
}

function nearestHeading(lines: readonly string[], index: number): string | null {
	for (let cursor = index; cursor >= Math.max(0, index - 8); cursor -= 1) {
		const line = (lines[cursor] ?? "").trim();
		if (/^#{1,6}\s+\S/u.test(line)) return clipUtf8(line.replace(/^#{1,6}\s+/u, ""), 256);
		if (cursor < index && line.length > 0 && line.length <= 120 && !/[.!?]$/u.test(line)) return clipUtf8(line, 256);
	}
	return null;
}

function boundedLineContext(value: string, column: number, maximum: number): string {
	const characters = Array.from(value);
	const center = Math.max(0, Math.min(characters.length, column));
	const start = Math.max(0, center - Math.floor(maximum / 4));
	const selected = characters.slice(start, start + maximum).join("");
	const prefix = start > 0 ? "…" : "";
	const suffix = start + maximum < characters.length ? "…" : "";
	return clipUtf8(`${prefix}${selected}${suffix}`, maximum);
}

function clipUtf8(value: string, maximum: number): string {
	if (Buffer.byteLength(value, "utf8") <= maximum) return value;
	const suffix = "…";
	const budget = maximum - Buffer.byteLength(suffix, "utf8");
	let output = "";
	let bytes = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > budget) break;
		output += character;
		bytes += size;
	}
	return `${output}${suffix}`;
}

function logicalLines(value: string): number {
	if (value.length === 0) return 0;
	let lines = 1;
	for (const character of value) {
		if (character === "\n") lines += 1;
		if (lines > CLI_OFFICIAL_MAX_TEXT_LINES) return lines;
	}
	return lines;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function hasControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code < 0x20 || (code >= 0x7f && code <= 0x9f);
	});
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
