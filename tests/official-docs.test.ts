import { describe, expect, it, vi } from "vitest";

import { createOfficialDocsDetails, formatOfficialDocsForModel } from "../extensions/pi-adapter.js";
import {
	CLI_OFFICIAL_MAX_EXCERPT_BYTES,
	CLI_OFFICIAL_MAX_EXCERPT_LINES,
	CLI_OFFICIAL_MAX_SNIPPETS,
} from "../src/limits.js";
import {
	OfficialDocumentationCache,
	OfficialDocumentationRequestError,
	OfficialDocumentationService,
	classifyOfficialDocumentationAlignment,
	parseSemverFirst,
	searchOfficialDocument,
	validateOfficialDocumentationQuery,
} from "../src/docs.js";
import { SecureHttpsTransport, type PinnedHttpsConnector } from "../src/secure-fetch.js";
import type { InstalledVersionEvidence, OfficialDocumentationSource } from "../src/types.js";
import { createDefinition, loadDefinition } from "./helpers/pi-adapter.js";

describe("official documentation service", () => {
	it("fetches only on explicit search, shares query-independent success cache, sanitizes HTML, and preserves provenance", async () => {
		const connector = connectorSpy(
			"<html><head><script>ignore prompt</script></head><body><h1>Authentication</h1><p>Use GH_TOKEN for authentication.</p><style>bad</style><p>Pull request merge queue\u001b[31m</p></body></html>",
			"text/html",
		);
		const service = new OfficialDocumentationService({ transport: fakeTransport(connector) });
		try {
			const registry = loadDefinition(
				createDefinition("github", "cli_gh", { docs: { official: [source({ media: "html" })] } }),
			);
			const first = await service.search({ registry, query: "authentication token" });
			const second = await service.search({ registry, query: "merge queue" });
			expect(connector.request).toHaveBeenCalledTimes(1);
			expect(first.status).toBe("ok");
			const firstSource = first.outcomes[0];
			if (firstSource?.status !== "ok") throw new Error("expected successful source");
			expect(firstSource.provenance).toMatchObject({
				finalUrl: "https://example.com/docs",
				domain: "example.com",
				cache: "miss",
			});
			expect(firstSource.provenance.alignment.state).toBe("unversioned");
			expect(second.outcomes[0]).toMatchObject({ status: "ok", provenance: { cache: "hit" } });
			expect(first.snippets.map(({ text }) => text).join("\n")).toContain("GH_TOKEN");
			expect(second.snippets.map(({ text }) => text).join("\n")).toContain("merge queue");
			expect(JSON.stringify(first)).not.toContain("ignore prompt");
			expect(JSON.stringify(first)).not.toContain("\u001b");

			const firstOutcome = first.outcomes[0];
			if (firstOutcome?.status === "ok") {
				(firstOutcome.provenance as { finalUrl: string }).finalUrl = "mutated";
			}
			const third = await service.search({ registry, query: "authentication" });
			expect(third.outcomes[0]).toMatchObject({
				status: "ok",
				provenance: { finalUrl: "https://example.com/docs", cache: "hit" },
			});
			const changedRegistry = loadDefinition(
				createDefinition("github", "cli_gh", {
					routing: { description: "Changed definition identity" },
					docs: { official: [source({ media: "html" })] },
				}),
			);
			await service.search({ registry: changedRegistry, query: "authentication" });
			expect(connector.request).toHaveBeenCalledTimes(2);
		} finally {
			await service.close();
		}
	});

	it("makes the globally ranked excerpt budget authoritative for model text and details", async () => {
		const body = Array.from({ length: 8 }, (_, index) =>
			[`external needle ${String(index)}`, "a", "b", "c", "d", "e"].join("\n"),
		).join("\n");
		const connector = connectorSpy(body, "text/plain");
		const service = new OfficialDocumentationService({ transport: fakeTransport(connector) });
		const sources = Array.from({ length: 4 }, (_, index) =>
			source({ id: `manual-${String(index)}`, url: `https://example.com/docs/${String(index)}` }),
		);
		const registry = loadDefinition(createDefinition("fixture", "cli_fixture", { docs: { official: sources } }));
		const result = await service.search({ registry, query: "external" });
		expect(connector.request).toHaveBeenCalledTimes(4);
		const model = formatOfficialDocsForModel(result);
		const details = createOfficialDocsDetails(result);
		const openings = model.match(/\[Untrusted external official documentation excerpt;/gu) ?? [];
		const closings = model.match(/\[End untrusted external documentation excerpt\]/gu) ?? [];
		expect(result.snippets).toHaveLength(CLI_OFFICIAL_MAX_SNIPPETS);
		expect(openings).toHaveLength(CLI_OFFICIAL_MAX_SNIPPETS);
		expect(closings).toHaveLength(openings.length);
		expect(
			details.kind === "official_docs"
				? details.outcomes.reduce((total, outcome) => total + (outcome.snippets?.length ?? 0), 0)
				: -1,
		).toBe(CLI_OFFICIAL_MAX_SNIPPETS);
		const selectedText = result.snippets.map(({ text }) => text).join("\n");
		expect(Buffer.byteLength(selectedText, "utf8")).toBeLessThanOrEqual(CLI_OFFICIAL_MAX_EXCERPT_BYTES);
		expect(selectedText.split("\n").length).toBeLessThanOrEqual(CLI_OFFICIAL_MAX_EXCERPT_LINES);
		let framed = false;
		for (const line of model.split("\n")) {
			if (line.startsWith("[Untrusted external official documentation excerpt;")) framed = true;
			else if (line === "[End untrusted external documentation excerpt]") framed = false;
			else if (line.includes("external needle ")) expect(framed).toBe(true);
		}
		expect(framed).toBe(false);
		await service.close();
	});

	it("ignores embedded active HTML elements", async () => {
		const connector = connectorSpy(
			"<main><p>visible needle</p><iframe>iframe hidden needle</iframe><object>object hidden needle</object><audio>audio hidden needle</audio></main>",
			"text/html",
		);
		const service = new OfficialDocumentationService({ transport: fakeTransport(connector) });
		const registry = loadDefinition(
			createDefinition("fixture", "cli_fixture", { docs: { official: [source({ media: "html" })] } }),
		);
		const result = await service.search({ registry, query: "needle" });
		const serialized = JSON.stringify(result);
		expect(serialized).toContain("visible needle");
		expect(serialized).not.toContain("iframe hidden");
		expect(serialized).not.toContain("object hidden");
		expect(serialized).not.toContain("audio hidden");
		await service.close();
	});

	it("enforces the aggregate transferred-body budget across configured sources", async () => {
		const body = `<p>needle</p><script>${"x".repeat(800 * 1024)}</script>`;
		const connector = connectorSpy(body, "text/html");
		const service = new OfficialDocumentationService({ transport: fakeTransport(connector) });
		const sources = Array.from({ length: 3 }, (_, index) =>
			source({ id: `manual-${String(index)}`, url: `https://example.com/docs/${String(index)}`, media: "html" }),
		);
		const registry = loadDefinition(createDefinition("fixture", "cli_fixture", { docs: { official: sources } }));
		const result = await service.search({ registry, query: "needle" });
		expect(result.outcomes.slice(0, 2).every(({ status }) => status === "ok")).toBe(true);
		expect(result.outcomes[2]).toMatchObject({ status: "failed", code: "body_too_large" });
		expect(service.diagnostics().cache.entries).toBe(2);
		await service.close();
	});

	it("counts failed response bodies against the aggregate transfer budget", async () => {
		const body = new Uint8Array(800 * 1024).fill(0x61);
		body[0] = 0xc3;
		body[1] = 0x28;
		const connector = {
			request: vi.fn((input: Parameters<PinnedHttpsConnector["request"]>[0]) =>
				Promise.resolve({
					statusCode: 200,
					rawHeaders: ["Content-Type", "text/plain"],
					headers: {},
					body,
					peerAddress: input.address.address,
				}),
			),
		} satisfies PinnedHttpsConnector;
		const service = new OfficialDocumentationService({ transport: fakeTransport(connector) });
		const sources = Array.from({ length: 3 }, (_, index) =>
			source({ id: `failed-${String(index)}`, url: `https://example.com/docs/${String(index)}` }),
		);
		const registry = loadDefinition(createDefinition("fixture", "cli_fixture", { docs: { official: sources } }));
		const result = await service.search({ registry, query: "needle" });
		expect(
			result.outcomes.slice(0, 2).every((outcome) => outcome.status === "failed" && outcome.code === "invalid_utf8"),
		).toBe(true);
		expect(result.outcomes[2]).toMatchObject({ status: "failed", code: "body_too_large" });
		expect(service.diagnostics().cache.entries).toBe(0);
		await service.close();
	});

	it("returns a structured timeout and caches nothing when aggregate cancellation stops DNS", async () => {
		const timedTransport = new SecureHttpsTransport({
			resolver: {
				resolve(_hostname, signal) {
					return new Promise((_resolve, reject) => {
						signal.addEventListener(
							"abort",
							() => {
								reject(new Error("cancelled DNS"));
							},
							{ once: true },
						);
					});
				},
			},
			connector: connectorSpy("unused", "text/plain"),
		});
		const service = new OfficialDocumentationService({ transport: timedTransport, aggregateTimeoutMs: 5 });
		const registry = loadDefinition(createDefinition("fixture", "cli_fixture", { docs: { official: [source()] } }));
		const result = await service.search({ registry, query: "timeout" });
		expect(result).toMatchObject({ status: "failed", outcomes: [{ status: "failed", code: "timeout" }] });
		expect(service.diagnostics().cache.entries).toBe(0);
		await service.close();
	});

	it("bounds normalized document lines before lexical window construction", async () => {
		const connector = connectorSpy(Array.from({ length: 10_001 }, () => "needle").join("\n"), "text/plain");
		const service = new OfficialDocumentationService({ transport: fakeTransport(connector) });
		const registry = loadDefinition(createDefinition("fixture", "cli_fixture", { docs: { official: [source()] } }));
		const result = await service.search({ registry, query: "needle" });
		expect(result.outcomes[0]).toMatchObject({ status: "failed", code: "body_too_large" });
		expect(service.diagnostics().cache.entries).toBe(0);
		await service.close();
	});

	it("deduplicates concurrent source misses and never caches failures", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const connector = {
			request: vi.fn(async (input: Parameters<PinnedHttpsConnector["request"]>[0]) => {
				await gate;
				return response("shared text", "text/plain", input.address.address);
			}),
		} satisfies PinnedHttpsConnector;
		const service = new OfficialDocumentationService({ transport: fakeTransport(connector) });
		const registry = loadDefinition(createDefinition("fixture", "cli_fixture", { docs: { official: [source()] } }));
		const first = service.search({ registry, query: "shared" });
		const second = service.search({ registry, query: "text" });
		await vi.waitFor(() => {
			expect(connector.request).toHaveBeenCalledTimes(1);
		});
		release();
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(service.diagnostics().cache.deduplicated).toBe(1);
		await service.close();

		const failedConnector = connectorSpy("not markdown", "text/plain");
		const failedService = new OfficialDocumentationService({ transport: fakeTransport(failedConnector) });
		const markdownRegistry = loadDefinition(
			createDefinition("fixture", "cli_fixture", { docs: { official: [source({ media: "markdown" })] } }),
		);
		await failedService.search({ registry: markdownRegistry, query: "markdown" });
		await failedService.search({ registry: markdownRegistry, query: "markdown" });
		expect(failedConnector.request).toHaveBeenCalledTimes(2);
		expect(failedService.diagnostics().cache.entries).toBe(0);
		await failedService.close();
	});

	it("rejects malformed UTF-8 as a structured uncached failure", async () => {
		const connector = {
			request(input: Parameters<PinnedHttpsConnector["request"]>[0]) {
				return Promise.resolve({
					statusCode: 200,
					rawHeaders: ["Content-Type", "text/plain"],
					headers: {},
					body: Uint8Array.from([0xc3, 0x28]),
					peerAddress: input.address.address,
				});
			},
		} satisfies PinnedHttpsConnector;
		const service = new OfficialDocumentationService({ transport: fakeTransport(connector) });
		const registry = loadDefinition(createDefinition("fixture", "cli_fixture", { docs: { official: [source()] } }));
		const result = await service.search({ registry, query: "invalid" });
		expect(result.outcomes[0]).toMatchObject({ status: "failed", code: "invalid_utf8" });
		expect(service.diagnostics().cache.entries).toBe(0);
		await service.close();
	});

	it("bounds and deterministically orders focused lexical snippets", () => {
		const query = validateOfficialDocumentationQuery("--glob authentication");
		const text = [
			"# Authentication",
			"Use authentication with --glob-like flags only in this fixture.",
			"x".repeat(10_000) + " authentication --glob",
			"# Other",
			"authentication --glob again",
		].join("\n");
		const snippets = searchOfficialDocument(text, query, "manual");
		expect(snippets.length).toBeGreaterThan(0);
		expect(snippets.length).toBeLessThanOrEqual(8);
		expect(snippets.every(({ text: value }) => Buffer.byteLength(value, "utf8") <= 2 * 1024)).toBe(true);
		const hugeLineSnippet = searchOfficialDocument(`${"x".repeat(10_000)} authentication --glob`, query, "manual")[0];
		expect(hugeLineSnippet?.text).toContain("authentication --glob");
		expect([...snippets].sort((a, b) => b.score - a.score || a.offset - b.offset)).toEqual(snippets);
	});

	it("strictly validates lexical queries", () => {
		expect(() => validateOfficialDocumentationQuery("auth token")).not.toThrow();
		for (const query of [
			"",
			"x".repeat(257),
			"bad\u0000query",
			Array.from({ length: 17 }, (_, i) => `t${String(i)}`).join(" "),
		]) {
			expect(() => validateOfficialDocumentationQuery(query)).toThrow(OfficialDocumentationRequestError);
		}
	});

	it("parses configured semver evidence conservatively and reports every honest alignment state", () => {
		expect(parseSemverFirst("gh version 2.45.1 (build)")).toBe("2.45.1");
		expect(parseSemverFirst("versions 1.2.3 and 2.3.4")).toBeNull();
		expect(parseSemverFirst("arbitrary latest")).toBeNull();
		expect(parseSemverFirst("tool 1.2.3-01")).toBeNull();
		const evidence = versionEvidence("2.45.1");
		expect(
			classifyOfficialDocumentationAlignment(source({ alignment: { mode: "exact", version: "2.45.1" } }), evidence)
				.state,
		).toBe("exact");
		expect(
			classifyOfficialDocumentationAlignment(source({ alignment: { mode: "exact", version: "2.44.0" } }), evidence)
				.state,
		).toBe("mismatch");
		expect(
			classifyOfficialDocumentationAlignment(
				source({ alignment: { mode: "compatible", version: "2.45.9", precision: "major_minor" } }),
				evidence,
			).state,
		).toBe("major_minor_match");
		expect(
			classifyOfficialDocumentationAlignment(
				source({ alignment: { mode: "compatible", version: "2.9.0", precision: "major" } }),
				evidence,
			).state,
		).toBe("major_match");
		expect(
			classifyOfficialDocumentationAlignment(
				source({ alignment: { mode: "compatible", version: "0.4.2", precision: "major_minor" } }),
				versionEvidence("0.4.1"),
			).state,
		).toBe("mismatch");
		expect(
			classifyOfficialDocumentationAlignment(
				source({ alignment: { mode: "compatible", version: "2.45.9", precision: "major_minor" } }),
				versionEvidence("2.45.1-beta.1"),
			).state,
		).toBe("mismatch");
		expect(classifyOfficialDocumentationAlignment(source({ alignment: { mode: "latest" } }), evidence).state).toBe(
			"unversioned",
		);
		expect(classifyOfficialDocumentationAlignment(source({ alignment: { mode: "unknown" } }), evidence).state).toBe(
			"unknown",
		);
		expect(
			classifyOfficialDocumentationAlignment(source({ alignment: { mode: "exact", version: "2.45.1" } })).state,
		).toBe("unknown");
	});

	it("isolates waiter cancellation and counts aborted flights until cleanup drains", async () => {
		const cache = new OfficialDocumentationCache();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const loader = vi.fn(async (signal: AbortSignal) => {
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else {
					signal.addEventListener(
						"abort",
						() => {
							resolve();
						},
						{ once: true },
					);
				}
			});
			await gate;
			if (signal.aborted) throw new Error("cancelled loader");
			return cachedDocument("shared");
		});
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = cache.getOrLoad({ key: "shared" }, firstController.signal, loader);
		const second = cache.getOrLoad({ key: "shared" }, secondController.signal, loader);
		firstController.abort();
		await expect(first).rejects.toThrow("waiter cancelled");
		expect(cache.stats().inFlight).toBe(1);
		secondController.abort();
		await vi.waitFor(() => {
			expect(cache.stats().inFlight).toBe(1);
		});
		release();
		await expect(second).rejects.toThrow("waiter cancelled");
		await vi.waitFor(() => {
			expect(cache.stats().inFlight).toBe(0);
		});
		expect(cache.stats().entries).toBe(0);
		await cache.close();
	});

	it("reports the official-cache concurrent-flight limit", async () => {
		const cache = new OfficialDocumentationCache({ maxFlights: 1 });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = cache.getOrLoad({ key: 1 }, undefined, async () => {
			await gate;
			return cachedDocument("first");
		});
		await expect(
			cache.getOrLoad({ key: 2 }, undefined, () => Promise.resolve(cachedDocument("second"))),
		).rejects.toThrow("concurrent-flight limit");
		release();
		await expect(first).resolves.toMatchObject({ text: "first" });
		await cache.close();
	});

	it("expires and evicts success-only cache entries with immutable copies", async () => {
		let now = 0;
		const cache = new OfficialDocumentationCache({ maxEntries: 1, maxBytes: 10_000, ttlMs: 10, now: () => now });
		let loads = 0;
		const load = () => {
			loads += 1;
			return Promise.resolve(cachedDocument(`text-${String(loads)}`));
		};
		const first = await cache.getOrLoad({ key: 1 }, undefined, load);
		(first as { text: string }).text = "mutated";
		expect((await cache.getOrLoad({ key: 1 }, undefined, load)).text).toBe("text-1");
		await cache.getOrLoad({ key: 2 }, undefined, load);
		expect(cache.stats().evictions).toBe(1);
		now = 20;
		await cache.getOrLoad({ key: 2 }, undefined, load);
		expect(loads).toBe(3);
		await cache.close();
	});
});

