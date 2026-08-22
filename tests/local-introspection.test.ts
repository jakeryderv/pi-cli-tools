import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalIntrospectionCache, type LocalIntrospectionCacheKey } from "../src/cache.js";
import {
	LocalIntrospectionService,
	fingerprintExecutable,
	resolveExecutable,
	validateCliDocsSubcommand,
} from "../src/introspect.js";
import { CLI_INTROSPECTION_DOCUMENT_MAX_BYTES } from "../src/limits.js";
import { runCliCapture } from "../src/runner.js";
import type { CliDiscovery, LocalIntrospectionSuccess, RegistryDefinition } from "../src/types.js";

const describePosix = process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip;

describe("local documentation selector validation", () => {
	it("accepts bounded command paths and rejects option, shell, path, whitespace, Unicode, and size confusion", () => {
		expect(validateCliDocsSubcommand(undefined)).toMatchObject({ valid: true, subcommand: [] });
		expect(validateCliDocsSubcommand(["pr", "create:v2"])).toMatchObject({
			valid: true,
			subcommand: ["pr", "create:v2"],
		});
		for (const value of [
			[],
			[""],
			["--help"],
			["--"],
			["../x"],
			["a/b"],
			["a b"],
			["$(touch-x)"],
			["é"],
			["x".repeat(65)],
			Array.from({ length: 9 }, () => "x"),
			"pr",
		]) {
			expect(validateCliDocsSubcommand(value).valid, JSON.stringify(value)).toBe(false);
		}
	});
});

