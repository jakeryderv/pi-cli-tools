import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import cliToolsExtension from "../extensions/cli-tools.js";

describe("cli-tools extension", () => {
	it("exports an extension factory", () => {
		expect(cliToolsExtension).toBeTypeOf("function");
	});

	it("initializes without accessing the Pi API", () => {
		const pi = {} as ExtensionAPI;

		expect(() => {
			cliToolsExtension(pi);
		}).not.toThrow();
	});
});
