import { describe, expect, it, vi } from "vitest";
import { promptBackendSettingsMenu } from "../lib/codex-manager/backend-settings-prompt.js";

describe("backend settings prompt", () => {
	it("returns null when not interactive", async () => {
		const result = await promptBackendSettingsMenu({
			initial: { fetchTimeoutMs: 1000 },
			isInteractive: () => false,
			ui: { theme: {} } as never,
			cloneBackendPluginConfig: (config) => ({ ...config }),
			backendCategoryOptions: [],
			getBackendCategoryInitialFocus: vi.fn(),
			buildBackendSettingsPreview: vi.fn(),
			highlightPreviewToken: vi.fn((text) => text),
			select: vi.fn(),
			getBackendCategory: vi.fn(),
			promptBackendCategorySettings: vi.fn(),
			backendDefaults: { fetchTimeoutMs: 1000 },
			copy: {
				previewHeading: "Preview",
				backendCategoriesHeading: "Categories",
				resetDefault: "Reset",
				saveAndBack: "Save",
				backNoSave: "Back",
				backendTitle: "Backend",
				backendSubtitle: "Subtitle",
				backendHelp: "Help",
				back: "Back",
			},
		});

		expect(result).toBeNull();
	});
});
