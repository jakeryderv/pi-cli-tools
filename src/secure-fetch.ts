import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { Agent as HttpsAgent, request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

import {
	CLI_OFFICIAL_BODY_INACTIVITY_MS,
	CLI_OFFICIAL_CONNECT_TIMEOUT_MS,
	CLI_OFFICIAL_DNS_TIMEOUT_MS,
	CLI_OFFICIAL_HEADERS_TIMEOUT_MS,
	CLI_OFFICIAL_MAX_ADDRESS_ATTEMPTS,
	CLI_OFFICIAL_MAX_BODY_BYTES,
	CLI_OFFICIAL_MAX_DNS_ANSWERS,
	CLI_OFFICIAL_MAX_HEADER_BYTES,
	CLI_OFFICIAL_MAX_HTTP_HOPS,
	CLI_OFFICIAL_MAX_REDIRECTS,
	CLI_OFFICIAL_SOURCE_TIMEOUT_MS,
} from "./limits.js";
import type { OfficialDocumentationFailureCode, OfficialDocumentationSource } from "./types.js";

export interface ResolvedAddress {
	readonly address: string;
	readonly family: 4 | 6;
}

export interface SecureFetchResponse {
	readonly configuredUrl: string;
	readonly finalUrl: string;
	readonly redirects: readonly string[];
	readonly mediaType: string;
	readonly charset: "utf-8";
	readonly body: Uint8Array;
	readonly bodySha256: string;
	readonly retrievedAt: string;
}

interface PinnedResponse {
	readonly statusCode: number;
	readonly rawHeaders: readonly string[];
	readonly headers: IncomingHttpHeaders;
	readonly body: Uint8Array;
	readonly peerAddress: string;
}

export interface AddressResolver {
	resolve(hostname: string, signal: AbortSignal): Promise<readonly ResolvedAddress[]>;
}

export interface PinnedTlsConnectionPolicy {
	readonly host: string;
	readonly port: 443;
	readonly servername: string;
	readonly rejectUnauthorized: true;
	readonly minVersion: "TLSv1.2";
}

export function createPinnedTlsConnectionPolicy(url: URL, address: ResolvedAddress): PinnedTlsConnectionPolicy {
	return {
		host: address.address,
		port: 443,
		servername: url.hostname,
		rejectUnauthorized: true,
		minVersion: "TLSv1.2",
	};
}

export function createOfficialRequestHeaders(): Readonly<Record<string, string>> {
	return {
		Accept: "text/html, text/plain, text/markdown, text/x-markdown",
		"Accept-Encoding": "identity",
		Connection: "close",
		"User-Agent": "pi-cli-tools",
	};
}

export interface PinnedHttpsConnector {
	request(input: {
		readonly url: URL;
		readonly address: ResolvedAddress;
		readonly signal: AbortSignal;
		readonly maxBodyBytes: number;
		readonly expectedMedia: OfficialDocumentationSource["media"];
	}): Promise<PinnedResponse>;
}

export class SecureFetchError extends Error {
	readonly code: OfficialDocumentationFailureCode;
	readonly addressRetryable: boolean;
	readonly transferredBodyBytes: number;

	constructor(
		code: OfficialDocumentationFailureCode,
		message: string,
		options: ErrorOptions & { readonly addressRetryable?: boolean; readonly transferredBodyBytes?: number } = {},
	) {
		super(message, options);
		this.name = "SecureFetchError";
		this.code = code;
		this.addressRetryable = options.addressRetryable ?? false;
		this.transferredBodyBytes = options.transferredBodyBytes ?? 0;
	}
}

/** Auditable per-hop resolver and pinned HTTPS transport. Registry/model data cannot replace its policy. */
export class SecureHttpsTransport {
	readonly #resolver: AddressResolver;
	readonly #connector: PinnedHttpsConnector;

	constructor(options: { readonly resolver?: AddressResolver; readonly connector?: PinnedHttpsConnector } = {}) {
		this.#resolver = options.resolver ?? new SystemAddressResolver();
		this.#connector = options.connector ?? new NodePinnedHttpsConnector();
	}

	async requestHop(
		url: URL,
		source: OfficialDocumentationSource,
		signal: AbortSignal,
		maxBodyBytes = CLI_OFFICIAL_MAX_BODY_BYTES,
	): Promise<PinnedResponse> {
		validateOfficialUrlForSource(url, source);
		let answers: readonly ResolvedAddress[];
		try {
			answers = await this.#resolver.resolve(url.hostname, signal);
		} catch (error) {
			if (error instanceof SecureFetchError) throw error;
			if (signal.aborted) throw cancellationError(signal);
			throw new SecureFetchError("dns_error", "Authoritative host DNS resolution failed", { cause: error });
		}
		if (answers.length < 1 || answers.length > CLI_OFFICIAL_MAX_DNS_ANSWERS) {
			throw new SecureFetchError("dns_error", "Authoritative host returned an invalid number of DNS answers");
		}
		const normalized = answers.map(normalizeResolvedAddress);
		if (normalized.some(({ address }) => !isPublicAddress(address))) {
			throw new SecureFetchError("unsafe_address", "Authoritative host resolved to a non-public or special address");
		}
		const stable = [...normalized]
			.sort((left, right) => left.family - right.family || compareStrings(left.address, right.address))
			.filter((answer, index, values) => index === 0 || answer.address !== values[index - 1]?.address);
		let lastError: unknown;
		for (const address of stable.slice(0, CLI_OFFICIAL_MAX_ADDRESS_ATTEMPTS)) {
			try {
				const response = await this.#connector.request({
					url,
					address,
					signal,
					maxBodyBytes,
					expectedMedia: source.media,
				});
				if (!addressesEqual(response.peerAddress, address.address)) {
					throw new SecureFetchError("peer_mismatch", "TLS peer address did not match the prevalidated DNS address");
				}
				return response;
			} catch (error) {
				if (signal.aborted) throw cancellationError(signal);
				const classified = classifyNetworkError(error, !(error instanceof SecureFetchError));
				if (!classified.addressRetryable) throw classified;
				lastError = classified;
			}
		}
		if (lastError instanceof SecureFetchError) throw lastError;
		throw classifyNetworkError(lastError);
	}
}

