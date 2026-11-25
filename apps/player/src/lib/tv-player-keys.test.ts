// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import { resolveTvPlayerKey, type TvPlayerAction } from "./tv-player-keys";

const ZAP_BACK: TvPlayerAction = { type: "zap", step: -1 };
const ZAP_ON: TvPlayerAction = { type: "zap", step: 1 };
const GUIDE: TvPlayerAction = { type: "guide" };
const CONTROLS: TvPlayerAction = { type: "controls" };
const DETAILS: TvPlayerAction = { type: "details" };
const INFO: TvPlayerAction = { type: "info" };
const PREVIOUS: TvPlayerAction = { type: "episode", step: -1 };
const NEXT: TvPlayerAction = { type: "episode", step: 1 };

describe("resolveTvPlayerKey on live TV", () => {
	it.each([
		["ArrowUp", DETAILS],
		["ArrowDown", CONTROLS],
		["ChannelUp", ZAP_BACK],
		["PageUp", ZAP_BACK],
		["ChannelDown", ZAP_ON],
		["PageDown", ZAP_ON],
		["Guide", GUIDE],
		["ContextMenu", GUIDE],
		["ArrowLeft", { type: "seek", step: -1 }],
		["ArrowRight", { type: "seek", step: 1 }],
	])("gives %s its action", (key, action) => {
		expect(resolveTvPlayerKey(key, true)).toEqual(action);
	});

	it("leaves OK to the player's own shortcuts", () => {
		expect(resolveTvPlayerKey("Enter", true)).toBeNull();
	});
});

describe("resolveTvPlayerKey on a movie or episode", () => {
	it.each([
		["ArrowUp", DETAILS],
		["ArrowDown", CONTROLS],
		["ChannelUp", PREVIOUS],
		["PageUp", PREVIOUS],
		["ChannelDown", NEXT],
		["PageDown", NEXT],
		["ContextMenu", INFO],
	])("gives %s its action", (key, action) => {
		expect(resolveTvPlayerKey(key, false)).toEqual(action);
	});

	it.each(["ArrowLeft", "ArrowRight", "Enter", "Guide"])(
		"leaves %s to the player's own shortcuts",
		(key) => {
			expect(resolveTvPlayerKey(key, false)).toBeNull();
		}
	);
});

describe("resolveTvPlayerKey on anything", () => {
	it.each([true, false])("gives the keys that work everywhere their action, live %s", (live) => {
		expect(resolveTvPlayerKey("Info", live)).toEqual(INFO);
		expect(resolveTvPlayerKey("MediaStop", live)).toEqual({ type: "stop" });
	});

	it.each([true, false])("gives no action to another key, live %s", (live) => {
		expect(resolveTvPlayerKey("a", live)).toBeNull();
	});
});
