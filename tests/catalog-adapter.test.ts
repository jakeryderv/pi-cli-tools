import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	activatePiCliTools,
	createPiCliToolsState,
	formatCliToolsDiagnostics,
	type CliToolsToolResultDetails,
} from "../extensions/pi-adapter.js";
import { createDefinition, createMockPi, createRegistry, createToolInfo } from "./helpers/pi-adapter.js";

const describePosix = process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip;

describePosix("cli_tools activation adapter", () => {
	let root: string;
	let bin: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-cli-tools-catalog-adapter-"));
		bin = join(root, "bin");
		await mkdir(bin);
		for (const name of ["eager", "lazy", "filtered", "collision", "quarantined"]) {
			await symlink(process.execPath, join(bin, name));
		}
		vi.stubEnv("PATH", bin);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	it("registers all eligible definitions, leaves lazy tools inactive, and enables additively and idempotently", async () => {
		const harness = createMockPi({ existingTools: [createToolInfo("read")] });
		const state = createPiCliToolsState(
			createRegistry([
				createDefinition("eager", "cli_eager", { activation: "eager" }),
				createDefinition("lazy", "cli_lazy", {
					activation: "lazy",
					routing: {
						description: "Search remote issue trackers",
						keywords: ["issues", "search"],
					},
				}),
			]),
		);
		await activatePiCliTools(harness.api, state, root);

		expect(harness.tools.map(({ name }) => name)).toEqual(["cli_eager", "cli_lazy", "cli_tools", "cli_docs"]);
		expect([...harness.activeNames]).toEqual(expect.arrayContaining(["read", "cli_eager", "cli_tools", "cli_docs"]));
		expect(harness.activeNames.has("cli_lazy")).toBe(false);
		const diagnostics = formatCliToolsDiagnostics(state, [...harness.activeNames], harness.api.getAllTools());
		expect(diagnostics).toContain("Eager: 1 | Lazy: 1");
		expect(diagnostics).toContain("cli_tools: registered/active");
		expect(diagnostics).toContain("policy=lazy");
		expect(diagnostics).toContain("Reload resets dynamically enabled tools");
		const catalog = requireTool(harness.tools, "cli_tools");
		expect(catalog.executionMode).toBe("sequential");

		const search = await catalog.execute(
			"search",
			{ action: "search", query: "issue search", limit: 5 },
			undefined,
			undefined,
			{ cwd: root } as ExtensionContext,
		);
		expect(search.details).toMatchObject({
			kind: "catalog_search",
			status: "ok",
			matches: [expect.objectContaining({ registryId: "lazy", active: false, enableable: true })],
		});

		const [first, second] = await Promise.all([
			catalog.execute("enable-1", { action: "enable", ids: ["lazy"] }, undefined, undefined, {
				cwd: root,
			} as ExtensionContext),
			catalog.execute("enable-2", { action: "enable", ids: ["lazy"] }, undefined, undefined, {
				cwd: root,
			} as ExtensionContext),
		]);
		expect([first.details, second.details]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "catalog_enable", enabled: ["lazy"] }),
				expect.objectContaining({ kind: "catalog_enable", alreadyActive: ["lazy"] }),
			]),
		);
		expect(harness.activeNames.has("read")).toBe(true);
		expect(harness.activeNames.has("cli_lazy")).toBe(true);
		expect(state.enabledByCliTools).toEqual(new Set(["lazy"]));
	});

	it("keeps eager no-op enable history unchanged", async () => {
		const harness = createMockPi({ existingTools: [createToolInfo("read")] });
		const state = createPiCliToolsState(
			createRegistry([createDefinition("eager", "cli_eager", { activation: "eager" })]),
		);
		await activatePiCliTools(harness.api, state, root);
		const registered = state.registered[0];
		expect(registered?.activationOrigin).toBe("initial_eager");
		const result = await requireTool(harness.tools, "cli_tools").execute(
			"noop",
			{ action: "enable", ids: ["eager"] },
			undefined,
			undefined,
			{ cwd: root } as ExtensionContext,
		);
		expect(result.details).toMatchObject({ kind: "catalog_enable", enabled: [], alreadyActive: ["eager"] });
		expect(state.enabledByCliTools).toEqual(new Set());
		expect(registered?.activationOrigin).toBe("initial_eager");
	});

	it("rejects unavailable batches before mutation and detects late ownership changes", async () => {
		const harness = createMockPi({ existingTools: [createToolInfo("read")] });
		const state = createPiCliToolsState(createRegistry([createDefinition("lazy", "cli_lazy", { activation: "lazy" })]));
		await activatePiCliTools(harness.api, state, root);
		const catalog = requireTool(harness.tools, "cli_tools");
		const before = [...harness.activeNames];
		const mixed = await catalog.execute("mixed", { action: "enable", ids: ["lazy", "missing"] }, undefined, undefined, {
			cwd: root,
		} as ExtensionContext);
		expect(mixed.details).toMatchObject({ kind: "catalog_request_error", code: "unavailable" });
		expect([...harness.activeNames]).toEqual(before);

		harness.sourceOverrides.set("cli_lazy", createToolInfo("cli_lazy", "extension:late").sourceInfo);
		const changed = await catalog.execute("changed", { action: "enable", ids: ["lazy"] }, undefined, undefined, {
			cwd: root,
		} as ExtensionContext);
		expect(changed.details).toMatchObject({
			kind: "catalog_request_error",
			code: "ownership_changed",
			entries: [expect.objectContaining({ registryId: "lazy", availability: "ownership_changed" })],
		});
		expect(harness.activeNames.has("cli_lazy")).toBe(false);
	});

	it("reports filtered registrations and host activation failures without removing unrelated active tools", async () => {
		const filteredHarness = createMockPi({
			existingTools: [createToolInfo("read")],
			filteredToolNames: ["cli_filtered"],
		});
		const filteredState = createPiCliToolsState(
			createRegistry([createDefinition("filtered", "cli_filtered", { activation: "lazy" })]),
		);
		await activatePiCliTools(filteredHarness.api, filteredState, root);
		expect(filteredState.filtered).toHaveLength(1);
		const filteredCatalog = requireTool(filteredHarness.tools, "cli_tools");
		const filtered = await filteredCatalog.execute(
			"filtered",
			{ action: "enable", ids: ["filtered"] },
			undefined,
			undefined,
			{ cwd: root } as ExtensionContext,
		);
		expect(filtered.details).toMatchObject({
			kind: "catalog_request_error",
			entries: [expect.objectContaining({ availability: "filtered_by_pi" })],
		});

		const failingHarness = createMockPi({
			existingTools: [createToolInfo("read")],
			setActiveToolsErrorAfter: 1,
		});
		const failingState = createPiCliToolsState(
			createRegistry([createDefinition("lazy", "cli_lazy", { activation: "lazy" })]),
		);
		await activatePiCliTools(failingHarness.api, failingState, root);
		const failure = await requireTool(failingHarness.tools, "cli_tools").execute(
			"failure",
			{ action: "enable", ids: ["lazy"] },
			undefined,
			undefined,
			{ cwd: root } as ExtensionContext,
		);
		expect(failure.details as CliToolsToolResultDetails).toMatchObject({
			kind: "catalog_request_error",
			code: "activation_failed",
		});
		expect(failingHarness.activeNames.has("read")).toBe(true);
		expect(failingHarness.activeNames.has("cli_lazy")).toBe(false);

		const droppingHarness = createMockPi({
			existingTools: [createToolInfo("read")],
			dropActiveToolNamesOnCall: { call: 2, names: ["read"] },
		});
		const droppingState = createPiCliToolsState(
			createRegistry([createDefinition("lazy", "cli_lazy", { activation: "lazy" })]),
		);
		await activatePiCliTools(droppingHarness.api, droppingState, root);
		const dropped = await requireTool(droppingHarness.tools, "cli_tools").execute(
			"dropped",
			{ action: "enable", ids: ["lazy"] },
			undefined,
			undefined,
			{ cwd: root } as ExtensionContext,
		);
		expect(dropped.details).toMatchObject({ kind: "catalog_request_error", code: "activation_failed" });
		expect(droppingHarness.activeNames.has("read")).toBe(false);
		expect(droppingHarness.activeNames.has("cli_lazy")).toBe(true);
	});

	it("reports disabled, quarantined, and colliding registry IDs without partial activation", async () => {
		const harness = createMockPi({ existingTools: [createToolInfo("cli_collision", "extension:earlier")] });
		const state = createPiCliToolsState(
			createRegistry(
				[
					createDefinition("quarantined", "cli_quarantined", { activation: "lazy" }),
					createDefinition("collision", "cli_collision", { activation: "lazy" }),
				],
				{
					disabled: [{ entry: { id: "disabled", disabled: true }, source: { layer: "user", path: "/disabled.yaml" } }],
					quarantined: [{ id: "quarantined", layer: "user", paths: ["/bad.yaml"], reason: "invalid_override" }],
				},
			),
		);
		await activatePiCliTools(harness.api, state, root);
		const catalog = requireTool(harness.tools, "cli_tools");
		for (const [id, availability] of [
			["disabled", "disabled"],
			["quarantined", "quarantined"],
			["collision", "collision"],
		] as const) {
			const before = [...harness.activeNames];
			const result = await catalog.execute(id, { action: "enable", ids: [id] }, undefined, undefined, {
				cwd: root,
			} as ExtensionContext);
			expect(result.details).toMatchObject({
				kind: "catalog_request_error",
				entries: [expect.objectContaining({ registryId: id, availability })],
			});
			expect([...harness.activeNames]).toEqual(before);
		}
	});

	it("renders the final middleware error state as authoritative", async () => {
		const harness = createMockPi();
		const state = createPiCliToolsState(createRegistry([createDefinition("lazy", "cli_lazy", { activation: "lazy" })]));
		await activatePiCliTools(harness.api, state, root);
		const catalog = requireTool(harness.tools, "cli_tools");
		if (!catalog.renderResult) throw new Error("expected cli_tools renderer");
		const failed = await catalog.execute("missing", { action: "enable", ids: ["unknown"] }, undefined, undefined, {
			cwd: root,
		} as ExtensionContext);
		const markedSuccessful = catalog
			.renderResult(failed, { expanded: false, isPartial: false }, plainTheme(), { isError: false } as never)
			.render(300)
			.join("\n");
		expect(markedSuccessful).toContain("marked successful");

		const successful = await catalog.execute("search", { action: "search", query: "lazy" }, undefined, undefined, {
			cwd: root,
		} as ExtensionContext);
		const markedError = catalog
			.renderResult(successful, { expanded: false, isPartial: false }, plainTheme(), { isError: true } as never)
			.render(300)
			.join("\n");
		expect(markedError).toContain("marked error");
	});

	it("uses an all-native-active fallback when cli_tools collides", async () => {
		const harness = createMockPi({
			existingTools: [createToolInfo("cli_tools", "extension:earlier"), createToolInfo("read")],
		});
		const state = createPiCliToolsState(createRegistry([createDefinition("lazy", "cli_lazy", { activation: "lazy" })]));
		await activatePiCliTools(harness.api, state, root);
		expect(state.catalog.status).toBe("collision");
		expect(state.loaderFallback).toBe(true);
		expect(harness.activeNames.has("cli_lazy")).toBe(true);
		expect(harness.activeNames.has("read")).toBe(true);
	});
});

function plainTheme(): Theme {
	return {
		fg(_color: unknown, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	} as unknown as Theme;
}

function requireTool(tools: ToolDefinition[], name: string): ToolDefinition {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`expected ${name}`);
	return tool;
}