export interface OfficialHttpHopBudget {
	remaining: number;
}

/** Fetch one fixed source with manual, fully revalidated redirects. */
export async function fetchAuthoritativeDocument(
	source: OfficialDocumentationSource,
	signal?: AbortSignal,
	transport: SecureHttpsTransport = new SecureHttpsTransport(),
	maxBodyBytes = CLI_OFFICIAL_MAX_BODY_BYTES,
	hopBudget: OfficialHttpHopBudget = { remaining: CLI_OFFICIAL_MAX_HTTP_HOPS },
): Promise<SecureFetchResponse> {
	if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > CLI_OFFICIAL_MAX_BODY_BYTES) {
		throw new SecureFetchError("body_too_large", "Official documentation aggregate body budget was exhausted");
	}
	const deadline = new AbortController();
	const timer = setTimeout(() => {
		deadline.abort(new SecureFetchError("timeout", "Official documentation source deadline exceeded"));
	}, CLI_OFFICIAL_SOURCE_TIMEOUT_MS);
	timer.unref();
	const aggregate = AbortSignal.any(
		[signal, deadline.signal].filter((item): item is AbortSignal => item !== undefined),
	);
	let current = parseAndValidateOfficialUrl(source.url, source);
	const visited = new Set<string>();
	const redirects: string[] = [];
	let transferredBodyBytes = 0;
	try {
		for (let hop = 0; ; hop += 1) {
			if (aggregate.aborted) throw cancellationError(aggregate);
			if (hopBudget.remaining < 1) {
				throw new SecureFetchError("redirect_error", "Official documentation aggregate HTTP hop limit exceeded");
			}
			hopBudget.remaining -= 1;
			if (visited.has(current.href))
				throw new SecureFetchError("redirect_error", "Official documentation redirect loop");
			visited.add(current.href);
			const response = await transport.requestHop(current, source, aggregate, maxBodyBytes);
			transferredBodyBytes += response.body.byteLength;
			const headerBytes = rawHeaderBytes(response.rawHeaders);
			if (headerBytes > CLI_OFFICIAL_MAX_HEADER_BYTES) {
				throw new SecureFetchError("headers_too_large", "Official documentation response headers exceeded the limit");
			}
			if (isRedirectStatus(response.statusCode)) {
				if (hop >= CLI_OFFICIAL_MAX_REDIRECTS) {
					throw new SecureFetchError("redirect_error", "Official documentation redirect limit exceeded");
				}
				const locations = rawHeaderValues(response.rawHeaders, "location");
				if (locations.length !== 1 || Buffer.byteLength(locations[0] ?? "", "utf8") > 2_048) {
					throw new SecureFetchError(
						"redirect_error",
						"Official documentation redirect Location is missing or ambiguous",
					);
				}
				let target: URL;
				try {
					target = new URL(locations[0] ?? "", current);
				} catch (error) {
					throw new SecureFetchError("redirect_error", "Official documentation redirect Location is malformed", {
						cause: error,
					});
				}
				validateOfficialUrlForSource(target, source);
				redirects.push(target.href);
				current = target;
				continue;
			}
			if (response.statusCode !== 200) {
				throw new SecureFetchError(
					"status_error",
					`Official documentation returned HTTP ${String(response.statusCode)}`,
				);
			}
			if (response.body.byteLength > maxBodyBytes) {
				throw new SecureFetchError("body_too_large", "Official documentation body exceeded the byte limit");
			}
			validateResponseEncoding(response.rawHeaders);
			const mediaType = validateResponseMedia(response.rawHeaders, source.media);
			const contentLength = parseContentLength(response.rawHeaders, maxBodyBytes);
			if (contentLength !== null && contentLength !== response.body.byteLength) {
				throw new SecureFetchError("truncated_body", "Official documentation body length did not match Content-Length");
			}
			if (response.body.byteLength < 1) {
				throw new SecureFetchError("empty_document", "Official documentation response was empty");
			}
			return {
				configuredUrl: source.url,
				finalUrl: current.href,
				redirects,
				mediaType,
				charset: "utf-8",
				body: Uint8Array.from(response.body),
				bodySha256: createHash("sha256").update(response.body).digest("hex"),
				retrievedAt: new Date().toISOString(),
			};
		}
	} catch (error) {
		if (aggregate.aborted) throw cancellationError(aggregate);
		throw withTransferredBodyBytes(error, transferredBodyBytes);
	} finally {
		clearTimeout(timer);
	}
}

