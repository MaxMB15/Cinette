// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
	isInside,
	isKeyboardFocusedControl,
	isSliderOwnKey,
	leaveSliderKeysToPlayer,
	type PlayerAction,
	playerShortcuts,
	repeatsWhenHeld,
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
	it("maps Enter to skipping an intro or credits", () => {
		expect(resolvePlayerHotkey(key("Enter"))).toEqual({ type: "skipSegment" });
		expect(resolvePlayerHotkey(key("Enter", { metaKey: true }))).toBeNull();
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

	it.each([
		{ k: "K", action: { type: "togglePlay" } },
		{ k: "f", action: { type: "toggleFullscreen" } },
		{ k: "M", action: { type: "toggleMute" } },
		{ k: "J", action: { type: "seekBy", seconds: -SEEK_SHORT } },
		{ k: "L", action: { type: "seekBy", seconds: SEEK_SHORT } },
		{ k: "n", action: { type: "nextEpisode" } },
		{ k: "N", action: { type: "nextEpisode" } },
		{ k: "p", action: { type: "prevEpisode" } },
		{ k: "P", action: { type: "prevEpisode" } },
		{ k: "s", action: { type: "toggleSubtitles" } },
		{ k: "S", action: { type: "toggleSubtitles" } },
		{ k: "i", action: { type: "toggleInfo" } },
		{ k: "I", action: { type: "toggleInfo" } },
		{ k: "?", action: { type: "toggleShortcuts" } },
		{ k: "Home", action: { type: "seekToPercent", percent: 0 } },
		{ k: "Escape", action: { type: "escape" } },
	])("maps $k to $action.type", ({ k, action }) => {
		expect(resolvePlayerHotkey(key(k))).toEqual(action);
	});

	it("maps every digit to its tenth of the runtime", () => {
		for (let d = 0; d <= 9; d++) {
			expect(resolvePlayerHotkey(key(String(d)))).toEqual({
				type: "seekToPercent",
				percent: d * 10,
			});
		}
	});

	it("leaves function keys alone even though their names end in a digit", () => {
		expect(resolvePlayerHotkey(key("F1"))).toBeNull();
		expect(resolvePlayerHotkey(key("F10"))).toBeNull();
	});
});