describe("focused local introspection cache", () => {
	it("uses structured keys, deterministic LRU bounds, success-only insertion, and identical-flight deduplication", async () => {
		const cache = new LocalIntrospectionCache({ maxEntries: 2, maxBytes: 4_096, maxFlights: 2 });
		let loads = 0;
		let resolveDeferred: ((value: LocalIntrospectionSuccess) => void) | undefined;
		const deferred = new Promise<LocalIntrospectionSuccess>((resolve) => {
			resolveDeferred = resolve;
		});
		const keyA = cacheKey("a", "help", ["a"]);
		const first = cache.getOrLoad(keyA, undefined, () => {
			loads += 1;
			return deferred;
		});
		const second = cache.getOrLoad(keyA, undefined, () => {
			loads += 1;
			return deferred;
		});
		resolveDeferred?.(success("help", "A"));
		const completed = await Promise.all([first, second]);
		expect(completed.map(({ cache: status }) => status)).toEqual(["miss", "miss"]);
		expect(loads).toBe(1);
		(completed[0].command.args as string[]).push("mutated-return-handle");
		const cachedA = await cache.getOrLoad(keyA, undefined, () => Promise.resolve(success("help", "wrong")));
		expect(cachedA.cache).toBe("hit");
		expect(cachedA.command.args).toEqual([]);

		await cache.getOrLoad(cacheKey("b", "help", ["b"]), undefined, () => Promise.resolve(success("help", "B")));
		await cache.getOrLoad(keyA, undefined, () => Promise.resolve(success("help", "wrong")));
		await cache.getOrLoad(cacheKey("c", "help", ["c"]), undefined, () => Promise.resolve(success("help", "C")));
		expect(cache.stats()).toMatchObject({ entries: 2, deduplicated: 1, evictions: 1 });

		let failures = 0;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			await expect(
				cache.getOrLoad(cacheKey("failed", "help", []), undefined, () => {
					failures += 1;
					return Promise.reject(new Error("not cacheable"));
				}),
			).rejects.toThrow("not cacheable");
		}
		expect(failures).toBe(2);
		await cache.close();

		const byteBounded = new LocalIntrospectionCache({ maxEntries: 20, maxBytes: 1_500 });
		for (const id of ["bytes-a", "bytes-b", "bytes-c"]) {
			await byteBounded.getOrLoad(cacheKey(id, "help", [id]), undefined, () =>
				Promise.resolve(success("help", id.repeat(50))),
			);
		}
		expect(byteBounded.stats().bytes).toBeLessThanOrEqual(1_500);
		expect(byteBounded.stats().evictions).toBeGreaterThan(0);
		await byteBounded.close();
	});

	it("keeps cancelled loaders in the concurrency bound until settlement", async () => {
		const cache = new LocalIntrospectionCache({ maxFlights: 1 });
		const controller = new AbortController();
		let rejectLoader: ((error: Error) => void) | undefined;
		const pending = cache.getOrLoad(
			cacheKey("draining", "help", []),
			controller.signal,
			(signal) =>
				new Promise((_resolve, reject) => {
					rejectLoader = reject;
					signal.addEventListener("abort", () => undefined, { once: true });
				}),
		);
		await Promise.resolve();
		controller.abort();
		await expect(
			cache.getOrLoad(cacheKey("new", "help", []), undefined, () => Promise.resolve(success("help", "new"))),
		).rejects.toThrow("concurrent-flight limit");
		expect(cache.stats().inFlight).toBe(1);
		rejectLoader?.(new Error("drained"));
		await expect(pending).rejects.toThrow("waiter cancelled");
		const admitted = await cache.getOrLoad(cacheKey("new", "help", []), undefined, () =>
			Promise.resolve(success("help", "new")),
		);
		expect(admitted.stdout).toBe("new");
		await cache.close();
	});

	it("keeps identity-invalidated loaders in the concurrency bound until settlement", async () => {
		const cache = new LocalIntrospectionCache({ maxFlights: 1 });
		cache.prepareRegistry("invalidate", "identity-one");
		let loaderSignal: AbortSignal | undefined;
		let rejectLoader: ((error: Error) => void) | undefined;
		const pending = cache.getOrLoad(cacheKey("invalidate", "help", []), undefined, (signal) => {
			loaderSignal = signal;
			return new Promise((_resolve, reject) => {
				rejectLoader = reject;
			});
		});
		await Promise.resolve();
		cache.prepareRegistry("invalidate", "identity-two");
		expect(loaderSignal?.aborted).toBe(true);
		await expect(
			cache.getOrLoad(cacheKey("other", "help", []), undefined, () => Promise.resolve(success("help", "other"))),
		).rejects.toThrow("concurrent-flight limit");
		expect(cache.stats().inFlight).toBe(1);
		rejectLoader?.(new Error("invalidated loader drained"));
		await expect(pending).rejects.toThrow("invalidated loader drained");
		expect(cache.stats().inFlight).toBe(0);
		await cache.close();
	});

	it("aborts a shared flight only after every waiter cancels and allows a fresh later request", async () => {
		const cache = new LocalIntrospectionCache();
		const key = cacheKey("cancel", "help", []);
		const firstController = new AbortController();
		const secondController = new AbortController();
		let flightSignal: AbortSignal | undefined;
		let launches = 0;
		const loader = (signal: AbortSignal) => {
			launches += 1;
			flightSignal = signal;
			return new Promise<LocalIntrospectionSuccess>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						reject(new Error("aborted flight"));
					},
					{ once: true },
				);
			});
		};
		const first = cache.getOrLoad(key, firstController.signal, loader);
		const second = cache.getOrLoad(key, secondController.signal, loader);
		await Promise.resolve();
		firstController.abort();
		await expect(first).rejects.toThrow("waiter cancelled");
		expect(flightSignal?.aborted).toBe(false);
		secondController.abort();
		await expect(second).rejects.toThrow("waiter cancelled");
		expect(flightSignal?.aborted).toBe(true);
		expect(cache.stats().inFlight).toBe(0);
		const fresh = await cache.getOrLoad(key, undefined, () => {
			launches += 1;
			return Promise.resolve(success("help", "fresh"));
		});
		expect(fresh.stdout).toBe("fresh");
		expect(launches).toBe(2);
		await cache.close();
	});
});