export function parseAndValidateOfficialUrl(value: string, source: OfficialDocumentationSource): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new SecureFetchError("redirect_error", "Official documentation URL is malformed", { cause: error });
	}
	validateOfficialUrlForSource(url, source);
	return url;
}

export function validateOfficialUrlForSource(url: URL, source: OfficialDocumentationSource): void {
	const raw = url.href;
	if (
		url.protocol !== "https:" ||
		url.port !== "" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		raw.includes("\\") ||
		hasAsciiControl(raw) ||
		!source.allowed_hosts.includes(url.hostname) ||
		!isSafeOfficialPath(url.pathname) ||
		!isSafeOfficialPath(source.allowed_path_prefix) ||
		!isAuthorizedOfficialPath(url.pathname, source.allowed_path_prefix) ||
		isIP(url.hostname) !== 0
	) {
		throw new SecureFetchError("redirect_error", "Official documentation URL escaped its configured HTTPS authority");
	}
}

function isAuthorizedOfficialPath(pathname: string, allowed: string): boolean {
	return (
		pathname === allowed || (allowed.endsWith("/") ? pathname.startsWith(allowed) : pathname.startsWith(`${allowed}/`))
	);
}

function isSafeOfficialPath(pathname: string): boolean {
	return pathname.startsWith("/") && !/%(?:25|2e|2f|5c)/iu.test(pathname) && !pathname.includes("\\");
}

/** Return true only for ordinary globally-routable unicast addresses. */
export function isPublicAddress(value: string): boolean {
	if (value.includes("%")) return false;
	const family = isIP(value);
	if (family === 4) {
		const address = parseIpv4(value);
		return address !== undefined && !IPV4_DENY.some(([network, bits]) => inCidr(address, 32, network, bits));
	}
	if (family === 6) {
		const address = parseIpv6(value);
		if (address === undefined) return false;
		return !IPV6_DENY.some(([network, bits]) => inCidr(address, 128, network, bits));
	}
	return false;
}