describe("repeatsWhenHeld", () => {
	it("keeps seeking and changing the volume while a key is held", () => {
		for (const k of ["ArrowLeft", "ArrowRight", "j", "L", "ArrowUp", "ArrowDown"]) {
			expect(repeatsWhenHeld(resolvePlayerHotkey(key(k))!)).toBe(true);
		}
	});

	it("runs everything else once per press", () => {
		for (const k of [
			" ",
			"k",
			"f",
			"m",
			"Escape",
			"n",
			"p",
			"s",
			"i",
			"?",
			"5",
			"Home",
			"Enter",
		]) {
			expect(repeatsWhenHeld(resolvePlayerHotkey(key(k))!)).toBe(false);
		}
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

	it("gives Shift the long seek whatever the skip lengths are", () => {
		const shiftLabels = playerShortcuts({ back: 5, forward: 15 })
			.filter(({ keys }) => keys[0].startsWith("Shift"))
			.map(({ label }) => label);
		expect(shiftLabels).toEqual([
			`Seek ${SEEK_LONG}s back / forward`,
			`Seek ${SEEK_LONG}s back / forward`,
		]);
	});

	/** The key presses each name in the overlay stands for. */
	const presses: Record<string, ReturnType<typeof key>[]> = {
		Space: [key(" ")],
		K: [key("k"), key("K")],
		F: [key("f"), key("F")],
		M: [key("m"), key("M")],
		"←": [key("ArrowLeft")],
		"→": [key("ArrowRight")],
		J: [key("j"), key("J")],
		L: [key("l"), key("L")],
		"Shift ←": [key("ArrowLeft", { shiftKey: true })],
		"Shift →": [key("ArrowRight", { shiftKey: true })],
		"Shift J": [key("J", { shiftKey: true })],
		"Shift L": [key("L", { shiftKey: true })],
		"0–9": Array.from({ length: 10 }, (_, d) => key(String(d))),
		Home: [key("Home")],
		"↑": [key("ArrowUp")],
		"↓": [key("ArrowDown")],
		N: [key("n"), key("N")],
		P: [key("p"), key("P")],
		S: [key("s"), key("S")],
		I: [key("i"), key("I")],
		Enter: [key("Enter")],
		"?": [key("?")],
		Esc: [key("Escape")],
	};

	it("labels every entry and names only keys the player handles", () => {
		for (const { keys, label } of playerShortcuts()) {
			expect(label).not.toBe("");
			expect(keys.length).toBeGreaterThan(0);
			for (const name of keys) {
				expect(presses[name], name).toBeDefined();
				for (const press of presses[name]) {
					expect(resolvePlayerHotkey(press), name).not.toBeNull();
				}
			}
		}
	});

	it("lists a key for every player action", () => {
		const listed = new Set(
			playerShortcuts()
				.flatMap(({ keys }) => keys.flatMap((name) => presses[name] ?? []))
				.map((press) => resolvePlayerHotkey(press)?.type)
		);
		// The type makes tsc fail when an action is added without a key here.
		const every: Record<PlayerAction["type"], true> = {
			escape: true,
			nextEpisode: true,
			prevEpisode: true,
			seekBy: true,
			seekToPercent: true,
			skipSegment: true,
			toggleFullscreen: true,
			toggleInfo: true,
			toggleMute: true,
			togglePlay: true,
			toggleShortcuts: true,
			toggleSubtitles: true,
			volumeBy: true,
		};
		expect([...listed].sort()).toEqual(Object.keys(every).sort());
	});
});

describe("isInside", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("is true only for nodes inside the container", () => {
		const container = document.createElement("div");
		const child = document.createElement("button");
		const outside = document.createElement("button");
		container.appendChild(child);
		document.body.append(container, outside);
		expect(isInside(container, child)).toBe(true);
		expect(isInside(container, container)).toBe(true);
		expect(isInside(container, outside)).toBe(false);
	});

	it("is false without a container or a node", () => {
		const child = document.createElement("button");
		expect(isInside(null, child)).toBe(false);
		expect(isInside(document.body, null)).toBe(false);
		expect(isInside(document.body, window)).toBe(false);
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

	/** An element whose `:focus-visible` match is set by the test. */
	const focusVisible = (el: HTMLElement) => {
		document.body.appendChild(el);
		const matches = vi.spyOn(el, "matches").mockReturnValue(true);
		return { el, matches };
	};

	const withRole = (role: string) => {
		const el = document.createElement("div");
		el.setAttribute("role", role);
		return el;
	};

	it.each([
		"button",
		"link",
		"checkbox",
		"switch",
		"tab",
		"menuitem",
		"menuitemcheckbox",
		"menuitemradio",
	])("treats an element with role %s as a control", (role) => {
		expect(isKeyboardFocusedControl(focusVisible(withRole(role)).el)).toBe(true);
	});

	it("treats a link as a control", () => {
		expect(isKeyboardFocusedControl(focusVisible(document.createElement("a")).el)).toBe(true);
	});

	it("leaves Space to the player on other elements, even when focus shows", () => {
		for (const el of [
			document.createElement("div"),
			document.createElement("span"),
			withRole("slider"),
			withRole("textbox"),
		]) {
			expect(isKeyboardFocusedControl(focusVisible(el).el)).toBe(false);
		}
	});

	it("asks the browser whether the control shows focus", () => {
		const { el, matches } = focusVisible(document.createElement("button"));
		isKeyboardFocusedControl(el);
		expect(matches).toHaveBeenCalledWith(":focus-visible");
	});
});

describe("slider keys", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	/** A slider thumb, focused by a press or by the keyboard, as `Slider` marks it. */
	const thumb = (focusSource?: "pointer" | "keyboard") => {
		const el = document.createElement("span");
		el.setAttribute("role", "slider");
		if (focusSource) el.setAttribute("data-focus-source", focusSource);
		document.body.appendChild(el);
		return el;
	};

	const keyDown = (target: EventTarget, k: string) => {
		const e = { key: k, target, preventDefault: vi.fn(), stopPropagation: vi.fn() };
		leaveSliderKeysToPlayer(e);
		return e;
	};

	const SLIDER_KEYS = [
		"ArrowLeft",
		"ArrowRight",
		"ArrowUp",
		"ArrowDown",
		"Home",
		"End",
		"PageUp",
		"PageDown",
	];

	it("lets a slider reached with the keyboard move with its keys and keep them", () => {
		const el = thumb("keyboard");
		for (const k of SLIDER_KEYS) {
			expect(isSliderOwnKey(el, k)).toBe(true);
			const e = keyDown(el, k);
			expect(e.preventDefault).not.toHaveBeenCalled();
			expect(e.stopPropagation).toHaveBeenCalled();
		}
	});

	it("keeps a pressed slider still and passes its keys on to the player", () => {
		const el = thumb("pointer");
		for (const k of SLIDER_KEYS) {
			expect(isSliderOwnKey(el, k)).toBe(false);
			const e = keyDown(el, k);
			expect(e.preventDefault).toHaveBeenCalled();
			expect(e.stopPropagation).not.toHaveBeenCalled();
		}
	});

	it("treats a slider with no recorded focus source as reached with the keyboard", () => {
		expect(isSliderOwnKey(thumb(), "ArrowLeft")).toBe(true);
	});

	it("never touches other keys", () => {
		for (const el of [thumb("keyboard"), thumb("pointer")]) {
			for (const k of [" ", "f", "m", "Escape", "Tab"]) {
				expect(isSliderOwnKey(el, k)).toBe(false);
				const e = keyDown(el, k);
				expect(e.preventDefault).not.toHaveBeenCalled();
				expect(e.stopPropagation).not.toHaveBeenCalled();
			}
		}
	});

	it("only applies to sliders", () => {
		const button = document.createElement("button");
		document.body.appendChild(button);
		expect(isSliderOwnKey(button, "ArrowLeft")).toBe(false);
		expect(isSliderOwnKey(null, "ArrowLeft")).toBe(false);
	});
});

import { isTypingTarget } from "./hotkeys";

describe("isTypingTarget", () => {
	/** jsdom doesn't compute isContentEditable, so set it the way a browser would. */
	const block = (editable: boolean) => {
		const div = document.createElement("div");
		Object.defineProperty(div, "isContentEditable", { value: editable });
		return div;
	};

	it.each([
		{ name: "a text input", tag: "input" },
		{ name: "a text area", tag: "textarea" },
		{ name: "a dropdown", tag: "select" },
	])("is true for $name", ({ tag }) => {
		expect(isTypingTarget(document.createElement(tag))).toBe(true);
	});

	it("is true for editable text and false for plain content", () => {
		expect(isTypingTarget(block(true))).toBe(true);
		expect(isTypingTarget(block(false))).toBe(false);
	});

	it("is false for targets that aren't elements", () => {
		expect(isTypingTarget(null)).toBe(false);
		expect(isTypingTarget(window)).toBe(false);
		expect(isTypingTarget(document)).toBe(false);
	});
});

describe("isKeyboardFocusedControl without :focus-visible support", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lets Space activate a button when the browser can't tell how it was focused", () => {
		const button = document.createElement("button");
		vi.spyOn(button, "matches").mockImplementation(() => {
			throw new DOMException("':focus-visible' is not a valid selector", "SyntaxError");
		});
		expect(isKeyboardFocusedControl(button)).toBe(true);
	});
});
