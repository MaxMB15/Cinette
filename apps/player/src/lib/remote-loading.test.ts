// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { loadStep, loadedText, stepState } from "./remote-loading";

describe("loadStep", () => {
	it("waits for the link while it reconnects, whatever came", () => {
		expect(loadStep(false, null)).toBe("link");
		expect(loadStep(false, { received: 8, total: 8 })).toBe("link");
	});

	it("gets the library until all of it came", () => {
		expect(loadStep(true, null)).toBe("get");
		expect(loadStep(true, { received: 7, total: 8 })).toBe("get");
		expect(loadStep(true, { received: 7, total: null })).toBe("get");
	});

	it("opens the library once all of it came", () => {
		expect(loadStep(true, { received: 8, total: 8 })).toBe("open");
		expect(loadStep(true, { received: 9, total: 8 })).toBe("open");
		expect(loadStep(true, { received: 0, total: 0 })).toBe("open");
	});
});

describe("stepState", () => {
	it("marks the steps before the current one done and the ones after waiting", () => {
		expect(stepState("link", "get")).toBe("done");
		expect(stepState("get", "get")).toBe("active");
		expect(stepState("open", "get")).toBe("waiting");
		expect(stepState("link", "open")).toBe("done");
		expect(stepState("get", "link")).toBe("waiting");
	});
});

describe("loadedText", () => {
	it("gives megabytes to one decimal", () => {
		expect(loadedText(3_100_000, 8_000_000)).toBe("3.1 of 8.0 MB");
		expect(loadedText(0, 460_800)).toBe("0.0 of 0.5 MB");
	});

	it("never says more than the total", () => {
		expect(loadedText(9_000_000, 8_000_000)).toBe("8.0 of 8.0 MB");
	});
});