const IPV4_DENY = [
	[ipv4("0.0.0.0"), 8],
	[ipv4("10.0.0.0"), 8],
	[ipv4("100.64.0.0"), 10],
	[ipv4("127.0.0.0"), 8],
	[ipv4("169.254.0.0"), 16],
	[ipv4("172.16.0.0"), 12],
	[ipv4("192.0.0.0"), 24],
	[ipv4("192.0.2.0"), 24],
	[ipv4("192.31.196.0"), 24],
	[ipv4("192.52.193.0"), 24],
	[ipv4("192.88.99.0"), 24],
	[ipv4("192.168.0.0"), 16],
	[ipv4("192.175.48.0"), 24],
	[ipv4("198.18.0.0"), 15],
	[ipv4("198.51.100.0"), 24],
	[ipv4("203.0.113.0"), 24],
	[ipv4("224.0.0.0"), 4],
	[ipv4("240.0.0.0"), 4],
] as const;

const IPV6_DENY = [
	[ipv6("::"), 96],
	[ipv6("::ffff:0:0"), 96],
	[ipv6("64:ff9b::"), 96],
	[ipv6("64:ff9b:1::"), 48],
	[ipv6("100::"), 64],
	[ipv6("100:0:0:1::"), 64],
	[ipv6("2001::"), 23],
	[ipv6("2001:db8::"), 32],
	[ipv6("2002::"), 16],
	[ipv6("2620:4f:8000::"), 48],
	[ipv6("3fff::"), 20],
	[ipv6("5f00::"), 16],
	[ipv6("fc00::"), 7],
	[ipv6("fe80::"), 10],
	[ipv6("ff00::"), 8],
] as const;

class SystemAddressResolver implements AddressResolver {
	async resolve(hostname: string, signal: AbortSignal): Promise<readonly ResolvedAddress[]> {
		const resolver = new Resolver();
		const timeout = new AbortController();
		const timer = setTimeout(() => {
			timeout.abort(new SecureFetchError("timeout", "DNS deadline exceeded"));
		}, CLI_OFFICIAL_DNS_TIMEOUT_MS);
		timer.unref();
		const combined = AbortSignal.any([signal, timeout.signal]);
		const onAbort = () => {
			resolver.cancel();
		};
		combined.addEventListener("abort", onAbort, { once: true });
		try {
			const absolute = `${hostname}.`;
			const [v4, v6] = await Promise.allSettled([resolver.resolve4(absolute), resolver.resolve6(absolute)]);
			if (combined.aborted) throw cancellationError(combined);
			const answers: ResolvedAddress[] = [];
			if (v4.status === "fulfilled") answers.push(...v4.value.map((address) => ({ address, family: 4 as const })));
			if (v6.status === "fulfilled") answers.push(...v6.value.map((address) => ({ address, family: 6 as const })));
			if (answers.length === 0) throw new SecureFetchError("dns_error", "Authoritative host returned no addresses");
			return answers;
		} finally {
			clearTimeout(timer);
			combined.removeEventListener("abort", onAbort);
		}
	}
}

export type PinnedTlsDialer = (policy: PinnedTlsConnectionPolicy) => TLSSocket;

/** One-request agent that withholds its socket callback until TLS and peer verification succeed. */
export class OneShotPinnedHttpsAgent extends HttpsAgent {
	readonly #url: URL;
	readonly #address: ResolvedAddress;
	readonly #dial: PinnedTlsDialer;
	readonly #onSocket: (socket: TLSSocket) => void;
	readonly #onVerified: (peerAddress: string) => void;

	constructor(options: {
		readonly url: URL;
		readonly address: ResolvedAddress;
		readonly dial?: PinnedTlsDialer;
		readonly onSocket?: (socket: TLSSocket) => void;
		readonly onVerified?: (peerAddress: string) => void;
	}) {
		super({ keepAlive: false, maxCachedSessions: 0, maxSockets: 1, maxTotalSockets: 1 });
		this.#url = options.url;
		this.#address = options.address;
		this.#dial = options.dial ?? tlsConnect;
		this.#onSocket = options.onSocket ?? (() => undefined);
		this.#onVerified = options.onVerified ?? (() => undefined);
	}

