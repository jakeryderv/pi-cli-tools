import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
	OneShotPinnedHttpsAgent,
	SecureFetchError,
	SecureHttpsTransport,
	createOfficialRequestHeaders,
	createPinnedTlsConnectionPolicy,
	fetchAuthoritativeDocument,
	isPublicAddress,
	type AddressResolver,
	type PinnedHttpsConnector,
	type ResolvedAddress,
} from "../src/secure-fetch.js";
import type { OfficialDocumentationSource } from "../src/types.js";

describe("official documentation secure fetch boundary", () => {
	it("rejects special IPv4 and IPv6 ranges including mapped, documentation, benchmark, and multicast", () => {
		for (const address of [
			"0.0.0.0",
			"10.0.0.1",
			"100.64.0.1",
			"127.0.0.1",
			"169.254.169.254",
			"172.31.255.255",
			"192.0.2.1",
			"192.168.1.1",
			"198.18.0.1",
			"198.51.100.1",
			"203.0.113.1",
			"224.0.0.1",
			"255.255.255.255",
			"::",
			"::1",
			"::ffff:7f00:1",
			"64:ff9b::1",
			"100::1",
			"100:0:0:1::1",
			"2001:db8::1",
			"2002::1",
			"2620:4f:8000::1",
			"3fff::1",
			"fc00::1",
			"fe80::1",
			"ff02::1",
		]) {
			expect(isPublicAddress(address), address).toBe(false);
		}
		expect(isPublicAddress("8.8.8.8")).toBe(true);
		expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
		expect(isPublicAddress("100:0:0:2::1")).toBe(true);
		expect(isPublicAddress("2620:4f:7fff::1")).toBe(true);
		expect(isPublicAddress("2620:4f:8001::1")).toBe(true);
	});

	it("uses only fixed identity-encoding headers with no ambient credentials or proxy controls", () => {
		expect(createOfficialRequestHeaders()).toEqual({
			Accept: "text/html, text/plain, text/markdown, text/x-markdown",
			"Accept-Encoding": "identity",
			Connection: "close",
			"User-Agent": "pi-cli-tools",
		});
		for (const forbidden of ["authorization", "proxy-authorization", "cookie", "referer"]) {
			expect(Object.keys(createOfficialRequestHeaders()).map((name) => name.toLowerCase())).not.toContain(forbidden);
		}
	});

	it("pins the IP while retaining mandatory TLS SNI and hostname verification policy", () => {
		const policy = createPinnedTlsConnectionPolicy(new URL("https://docs.example.com/manual"), {
			address: "8.8.8.8",
			family: 4,
		});
		expect(policy).toEqual({
			host: "8.8.8.8",
			port: 443,
			servername: "docs.example.com",
			rejectUnauthorized: true,
			minVersion: "TLSv1.2",
		});
		expect(policy).not.toHaveProperty("checkServerIdentity");
	});

	it("withholds the one-shot agent socket until the selected address completes verified TLS", () => {
		const socket = new EventEmitter() as EventEmitter & {
			remoteAddress: string;
			destroy: ReturnType<typeof vi.fn>;
		};
		socket.remoteAddress = "8.8.8.8";
		socket.destroy = vi.fn();
		const dial = vi.fn(() => socket as never);
		const callback = vi.fn();
		const agent = new OneShotPinnedHttpsAgent({
			url: new URL("https://docs.example.com/manual"),
			address: { address: "8.8.8.8", family: 4 },
			dial,
		});
		agent.createConnection({}, callback);
		expect(callback).not.toHaveBeenCalled();
		expect(dial).toHaveBeenCalledWith({
			host: "8.8.8.8",
			port: 443,
			servername: "docs.example.com",
			rejectUnauthorized: true,
			minVersion: "TLSv1.2",
		});
		socket.emit("secureConnect");
		expect(callback).toHaveBeenCalledWith(null, socket);
		agent.destroy();
	});

	it("never releases a one-shot agent socket whose peer differs from the selected address", () => {
		const socket = new EventEmitter() as EventEmitter & {
			remoteAddress: string;
			destroy: ReturnType<typeof vi.fn>;
		};
		socket.remoteAddress = "1.1.1.1";
		socket.destroy = vi.fn();
		const callback = vi.fn();
		const agent = new OneShotPinnedHttpsAgent({
			url: new URL("https://docs.example.com/manual"),
			address: { address: "8.8.8.8", family: 4 },
			dial: () => socket as never,
		});
		agent.createConnection({}, callback);
		socket.emit("secureConnect");
		expect(socket.destroy).toHaveBeenCalledWith(expect.objectContaining({ code: "peer_mismatch" }));
		expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: "peer_mismatch" }), socket);
		agent.destroy();
	});

	it("rejects an entire mixed DNS answer set before connecting and pins a validated address", async () => {
		const connector = connectorSpy();
		const mixed = transport(
			() =>
				Promise.resolve([
					{ address: "8.8.8.8", family: 4 },
					{ address: "127.0.0.1", family: 4 },
				]),
			connector,
		);
		await expect(fetchAuthoritativeDocument(source(), undefined, mixed)).rejects.toMatchObject({
			code: "unsafe_address",
		});
		expect(connector.request).not.toHaveBeenCalled();

		const pinnedConnector = connectorSpy();
		const pinned = transport(() => Promise.resolve([{ address: "8.8.8.8", family: 4 }]), pinnedConnector);
		await fetchAuthoritativeDocument(source(), undefined, pinned);
		expect(pinnedConnector.request).toHaveBeenCalledTimes(1);
		expect(pinnedConnector.inputs[0]?.url.hostname).toBe("example.com");
		expect(pinnedConnector.inputs[0]?.address).toEqual({ address: "8.8.8.8", family: 4 });
	});

	it("rejects empty, oversized, and malformed DNS answer sets", async () => {
		const answers = [
			[],
			Array.from({ length: 17 }, () => ({ address: "8.8.8.8", family: 4 as const })),
			[{ address: "not-an-address", family: 4 as const }],
			[{ address: "8.8.8.8", family: 6 as const }],
		];
		for (const result of answers) {
			const guarded = transport(() => Promise.resolve(result), connectorSpy());
			await expect(fetchAuthoritativeDocument(source(), undefined, guarded)).rejects.toMatchObject({
				code: "dns_error",
			});
		}
	});

	it("attempts at most two already-vetted addresses without re-resolving", async () => {
		let resolutions = 0;
		const resolver: AddressResolver = {
			resolve() {
				resolutions += 1;
				return Promise.resolve([
					{ address: "1.1.1.1", family: 4 },
					{ address: "8.8.8.8", family: 4 },
					{ address: "9.9.9.9", family: 4 },
				]);
			},
		};
		const connector = {
			request: vi.fn(() => Promise.reject(new Error("connect failed"))),
		} satisfies PinnedHttpsConnector;
		await expect(
			fetchAuthoritativeDocument(source(), undefined, new SecureHttpsTransport({ resolver, connector })),
		).rejects.toMatchObject({ code: "network_error" });
		expect(resolutions).toBe(1);
		expect(connector.request).toHaveBeenCalledTimes(2);
	});

	it("classifies TLS verification failures after bounded address failover", async () => {
		const tlsFailure = Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" });
		const connector = { request: vi.fn(() => Promise.reject(tlsFailure)) } satisfies PinnedHttpsConnector;
		await expect(
			fetchAuthoritativeDocument(source(), undefined, transport(publicDns, connector)),
		).rejects.toMatchObject({
			code: "tls_error",
		});
		expect(connector.request).toHaveBeenCalledTimes(1);
	});

	it("does not retry response-policy failures on another address", async () => {
		const connector = {
			request: vi.fn(() => Promise.reject(new SecureFetchError("wrong_type", "wrong media"))),
		} satisfies PinnedHttpsConnector;
		await expect(
			fetchAuthoritativeDocument(
				source(),
				undefined,
				transport(
					() =>
						Promise.resolve([
							{ address: "1.1.1.1", family: 4 },
							{ address: "8.8.8.8", family: 4 },
						]),
					connector,
				),
			),
		).rejects.toMatchObject({ code: "wrong_type" });
		expect(connector.request).toHaveBeenCalledTimes(1);
	});

	it("does not re-resolve a hop after selecting its pinned address", async () => {
		let resolutions = 0;
		const resolver: AddressResolver = {
			resolve() {
				resolutions += 1;
				return Promise.resolve([
					resolutions === 1 ? { address: "8.8.8.8", family: 4 as const } : { address: "127.0.0.1", family: 4 as const },
				]);
			},
		};
		await fetchAuthoritativeDocument(
			source(),
			undefined,
			new SecureHttpsTransport({ resolver, connector: connectorSpy() }),
		);
		expect(resolutions).toBe(1);
	});

	it("revalidates and separately resolves every allowed redirect hop", async () => {
		const resolved: string[] = [];
		const resolver: AddressResolver = {
			resolve(hostname) {
				resolved.push(hostname);
				return Promise.resolve([{ address: hostname === "example.com" ? "8.8.8.8" : "1.1.1.1", family: 4 }]);
			},
		};
		let call = 0;
		const connector: PinnedHttpsConnector = {
			request(input) {
				call += 1;
				if (call === 1) {
					return Promise.resolve(
						response(302, "", input.address.address, ["Location", "https://docs.example.com/docs/final"]),
					);
				}
				return Promise.resolve(response(200, "final text", input.address.address));
			},
		};
		const result = await fetchAuthoritativeDocument(
			source({ allowed_hosts: ["example.com", "docs.example.com"] }),
			undefined,
			new SecureHttpsTransport({ resolver, connector }),
		);
		expect(resolved).toEqual(["example.com", "docs.example.com"]);
		expect(result.finalUrl).toBe("https://docs.example.com/docs/final");
		expect(result.redirects).toEqual(["https://docs.example.com/docs/final"]);
	});

	it("enforces a caller-shared aggregate HTTP hop budget", async () => {
		const connector = connectorSpy(response(302, "", "8.8.8.8", ["Location", "/docs/final"]));
		await expect(
			fetchAuthoritativeDocument(source(), undefined, transport(publicDns, connector), undefined, { remaining: 1 }),
		).rejects.toMatchObject({ code: "redirect_error" });
		expect(connector.request).toHaveBeenCalledTimes(1);
	});

	it.each([
		["undeclared host", "https://evil.example/docs", "redirect_error"],
		["HTTP downgrade", "http://example.com/docs/final", "redirect_error"],
		["non-default port", "https://example.com:444/docs/final", "redirect_error"],
		["query target", "https://example.com/docs/final?q=x", "redirect_error"],
		["path escape", "https://example.com/other", "redirect_error"],
		["path sibling", "https://example.com/docsevil", "redirect_error"],
		["encoded path separator", "https://example.com/docs%2f..%2fadmin", "redirect_error"],
	])("rejects %s redirects", async (_name, location, code) => {
		const connector = connectorSpy(response(302, "", "8.8.8.8", ["Location", location]));
		await expect(
			fetchAuthoritativeDocument(source(), undefined, transport(publicDns, connector)),
		).rejects.toMatchObject({
			code,
		});
	});

	it("rejects duplicate Location, peer changes, wrong type, compression, overflow, and truncation", async () => {
		const cases = [
			response(302, "", "8.8.8.8", ["Location", "/docs/a", "Location", "/docs/b"]),
			response(503, "", "8.8.8.8"),
			response(200, "", "8.8.8.8"),
			response(200, "ok", "1.1.1.1"),
			response(200, "ok", "8.8.8.8", ["Content-Type", "application/json"]),
			response(200, "ok", "8.8.8.8", ["Content-Type", "text/plain", "Content-Type", "text/plain"]),
			response(200, "ok", "8.8.8.8", ["Content-Type", "text/plain", "Content-Encoding", "gzip"]),
			response(200, "ok", "8.8.8.8", ["Content-Type", "text/plain", "X-Large", "x".repeat(17 * 1024)]),
			response(200, "x".repeat(1024 * 1024 + 1), "8.8.8.8"),
			response(200, "short", "8.8.8.8", ["Content-Type", "text/plain", "Content-Length", "20"]),
		];
		const codes = [
			"redirect_error",
			"status_error",
			"empty_document",
			"peer_mismatch",
			"wrong_type",
			"wrong_type",
			"unsupported_encoding",
			"headers_too_large",
			"body_too_large",
			"truncated_body",
		];
		for (const [index, item] of cases.entries()) {
			await expect(
				fetchAuthoritativeDocument(source({ media: "text" }), undefined, transport(publicDns, connectorSpy(item))),
			).rejects.toMatchObject({ code: codes[index] });
		}
	});

	it("returns structured cancellation while DNS is pending", async () => {
		const resolver: AddressResolver = {
			resolve(_hostname, signal) {
				return new Promise((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				});
			},
		};
		const controller = new AbortController();
		const pending = fetchAuthoritativeDocument(
			source(),
			controller.signal,
			new SecureHttpsTransport({ resolver, connector: connectorSpy() }),
		);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "cancelled" });
	});
});