describePosix("local introspection service", () => {
	let root: string;
	let bin: string;
	let logPath: string;
	let executablePath: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-cli-tools-local-introspection-"));
		bin = join(root, "bin");
		logPath = join(root, "invocations.jsonl");
		executablePath = join(bin, "fixture-cli");
		await mkdir(bin);
		await writeFixture(executablePath, logPath, "fixture output");
	});

	afterEach(async () => {
		await rm(root, { force: true, recursive: true });
	});

	it("honors cancellation before filesystem discovery and identity work", async () => {
		const controller = new AbortController();
		controller.abort(new Error("filesystem deadline"));
		await expect(
			resolveExecutable(["fixture-cli"], { cwd: root, env: { PATH: bin }, signal: controller.signal }),
		).rejects.toThrow("filesystem deadline");
		await expect(fingerprintExecutable(executablePath, controller.signal)).rejects.toThrow("filesystem deadline");
	});

	it("is lazy, preserves exact argv boundaries, caches each source, and isolates subcommand help", async () => {
		const definition = createDefinition("one", "cli_one", {
			version: { args: ["--version", "version ; $(literal)"] },
			help: { args: ["--help", "help ; $(literal)", "a b"] },
			subcommand_help: {
				allowed_paths: [["pr", "create"]],
				append_args: ["--help", "tail ; $(literal)"],
			},
			man: false,
		});
		const service = new LocalIntrospectionService({ getHostEnvironment: () => ({ PATH: bin }) });
		await expect(access(logPath)).rejects.toMatchObject({ code: "ENOENT" });

		const first = await service.inspect({ discovery: available(definition, executablePath), cwd: root });
		expect(first).toMatchObject({
			status: "ok",
			version: { status: "ok", source: "version", cache: "miss" },
			documentation: { status: "ok", source: "help", cache: "miss" },
		});
		const second = await service.inspect({ discovery: available(definition, executablePath), cwd: root });
		expect(second).toMatchObject({
			version: { status: "ok", cache: "hit" },
			documentation: { status: "ok", cache: "hit" },
		});
		const subcommand = await service.inspect({
			discovery: available(definition, executablePath),
			cwd: root,
			subcommand: ["pr", "create"],
		});
		expect(subcommand).toMatchObject({
			version: { status: "ok", cache: "hit" },
			documentation: { status: "ok", source: "subcommand_help", cache: "miss" },
		});
		const invokedArgs = (await invocations(logPath)).map(({ args }) => args);
		expect(invokedArgs).toHaveLength(3);
		expect(invokedArgs).toEqual(
			expect.arrayContaining([
				["--version", "version ; $(literal)"],
				["--help", "help ; $(literal)", "a b"],
				["pr", "create", "--help", "tail ; $(literal)"],
			]),
		);
		expect(service.diagnostics().cache).toMatchObject({ entries: 3, hits: 3, misses: 3 });
		const disallowed = await service.inspect({
			discovery: available(definition, executablePath),
			cwd: root,
			subcommand: ["extension-or-alias"],
		});
		expect(disallowed.documentation).toMatchObject({ status: "failed", code: "invalid_request" });
		expect(await invocations(logPath)).toHaveLength(3);
		await service.close();
	});

	it("uses man only as a lazy top-level fallback with an exact helper path and controlled environment", async () => {
		const manLog = join(root, "man.jsonl");
		const manPath = join(bin, "fake-man");
		await writeFixture(manPath, manLog, "configured man text");
		const definition = createDefinition("manual", "cli_manual", {
			version: { args: ["--version"] },
			help: { args: ["--help", "--exit=1"] },
			subcommand_help: { allowed_paths: [["pr"]], append_args: ["--help", "--exit=1"] },
			man: {
				binary: { candidates: ["fake-man"] },
				args: ["section 1", "page;$(literal)"],
			},
		});
		const service = new LocalIntrospectionService({
			getHostEnvironment: () => ({
				PATH: bin,
				PAGER: "hostile-pager --option",
				MANPAGER: "hostile-manpager",
				MANOPT: "--hostile",
				INTROSPECTION_SENTINEL: "secret",
			}),
		});
		const result = await service.inspect({ discovery: available(definition, executablePath), cwd: root });
		expect(result).toMatchObject({
			status: "ok",
			documentation: { status: "ok", source: "man", stdout: "configured man text" },
		});
		expect(result.attempts.map(({ source, status }) => [source, status])).toEqual([
			["version", "ok"],
			["help", "failed"],
			["man", "ok"],
		]);
		const [man] = await invocations(manLog);
		expect(man?.args).toEqual(["section 1", "page;$(literal)"]);
		expect(man?.environment).toMatchObject({ MANPAGER: "cat", PAGER: "cat", TERM: "dumb", MANOPT: null });
		expect(man?.environment.INTROSPECTION_SENTINEL).toBeNull();
		expect(man?.tty).toEqual({ stdin: false, stdout: false, stderr: false });

		const subcommand = await service.inspect({
			discovery: available(definition, executablePath),
			cwd: root,
			subcommand: ["pr"],
		});
		expect(subcommand.status).toBe("failed");
		expect(await invocations(manLog)).toHaveLength(1);
		await service.close();

		const missingDefinition = createDefinition("missing-man", "cli_missing_man", {
			man: { binary: { candidates: ["definitely-missing-man"] }, args: ["page"] },
		});
		const missingService = new LocalIntrospectionService({ getHostEnvironment: () => ({ PATH: bin }) });
		const missing = await missingService.inspect({
			discovery: available(missingDefinition, executablePath),
			cwd: root,
		});
		expect(missing.documentation).toMatchObject({ status: "unavailable", code: "helper_missing" });
		await missingService.close();

		const noPageDefinition = createDefinition("no-page", "cli_no_page", {
			man: { binary: { candidates: ["fake-man"] }, args: ["--exit=1"] },
		});
		const noPageService = new LocalIntrospectionService({ getHostEnvironment: () => ({ PATH: bin }) });
		const noPage = await noPageService.inspect({
			discovery: available(noPageDefinition, executablePath),
			cwd: root,
		});
		expect(noPage.documentation).toMatchObject({
			status: "failed",
			code: "unaccepted_exit",
			exitCode: 1,
			execution: { exitCode: 1 },
		});
		if (noPage.documentation.status !== "failed") throw new Error("expected man failure");
		expect(typeof noPage.documentation.execution?.durationMs).toBe("number");
		await noPageService.close();
	});

	it("deduplicates concurrent work while one cancelled waiter does not abort a live waiter", async () => {
		const gate = join(root, "release");
		const definition = createDefinition("concurrent", "cli_concurrent", {
			help: { args: ["--help", `--gate=${gate}`] },
			man: false,
		});
		const service = new LocalIntrospectionService({ getHostEnvironment: () => ({ PATH: bin }) });
		const firstController = new AbortController();
		const first = service.inspect({
			discovery: available(definition, executablePath),
			cwd: root,
			signal: firstController.signal,
		});
		const second = service.inspect({ discovery: available(definition, executablePath), cwd: root });
		await waitForInvocation(logPath);
		firstController.abort();
		await writeFile(gate, "release", "utf8");
		const [cancelled, successful] = await Promise.all([first, second]);
		expect(cancelled.documentation).toMatchObject({ status: "failed", code: "cancelled" });
		expect(successful.documentation).toMatchObject({ status: "ok", cache: "miss" });
		expect(await invocations(logPath)).toHaveLength(1);
		expect(service.diagnostics().cache.deduplicated).toBeGreaterThanOrEqual(1);
		await service.close();
	});

	it("aborts an outstanding flight on service shutdown and cannot populate session cache afterward", async () => {
		const gate = join(root, "never-release");
		const definition = createDefinition("shutdown", "cli_shutdown", {
			help: { args: ["--help", `--gate=${gate}`] },
			man: false,
		});
		const service = new LocalIntrospectionService({ getHostEnvironment: () => ({ PATH: bin }) });
		const pending = service.inspect({ discovery: available(definition, executablePath), cwd: root });
		await waitForInvocation(logPath);
		await service.close();
		const result = await pending;
		expect(result.documentation).toMatchObject({ status: "failed", code: "cancelled" });
		expect(service.diagnostics().cache).toMatchObject({ entries: 0, inFlight: 0 });
	});

	it("enforces distinct-flight capacity, aggregate cancellation, and command-specific accepted exits", async () => {
		const gate = join(root, "capacity-release");
		const cache = new LocalIntrospectionCache({ maxFlights: 1 });
		const service = new LocalIntrospectionService({ cache, getHostEnvironment: () => ({ PATH: bin }) });
		const blockedDefinition = createDefinition("blocked", "cli_blocked", {
			help: { args: ["--help", `--gate=${gate}`] },
			man: false,
		});
		const blocked = service.inspect({ discovery: available(blockedDefinition, executablePath), cwd: root });
		await waitForInvocation(logPath);
		const limitedDefinition = createDefinition("limited", "cli_limited", {
			help: { args: ["--help"] },
			man: false,
		});
		const limited = await service.inspect({ discovery: available(limitedDefinition, executablePath), cwd: root });
		expect(limited.documentation).toMatchObject({ status: "failed", code: "concurrency_limit" });
		await writeFile(gate, "release", "utf8");
		expect((await blocked).documentation).toMatchObject({ status: "ok" });
		await service.close();

		const deadlineService = new LocalIntrospectionService({
			getHostEnvironment: () => ({ PATH: bin }),
			aggregateTimeoutMs: 100,
		});
		const hanging = createDefinition("deadline", "cli_deadline", {
			help: { args: ["--help", "--hang"], timeout_ms: 5_000 },
			man: false,
		});
		const deadlineResult = await deadlineService.inspect({
			discovery: available(hanging, executablePath),
			cwd: root,
		});
		expect(deadlineResult.documentation).toMatchObject({ status: "failed", code: "timed_out" });
		await deadlineService.close();

		const acceptedService = new LocalIntrospectionService({ getHostEnvironment: () => ({ PATH: bin }) });
		const acceptedDefinition = createDefinition("accepted", "cli_accepted", {
			help: { args: ["--help", "--exit=1"], accepted_exit_codes: [1] },
			man: false,
		});
		const accepted = await acceptedService.inspect({
			discovery: available(acceptedDefinition, executablePath),
			cwd: root,
		});
		expect(accepted.documentation).toMatchObject({ status: "ok", exitCode: 1, cache: "miss" });
		await acceptedService.close();
	});

	it("does not cache unconfirmed process cleanup and preserves cleanup metadata", async () => {
		let executions = 0;
		const definition = createDefinition("cleanup", "cli_cleanup", {
			help: { args: ["--help"] },
			man: false,
		});
		const service = new LocalIntrospectionService({
			getHostEnvironment: () => ({ PATH: bin }),
			execute: async (request, options) => {
				executions += 1;
				const result = await runCliCapture(request, options);
				if (result.status !== "exited") return result;
				return {
					...result,
					processGroupCleanup: { ...result.processGroupCleanup, confirmed: false },
				};
			},
		});
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const result = await service.inspect({ discovery: available(definition, executablePath), cwd: root });
			expect(result.documentation).toMatchObject({
				status: "failed",
				code: "cleanup_incomplete",
				execution: {
					capture: { complete: true },
					cleanup: { reason: "natural_exit", confirmed: false },
				},
			});
		}
		expect(executions).toBe(2);
		expect(service.diagnostics().cache.entries).toBe(0);
		await service.close();
	});

	it("does not cache unaccepted exits or timeouts, but caches the next complete success", async () => {
		const once = join(root, "failed-once");
		const failing = createDefinition("failure", "cli_failure", {
			help: { args: ["--help", `--fail-once=${once}`] },
			man: false,
		});
		const service = new LocalIntrospectionService({ getHostEnvironment: () => ({ PATH: bin }) });
		const first = await service.inspect({ discovery: available(failing, executablePath), cwd: root });
		expect(first.attempts).toEqual(
			expect.arrayContaining([expect.objectContaining({ source: "help", status: "failed", code: "unaccepted_exit" })]),
		);
		const second = await service.inspect({ discovery: available(failing, executablePath), cwd: root });
		expect(second.documentation).toMatchObject({ status: "ok", cache: "miss" });
		const third = await service.inspect({ discovery: available(failing, executablePath), cwd: root });
		expect(third.documentation).toMatchObject({ status: "ok", cache: "hit" });

		const hanging = createDefinition("hanging", "cli_hanging", {
			help: { args: ["--help", "--hang"], timeout_ms: 100 },
			man: false,
		});
		const timed = await service.inspect({ discovery: available(hanging, executablePath), cwd: root });
		expect(timed.attempts).toEqual(
			expect.arrayContaining([expect.objectContaining({ source: "help", status: "failed", code: "timed_out" })]),
		);

		const signalled = createDefinition("signalled", "cli_signalled", {
			help: { args: ["--help", "--signal"] },
			man: false,
		});
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const signalResult = await service.inspect({ discovery: available(signalled, executablePath), cwd: root });
			expect(signalResult.attempts).toEqual(
				expect.arrayContaining([expect.objectContaining({ source: "help", status: "failed", code: "signal_exit" })]),
			);
		}
		await service.close();
	});

	it("does not cache spawn failures, incomplete capture, or an identity changed during execution", async () => {
		const failureDefinition = createDefinition("operational", "cli_operational", {
			help: { args: ["--help"] },
			man: false,
		});
		const spawnPath = join(bin, "spawn-race");
		await writeFixture(spawnPath, logPath, "spawn");
		let removeBeforeSpawn = true;
		const spawnService = new LocalIntrospectionService({
			getHostEnvironment: () => ({ PATH: bin }),
			execute: async (request, options) => {
				if (removeBeforeSpawn) {
					removeBeforeSpawn = false;
					await rm(spawnPath);
				}
				return runCliCapture(request, options);
			},
		});
		const spawnResult = await spawnService.inspect({
			discovery: available(failureDefinition, spawnPath),
			cwd: root,
		});
		expect(spawnResult.attempts).toEqual(
			expect.arrayContaining([expect.objectContaining({ source: "help", status: "failed", code: "spawn_error" })]),
		);
		expect(spawnService.diagnostics().cache.entries).toBe(0);
		await spawnService.close();

		await writeFixture(executablePath, logPath, "complete");
		let incompleteRuns = 0;
		const incompleteService = new LocalIntrospectionService({
			getHostEnvironment: () => ({ PATH: bin }),
			execute: async (request, options) => {
				incompleteRuns += 1;
				const result = await runCliCapture(request, options);
				return {
					...result,
					capture: { complete: false, cutOff: true, reason: "output_drain_timeout" as const },
				};
			},
		});
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const incomplete = await incompleteService.inspect({
				discovery: available(failureDefinition, executablePath),
				cwd: root,
			});
			expect(incomplete.attempts).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ source: "help", status: "failed", code: "capture_incomplete" }),
				]),
			);
		}
		expect(incompleteRuns).toBe(2);
		expect(incompleteService.diagnostics().cache.entries).toBe(0);
		await incompleteService.close();

		await writeFixture(executablePath, logPath, "before replacement");
		const changingService = new LocalIntrospectionService({
			getHostEnvironment: () => ({ PATH: bin }),
			execute: async (request, options) => {
				const result = await runCliCapture(request, options);
				await writeFixture(executablePath, logPath, "changed during execution");
				return result;
			},
		});
		const changed = await changingService.inspect({
			discovery: available(failureDefinition, executablePath),
			cwd: root,
		});
		expect(changed.attempts).toEqual(
			expect.arrayContaining([expect.objectContaining({ source: "help", status: "failed", code: "identity_changed" })]),
		);
		expect(changingService.diagnostics().cache.entries).toBe(0);
		await changingService.close();
	});

	it("bounds and sanitizes hostile output without a spool and invalidates changed identities and definitions", async () => {
		const definition = createDefinition("bounded", "cli_bounded", {
			help: { args: ["--help", "--large", "--hostile"] },
			man: false,
		});
		const service = new LocalIntrospectionService({ getHostEnvironment: () => ({ PATH: bin }) });
		const bounded = await service.inspect({ discovery: available(definition, executablePath), cwd: root });
		if (bounded.documentation.status !== "ok") throw new Error("expected bounded help");
		expect(bounded.documentation.truncated).toBe(true);
		expect(Buffer.byteLength(bounded.documentation.stdout, "utf8")).toBeLessThanOrEqual(
			CLI_INTROSPECTION_DOCUMENT_MAX_BYTES,
		);
		expect(
			Array.from(bounded.documentation.stdout).some((character) => {
				const codePoint = character.codePointAt(0);
				return codePoint === 0 || codePoint === 0x1b || codePoint === 0x202e;
			}),
		).toBe(false);

		const identityDefinition = createDefinition("identity", "cli_identity", {
			help: { args: ["--help"] },
			man: false,
		});
		const original = await service.inspect({ discovery: available(identityDefinition, executablePath), cwd: root });
		expect(original.documentation).toMatchObject({ status: "ok", stdout: "fixture output", cache: "miss" });
		await writeFixture(executablePath, logPath, "replacement output");
		const replacement = await service.inspect({
			discovery: available(identityDefinition, executablePath),
			cwd: root,
		});
		expect(replacement.documentation).toMatchObject({ status: "ok", cache: "miss" });
		if (replacement.documentation.status === "ok") expect(replacement.documentation.stdout).toBe("replacement output");

		const changedDefinition = createDefinition("identity", "cli_identity", {
			help: { args: ["--help", "--stdout=definition changed"] },
			man: false,
		});
		const changed = await service.inspect({ discovery: available(changedDefinition, executablePath), cwd: root });
		expect(changed.documentation).toMatchObject({ status: "ok", cache: "miss", stdout: "definition changed" });
		expect(service.diagnostics().cache.invalidations).toBeGreaterThanOrEqual(2);
		await service.close();
	});

	it("isolates cache entries by cwd and exact environment snapshot while retaining the discovered path", async () => {
		let sentinel = "one";
		const definition = createDefinition("context", "cli_context", { help: { args: ["--help"] }, man: false });
		const service = new LocalIntrospectionService({
			getHostEnvironment: () => ({ PATH: bin, CACHE_SENTINEL: sentinel }),
		});
		const discovery = available(definition, executablePath);
		const first = await service.inspect({ discovery, cwd: root });
		const cached = await service.inspect({ discovery, cwd: root });
		expect(first.documentation).toMatchObject({ status: "ok", cache: "miss" });
		expect(cached.documentation).toMatchObject({ status: "ok", cache: "hit" });
		sentinel = "two";
		const changedEnvironment = await service.inspect({ discovery, cwd: root });
		expect(changedEnvironment.documentation).toMatchObject({ status: "ok", cache: "miss" });
		const otherCwd = join(root, "other-cwd");
		await mkdir(otherCwd);
		const changedCwd = await service.inspect({ discovery, cwd: otherCwd });
		expect(changedCwd.documentation).toMatchObject({ status: "ok", cache: "miss" });
		expect((await invocations(logPath)).map(({ cwd }) => cwd)).toEqual([
			await realpath(root),
			await realpath(root),
			await realpath(otherCwd),
		]);
		await service.close();

		const emptyEnvironmentDefinition: RegistryDefinition = {
			...definition,
			id: "empty-context",
			tool_name: "cli_empty_context",
			execution: { ...definition.execution, inherit_env: false },
		};
		const emptyService = new LocalIntrospectionService({
			getHostEnvironment: () => ({ PATH: bin, INTROSPECTION_SENTINEL: "must-not-leak" }),
		});
		await emptyService.inspect({ discovery: available(emptyEnvironmentDefinition, executablePath), cwd: root });
		expect((await invocations(logPath)).at(-1)?.environment.INTROSPECTION_SENTINEL).toBeNull();
		await emptyService.close();
	});

	it("keeps cache keys isolated across definitions that share one executable", async () => {
		const service = new LocalIntrospectionService({ getHostEnvironment: () => ({ PATH: bin }) });
		const a = createDefinition("a", "cli_a", { help: { args: ["--help", "--stdout=A"] }, man: false });
		const b = createDefinition("b", "cli_b", { help: { args: ["--help", "--stdout=B"] }, man: false });
		const [aResult, bResult] = await Promise.all([
			service.inspect({ discovery: available(a, executablePath), cwd: root }),
			service.inspect({ discovery: available(b, executablePath), cwd: root }),
		]);
		expect(aResult.documentation).toMatchObject({ status: "ok", stdout: "A", cache: "miss" });
		expect(bResult.documentation).toMatchObject({ status: "ok", stdout: "B", cache: "miss" });
		await service.close();
	});
});