	override createConnection(
		_options: RequestOptions,
		callback?: (error: Error | null, stream: Duplex) => void,
	): Duplex | null | undefined {
		const socket = this.#dial(createPinnedTlsConnectionPolicy(this.#url, this.#address));
		this.#onSocket(socket);
		if (!callback) {
			socket.destroy(
				new SecureFetchError("network_error", "Pinned HTTPS agent requires asynchronous connection setup"),
			);
			return undefined;
		}
		let supplied = false;
		const supply = (error?: Error) => {
			if (supplied) return;
			supplied = true;
			socket.removeListener("error", onConnectError);
			if (error) callback(error, socket);
			else callback(null, socket);
		};
		const onConnectError = (error: Error) => {
			supply(error);
		};
		socket.once("error", onConnectError);
		socket.once("secureConnect", () => {
			const peerAddress = socket.remoteAddress ?? "";
			if (!addressesEqual(peerAddress, this.#address.address)) {
				const error = new SecureFetchError("peer_mismatch", "TLS peer address changed after DNS pinning");
				socket.destroy(error);
				supply(error);
				return;
			}
			this.#onVerified(peerAddress);
			supply();
		});
		return undefined;
	}
}

export class NodePinnedHttpsConnector implements PinnedHttpsConnector {
	request(input: {
		readonly url: URL;
		readonly address: ResolvedAddress;
		readonly signal: AbortSignal;
		readonly maxBodyBytes: number;
		readonly expectedMedia: OfficialDocumentationSource["media"];
	}): Promise<PinnedResponse> {
		return new Promise((resolve, reject) => {
			let settled = false;
			let responseStarted = false;
			let bodyTimer: NodeJS.Timeout | undefined;
			let peerAddress = "";
			let connectingSocket: TLSSocket | undefined;
			const agent = new OneShotPinnedHttpsAgent({
				url: input.url,
				address: input.address,
				onSocket(socket) {
					connectingSocket = socket;
				},
				onVerified(address) {
					clearTimeout(connectTimer);
					peerAddress = address;
				},
			});
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(headersTimer);
				clearTimeout(connectTimer);
				if (bodyTimer) clearTimeout(bodyTimer);
				input.signal.removeEventListener("abort", onAbort);
				agent.destroy();
				callback();
			};
			const fail = (error: unknown) => {
				finish(() => {
					reject(classifyNetworkError(error, !responseStarted));
				});
			};
			const req = httpsRequest(input.url, {
				method: "GET",
				agent,
				maxHeaderSize: CLI_OFFICIAL_MAX_HEADER_BYTES,
				headers: createOfficialRequestHeaders(),
			});
			const onAbort = () => {
				const error = cancellationError(input.signal);
				connectingSocket?.destroy(error);
				req.destroy(error);
			};
			input.signal.addEventListener("abort", onAbort, { once: true });
			const connectTimer = setTimeout(() => {
				const error = new SecureFetchError("timeout", "HTTPS connect/TLS deadline exceeded", {
					addressRetryable: true,
				});
				connectingSocket?.destroy(error);
				req.destroy(error);
			}, CLI_OFFICIAL_CONNECT_TIMEOUT_MS);
			connectTimer.unref();
			const headersTimer = setTimeout(() => {
				req.destroy(new SecureFetchError("timeout", "HTTPS response-header deadline exceeded"));
			}, CLI_OFFICIAL_HEADERS_TIMEOUT_MS);
			headersTimer.unref();
			req.once("response", (response) => {
				responseStarted = true;
				clearTimeout(headersTimer);
				this.#consumeResponse(
					response,
					req,
					peerAddress,
					input.maxBodyBytes,
					input.expectedMedia,
					finish,
					fail,
					resolve,
					(timer) => {
						bodyTimer = timer;
					},
				);
			});
			req.once("error", fail);
			if (input.signal.aborted) onAbort();
			else req.end();
		});
	}

	#consumeResponse(
		response: IncomingMessage,
		req: ReturnType<typeof httpsRequest>,
		peerAddress: string,
		maxBodyBytes: number,
		expectedMedia: OfficialDocumentationSource["media"],
		finish: (callback: () => void) => void,
		fail: (error: unknown) => void,
		resolve: (response: PinnedResponse) => void,
		setBodyTimer: (timer: NodeJS.Timeout) => void,
	): void {
		const statusCode = response.statusCode ?? 0;
		if (statusCode !== 200) {
			response.destroy();
			finish(() => {
				resolve({
					statusCode,
					rawHeaders: [...response.rawHeaders],
					headers: response.headers,
					body: new Uint8Array(),
					peerAddress,
				});
			});
			return;
		}
		let bytes = 0;
		try {
			parseContentLength(response.rawHeaders, maxBodyBytes);
			validateResponseEncoding(response.rawHeaders);
			validateResponseMedia(response.rawHeaders, expectedMedia);
		} catch (error) {
			response.destroy();
			fail(withTransferredBodyBytes(error, bytes));
			return;
		}
		const chunks: Uint8Array[] = [];
		let inactivity: NodeJS.Timeout | undefined;
		const resetInactivity = () => {
			if (inactivity) clearTimeout(inactivity);
			inactivity = setTimeout(() => {
				req.destroy(
					new SecureFetchError("timeout", "Official documentation body became inactive", {
						transferredBodyBytes: bytes,
					}),
				);
			}, CLI_OFFICIAL_BODY_INACTIVITY_MS);
			inactivity.unref();
			setBodyTimer(inactivity);
		};
		resetInactivity();
		response.on("data", (chunk: Buffer) => {
			resetInactivity();
			bytes += chunk.byteLength;
			if (bytes > maxBodyBytes) {
				req.destroy(
					new SecureFetchError("body_too_large", "Official documentation body exceeded the byte limit", {
						transferredBodyBytes: bytes,
					}),
				);
				return;
			}
			chunks.push(Uint8Array.from(chunk));
		});
		response.once("aborted", () => {
			fail(
				new SecureFetchError("truncated_body", "Official documentation response aborted", {
					transferredBodyBytes: bytes,
				}),
			);
		});
		response.once("error", (error) => {
			fail(withTransferredBodyBytes(error, bytes));
		});
		response.once("end", () => {
			if (!response.complete) {
				fail(
					new SecureFetchError("truncated_body", "Official documentation response was truncated", {
						transferredBodyBytes: bytes,
					}),
				);
				return;
			}
			finish(() => {
				resolve({
					statusCode,
					rawHeaders: [...response.rawHeaders],
					headers: response.headers,
					body: Uint8Array.from(
						Buffer.concat(
							chunks.map((chunk) => Buffer.from(chunk)),
							bytes,
						),
					),
					peerAddress,
				});
			});
		});
	}
}

