import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pi extension entry point.
 *
 * Tool registration is intentionally deferred to the first implementation pass.
 */
export default function cliToolsExtension(pi: ExtensionAPI): void {
	void pi;
}
