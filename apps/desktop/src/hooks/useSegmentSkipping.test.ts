// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSegmentSkipping } from "./useSegmentSkipping";
import { NOTICE_MS, OFFER_SECONDS } from "@/lib/skip-segments";
import type { SkipSegmentModes } from "@/lib/player-prefs";
import { makeSegment } from "@/test/segments";

type Options = Parameters<typeof useSegmentSkipping>[0];

const intro = makeSegment();
const credits = makeSegment({ kind: "credits", start: 2700, end: 2820, autoFrom: 2700 });
const DURATION = 2820;

const BUTTONS: SkipSegmentModes = { opening: "button", ending: "button" };
const AUTO: SkipSegmentModes = { opening: "auto", ending: "auto" };

/** Renders the hook at `position` 0, with a way to move the position along. */
const setup = (overrides: Partial<Options> = {}) => {
	let props: Options = {
		video: "s01e02",
		segments: [intro, credits],
		position: 0,
		duration: DURATION,
		playing: true,
		modes: BUTTONS,
		autoplay: true,
		hasNext: true,
		seek: vi.fn(),
		onNextEpisode: vi.fn(),
		...overrides,
	};
	const hook = renderHook((p: Options) => useSegmentSkipping(p), { initialProps: props });
	const update = (change: Partial<Options>) => {
		props = { ...props, ...change };
		hook.rerender(props);
	};
	return {
		...hook,
		seek: props.seek,
		onNextEpisode: props.onNextEpisode,
		update,
		/** A poll at `position`. */
		at: (position: number) => update({ position }),
		/** Polls a second apart from `from` up to `to`. */
		play: (from: number, to: number) => {
			for (let p = from; p <= to; p++) update({ position: p });
		},
	};
};

