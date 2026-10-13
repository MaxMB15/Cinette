// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import { downloadPercent } from "./download-progress";

describe("downloadPercent", () => {
	it("rounds to a whole percent", () => {
		expect(downloadPercent({ downloadedBytes: 0, totalBytes: 1000 })).toBe(0);
		expect(downloadPercent({ downloadedBytes: 254, totalBytes: 1000 })).toBe(25);
		expect(downloadPercent({ downloadedBytes: 255, totalBytes: 1000 })).toBe(26);
		expect(downloadPercent({ downloadedBytes: 1000, totalBytes: 1000 })).toBe(100);
	});

	it("stops at 100 when the file grows past the size the server gave", () => {
		expect(downloadPercent({ downloadedBytes: 1012, totalBytes: 1000 })).toBe(100);
	});

	it("has no percent without a size", () => {
		expect(downloadPercent({ downloadedBytes: 5000, totalBytes: null })).toBeNull();
		expect(downloadPercent({ downloadedBytes: 0, totalBytes: 0 })).toBeNull();
	});
});
