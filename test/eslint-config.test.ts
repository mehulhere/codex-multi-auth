import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("eslint config", () => {
	it("keeps vendor directory ignored", () => {
		const content = readFileSync(new URL("../eslint.config.js", import.meta.url), "utf8");
		expect(content).toMatch(/['"`]vendor\/\*\*['"`]/);
	});
});
