// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Controls } from "./Controls";
import type { PlayerState } from "@/lib/types";

const noop = () => {};

const playing: PlayerState = {
	isPlaying: true,
	isPaused: false,
	currentUrl: "http://example.com/episode.mkv",
	volume: 100,
	position: 120,
	duration: 1800,
};

const renderControls = (touchLayout: boolean, hideCenterControls = false) =>
	render(
		<Controls
			state={playing}
			visible
			onPlay={noop}
			onPause={noop}
			onStop={noop}
			onSeek={noop}
			onVolumeChange={noop}
			skip={{ back: 10, forward: 10 }}
			onSkip={vi.fn()}
			onPrevEpisode={noop}
			onNextEpisode={noop}
			touchLayout={touchLayout}
			hideCenterControls={hideCenterControls}
		/>
	);

describe("Controls", () => {
	afterEach(cleanup);

	it("moves play and the skip buttons to the middle row on touch layouts", () => {
		renderControls(true);
		const pause = screen.getByRole("button", { name: "Pause" });
		const middleRow = pause.parentElement!;
		expect(screen.getAllByRole("button", { name: "Pause" })).toHaveLength(1);
		expect(middleRow).toContainElement(
			screen.getByRole("button", { name: "Skip back 10 seconds" })
		);
	});

	it("keeps the episode buttons out of the middle row, where a double-tap skips", () => {
		renderControls(true);
		const middleRow = screen.getByRole("button", { name: "Pause" }).parentElement!;
		for (const name of ["Previous episode", "Next episode"]) {
			const button = screen.getByRole("button", { name });
			expect(middleRow).not.toContainElement(button);
		}
	});

	it("leaves out play, pause and skip while the stream can't play", () => {
		for (const touchLayout of [true, false]) {
			renderControls(touchLayout, true);
			expect(screen.queryByRole("button", { name: /^(Play|Pause)$/ })).toBeNull();
			expect(screen.queryByRole("button", { name: /^Skip/ })).toBeNull();
			// Stop still works, to give up on a stream that won't open.
			expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
			cleanup();
		}
	});

	it("shows the episode buttons in the bar on desktop", () => {
		renderControls(false);
		expect(screen.getByRole("button", { name: "Previous episode" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Next episode" })).toBeInTheDocument();
	});
});

describe("Controls seek bar", () => {
	const renderSeekBar = (overrides: Partial<PlayerState> = {}) => {
		const onSeek = vi.fn();
		const controls = (state: PlayerState) => (
			<Controls
				state={state}
				visible
				onPlay={noop}
				onPause={noop}
				onStop={noop}
				onSeek={onSeek}
				onVolumeChange={noop}
			/>
		);
		const view = render(controls({ ...playing, ...overrides }));
		const thumb = screen.getByRole("slider", { name: "Seek" });
		// Radix puts the thumb in a positioned wrapper, after the track and its fill.
		const root = thumb.parentElement!.parentElement!;
		const fill = root.firstElementChild!.firstElementChild as HTMLElement;
		return {
			onSeek,
			thumb,
			root,
			percent: (style: string) => Number(/(-?[\d.]+)%/.exec(style)?.[1]),
			thumbLeft: () => thumb.parentElement!.style.left,
			fillRight: () => fill.style.right,
			rerender: (next: Partial<PlayerState>) =>
				view.rerender(controls({ ...playing, ...overrides, ...next })),
		};
	};

	/** Makes the thumb match :focus-visible or not, as a Tab or a click would. */
	const focusThumb = (thumb: HTMLElement, byKeyboard: boolean) => {
		vi.spyOn(thumb, "matches").mockImplementation((selector) =>
			selector === ":focus-visible" ? byKeyboard : false
		);
		thumb.focus();
	};

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("draws the thumb where the fill ends, between whole seconds too", () => {
		const bar = renderSeekBar({ position: 450.6 });
		// jsdom keeps four decimals of a percentage.
		const percent = (450.6 / 1800) * 100;
		expect(bar.percent(bar.thumbLeft())).toBeCloseTo(percent, 3);
		expect(100 - bar.percent(bar.fillRight())).toBeCloseTo(percent, 3);
	});

	it("keeps the thumb and fill together at the end when the position runs past the duration", () => {
		const bar = renderSeekBar({ position: 1805 });
		expect(bar.percent(bar.thumbLeft())).toBe(100);
		expect(bar.percent(bar.fillRight())).toBe(0);
	});

	it("follows the duration when it changes", () => {
		const bar = renderSeekBar({ position: 900 });
		bar.rerender({ duration: 3600 });
		expect(bar.percent(bar.thumbLeft())).toBe(25);
		expect(bar.percent(bar.fillRight())).toBe(75);
	});

	it("names the position for screen readers", () => {
		const { thumb } = renderSeekBar();
		expect(thumb).toHaveAttribute("aria-valuetext", "2:00 of 30:00");
	});

	describe("with the keyboard", () => {
		it("seeks one second per arrow on a bar reached with Tab", () => {
			const bar = renderSeekBar();
			focusThumb(bar.thumb, true);
			fireEvent.keyDown(bar.thumb, { key: "ArrowRight" });
			expect(bar.onSeek).toHaveBeenCalledWith(121);
			// The key seeks at once and leaves no drag behind, so the bar
			// carries on following playback.
			bar.rerender({ position: 125 });
			expect(bar.thumb).toHaveAttribute("aria-valuenow", "125");
		});

		it("leaves the arrows to the player hotkeys after a click", () => {
			const bar = renderSeekBar();
			focusThumb(bar.thumb, false);
			const notCancelled = fireEvent.keyDown(bar.thumb, { key: "ArrowRight" });
			expect(notCancelled).toBe(false);
			expect(bar.onSeek).not.toHaveBeenCalled();
		});

		it("still takes keys the player doesn't use after a click", () => {
			const bar = renderSeekBar();
			focusThumb(bar.thumb, false);
			fireEvent.keyDown(bar.thumb, { key: "End" });
			expect(bar.onSeek).toHaveBeenCalledWith(1800);
		});
	});

	describe("with a pointer", () => {
		// jsdom has no pointer events or pointer capture.
		const saved = {
			PointerEvent: window.PointerEvent,
			setPointerCapture: Element.prototype.setPointerCapture,
			hasPointerCapture: Element.prototype.hasPointerCapture,
			releasePointerCapture: Element.prototype.releasePointerCapture,
		};
		beforeAll(() => {
			class TestPointerEvent extends MouseEvent {
				readonly pointerId: number;
				constructor(type: string, init: PointerEventInit = {}) {
					super(type, init);
					this.pointerId = init.pointerId ?? 1;
				}
			}
			window.PointerEvent = TestPointerEvent as typeof PointerEvent;
			Element.prototype.setPointerCapture = () => {};
			Element.prototype.hasPointerCapture = () => true;
			Element.prototype.releasePointerCapture = () => {};
		});
		afterAll(() => {
			Object.assign(window, { PointerEvent: saved.PointerEvent });
			Object.assign(Element.prototype, {
				setPointerCapture: saved.setPointerCapture,
				hasPointerCapture: saved.hasPointerCapture,
				releasePointerCapture: saved.releasePointerCapture,
			});
		});

		/** Gives the bar a width of 1000px, so clientX 500 is the middle. */
		const withWidth = (root: HTMLElement) =>
			vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
				left: 0,
				right: 1000,
				width: 1000,
				top: 0,
				bottom: 16,
				height: 16,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			});

		it("shows the drag while playback moves on, then seeks once on release", () => {
			const bar = renderSeekBar();
			withWidth(bar.root);
			const track = bar.root.firstElementChild!;

			fireEvent.pointerDown(track, { pointerId: 1, clientX: 500, button: 0 });
			fireEvent.pointerMove(track, { pointerId: 1, clientX: 750 });
			expect(bar.thumb).toHaveAttribute("aria-valuenow", "1350");
			bar.rerender({ position: 130 });
			expect(bar.thumb).toHaveAttribute("aria-valuenow", "1350");
			expect(bar.onSeek).not.toHaveBeenCalled();

			fireEvent.pointerUp(track, { pointerId: 1, clientX: 750 });
			expect(bar.onSeek).toHaveBeenCalledTimes(1);
			expect(bar.onSeek).toHaveBeenCalledWith(1350);
			expect(bar.thumb).toHaveAttribute("aria-valuenow", "130");
		});

		it("drops the drag without seeking when the touch is cancelled", () => {
			const bar = renderSeekBar();
			withWidth(bar.root);
			const track = bar.root.firstElementChild!;

			fireEvent.pointerDown(track, { pointerId: 1, clientX: 500, button: 0 });
			fireEvent.pointerCancel(track, { pointerId: 1 });
			expect(bar.onSeek).not.toHaveBeenCalled();
			expect(bar.thumb).toHaveAttribute("aria-valuenow", "120");
		});

		it("follows playback again after a drag that ends where it began", () => {
			const bar = renderSeekBar();
			withWidth(bar.root);
			const track = bar.root.firstElementChild!;

			fireEvent.pointerDown(track, { pointerId: 1, clientX: 500, button: 0 });
			// 120 s is 66.67px along a 1000px bar of 1800 s.
			fireEvent.pointerMove(track, { pointerId: 1, clientX: 66.67 });
			fireEvent.pointerUp(track, { pointerId: 1, clientX: 66.67 });
			// Nothing to seek to, so no commit ends the drag.
			expect(bar.onSeek).not.toHaveBeenCalled();
			bar.rerender({ position: 140 });
			expect(bar.thumb).toHaveAttribute("aria-valuenow", "140");
		});
	});
});