describe("useSegmentSkipping", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	describe("with a button", () => {
		it("offers to skip while a segment plays", () => {
			const { result, at } = setup();
			expect(result.current.offer).toBeNull();
			at(60);
			expect(result.current.offer).toEqual({
				label: "Skip intro",
				next: false,
				fresh: true,
				unsure: false,
			});
			at(119.5);
			expect(result.current.offer).toBeNull();
		});

		it("keeps the button for the first seconds only, unless the controls show", () => {
			const { result, play } = setup();
			play(58, 60 + OFFER_SECONDS - 1);
			expect(result.current.offer?.fresh).toBe(true);
			play(60 + OFFER_SECONDS, 60 + OFFER_SECONDS);
			expect(result.current.offer?.fresh).toBe(false);
		});

		it("counts the first seconds from where playback started in the segment", () => {
			const { result, at, play } = setup();
			at(90);
			expect(result.current.offer?.fresh).toBe(true);
			play(91, 90 + OFFER_SECONDS - 1);
			expect(result.current.offer?.fresh).toBe(true);
			play(90 + OFFER_SECONDS, 90 + OFFER_SECONDS);
			expect(result.current.offer?.fresh).toBe(false);
		});

		it("shows the button afresh after a seek within the segment", () => {
			const { result, at, play } = setup();
			play(58, 80);
			expect(result.current.offer?.fresh).toBe(false);
			at(100);
			expect(result.current.offer?.fresh).toBe(true);
		});

		it("jumps to the end of the segment and hides the button", () => {
			const { result, at, seek } = setup();
			at(70);
			let skipped = false;
			act(() => {
				skipped = result.current.skip();
			});
			expect(skipped).toBe(true);
			expect(seek).toHaveBeenCalledWith(120);
			expect(result.current.offer).toBeNull();
			// A poll from before the seek doesn't bring it back.
			at(120);
			at(71);
			expect(result.current.offer).toBeNull();
		});

		it("does nothing more when pressed twice at once", () => {
			const { result, at, seek } = setup();
			at(70);
			let again = true;
			act(() => {
				result.current.skip();
				again = result.current.skip();
			});
			expect(again).toBe(false);
			expect(seek).toHaveBeenCalledTimes(1);
		});

		it("offers the segment again after a seek back into it right away", () => {
			const { result, at, play } = setup();
			at(70);
			act(() => void result.current.skip());
			at(120);
			act(() => vi.advanceTimersByTime(500));
			at(65);
			act(() => vi.advanceTimersByTime(3000));
			play(66, 67);
			expect(result.current.offer?.label).toBe("Skip intro");
		});

		it("offers the segment again when playback goes back into it later", () => {
			const { result, at } = setup();
			at(70);
			act(() => void result.current.skip());
			at(120);
			act(() => vi.advanceTimersByTime(3000));
			at(121);
			at(80);
			expect(result.current.offer?.label).toBe("Skip intro");
		});

		it("marks times made for a video of another length", () => {
			const unsure = makeSegment({ fit: "mismatch", autoFrom: null });
			const { result, at } = setup({ segments: [unsure] });
			at(60);
			expect(result.current.offer?.unsure).toBe(true);
		});

		it("offers the next episode at credits that run to the end", () => {
			const { result, at, onNextEpisode } = setup();
			at(2700);
			expect(result.current.offer).toMatchObject({ label: "Next episode", next: true });
			act(() => void result.current.skip());
			expect(onNextEpisode).toHaveBeenCalledTimes(1);
			expect(result.current.offer).toBeNull();
			expect(result.current.skip()).toBe(false);
			expect(onNextEpisode).toHaveBeenCalledTimes(1);
		});

		it("offers nothing at the credits of the last episode", () => {
			const { result, at } = setup({ hasNext: false });
			at(2700);
			expect(result.current.offer).toBeNull();
			let skipped = true;
			act(() => {
				skipped = result.current.skip();
			});
			expect(skipped).toBe(false);
		});

		it("offers credits followed by more of the video as a skip", () => {
			const midCredits = makeSegment({ kind: "credits", start: 2600, end: 2700 });
			const { result, at, seek } = setup({ segments: [midCredits] });
			at(2650);
			expect(result.current.offer?.label).toBe("Skip credits");
			act(() => void result.current.skip());
			expect(seek).toHaveBeenCalledWith(2700);
		});

		it("never skips on its own", () => {
			const { result, play, seek } = setup();
			play(55, 70);
			expect(seek).not.toHaveBeenCalled();
			expect(result.current.notice).toBeNull();
		});
	});

	describe("when off", () => {
		it("offers and skips nothing in that group", () => {
			const { result, play, seek } = setup({ modes: { opening: "off", ending: "auto" } });
			play(55, 70);
			expect(result.current.offer).toBeNull();
			expect(seek).not.toHaveBeenCalled();
			expect(result.current.skip()).toBe(false);
		});
	});

	describe("on its own", () => {
		it("skips once playback runs into the segment and offers to undo", () => {
			const { result, play, seek } = setup({ modes: AUTO });
			play(55, 60);
			expect(seek).toHaveBeenCalledWith(120);
			expect(result.current.notice).toEqual({ label: "Skipped intro" });
			expect(result.current.offer).toBeNull();
		});

		it("goes back with Undo and doesn't skip again", () => {
			const { result, play, at, seek } = setup({ modes: AUTO });
			play(55, 61);
			at(120);
			act(() => result.current.undo());
			expect(seek).toHaveBeenLastCalledWith(60);
			expect(result.current.notice).toBeNull();
			play(60, 70);
			expect(seek).toHaveBeenCalledTimes(2);
			expect(result.current.offer?.label).toBe("Skip intro");
		});

		it("hides the notice after a few seconds", () => {
			const { result, play } = setup({ modes: AUTO });
			play(58, 60);
			act(() => vi.advanceTimersByTime(NOTICE_MS - 1));
			expect(result.current.notice).not.toBeNull();
			act(() => vi.advanceTimersByTime(1));
			expect(result.current.notice).toBeNull();
		});

		it("shows the button instead after a seek into the segment", () => {
			const { result, at, play, seek } = setup({ modes: AUTO });
			play(0, 2);
			at(80);
			play(81, 90);
			expect(seek).not.toHaveBeenCalled();
			expect(result.current.offer?.label).toBe("Skip intro");
		});

		it("waits for playback to run into the point it may skip from", () => {
			const late = makeSegment({ offset: 4, autoFrom: 64 });
			const { play, seek } = setup({ modes: AUTO, segments: [late] });
			play(58, 63);
			expect(seek).not.toHaveBeenCalled();
			play(64, 64);
			expect(seek).toHaveBeenCalledWith(120);
		});

		it("doesn't skip while paused", () => {
			const { update, seek } = setup({ modes: AUTO, playing: false });
			update({ position: 59 });
			update({ position: 61 });
			expect(seek).not.toHaveBeenCalled();
		});

		it("shows the button for times that aren't sure enough", () => {
			const unsure = makeSegment({ fit: "unchecked", autoFrom: null });
			const { result, play, seek } = setup({ modes: AUTO, segments: [unsure] });
			play(55, 65);
			expect(seek).not.toHaveBeenCalled();
			expect(result.current.offer?.label).toBe("Skip intro");
		});

		it("skips an intro at the start when its times arrive after playback began", () => {
			const opening = makeSegment({ start: 0, end: 50, autoFrom: 0 });
			const { update, play, seek } = setup({ modes: AUTO, segments: [] });
			play(0, 3);
			update({ segments: [opening] });
			expect(seek).toHaveBeenCalledWith(50);
		});

		it("skips again in the next video", () => {
			const { update, play, seek } = setup({ modes: AUTO });
			play(58, 61);
			update({ video: "s01e03", segments: [makeSegment()], position: 0 });
			play(1, 60);
			expect(seek).toHaveBeenCalledTimes(2);
		});

		it("doesn't skip an undone segment again when its times come again", () => {
			const { result, update, play, at, seek } = setup({ modes: AUTO });
			play(55, 61);
			at(120);
			act(() => result.current.undo());
			// Looked up again for a new length, so the times moved a little.
			update({ segments: [makeSegment({ start: 59, end: 119, autoFrom: 59 }), credits] });
			at(50);
			play(51, 70);
			expect(seek).toHaveBeenCalledTimes(2);
		});

		it("doesn't start over when the video is lost for a moment", () => {
			const { result, update, play, at, seek } = setup({ modes: AUTO });
			play(55, 61);
			at(120);
			act(() => result.current.undo());
			update({ video: null, segments: [] });
			update({ video: "s01e02", segments: [intro, credits] });
			play(60, 70);
			expect(seek).toHaveBeenCalledTimes(2);
		});
	});

	describe("at credits that run to the end", () => {
		it("counts down to the next episode with autoplay on", () => {
			const { result, play, onNextEpisode } = setup({ modes: AUTO });
			play(2698, 2700);
			expect(result.current.countdown).toEqual({ cancelLabel: "Watch credits" });
			expect(result.current.offer).toBeNull();
			act(() => void result.current.skip());
			expect(onNextEpisode).toHaveBeenCalledTimes(1);
			expect(result.current.countdown).toBeNull();
		});

		it("goes on once when the countdown ends and Enter is pressed at once", () => {
			const { result, play, onNextEpisode } = setup({ modes: AUTO });
			play(2698, 2700);
			let again = true;
			act(() => {
				result.current.skip();
				again = result.current.skip();
			});
			expect(again).toBe(false);
			expect(onNextEpisode).toHaveBeenCalledTimes(1);
		});

		it("stays on the credits when the countdown is canceled", () => {
			const { result, play, onNextEpisode } = setup({ modes: AUTO });
			play(2698, 2700);
			act(() => result.current.cancelCountdown());
			expect(result.current.countdown).toBeNull();
			play(2701, 2710);
			expect(result.current.countdown).toBeNull();
			expect(result.current.offer).toBeNull();
			// Enter has no button to press.
			expect(result.current.skip()).toBe(false);
			expect(onNextEpisode).not.toHaveBeenCalled();
		});

		it("stops the countdown when autoplay is turned off", () => {
			const { result, play, update } = setup({ modes: AUTO });
			play(2698, 2700);
			update({ autoplay: false });
			expect(result.current.countdown).toBeNull();
			expect(result.current.offer?.label).toBe("Next episode");
		});

		it("stops the countdown when the credits are set to the button", () => {
			const { result, play, update } = setup({ modes: AUTO });
			play(2698, 2700);
			update({ modes: BUTTONS });
			expect(result.current.countdown).toBeNull();
		});

		it("stops the countdown when playback leaves the credits", () => {
			const { result, play, at } = setup({ modes: AUTO });
			play(2698, 2700);
			at(2000);
			expect(result.current.countdown).toBeNull();
		});

		it("shows the button with autoplay off", () => {
			const { result, play } = setup({ modes: AUTO, autoplay: false });
			play(2698, 2702);
			expect(result.current.countdown).toBeNull();
			expect(result.current.offer?.label).toBe("Next episode");
		});

		it("does nothing at the last episode", () => {
			const { result, play } = setup({ modes: AUTO, hasNext: false });
			play(2698, 2702);
			expect(result.current.countdown).toBeNull();
			expect(result.current.offer).toBeNull();
		});
	});
});
