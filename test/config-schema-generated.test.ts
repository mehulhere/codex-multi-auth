import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildConfigJsonSchema,
	CONFIG_SCHEMA_RELATIVE_PATH,
	renderConfigJsonSchema,
} from "../lib/config-schema.js";
import { PluginConfigSchema } from "../lib/schemas.js";

const committedPath = path.join(process.cwd(), CONFIG_SCHEMA_RELATIVE_PATH);

/**
 * Drift guard for audit roadmap §4.5.2: config/schema/config.schema.json is
 * generated from the zod PluginConfigSchema. If PluginConfigSchema (or the
 * generator) changes without regenerating the committed file, these tests
 * fail. Fix: run `npm run generate:schema` and commit the result.
 */
describe("config.schema.json is generated from PluginConfigSchema", () => {
	const committedRaw = readFileSync(committedPath, "utf8");

	it("committed schema deep-equals the in-memory regeneration (if this fails, run `npm run generate:schema`)", () => {
		expect(
			JSON.parse(committedRaw),
			"config/schema/config.schema.json is out of date — run `npm run generate:schema` and commit the result",
		).toEqual(buildConfigJsonSchema());
	});

	it("committed schema matches the serialized output byte-for-byte (if this fails, run `npm run generate:schema`)", () => {
		expect(
			committedRaw,
			"config/schema/config.schema.json serialization drifted — run `npm run generate:schema` and commit the result",
		).toBe(renderConfigJsonSchema());
	});

	it("generation is deterministic across invocations", () => {
		expect(renderConfigJsonSchema()).toBe(renderConfigJsonSchema());
	});

	it("covers every PluginConfigSchema field and preserves root metadata", () => {
		const schema = buildConfigJsonSchema() as {
			$schema?: string;
			$id?: string;
			title?: string;
			$defs?: {
				pluginConfig?: { properties?: Record<string, unknown> };
			};
		};

		expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
		expect(schema.$id).toBe(
			"https://codex-multi-auth.local/schema/config.schema.json",
		);
		expect(schema.title).toBe("codex-multi-auth config template");

		const generatedKeys = Object.keys(
			schema.$defs?.pluginConfig?.properties ?? {},
		).sort();
		const zodKeys = Object.keys(PluginConfigSchema.shape).sort();
		expect(generatedKeys).toEqual(zodKeys);
		expect(zodKeys.length).toBeGreaterThan(0);
	});
});
