// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { offerShows, skipButtonShows, useSegmentSkipping } from "./useSegmentSkipping";
import { MAX_PLAY_STEP, NOTICE_MS, OFFER_SECONDS, SKIP_SETTLE_MS } from "@/lib/skip-segments";
import type { SkipSegmentModes } from "@/lib/player-prefs";
import { makeSegment } from "@/test/segments";

type Options = Parameters<typeof useSegmentSkipping>[0];

const intro = makeSegment();
const credits = makeSegment({
	kind: "credits",
	start: 2700,
	end: 2820,
	autoFrom: 2702,
	autoTo: 2818,
});
const DURATION = 2820;
/** A recap the player may skip on its own, with an intro where it ends. */
const firstRecap = makeSegment({
	kind: "recap",
	start: 0,
	end: 30,
	fit: "shifted",
	autoFrom: 2,
	autoTo: 30,
});
const introAfterRecap = makeSegment({
	start: 30,
	end: 90,
	fit: "shifted",
	autoFrom: 32,
	autoTo: 90,
});

const BUTTONS: SkipSegmentModes = { opening: "button", ending: "button" };
const AUTO: SkipSegmentModes = { opening: "auto", ending: "auto" };

/** Renders the hook at `position` 0, with a way to move the position along. */
const setup = (overrides: Partial<Options> = {}) => {
	let props: Options = {
		video: "s01e02",
		segments: [intro, credits],
		position: 0,
		duration: DURATION,
		reconnecting: false,
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
			const unsure = makeSegment({ fit: "mismatch", autoFrom: null, autoTo: null });
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

		it("hides the button while the stream reconnects and brings it back after", () => {
			const { result, update, at } = setup();
			at(70);
			update({ position: 0, duration: 0 });
			expect(result.current.offer).toBeNull();
			expect(result.current.skip()).toBe(false);
			update({ position: 71, duration: DURATION });
			expect(result.current.offer).toMatchObject({ label: "Skip intro", fresh: true });
		});

		it("keeps a skipped segment's button hidden across a reconnect", () => {
			const { result, update, at } = setup();
			at(70);
			act(() => void result.current.skip());
			act(() => vi.advanceTimersByTime(3000));
			update({ position: 0, duration: 0 });
			// The stream came back before the skip took.
			update({ position: 71, duration: DURATION });
			expect(result.current.offer).toBeNull();
		});

		it("lets the next segment skip on its own after a press lands at its start", () => {
			const recap = { ...firstRecap, autoFrom: null, autoTo: null };
			const { result, at, play, seek } = setup({
				modes: AUTO,
				segments: [recap, introAfterRecap],
			});
			at(5);
			act(() => void result.current.skip());
			expect(seek).toHaveBeenCalledWith(30);
			play(30, 32);
			expect(seek).toHaveBeenLastCalledWith(90);
			expect(result.current.notice).toEqual({ label: "Skipped intro" });
		});

		it("forgets where a press lands once playback gets there", () => {
			const { result, at, play, seek } = setup({ segments: [firstRecap, introAfterRecap] });
			play(25, 28);
			act(() => void result.current.skip());
			expect(seek).toHaveBeenCalledWith(30);
			play(29, 30);
			act(() => vi.advanceTimersByTime(SKIP_SETTLE_MS));
			// A seek back into the recap, close to where the press landed.
			at(28);
			expect(result.current.offer?.label).toBe("Skip recap");
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
			play(55, 62);
			expect(seek).toHaveBeenCalledWith(118);
			expect(result.current.notice).toEqual({ label: "Skipped intro" });
			expect(result.current.offer).toBeNull();
		});

		it("goes back with Undo and doesn't skip again", () => {
			const { result, play, at, seek } = setup({ modes: AUTO });
			play(55, 62);
			at(118);
			act(() => result.current.undo());
			expect(seek).toHaveBeenLastCalledWith(62);
			expect(result.current.notice).toBeNull();
			play(62, 70);
			expect(seek).toHaveBeenCalledTimes(2);
			expect(result.current.offer?.label).toBe("Skip intro");
		});

		it("hides the notice after a few seconds", () => {
			const { result, play } = setup({ modes: AUTO });
			play(58, 62);
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

		it("shows the button after a seek to just before the point it may skip from", () => {
			const { result, at, play, seek } = setup({ modes: AUTO });
			play(0, 2);
			at(61);
			play(62, 70);
			expect(seek).not.toHaveBeenCalled();
			expect(result.current.offer?.label).toBe("Skip intro");
		});

		it("waits for playback to run into the point it may skip from", () => {
			const late = makeSegment({ fit: "shifted", offset: -4, autoFrom: 64, autoTo: 120 });
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

		it("skips a segment that starts where the skipped one ends", () => {
			const { result, at, play, seek } = setup({
				modes: AUTO,
				segments: [firstRecap, introAfterRecap],
			});
			play(0, 2);
			expect(seek).toHaveBeenCalledWith(30);
			at(30.4);
			play(31, 32);
			expect(seek).toHaveBeenLastCalledWith(90);
			expect(result.current.notice).toEqual({ label: "Skipped intro" });
		});

		it("skips an overlapping segment when the skip lands a little early", () => {
			const overlapping = { ...introAfterRecap, start: 29.5, autoFrom: 31.5 };
			const { result, at, play, seek } = setup({
				modes: AUTO,
				segments: [firstRecap, overlapping],
			});
			play(0, 2);
			// The player shows the landing at once, then mpv's first frame
			// comes in a few milliseconds short of it.
			at(30);
			at(29.997);
			play(31, 32);
			expect(seek).toHaveBeenLastCalledWith(90);
			expect(result.current.notice).toEqual({ label: "Skipped intro" });
		});

		it("doesn't bring the button back when the skip lands after a wait", () => {
			const { result, play, at } = setup({ modes: AUTO });
			play(55, 62);
			// The stream buffers at the landing for a few seconds.
			act(() => vi.advanceTimersByTime(NOTICE_MS + 1000));
			at(118);
			expect(result.current.offer).toBeNull();
			at(118.9);
			expect(result.current.offer).toBeNull();
		});

		it("doesn't bring the button back when the skip lands a little early after a wait", () => {
			const { result, play, at } = setup({ modes: AUTO });
			play(55, 62);
			at(118);
			act(() => vi.advanceTimersByTime(1000));
			at(117.997);
			act(() => vi.advanceTimersByTime(NOTICE_MS));
			at(118);
			expect(result.current.notice).toBeNull();
			expect(result.current.offer).toBeNull();
		});

		it("forgets where a skip lands after a seek somewhere else", () => {
			const { result, at, play, seek } = setup({
				modes: AUTO,
				segments: [firstRecap, introAfterRecap],
			});
			play(0, 2);
			// The viewer goes back before the skip shows, then into the intro.
			at(10);
			at(31);
			play(32, 33);
			expect(seek).toHaveBeenCalledTimes(1);
			expect(result.current.offer?.label).toBe("Skip intro");
		});

		it("takes a seek further than a step from where a skip lands as the viewer's", () => {
			const { result, at, play, seek } = setup({
				modes: AUTO,
				segments: [firstRecap, introAfterRecap],
			});
			play(0, 2);
			at(30 + MAX_PLAY_STEP + 1);
			play(35, 36);
			expect(seek).toHaveBeenCalledTimes(1);
			expect(result.current.offer?.label).toBe("Skip intro");
		});

		it("forgets where a skip lands in the next video", () => {
			const { result, update, at, play, seek } = setup({
				modes: AUTO,
				segments: [firstRecap, introAfterRecap],
			});
			play(0, 2);
			update({ video: "s01e03", segments: [introAfterRecap] });
			at(31);
			play(32, 33);
			expect(seek).toHaveBeenCalledTimes(1);
			expect(result.current.offer?.label).toBe("Skip intro");
		});

		it("doesn't skip back when held past where the skip lands", () => {
			const { result, update, play, seek } = setup({ modes: AUTO });
			play(55, 58);
			update({ playing: false });
			play(59, 118);
			update({ position: 118.5, playing: true });
			expect(seek).not.toHaveBeenCalled();
			expect(result.current.notice).toBeNull();
		});

		it("plays the rest when held until just before where the skip lands", () => {
			const { result, update, play, seek } = setup({ modes: AUTO });
			play(55, 58);
			update({ playing: false });
			play(59, 117);
			update({ playing: true });
			play(118, 119);
			expect(seek).not.toHaveBeenCalled();
			expect(result.current.notice).toBeNull();
		});

		it("still skips on its own after being held past the segment once", () => {
			const { update, play, at, seek } = setup({ modes: AUTO });
			play(55, 58);
			update({ playing: false });
			play(59, 118);
			update({ position: 118.5, playing: true });
			at(40);
			play(41, 62);
			expect(seek).toHaveBeenCalledExactlyOnceWith(118);
		});

		it("skips an intro at the start when its times arrive after playback began", () => {
			const opening = makeSegment({ start: 0, end: 50, autoFrom: 2, autoTo: 48 });
			const { update, play, seek } = setup({ modes: AUTO, segments: [] });
			play(0, 3);
			update({ segments: [opening] });
			expect(seek).toHaveBeenCalledWith(48);
		});

		it("skips a recap at the start when playback begins a moment in", () => {
			const recap = makeSegment({
				kind: "recap",
				start: 0,
				end: 30,
				autoFrom: 2,
				autoTo: 28,
			});
			const { update, play, seek } = setup({ modes: AUTO, segments: [recap] });
			update({ position: 1 });
			play(2, 2);
			expect(seek).toHaveBeenCalledWith(28);
		});

		it("skips when the stream reconnects just before the segment", () => {
			const { update, play, seek } = setup({ modes: AUTO });
			play(55, 59);
			update({ position: 0, duration: 0 });
			update({ position: 60, duration: DURATION });
			play(61, 62);
			expect(seek).toHaveBeenCalledWith(118);
		});

		it("doesn't skip or offer anything while the stream reconnects", () => {
			const opening = makeSegment({ start: 0, end: 50, autoFrom: 2, autoTo: 48 });
			const { result, update, play, seek } = setup({ modes: AUTO, segments: [opening] });
			play(1500, 1502);
			for (let poll = 0; poll < 5; poll++) update({ position: 0, duration: 0 });
			expect(result.current.offer).toBeNull();
			play(1503, 1505);
			expect(seek).not.toHaveBeenCalled();
		});

		it("leaves out polls while the stream reconnects, even with a length", () => {
			const recap = makeSegment({
				kind: "recap",
				start: 0,
				end: 30,
				autoFrom: 2,
				autoTo: 28,
			});
			const { result, update, play, seek } = setup({
				modes: AUTO,
				segments: [recap, credits],
			});
			play(2698, 2702);
			update({ reconnecting: true, position: 0 });
			expect(result.current.offer).toBeNull();
			expect(result.current.countdown).not.toBeNull();
			update({ reconnecting: false, position: 2703 });
			expect(result.current.countdown).toEqual({ cancelLabel: "Watch credits" });
			expect(seek).not.toHaveBeenCalled();
		});

		it("leaves out the last poll from a reconnect until a new one comes", () => {
			const { result, update, play, seek } = setup({
				modes: AUTO,
				segments: [firstRecap, credits],
			});
			play(2698, 2702);
			update({ reconnecting: true, position: 0 });
			// The reconnect ends before the next poll.
			update({ reconnecting: false });
			expect(result.current.offer).toBeNull();
			expect(result.current.countdown).toEqual({ cancelLabel: "Watch credits" });
			update({ position: 2703 });
			expect(result.current.countdown).toEqual({ cancelLabel: "Watch credits" });
			expect(seek).not.toHaveBeenCalled();
		});

		it("skips again in the next video", () => {
			const { update, play, seek } = setup({ modes: AUTO });
			play(58, 62);
			update({ video: "s01e03", segments: [makeSegment()], position: 0 });
			play(1, 62);
			expect(seek).toHaveBeenCalledTimes(2);
		});

		it("doesn't skip an undone segment again when its times come again", () => {
			const { result, update, play, at, seek } = setup({ modes: AUTO });
			play(55, 62);
			at(118);
			act(() => result.current.undo());
			// Looked up again for a new length, so the times moved a little.
			const moved = makeSegment({ start: 59, end: 119, autoFrom: 61, autoTo: 117 });
			update({ segments: [moved, credits] });
			at(50);
			play(51, 70);
			expect(seek).toHaveBeenCalledTimes(2);
		});

		it("doesn't start over when the video is lost for a moment", () => {
			const { result, update, play, at, seek } = setup({ modes: AUTO });
			play(55, 62);
			at(118);
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
			play(2698, 2702);
			expect(result.current.countdown).toEqual({ cancelLabel: "Watch credits" });
			expect(result.current.offer).toBeNull();
			act(() => void result.current.skip());
			expect(onNextEpisode).toHaveBeenCalledTimes(1);
			expect(result.current.countdown).toBeNull();
		});

		it("goes on once when the countdown ends and Enter is pressed at once", () => {
			const { result, play, onNextEpisode } = setup({ modes: AUTO });
			play(2698, 2702);
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
			play(2698, 2702);
			act(() => result.current.cancelCountdown());
			expect(result.current.countdown).toBeNull();
			play(2703, 2710);
			expect(result.current.countdown).toBeNull();
			expect(result.current.offer).toBeNull();
			// Enter has no button to press.
			expect(result.current.skip()).toBe(false);
			expect(onNextEpisode).not.toHaveBeenCalled();
		});

		it("stops the countdown when autoplay is turned off", () => {
			const { result, play, update } = setup({ modes: AUTO });
			play(2698, 2702);
			update({ autoplay: false });
			expect(result.current.countdown).toBeNull();
			expect(result.current.offer?.label).toBe("Next episode");
		});

		it("stops the countdown when the credits are set to the button", () => {
			const { result, play, update } = setup({ modes: AUTO });
			play(2698, 2702);
			update({ modes: BUTTONS });
			expect(result.current.countdown).toBeNull();
		});

		it("stops the countdown when playback leaves the credits", () => {
			const { result, play, at } = setup({ modes: AUTO });
			play(2698, 2702);
			at(2000);
			expect(result.current.countdown).toBeNull();
		});

		it("keeps the countdown while the stream reconnects", () => {
			const { result, play, update } = setup({ modes: AUTO });
			play(2698, 2702);
			update({ position: 0, duration: 0 });
			expect(result.current.countdown).not.toBeNull();
			update({ position: 2703, duration: DURATION });
			expect(result.current.countdown).toEqual({ cancelLabel: "Watch credits" });
		});

		it("shows the button with autoplay off", () => {
			const { result, play } = setup({ modes: AUTO, autoplay: false });
			play(2698, 2704);
			expect(result.current.countdown).toBeNull();
			expect(result.current.offer?.label).toBe("Next episode");
		});

		it("does nothing at the last episode", () => {
			const { result, play } = setup({ modes: AUTO, hasNext: false });
			play(2698, 2704);
			expect(result.current.countdown).toBeNull();
			expect(result.current.offer).toBeNull();
		});
	});

	describe("offerShows", () => {
		const offer = { label: "Skip intro", next: false, fresh: true, unsure: false };

		it("shows a fresh offer with or without the controls", () => {
			expect(offerShows(offer, false)).toBe(true);
			expect(offerShows(offer, true)).toBe(true);
		});

		it("shows an older offer only with the controls", () => {
			expect(offerShows({ ...offer, fresh: false }, false)).toBe(false);
			expect(offerShows({ ...offer, fresh: false }, true)).toBe(true);
		});

		it("shows nothing without an offer", () => {
			expect(offerShows(null, true)).toBe(false);
		});
	});

	describe("skipButtonShows", () => {
		const offer = { label: "Skip intro", next: false, fresh: true, unsure: false };
		const none = { offer: null, notice: null, countdown: null };

		it("shows the countdown's button", () => {
			const countdown = { cancelLabel: "Watch credits" };
			expect(skipButtonShows({ ...none, countdown }, false)).toBe(true);
		});

		it("shows a Skip button as offerShows says", () => {
			expect(skipButtonShows({ ...none, offer }, false)).toBe(true);
			expect(skipButtonShows({ ...none, offer: { ...offer, fresh: false } }, false)).toBe(
				false
			);
			expect(skipButtonShows(none, true)).toBe(false);
		});

		it("hides the Skip button under a notice", () => {
			const notice = { label: "Skipped recap" };
			expect(skipButtonShows({ ...none, offer, notice }, true)).toBe(false);
		});
	});
});
