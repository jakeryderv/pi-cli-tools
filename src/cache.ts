import { createHash } from "node:crypto";

import {
	CLI_INTROSPECTION_CACHE_MAX_BYTES,
	CLI_INTROSPECTION_CACHE_MAX_ENTRIES,
	CLI_INTROSPECTION_CACHE_MAX_FLIGHTS,
} from "./limits.js";
import type { ExecutableIdentity, LocalIntrospectionSource, LocalIntrospectionSuccess } from "./types.js";

export interface LocalIntrospectionCacheKey {
	readonly schemaVersion: 1;
	readonly registryId: string;
	readonly definitionSha256: string;
	readonly executable: ExecutableIdentity;
	readonly helperExecutable?: ExecutableIdentity;
	readonly source: LocalIntrospectionSource;
	readonly subcommand: readonly string[];
	readonly args: readonly string[];
	readonly cwd: string;
	readonly environmentSha256: string;
}

export interface LocalIntrospectionCacheStats {
	readonly entries: number;
	readonly bytes: number;
	readonly inFlight: number;
	readonly hits: number;
	readonly misses: number;
	readonly deduplicated: number;
	readonly evictions: number;
	readonly invalidations: number;
}

export interface LocalIntrospectionCacheDiagnostics extends LocalIntrospectionCacheStats {
	readonly cachedVersions: readonly { readonly registryId: string }[];
}

export class LocalIntrospectionCacheWaiterCancelledError extends Error {
	constructor() {
		super("Local introspection cache waiter cancelled");
		this.name = "LocalIntrospectionCacheWaiterCancelledError";
	}
}

export class LocalIntrospectionCacheConcurrencyError extends Error {
	constructor() {
		super("Local introspection concurrent-flight limit reached");
		this.name = "LocalIntrospectionCacheConcurrencyError";
	}
}

interface CacheEntry {
	readonly key: LocalIntrospectionCacheKey;
	readonly value: LocalIntrospectionSuccess;
	readonly bytes: number;
}

interface Flight {
	readonly key: LocalIntrospectionCacheKey;
	readonly registryIdentity: string;
	readonly controller: AbortController;
	readonly waiters: Set<symbol>;
	readonly promise: Promise<LocalIntrospectionSuccess>;
}

/** Session-scoped, success-only LRU cache and waiter-aware identical-flight deduplicator. */
export class LocalIntrospectionCache {
	readonly #maxEntries: number;
	readonly #maxBytes: number;
	readonly #maxFlights: number;
	readonly #entries = new Map<string, CacheEntry>();
	/** Flights eligible for identical-request deduplication. */
	readonly #flights = new Map<string, Flight>();
	/** Every loader still settling, including aborted loaders no longer eligible for deduplication. */
	readonly #trackedFlights = new Set<Flight>();
	readonly #registryIdentities = new Map<string, string>();
	#bytes = 0;
	#hits = 0;
	#misses = 0;
	#deduplicated = 0;
	#evictions = 0;
	#invalidations = 0;
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(
		options: {
			readonly maxEntries?: number;
			readonly maxBytes?: number;
			readonly maxFlights?: number;
		} = {},
	) {
		this.#maxEntries = options.maxEntries ?? CLI_INTROSPECTION_CACHE_MAX_ENTRIES;
		this.#maxBytes = options.maxBytes ?? CLI_INTROSPECTION_CACHE_MAX_BYTES;
		this.#maxFlights = options.maxFlights ?? CLI_INTROSPECTION_CACHE_MAX_FLIGHTS;
	}

	/** Invalidate settled and in-flight data if a definition or selected executable identity changed. */
	prepareRegistry(registryId: string, identity: string): void {
		const previous = this.#registryIdentities.get(registryId);
		if (previous === identity) return;
		this.#registryIdentities.set(registryId, identity);
		if (previous === undefined) return;

		let changed = false;
		for (const [digest, entry] of this.#entries) {
			if (entry.key.registryId !== registryId) continue;
			this.#entries.delete(digest);
			this.#bytes -= entry.bytes;
			changed = true;
		}
		for (const flight of this.#trackedFlights) {
			if (flight.key.registryId !== registryId) continue;
			for (const [digest, current] of this.#flights) {
				if (current === flight) this.#flights.delete(digest);
			}
			flight.controller.abort();
			changed = true;
		}
		if (changed) this.#invalidations += 1;
	}