function createDefinition(
	id: string,
	toolName: string,
	introspection: RegistryDefinition["introspection"],
): RegistryDefinition {
	return {
		id,
		tool_name: toolName,
		binary: { candidates: ["fixture-cli"] },
		routing: { description: `Use ${id}` },
		introspection,
		docs: { official: [] },
		execution: { timeout_ms: 5_000, cwd: "session", inherit_env: true, accepted_exit_codes: [0, 1] },
	};
}

function available(
	definition: RegistryDefinition,
	executablePath: string,
): Extract<CliDiscovery, { status: "available" }> {
	return {
		status: "available",
		registry: { definition, source: { layer: "test", path: `/registry/${definition.id}.yaml` } },
		resolution: { candidate: "fixture-cli", executablePath, checkedPaths: [executablePath] },
	};
}

async function writeFixture(path: string, log: string, defaultOutput: string): Promise<void> {
	await writeFile(
		path,
		`#!${process.execPath}\nimport { appendFile, access, writeFile } from "node:fs/promises";\nconst args = process.argv.slice(2);\nawait appendFile(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), environment: { MANPAGER: process.env.MANPAGER ?? null, PAGER: process.env.PAGER ?? null, MANOPT: process.env.MANOPT ?? null, TERM: process.env.TERM ?? null, INTROSPECTION_SENTINEL: process.env.INTROSPECTION_SENTINEL ?? null }, tty: { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY), stderr: Boolean(process.stderr.isTTY) } }) + "\\n");\nconst failOnce = args.find((arg) => arg.startsWith("--fail-once="))?.slice(12);\nif (failOnce) { try { await access(failOnce); } catch { await writeFile(failOnce, "failed"); process.exit(1); } }\nif (args.includes("--exit=1")) process.exit(1);\nif (args.includes("--signal")) process.kill(process.pid, "SIGTERM");\nif (args.includes("--hang")) await new Promise((resolve) => setInterval(resolve, 60_000));\nconst gate = args.find((arg) => arg.startsWith("--gate="))?.slice(7);\nif (gate) { for (;;) { try { await access(gate); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } } }\nconst explicit = args.find((arg) => arg.startsWith("--stdout="))?.slice(9);\nlet output = explicit ?? (args.includes("--version") ? "fixture 1.0.0" : ${JSON.stringify(defaultOutput)});\nif (args.includes("--large")) output = "x".repeat(40 * 1024);\nif (args.includes("--hostile")) output = "\\u001b[31m\\u0000\\u202e" + output + "\\u001b[0m";\nprocess.stdout.write(output);\n`,
		"utf8",
	);
	await chmod(path, 0o755);
}