function validateResponseEncoding(rawHeaders: readonly string[]): void {
	const values = rawHeaderValues(rawHeaders, "content-encoding");
	if (values.length > 1 || (values.length === 1 && values[0]?.trim().toLowerCase() !== "identity")) {
		throw new SecureFetchError("unsupported_encoding", "Official documentation used unsupported content encoding");
	}
}

function validateResponseMedia(rawHeaders: readonly string[], expected: OfficialDocumentationSource["media"]): string {
	const values = rawHeaderValues(rawHeaders, "content-type");
	if (values.length !== 1)
		throw new SecureFetchError("wrong_type", "Official documentation Content-Type is missing or ambiguous");
	const parts = (values[0] ?? "").split(";").map((part) => part.trim().toLowerCase());
	const mediaType = parts[0] ?? "";
	const allowed =
		expected === "html"
			? ["text/html"]
			: expected === "markdown"
				? ["text/markdown", "text/x-markdown"]
				: ["text/plain"];
	if (!allowed.includes(mediaType))
		throw new SecureFetchError("wrong_type", "Official documentation media type did not match registry policy");
	const charset = parts.slice(1).filter((part) => part.startsWith("charset="));
	if (charset.length > 1 || (charset.length === 1 && !["charset=utf-8", "charset=utf8"].includes(charset[0] ?? ""))) {
		throw new SecureFetchError("wrong_type", "Official documentation must be UTF-8 compatible");
	}
	return mediaType;
}

function parseContentLength(rawHeaders: readonly string[], maxBodyBytes: number): number | null {
	const values = rawHeaderValues(rawHeaders, "content-length");
	if (values.length === 0) return null;
	if (values.length !== 1 || !/^\d+$/u.test(values[0] ?? "")) {
		throw new SecureFetchError("truncated_body", "Official documentation Content-Length is malformed or ambiguous");
	}
	const value = Number(values[0]);
	if (!Number.isSafeInteger(value))
		throw new SecureFetchError("body_too_large", "Official documentation Content-Length is invalid");
	if (value > maxBodyBytes)
		throw new SecureFetchError("body_too_large", "Official documentation Content-Length exceeds the limit");
	return value;
}

function rawHeaderValues(rawHeaders: readonly string[], name: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < rawHeaders.length; index += 2) {
		if (rawHeaders[index]?.toLowerCase() === name) values.push(rawHeaders[index + 1] ?? "");
	}
	return values;
}