	async getOrLoad(
		key: LocalIntrospectionCacheKey,
		signal: AbortSignal | undefined,
		loader: (signal: AbortSignal) => Promise<LocalIntrospectionSuccess>,
	): Promise<LocalIntrospectionSuccess> {
		if (this.#closed || signal?.aborted) throw new LocalIntrospectionCacheWaiterCancelledError();
		const stableKey = cloneSerializable(key);
		if (!this.#registryIdentities.has(stableKey.registryId)) {
			this.#registryIdentities.set(
				stableKey.registryId,
				`${stableKey.definitionSha256}:${hashCanonicalValue(stableKey.executable)}`,
			);
		}
		const digest = hashCanonicalValue(stableKey);
		const cached = this.#entries.get(digest);
		if (cached) {
			this.#entries.delete(digest);
			this.#entries.set(digest, cached);
			this.#hits += 1;
			return cloneSerializable({ ...cached.value, cache: "hit" as const });
		}

		let flight = this.#flights.get(digest);
		if (flight) {
			this.#deduplicated += 1;
		} else {
			if (this.#trackedFlights.size >= this.#maxFlights) throw new LocalIntrospectionCacheConcurrencyError();
			this.#misses += 1;
			flight = this.#createFlight(digest, stableKey, loader);
			this.#flights.set(digest, flight);
		}
		return this.#waitForFlight(flight, signal);
	}

	async clear(): Promise<void> {
		const draining = [...this.#trackedFlights];
		for (const flight of draining) flight.controller.abort();
		this.#flights.clear();
		this.#entries.clear();
		this.#registryIdentities.clear();
		this.#bytes = 0;
		await Promise.allSettled(draining.map(({ promise }) => promise));
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#closePromise = this.clear();
		return this.#closePromise;
	}

	stats(): LocalIntrospectionCacheStats {
		return {
			entries: this.#entries.size,
			bytes: this.#bytes,
			inFlight: this.#trackedFlights.size,
			hits: this.#hits,
			misses: this.#misses,
			deduplicated: this.#deduplicated,
			evictions: this.#evictions,
			invalidations: this.#invalidations,
		};
	}

	diagnostics(): LocalIntrospectionCacheDiagnostics {
		const registryIds = new Set<string>();
		for (const entry of this.#entries.values()) {
			if (entry.key.source === "version") registryIds.add(entry.key.registryId);
		}
		return {
			...this.stats(),
			cachedVersions: [...registryIds].map((registryId) => ({ registryId })),
		};
	}

	#createFlight(
		digest: string,
		key: LocalIntrospectionCacheKey,
		loader: (signal: AbortSignal) => Promise<LocalIntrospectionSuccess>,
	): Flight {
		const controller = new AbortController();
		const registryIdentity = this.#registryIdentities.get(key.registryId) ?? "";
		const waiters = new Set<symbol>();
		const flight: Flight = {
			key,
			registryIdentity,
			controller,
			waiters,
			promise: Promise.resolve()
				.then(() => loader(controller.signal))
				.then((value) => {
					const stableValue = cloneSerializable({ ...value, cache: "miss" as const });
					if (
						!this.#closed &&
						!controller.signal.aborted &&
						this.#registryIdentities.get(key.registryId) === registryIdentity
					) {
						this.#insert(digest, key, stableValue);
					}
					return cloneSerializable(stableValue);
				})
				.finally(() => {
					const current = this.#flights.get(digest);
					if (current === flight) this.#flights.delete(digest);
					this.#trackedFlights.delete(flight);
				}),
		};
		this.#trackedFlights.add(flight);
		// A flight can lose every waiter; keep its rejection observed while process cleanup settles.
		void flight.promise.catch(() => undefined);
		return flight;
	}

	#waitForFlight(flight: Flight, signal: AbortSignal | undefined): Promise<LocalIntrospectionSuccess> {
		const token = Symbol("waiter");
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
					for (const [digest, current] of this.#flights) {
						if (current === flight) this.#flights.delete(digest);
					}
					flight.controller.abort();
					void flight.promise.then(
						() => {
							reject(new LocalIntrospectionCacheWaiterCancelledError());
						},
						(error: unknown) => {
							reject(error instanceof Error ? error : new Error(String(error)));
						},
					);
					return;
				}
				reject(new LocalIntrospectionCacheWaiterCancelledError());
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			flight.promise.then(
				(value) => {
					if (finish()) resolve(cloneSerializable(value));
				},
				(error: unknown) => {
					if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
				},
			);
			if (signal?.aborted) onAbort();
		});
	}

	#insert(digest: string, key: LocalIntrospectionCacheKey, value: LocalIntrospectionSuccess): void {
		const bytes = Buffer.byteLength(JSON.stringify({ key, value }), "utf8");
		if (bytes > this.#maxBytes || this.#maxEntries < 1) return;
		const previous = this.#entries.get(digest);
		if (previous) {
			this.#entries.delete(digest);
			this.#bytes -= previous.bytes;
		}
		this.#entries.set(digest, {
			key: cloneSerializable(key),
			value: cloneSerializable(value),
			bytes,
		});
		this.#bytes += bytes;
		while (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
			const oldest = this.#entries.entries().next().value;
			if (!oldest) break;
			this.#entries.delete(oldest[0]);
			this.#bytes -= oldest[1].bytes;
			this.#evictions += 1;
		}
	}
}

export function hashCanonicalValue(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function cloneSerializable<T>(value: T): T {
	return structuredClone(value);
}
