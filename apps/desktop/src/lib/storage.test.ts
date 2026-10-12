// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStorage, writeStorage } from "./storage";

describe("storage helpers", () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns null for a missing key", () => {
		expect(readStorage("missing")).toBeNull();
	});

	it("round-trips a value in local storage by default", () => {
		expect(writeStorage("k", "v")).toBe(true);
		expect(localStorage.getItem("k")).toBe("v");
		expect(readStorage("k")).toBe("v");
	});

	it("keeps session values apart from local ones", () => {
		writeStorage("k", "session", "session");
		expect(sessionStorage.getItem("k")).toBe("session");
		expect(readStorage("k")).toBeNull();
		expect(readStorage("k", "session")).toBe("session");
	});

	it("returns null when reading throws", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new DOMException("blocked", "SecurityError");
		});
		expect(readStorage("k")).toBeNull();
	});

	it("returns false when writing throws", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("full", "QuotaExceededError");
		});
		expect(writeStorage("k", "v")).toBe(false);
	});
});
