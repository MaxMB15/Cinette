// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { isOpeningStream, type StreamOpeningInput } from "./stream-opening";

const OPENING: StreamOpeningInput = {
	loadPending: false,
	currentUrl: "http://stream.example.com/live.m3u8",
	playbackStarted: false,
	firstFrameReady: false,
	error: null,
	failed: false,
	reconnecting: false,
};

describe("isOpeningStream", () => {
	it("shows once a load has returned and nothing is playing yet", () => {
		expect(isOpeningStream(OPENING)).toBe(true);
	});

	it("shows while the load is in flight, even before currentUrl is set", () => {
		expect(isOpeningStream({ ...OPENING, loadPending: true, currentUrl: null })).toBe(true);
	});

	it("ignores stale state from the previous stream while the load is in flight", () => {
		expect(
			isOpeningStream({
				...OPENING,
				loadPending: true,
				playbackStarted: true,
				firstFrameReady: true,
			})
		).toBe(true);
	});

	it("hides when playback has started", () => {
		expect(isOpeningStream({ ...OPENING, playbackStarted: true })).toBe(false);
	});

	it("hides on the first frame, before the next poll", () => {
		expect(isOpeningStream({ ...OPENING, firstFrameReady: true })).toBe(false);
	});

	it("hides when nothing is loaded", () => {
		expect(isOpeningStream({ ...OPENING, currentUrl: null })).toBe(false);
	});

	it("hides when the load fails", () => {
		expect(isOpeningStream({ ...OPENING, error: "loadfile: error" })).toBe(false);
		expect(isOpeningStream({ ...OPENING, loadPending: true, error: "boom" })).toBe(false);
	});

	it("hides when the stream failed to open or retries ran out", () => {
		expect(isOpeningStream({ ...OPENING, failed: true })).toBe(false);
	});

	it("gives way to the reconnect banner", () => {
		expect(isOpeningStream({ ...OPENING, reconnecting: true })).toBe(false);
	});
});
