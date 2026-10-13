// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStorage, removeStorage, writeStorage } from "./storage";

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

	it("removes a value from the area it's in", () => {
		localStorage.setItem("k", "local");
		sessionStorage.setItem("k", "session");
		removeStorage("k", "session");
		expect(sessionStorage.getItem("k")).toBeNull();
		expect(localStorage.getItem("k")).toBe("local");
		removeStorage("k");
		expect(localStorage.getItem("k")).toBeNull();
	});

	it("logs and carries on when removing throws", () => {
		vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
			throw new DOMException("blocked", "SecurityError");
		});
		expect(() => removeStorage("k")).not.toThrow();
		expect(console.warn).toHaveBeenCalledOnce();
	});

	it("names the key and passes on the error in each warning", () => {
		const blocked = new DOMException("blocked", "SecurityError");
		const fail = () => {
			throw blocked;
		};
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(fail);
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(fail);
		vi.spyOn(Storage.prototype, "removeItem").mockImplementation(fail);
		readStorage("splash-shown", "session");
		writeStorage("donation-last-shown", "1");
		removeStorage("donation-last-shown");
		expect(vi.mocked(console.warn).mock.calls).toEqual([
			[expect.stringContaining("could not read splash-shown"), blocked],
			[expect.stringContaining("could not write donation-last-shown"), blocked],
			[expect.stringContaining("could not remove donation-last-shown"), blocked],
		]);
	});
});
