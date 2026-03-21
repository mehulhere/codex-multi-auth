#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const components = [
	{
		name: "@codex-ai/plugin",
		root: "vendor/codex-ai-plugin",
		source: "vendored dist shim",
		files: [
			"vendor/codex-ai-plugin/package.json",
			"vendor/codex-ai-plugin/dist/index.js",
			"vendor/codex-ai-plugin/dist/index.d.ts",
			"vendor/codex-ai-plugin/dist/tool.js",
			"vendor/codex-ai-plugin/dist/tool.d.ts",
		],
	},
	{
		name: "@codex-ai/sdk",
		root: "vendor/codex-ai-sdk",
		source: "vendored dist shim",
		files: [
			"vendor/codex-ai-sdk/package.json",
			"vendor/codex-ai-sdk/dist/index.js",
			"vendor/codex-ai-sdk/dist/index.d.ts",
		],
	},
];

async function hashFile(path) {
	const content = await readFile(path);
	return createHash("sha256").update(content).digest("hex");
}

const manifest = {
	generatedAt: new Date().toISOString().slice(0, 10),
	components: [],
};

for (const component of components) {
	const packageJson = JSON.parse(
		await readFile(`${component.root}/package.json`, "utf8"),
	);
	manifest.components.push({
		name: component.name,
		version: packageJson.version,
		source: component.source,
		root: component.root,
		files: await Promise.all(
			component.files.map(async (path) => ({
				path,
				sha256: await hashFile(path),
			})),
		),
	});
}

await writeFile(
	"vendor/provenance.json",
	`${JSON.stringify(manifest, null, 2)}\n`,
	"utf8",
);
console.log(
	`Updated vendor/provenance.json for ${manifest.components.length} component(s)`,
);
