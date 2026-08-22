import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import Value from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	activatePiCliTools,
	createCliDocsTool,
	createPiCliToolsState,
	isCliDocsToolResultDetails,
} from "../extensions/pi-adapter.js";
import { OfficialDocumentationService } from "../src/docs.js";
import { SecureHttpsTransport, type PinnedHttpsConnector } from "../src/secure-fetch.js";
import type { OfficialDocumentationSource } from "../src/types.js";
import { createDefinition, createMockPi, createRegistry } from "./helpers/pi-adapter.js";

const describePosix = process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip;

describePosix("official cli_docs Pi adapter", () => {
	let root: string;
	let bin: string;
	let executable: string;
	let versionMarker: string;
	let helpMarker: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-cli-tools-official-adapter-"));
		bin = join(root, "bin");
		await mkdir(bin);
		executable = join(bin, "fixture");
		versionMarker = join(root, "version-marker");
		helpMarker = join(root, "help-marker");
		await writeFile(
			executable,
			`#!${process.execPath}\nimport { writeFile } from "node:fs/promises";\nif (process.argv[2] === "--version") { await writeFile(${JSON.stringify(versionMarker)}, "yes"); process.stdout.write("fixture 1.2.3"); }\nif (process.argv[2] === "--help") { await writeFile(${JSON.stringify(helpMarker)}, "yes"); process.stdout.write("fixture help"); }\n`,
			"utf8",
		);
		await chmod(executable, 0o755);
		vi.stubEnv("PATH", bin);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	it("preserves local input compatibility and fetches remote text only for explicit official queries", async () => {
		const connector = connectorSpy();
		const definition = createDefinition("fixture", "cli_fixture", {
			binary: { candidates: ["fixture"] },
			introspection: { version: { args: ["--version"] }, help: { args: ["--help"] }, man: false },
			docs: { official: [source()] },
		});
		const harness = createMockPi();
		const state = createPiCliToolsState(createRegistry([definition]));
		await activatePiCliTools(harness.api, state, root);
		const localService = state.introspectionService;
		if (!localService) throw new Error("expected local service");
		await state.officialDocumentationService?.close();
		const officialService = new OfficialDocumentationService({ transport: fakeTransport(connector) });
		state.officialDocumentationService = officialService;
		const docs = createCliDocsTool(harness.api, state, localService, officialService);
		try {
			expect(Value.Check(docs.parameters, { tool: "cli_fixture" })).toBe(true);
			expect(
				Value.Check(docs.parameters, { tool: "cli_fixture", operation: "official", query: "authentication" }),
			).toBe(true);
			expect(
				Value.Check(docs.parameters, {
					tool: "cli_fixture",
					operation: "official",
					query: "x",
					url: "https://evil.test",
				}),
			).toBe(false);

			await docs.execute("local", { tool: "cli_fixture" }, undefined, undefined, { cwd: root } as ExtensionContext);
			expect(connector.request).not.toHaveBeenCalled();
			const official = await docs.execute(
				"official",
				{ tool: "cli_fixture", operation: "official", query: "authentication token" },
				undefined,
				undefined,
				{ cwd: root } as ExtensionContext,
			);
			expect(connector.request).toHaveBeenCalledTimes(1);
			expect(isCliDocsToolResultDetails(official.details)).toBe(true);
			if (!isCliDocsToolResultDetails(official.details) || official.details.kind !== "official_docs") {
				throw new Error("expected official details");
			}
			expect(official.details.status).toBe("ok");
			expect(official.details.outcomes[0]?.provenance?.finalUrl).toBe("https://example.com/docs");
			expect(official.details.outcomes[0]?.provenance?.alignment.state).toBe("unversioned");
			const text = official.content.find(({ type }) => type === "text");
			expect(text?.type === "text" ? text.text : "").toContain("Untrusted external official documentation excerpt");
			expect(JSON.stringify(official.details)).not.toContain("Authentication token details");

			const beforeInvalid = connector.request.mock.calls.length;
			const invalid = await docs.execute(
				"invalid",
				{ tool: "cli_fixture", operation: "official" } as never,
				undefined,
				undefined,
				{ cwd: root } as ExtensionContext,
			);
			expect(invalid.details).toMatchObject({ kind: "docs_request_error", code: "invalid_request" });
			expect(connector.request).toHaveBeenCalledTimes(beforeInvalid);
		} finally {
			await Promise.all([localService.close(), officialService.close()]);
		}
	});

	it("runs only configured installed-version evidence for fixed alignment and renders compact remote status", async () => {
		const connector = connectorSpy();
		const definition = createDefinition("fixture", "cli_fixture", {
			binary: { candidates: ["fixture"] },
			introspection: {
				version: { args: ["--version"], parse: { kind: "semver_first" } },
				help: { args: ["--help"] },
				man: false,
			},
			docs: { official: [source({ alignment: { mode: "exact", version: "1.2.3" } })] },
		});
		const harness = createMockPi();
		const state = createPiCliToolsState(createRegistry([definition]));
		await activatePiCliTools(harness.api, state, root);
		const localService = state.introspectionService;
		if (!localService) throw new Error("expected local service");
		await state.officialDocumentationService?.close();
		const officialService = new OfficialDocumentationService({ transport: fakeTransport(connector) });
		state.officialDocumentationService = officialService;
		const docs = createCliDocsTool(harness.api, state, localService, officialService);
		try {
			const result = await docs.execute(
				"fixed",
				{ tool: "cli_fixture", operation: "official", query: "authentication" },
				undefined,
				undefined,
				{ cwd: root } as ExtensionContext,
			);
			if (!isCliDocsToolResultDetails(result.details) || result.details.kind !== "official_docs") {
				throw new Error("expected official details");
			}
			const alignment = result.details.outcomes[0]?.provenance?.alignment;
			expect(alignment).toMatchObject({
				state: "exact",
				installedVersion: "1.2.3",
				evidenceSource: "installed_version_command",
			});
			expect(alignment?.evidenceDefinitionSha256).toMatch(/^[a-f0-9]{64}$/u);
			expect(alignment?.evidenceExecutableIdentitySha256).toMatch(/^[a-f0-9]{64}$/u);
			await expect(access(versionMarker)).resolves.toBeUndefined();
			await expect(access(helpMarker)).rejects.toMatchObject({ code: "ENOENT" });
			if (!docs.renderResult) throw new Error("expected renderer");
			const rendered = docs
				.renderResult(result, { expanded: false, isPartial: false }, plainTheme(), { isError: false } as never)
				.render(300)
				.join("\n");
			expect(rendered).toContain("official 1 excerpt(s)");
			expect(rendered).toContain("exact");
		} finally {
			await Promise.all([localService.close(), officialService.close()]);
		}
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

function connectorSpy() {
	return {
		request: vi.fn((input: Parameters<PinnedHttpsConnector["request"]>[0]) =>
			Promise.resolve({
				statusCode: 200,
				rawHeaders: ["Content-Type", "text/plain"],
				headers: {},
				body: Uint8Array.from(Buffer.from("Authentication token details")),
				peerAddress: input.address.address,
			}),
		),
	} satisfies PinnedHttpsConnector;
}

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
