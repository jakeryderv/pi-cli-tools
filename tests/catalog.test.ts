import { describe, expect, it } from "vitest";

import { CatalogRequestError, searchCatalog, type CatalogEntryState } from "../src/catalog.js";
import { createDefinition, loadDefinition } from "./helpers/pi-adapter.js";

describe("deterministic registry catalog search", () => {
	it("ranks exact identity, curated keywords, preferred use, description, and stable ties", () => {
		const entries = [
			entry("zeta", "cli_zeta", {
				routing: { description: "Search GitHub pull requests", keywords: ["github", "pull-request"] },
			}),
			entry("github", "cli_gh", {
				binary: { candidates: ["gh"] },
				routing: {
					description: "Work with repositories and issues",
					keywords: ["github", "pull-request"],
					prefer_for: ["search GitHub pull requests"],
					avoid_for: ["local history"],
				},
			}),
			entry("alpha", "cli_alpha", {
				routing: { description: "Search GitHub pull requests", keywords: ["github", "pull-request"] },
			}),
		];

		expect(searchCatalog(entries, { query: "github" }).map(({ registryId }) => registryId)).toEqual([
			"github",
			"alpha",
			"zeta",
		]);
		expect(searchCatalog(entries, { query: "github", limit: 2 })).toHaveLength(2);
		const exact = searchCatalog(entries, { query: "github" })[0];
		expect(exact).toMatchObject({ registryId: "github", active: false, enableable: true });
		expect(exact?.matchedFields).toEqual(expect.arrayContaining(["id", "keyword"]));
	});

	it("enforces printable UTF-8, term, and result bounds and treats no matches as success", () => {
		const entries = [entry("github", "cli_gh")];
		expect(searchCatalog(entries, { query: "nothing relevant" })).toEqual([]);
		for (const request of [
			{ query: "" },
			{ query: "x".repeat(513) },
			{ query: "bad\u0000query" },
			{ query: Array.from({ length: 33 }, (_, index) => `t${String(index)}`).join(" ") },
			{ query: "github", limit: 0 },
			{ query: "github", limit: 11 },
			{ query: "github", executable: "gh" },
		]) {
			expect(() => searchCatalog(entries, request)).toThrow(CatalogRequestError);
		}
	});
});

function entry(
	id: string,
	toolName: string,
	overrides: Parameters<typeof createDefinition>[2] = {},
): CatalogEntryState {
	const definition = createDefinition(id, toolName, overrides);
	return {
		registry: loadDefinition(definition),
		availability: "registered",
		active: false,
		enableable: true,
		reason: null,
	};
}
