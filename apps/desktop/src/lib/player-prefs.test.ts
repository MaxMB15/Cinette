// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	readDefaultVolume,
	writeDefaultVolume,
	readVolumePreference,
	writeVolumePreference,
	readHwdecEnabled,
	writeHwdecEnabled,
	readSkipIntervals,
	writeSkipInterval,
	SKIP_INTERVALS_EVENT,
	readSkipSegmentModes,
	writeSkipSegmentMode,
	SKIP_SEGMENT_MODES_EVENT,
	type SkipSegmentMode,
} from "./player-prefs";

describe("player-prefs", () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
	});

	describe("default volume", () => {
		it("is 100 when never set", () => {
			expect(readDefaultVolume()).toBe(100);
		});

		it("round-trips a saved value", () => {
			writeDefaultVolume(65);
			expect(readDefaultVolume()).toBe(65);
		});

		it("clamps to the range mpv accepts", () => {
			writeDefaultVolume(400);
			expect(readDefaultVolume()).toBe(150);
			writeDefaultVolume(-5);
			expect(readDefaultVolume()).toBe(0);
		});

		it("ignores a value that isn't a number", () => {
			localStorage.setItem("mvp_default_volume", "loud");
			expect(readDefaultVolume()).toBe(100);
		});
	});

	describe("volume preference", () => {
		it("falls back to the default volume", () => {
			writeDefaultVolume(70);
			expect(readVolumePreference()).toEqual({ volume: 70, preMute: 70 });
		});

		it("unmutes to 100 when the default volume is 0", () => {
			writeDefaultVolume(0);
			expect(readVolumePreference()).toEqual({ volume: 0, preMute: 100 });
		});

		it("prefers the volume chosen this session", () => {
			writeDefaultVolume(70);
			writeVolumePreference({ volume: 30, preMute: 50 });
			expect(readVolumePreference()).toEqual({ volume: 30, preMute: 50 });
		});

		it("drops this session's volume when the default changes", () => {
			writeVolumePreference({ volume: 30, preMute: 50 });
			writeDefaultVolume(90);
			expect(readVolumePreference()).toEqual({ volume: 90, preMute: 90 });
		});

		it("ignores session data that isn't a volume preference", () => {
			writeDefaultVolume(70);
			for (const bad of ["null", "42", "{}", '{"volume":"loud","preMute":50}', "not json"]) {
				sessionStorage.setItem("mvp_volume", bad);
				expect(readVolumePreference()).toEqual({ volume: 70, preMute: 70 });
			}
		});
	});

	describe("hardware decoding", () => {
		it("is on when never set", () => {
			expect(readHwdecEnabled()).toBe(true);
		});

		it("round-trips the setting", () => {
			writeHwdecEnabled(false);
			expect(readHwdecEnabled()).toBe(false);
			writeHwdecEnabled(true);
			expect(readHwdecEnabled()).toBe(true);
		});
	});

	describe("skip intervals", () => {
		it("are 10 seconds each when never set", () => {
			expect(readSkipIntervals()).toEqual({ back: 10, forward: 10 });
		});

		it("round-trips each direction on its own", () => {
			writeSkipInterval("back", 5);
			expect(readSkipIntervals()).toEqual({ back: 5, forward: 10 });
			writeSkipInterval("forward", 30);
			expect(readSkipIntervals()).toEqual({ back: 5, forward: 30 });
		});

		it("ignores lengths Settings doesn't offer", () => {
			writeSkipInterval("forward", 30);
			writeSkipInterval("forward", 7);
			expect(readSkipIntervals().forward).toBe(30);
			for (const bad of ["7", "0", "-10", "ten", ""]) {
				localStorage.setItem("mvp_skip_back", bad);
				expect(readSkipIntervals().back).toBe(10);
			}
		});

		it("fires an event when a length changes", () => {
			const listener = vi.fn();
			window.addEventListener(SKIP_INTERVALS_EVENT, listener);
			writeSkipInterval("back", 15);
			writeSkipInterval("back", 8);
			window.removeEventListener(SKIP_INTERVALS_EVENT, listener);
			expect(listener).toHaveBeenCalledTimes(1);
		});
	});

	describe("skip segment modes", () => {
		it("show a button for both groups when never set", () => {
			expect(readSkipSegmentModes()).toEqual({ opening: "button", ending: "button" });
		});

		it("round-trips each group on its own", () => {
			writeSkipSegmentMode("opening", "auto");
			expect(readSkipSegmentModes()).toEqual({ opening: "auto", ending: "button" });
			writeSkipSegmentMode("ending", "off");
			expect(readSkipSegmentModes()).toEqual({ opening: "auto", ending: "off" });
		});

		it("ignores modes it doesn't know", () => {
			writeSkipSegmentMode("ending", "auto");
			writeSkipSegmentMode("ending", "always" as SkipSegmentMode);
			expect(readSkipSegmentModes().ending).toBe("auto");
			for (const bad of ["always", "", "AUTO"]) {
				localStorage.setItem("mvp_skip_opening", bad);
				expect(readSkipSegmentModes().opening).toBe("button");
			}
		});

		it("falls back to the button when storage throws", () => {
			const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
				throw new Error("denied");
			});
			try {
				expect(readSkipSegmentModes()).toEqual({ opening: "button", ending: "button" });
			} finally {
				get.mockRestore();
			}
		});

		it("fires an event when a mode changes", () => {
			const listener = vi.fn();
			window.addEventListener(SKIP_SEGMENT_MODES_EVENT, listener);
			writeSkipSegmentMode("opening", "off");
			writeSkipSegmentMode("opening", "never" as SkipSegmentMode);
			window.removeEventListener(SKIP_SEGMENT_MODES_EVENT, listener);
			expect(listener).toHaveBeenCalledTimes(1);
		});
	});
});

describe("player-prefs when storage is unavailable", () => {
	const blocked = () => {
		throw new DOMException("The operation is insecure.", "SecurityError");
	};

	it("falls back to the built-in settings when storage can't be read", () => {
		const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
		try {
			expect(readDefaultVolume()).toBe(100);
			expect(readVolumePreference()).toEqual({ volume: 100, preMute: 100 });
			expect(readHwdecEnabled()).toBe(true);
			expect(readSkipIntervals()).toEqual({ back: 10, forward: 10 });
		} finally {
			getItem.mockRestore();
		}
	});

	it("drops changes quietly when storage can't be written", () => {
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
		const listener = vi.fn();
		window.addEventListener(SKIP_INTERVALS_EVENT, listener);
		try {
			expect(() => {
				writeDefaultVolume(40);
				writeVolumePreference({ volume: 40, preMute: 40 });
				writeHwdecEnabled(false);
				writeSkipInterval("forward", 30);
			}).not.toThrow();
			expect(listener).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener(SKIP_INTERVALS_EVENT, listener);
			setItem.mockRestore();
		}
	});
});