function source(overrides: Partial<OfficialDocumentationSource> = {}): OfficialDocumentationSource {
	return {
		id: "manual",
		title: "Manual",
		url: "https://example.com/docs",
		allowed_hosts: ["example.com"],
		allowed_path_prefix: "/docs",
		media: "text",
		alignment: { mode: "latest" },
		...overrides,
	};
}

function publicDns(): Promise<readonly ResolvedAddress[]> {
	return Promise.resolve([{ address: "8.8.8.8", family: 4 }]);
}

function transport(resolve: AddressResolver["resolve"], connector: PinnedHttpsConnector): SecureHttpsTransport {
	return new SecureHttpsTransport({ resolver: { resolve }, connector });
}

function connectorSpy(initial = response(200, "manual text", "8.8.8.8")) {
	const inputs: Parameters<PinnedHttpsConnector["request"]>[0][] = [];
	return {
		inputs,
		request: vi.fn((input: Parameters<PinnedHttpsConnector["request"]>[0]) => {
			inputs.push(input);
			return Promise.resolve(initial);
		}),
	};
}

function response(statusCode: number, body: string | Uint8Array, peerAddress: string, extraHeaders: string[] = []) {
	const bytes = typeof body === "string" ? Buffer.from(body) : body;
	const hasType = extraHeaders.some((value) => value.toLowerCase() === "content-type");
	const rawHeaders = hasType ? extraHeaders : ["Content-Type", "text/plain", ...extraHeaders];
	return {
		statusCode,
		rawHeaders,
		headers: {},
		body: Uint8Array.from(bytes),
		peerAddress,
	};
}