function source(overrides: Partial<OfficialDocumentationSource> = {}): OfficialDocumentationSource {
	return {
		id: "manual",
		title: "Fixture manual",
		url: "https://example.com/docs",
		allowed_hosts: ["example.com"],
		allowed_path_prefix: "/docs",
		media: "text",
		alignment: { mode: "latest" },
		...overrides,
	};
}

function fakeTransport(connector: PinnedHttpsConnector): SecureHttpsTransport {
	return new SecureHttpsTransport({
		resolver: {
			resolve() {
				return Promise.resolve([{ address: "8.8.8.8", family: 4 }]);
			},
		},
		connector,
	});
}

function connectorSpy(body: string, mediaType: string) {
	return {
		request: vi.fn((input: Parameters<PinnedHttpsConnector["request"]>[0]) =>
			Promise.resolve(response(body, mediaType, input.address.address)),
		),
	} satisfies PinnedHttpsConnector;
}

function response(body: string, mediaType: string, peerAddress: string) {
	return {
		statusCode: 200,
		rawHeaders: ["Content-Type", mediaType],
		headers: {},
		body: Uint8Array.from(Buffer.from(body)),
		peerAddress,
	};
}

function versionEvidence(version: string): InstalledVersionEvidence {
	return {
		parser: "semver_first",
		raw: `tool ${version}`,
		normalizedVersion: version,
		source: "installed_version_command",
		definitionSha256: "a".repeat(64),
		executableIdentitySha256: "b".repeat(64),
	};
}

function cachedDocument(text: string) {
	return {
		text,
		configuredUrl: "https://example.com/docs",
		finalUrl: "https://example.com/docs",
		redirects: [],
		mediaType: "text/plain",
		bodySha256: "a".repeat(64),
		bodyBytes: Buffer.byteLength(text, "utf8"),
		textSha256: "b".repeat(64),
		retrievedAt: "2026-01-01T00:00:00.000Z",
		cache: "miss" as const,
	};
}