function rawHeaderBytes(rawHeaders: readonly string[]): number {
	let bytes = 2;
	for (let index = 0; index < rawHeaders.length; index += 2) {
		bytes += Buffer.byteLength(rawHeaders[index] ?? "", "latin1");
		bytes += Buffer.byteLength(rawHeaders[index + 1] ?? "", "latin1") + 4;
	}
	return bytes;
}

function normalizeResolvedAddress(value: ResolvedAddress): ResolvedAddress {
	const family = isIP(value.address);
	if (family !== value.family) throw new SecureFetchError("dns_error", "DNS returned a malformed address family");
	const parsed = family === 4 ? parseIpv4(value.address) : parseIpv6(value.address);
	if (parsed === undefined) throw new SecureFetchError("dns_error", "DNS returned a malformed address");
	return { address: family === 4 ? formatIpv4(parsed) : value.address.toLowerCase(), family };
}

function addressesEqual(left: string, right: string): boolean {
	const leftFamily = isIP(left);
	const rightFamily = isIP(right);
	if (leftFamily !== rightFamily) return false;
	if (leftFamily === 4) return parseIpv4(left) === parseIpv4(right);
	if (leftFamily === 6) return parseIpv6(left) === parseIpv6(right);
	return false;
}

function parseIpv4(value: string): bigint | undefined {
	const parts = value.split(".");
	if (parts.length !== 4) return undefined;
	let result = 0n;
	for (const part of parts) {
		if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return undefined;
		const octet = Number(part);
		if (octet > 255) return undefined;
		result = (result << 8n) | BigInt(octet);
	}
	return result;
}

function parseIpv6(value: string): bigint | undefined {
	if (value.includes("%") || value.includes(".")) return undefined;
	const halves = value.toLowerCase().split("::");
	if (halves.length > 2) return undefined;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	if (halves.length === 1 && left.length !== 8) return undefined;
	if (halves.length === 2 && left.length + right.length >= 8) return undefined;
	const groups = [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right];
	if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return undefined;
	return groups.reduce((result, group) => (result << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

function inCidr(address: bigint, totalBits: number, network: bigint, prefixBits: number): boolean {
	const shift = BigInt(totalBits - prefixBits);
	return address >> shift === network >> shift;
}

function ipv4(value: string): bigint {
	const parsed = parseIpv4(value);
	if (parsed === undefined) throw new Error(`Invalid internal IPv4 constant: ${value}`);
	return parsed;
}

function ipv6(value: string): bigint {
	const parsed = parseIpv6(value);
	if (parsed === undefined) throw new Error(`Invalid internal IPv6 constant: ${value}`);
	return parsed;
}

function formatIpv4(value: bigint): string {
	return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join(".");
}

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function classifyNetworkError(error: unknown, addressRetryable = false): SecureFetchError {
	if (error instanceof SecureFetchError) return error;
	const candidate = error as NodeJS.ErrnoException | undefined;
	const code = candidate?.code ?? "";
	if (/^(?:ERR_TLS|CERT_|DEPTH_|UNABLE_|SELF_SIGNED|HOSTNAME_)/u.test(code)) {
		return new SecureFetchError("tls_error", "Official documentation TLS verification failed", {
			cause: error,
			addressRetryable,
		});
	}
	if (code === "HPE_HEADER_OVERFLOW") {
		return new SecureFetchError("headers_too_large", "Official documentation response headers exceeded the limit", {
			cause: error,
		});
	}
	return new SecureFetchError("network_error", "Official documentation network request failed", {
		cause: error,
		addressRetryable,
	});
}

function withTransferredBodyBytes(error: unknown, transferredBodyBytes: number): SecureFetchError {
	const classified = classifyNetworkError(error);
	if (classified.transferredBodyBytes >= transferredBodyBytes) return classified;
	return new SecureFetchError(classified.code, classified.message, {
		cause: classified,
		addressRetryable: classified.addressRetryable,
		transferredBodyBytes,
	});
}

function cancellationError(signal: AbortSignal): SecureFetchError {
	if (signal.reason instanceof SecureFetchError && signal.reason.code === "timeout") return signal.reason;
	return new SecureFetchError("cancelled", "Official documentation request was cancelled");
}

function hasAsciiControl(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code < 0x20 || code === 0x7f;
	});
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