async function invocations(path: string): Promise<
	{
		args: string[];
		cwd: string;
		environment: Record<string, string | null>;
		tty: { stdin: boolean; stdout: boolean; stderr: boolean };
	}[]
> {
	try {
		return (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Awaited<ReturnType<typeof invocations>>[number]);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

async function waitForInvocation(path: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if ((await invocations(path)).length > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for invocation: ${path}`);
}

function cacheKey(registryId: string, source: "version" | "help", args: string[]): LocalIntrospectionCacheKey {
	return {
		schemaVersion: 1,
		registryId,
		definitionSha256: `definition-${registryId}`,
		executable: {
			realpath: `/bin/${registryId}`,
			dev: "1",
			ino: registryId,
			mode: "1",
			size: "1",
			mtimeNs: "1",
			ctimeNs: "1",
		},
		source,
		subcommand: [],
		args,
		cwd: "/tmp",
		environmentSha256: "environment",
	};
}

function success(source: "version" | "help", stdout: string): LocalIntrospectionSuccess {
	return {
		status: "ok",
		source,
		command: { executablePath: "/bin/tool", args: [], cwd: "/tmp", timeoutMs: 1_000 },
		stdout,
		stderr: "",
		exitCode: 0,
		durationMs: 1,
		truncated: false,
		cache: "miss",
		execution: {
			exitCode: 0,
			signal: null,
			durationMs: 1,
			capture: { complete: true, cutOff: false, reason: null },
			cleanup: { reason: "natural_exit", attempted: true, forced: false, confirmed: true, error: null },
			error: null,
		},
	};
}
