// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
	isKeyboardFocusedControl,
	playerShortcuts,
	resolvePlayerHotkey,
	SEEK_LONG,
	SEEK_SHORT,
	VOLUME_STEP,
} from "./hotkeys";

const key = (
	k: string,
	mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}
) => ({
	key: k,
	shiftKey: false,
	ctrlKey: false,
	metaKey: false,
	altKey: false,
	...mods,
});

describe("resolvePlayerHotkey", () => {
	it("maps space and K to play/pause", () => {
		expect(resolvePlayerHotkey(key(" "))).toEqual({ type: "togglePlay" });
		expect(resolvePlayerHotkey(key("k"))).toEqual({ type: "togglePlay" });
	});
	it("maps F and M regardless of case", () => {
		expect(resolvePlayerHotkey(key("F"))).toEqual({ type: "toggleFullscreen" });
		expect(resolvePlayerHotkey(key("m"))).toEqual({ type: "toggleMute" });
	});
	it("seeks with arrows, longer with shift", () => {
		expect(resolvePlayerHotkey(key("ArrowLeft"))).toEqual({
			type: "seekBy",
			seconds: -SEEK_SHORT,
		});
		expect(resolvePlayerHotkey(key("ArrowRight", { shiftKey: true }))).toEqual({
			type: "seekBy",
			seconds: SEEK_LONG,
		});
	});
	it("seeks with J/L, longer with shift", () => {
		expect(resolvePlayerHotkey(key("j"))).toEqual({ type: "seekBy", seconds: -SEEK_SHORT });
		expect(resolvePlayerHotkey(key("l"))).toEqual({ type: "seekBy", seconds: SEEK_SHORT });
		expect(resolvePlayerHotkey(key("J", { shiftKey: true }))).toEqual({
			type: "seekBy",
			seconds: -SEEK_LONG,
		});
		expect(resolvePlayerHotkey(key("L", { shiftKey: true }))).toEqual({
			type: "seekBy",
			seconds: SEEK_LONG,
		});
	});
	it("uses the skip lengths passed in, keeping shift at the long seek", () => {
		const skip = { back: 5, forward: 30 };
		expect(resolvePlayerHotkey(key("ArrowLeft"), skip)).toEqual({
			type: "seekBy",
			seconds: -5,
		});
		expect(resolvePlayerHotkey(key("l"), skip)).toEqual({ type: "seekBy", seconds: 30 });
		expect(resolvePlayerHotkey(key("J", { shiftKey: true }), skip)).toEqual({
			type: "seekBy",
			seconds: -SEEK_LONG,
		});
	});
	it("changes volume with up/down", () => {
		expect(resolvePlayerHotkey(key("ArrowUp"))).toEqual({
			type: "volumeBy",
			delta: VOLUME_STEP,
		});
		expect(resolvePlayerHotkey(key("ArrowDown"))).toEqual({
			type: "volumeBy",
			delta: -VOLUME_STEP,
		});
	});
	it("maps digits to percentage seeks", () => {
		expect(resolvePlayerHotkey(key("0"))).toEqual({ type: "seekToPercent", percent: 0 });
		expect(resolvePlayerHotkey(key("7"))).toEqual({ type: "seekToPercent", percent: 70 });
	});
	it("ignores modifier combinations", () => {
		expect(resolvePlayerHotkey(key("f", { metaKey: true }))).toBeNull();
		expect(resolvePlayerHotkey(key("m", { ctrlKey: true }))).toBeNull();
		expect(resolvePlayerHotkey(key(" ", { altKey: true }))).toBeNull();
	});
	it("returns null for unbound keys", () => {
		expect(resolvePlayerHotkey(key("z"))).toBeNull();
	});
});

describe("playerShortcuts", () => {
	const seekLabels = (skip?: { back: number; forward: number }) =>
		playerShortcuts(skip)
			.filter(({ keys }) => keys[0] === "←" || keys[0] === "J")
			.map(({ label }) => label);

	it("describes the default skip", () => {
		expect(seekLabels()).toEqual(["Seek 10s back / forward", "Seek 10s back / forward"]);
	});

	it("names both lengths when they differ", () => {
		expect(seekLabels({ back: 15, forward: 30 })).toEqual([
			"Seek 15s back / 30s forward",
			"Seek 15s back / 30s forward",
		]);
	});
});

describe("isKeyboardFocusedControl", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		document.body.innerHTML = "";
	});

	it("is false for non-controls", () => {
		const div = document.createElement("div");
		document.body.appendChild(div);
		expect(isKeyboardFocusedControl(div)).toBe(false);
		expect(isKeyboardFocusedControl(null)).toBe(false);
	});

	it("is true for a button or button-role element that matches :focus-visible", () => {
		const button = document.createElement("button");
		const item = document.createElement("div");
		item.setAttribute("role", "menuitemradio");
		document.body.append(button, item);
		for (const el of [button, item]) {
			vi.spyOn(el, "matches").mockReturnValue(true);
			expect(isKeyboardFocusedControl(el)).toBe(true);
		}
	});

	it("is false for a button focused by a mouse click", () => {
		const button = document.createElement("button");
		document.body.appendChild(button);
		vi.spyOn(button, "matches").mockReturnValue(false);
		expect(isKeyboardFocusedControl(button)).toBe(false);
	});
});
