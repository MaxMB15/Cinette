// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { openUrl as openWithSystem } from "@tauri-apps/plugin-opener";
import { openUrl } from "./openUrl";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const DONATE_URL = "https://buymeacoffee.com/MaxMB15";

describe("openUrl", () => {
	let windowOpen: MockInstance<Window["open"]>;

	beforeEach(() => {
		windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.mocked(openWithSystem).mockReset();
	});

	it("opens the link in the system browser", async () => {
		vi.mocked(openWithSystem).mockResolvedValueOnce(undefined);

		await openUrl(DONATE_URL);

		expect(openWithSystem).toHaveBeenCalledExactlyOnceWith(DONATE_URL);
		expect(windowOpen).not.toHaveBeenCalled();
	});

	it("opens a new tab when the system browser can't be reached", async () => {
		vi.mocked(openWithSystem).mockRejectedValueOnce(new Error("not running in Tauri"));

		await openUrl(DONATE_URL);

		expect(windowOpen).toHaveBeenCalledExactlyOnceWith(DONATE_URL, "_blank");
	});
});
