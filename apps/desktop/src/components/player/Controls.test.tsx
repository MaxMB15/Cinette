// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach, beforeAll, afterAll, onTestFinished } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { platform as osPlatform } from "@tauri-apps/plugin-os";
import { Controls } from "./Controls";
import type { PlayerState } from "@/lib/types";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: vi.fn() }));

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
		const thumb = () => screen.getByRole("slider", { name: "Seek" });
		// Radix puts the thumb in a positioned wrapper, after the track and its fill.
		const root = () => thumb().parentElement!.parentElement!;
		const track = () => root().firstElementChild!;
		return {
			onSeek,
			thumb,
			root,
			track,
			valueNow: () => Number(thumb().getAttribute("aria-valuenow")),
			percent: (style: string) => Number(/(-?[\d.]+)%/.exec(style)?.[1]),
			thumbLeft: () => thumb().parentElement!.style.left,
			fillRight: () => (track().firstElementChild as HTMLElement).style.right,
			rerender: (next: Partial<PlayerState>) =>
				view.rerender(controls({ ...playing, ...overrides, ...next })),
		};
	};

	// jsdom has no pointer events or pointer capture. Captures are kept by
	// pointer. As in browsers, a touch or pen press captures its pointer
	// before any handler runs, and the release lets it go after them.
	const captured = new Set<number>();
	const captureOnPress = (e: PointerEvent) => {
		if (e.pointerType === "touch" || e.pointerType === "pen") captured.add(e.pointerId);
	};
	const releaseAfterRelease = (e: PointerEvent) => void captured.delete(e.pointerId);
	const saved = {
		PointerEvent: window.PointerEvent,
		setPointerCapture: Element.prototype.setPointerCapture,
		hasPointerCapture: Element.prototype.hasPointerCapture,
		releasePointerCapture: Element.prototype.releasePointerCapture,
	};
	beforeAll(() => {
		class TestPointerEvent extends MouseEvent {
			readonly pointerId: number;
			readonly pointerType: string;
			readonly isPrimary: boolean;
			constructor(type: string, init: PointerEventInit = {}) {
				super(type, init);
				this.pointerId = init.pointerId ?? 1;
				this.pointerType = init.pointerType ?? "mouse";
				this.isPrimary = init.isPrimary ?? true;
			}
		}
		window.PointerEvent = TestPointerEvent as typeof PointerEvent;
		Element.prototype.setPointerCapture = (id: number) => void captured.add(id);
		Element.prototype.hasPointerCapture = (id: number) => captured.has(id);
		Element.prototype.releasePointerCapture = (id: number) => void captured.delete(id);
		window.addEventListener("pointerdown", captureOnPress, true);
		window.addEventListener("pointerup", releaseAfterRelease);
		window.addEventListener("pointercancel", releaseAfterRelease);
	});
	afterAll(() => {
		window.removeEventListener("pointerdown", captureOnPress, true);
		window.removeEventListener("pointerup", releaseAfterRelease);
		window.removeEventListener("pointercancel", releaseAfterRelease);
		Object.assign(window, { PointerEvent: saved.PointerEvent });
		Object.assign(Element.prototype, {
			setPointerCapture: saved.setPointerCapture,
			hasPointerCapture: saved.hasPointerCapture,
			releasePointerCapture: saved.releasePointerCapture,
		});
	});

	afterEach(() => {
		cleanup();
		captured.clear();
		vi.restoreAllMocks();
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

	const press = (target: Element, init: PointerEventInit = {}) =>
		fireEvent.pointerDown(target, { pointerId: 1, button: 0, ...init });
	const release = (target: Element, init: PointerEventInit = {}) =>
		fireEvent.pointerUp(target, { pointerId: 1, ...init });

	/** Focuses the thumb the way Tab does, without a press. */
	const tabTo = (thumb: HTMLElement) =>
		act(() => {
			fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
			thumb.focus();
			fireEvent.keyUp(thumb, { key: "Tab" });
		});
	/**
	 * Moves focus away and gives it back without Tab, the way an overlay such
	 * as the shortcuts list does when it closes.
	 */
	const giveFocusBack = (thumb: HTMLElement) =>
		act(() => {
			screen.getByRole("button", { name: "Stop" }).focus();
			fireEvent.keyDown(document.activeElement!, { key: "Escape" });
			thumb.focus();
		});
	/** Presses and releases the thumb, which focuses it without moving the bar. */
	const clickThumb = (thumb: HTMLElement) => {
		press(thumb);
		release(thumb);
	};

	// jsdom gives every element a size of 0, so Radix adds no edge offset to
	// the thumb here. These tests check that both are drawn from one value.
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

	it("names the position and volume for screen readers", () => {
		const bar = renderSeekBar();
		expect(bar.thumb()).toHaveAttribute("aria-valuetext", "2:00 of 30:00");
		expect(screen.getByRole("slider", { name: "Volume" })).toHaveAttribute(
			"aria-valuetext",
			"100%"
		);
	});

	describe("with the keyboard", () => {
		it("seeks one second per arrow on a bar reached with Tab", () => {
			const bar = renderSeekBar();
			tabTo(bar.thumb());
			expect(bar.thumb()).toHaveAttribute("data-focus-source", "keyboard");
			fireEvent.keyDown(bar.thumb(), { key: "ArrowRight" });
			expect(bar.onSeek).toHaveBeenCalledWith(121);
			// The key seeks at once and leaves no drag behind, so the bar
			// carries on following playback.
			bar.rerender({ position: 125 });
			expect(bar.valueNow()).toBe(125);
		});

		it("keeps its keys from the player's other handlers when reached with Tab", () => {
			const bar = renderSeekBar();
			tabTo(bar.thumb());
			const onWindowKey = vi.fn();
			window.addEventListener("keydown", onWindowKey);
			try {
				fireEvent.keyDown(bar.thumb(), { key: "ArrowUp" });
				expect(onWindowKey).not.toHaveBeenCalled();
				// Keys the slider doesn't use still reach the player.
				fireEvent.keyDown(bar.thumb(), { key: "f" });
				expect(onWindowKey).toHaveBeenCalledTimes(1);
			} finally {
				window.removeEventListener("keydown", onWindowKey);
			}
		});

		it("leaves the arrows to the player after a click", () => {
			const bar = renderSeekBar();
			const onWindowKey = vi.fn();
			window.addEventListener("keydown", onWindowKey);
			try {
				clickThumb(bar.thumb());
				expect(bar.thumb()).toHaveFocus();
				expect(bar.thumb()).toHaveAttribute("data-focus-source", "pointer");
				const notCanceled = fireEvent.keyDown(bar.thumb(), { key: "ArrowRight" });
				expect(notCanceled).toBe(false);
				expect(onWindowKey).toHaveBeenCalledTimes(1);
				expect(bar.onSeek).not.toHaveBeenCalled();
			} finally {
				window.removeEventListener("keydown", onWindowKey);
			}
		});

		it("ignores End after a click, so it doesn't jump to the end", () => {
			const bar = renderSeekBar();
			clickThumb(bar.thumb());
			fireEvent.keyDown(bar.thumb(), { key: "End" });
			expect(bar.onSeek).not.toHaveBeenCalled();
			expect(bar.valueNow()).toBe(120);
		});

		it("leaves its keys to the player when focus comes back to it after a click", () => {
			const bar = renderSeekBar();
			clickThumb(bar.thumb());
			giveFocusBack(bar.thumb());
			expect(bar.thumb()).toHaveFocus();
			expect(bar.thumb()).toHaveAttribute("data-focus-source", "pointer");
			fireEvent.keyDown(bar.thumb(), { key: "End" });
			fireEvent.keyDown(bar.thumb(), { key: "ArrowRight" });
			expect(bar.onSeek).not.toHaveBeenCalled();
		});

		it("leaves its keys to the player when focus comes back after a click on the focused bar", () => {
			const bar = renderSeekBar();
			tabTo(bar.thumb());
			clickThumb(bar.thumb());
			expect(bar.thumb()).toHaveAttribute("data-focus-source", "pointer");
			giveFocusBack(bar.thumb());
			expect(bar.thumb()).toHaveAttribute("data-focus-source", "pointer");
		});

		it("keeps its keys when focus comes back to it after Tab", () => {
			const bar = renderSeekBar();
			tabTo(bar.thumb());
			giveFocusBack(bar.thumb());
			expect(bar.thumb()).toHaveAttribute("data-focus-source", "keyboard");
			fireEvent.keyDown(bar.thumb(), { key: "ArrowRight" });
			expect(bar.onSeek).toHaveBeenCalledWith(121);
		});

		it("leaves its keys to the player when focus comes back after Tab was let go", () => {
			const bar = renderSeekBar();
			clickThumb(bar.thumb());
			act(() => {
				fireEvent.keyDown(bar.thumb(), { key: "Tab" });
				screen.getByRole("button", { name: "Stop" }).focus();
				fireEvent.keyUp(document.activeElement!, { key: "Tab" });
			});
			// Focus comes back with no key down, as a screen reader gives it.
			act(() => bar.thumb().focus());
			expect(bar.thumb()).toHaveAttribute("data-focus-source", "pointer");
		});

		it("leaves its keys to the player when focus comes back after another key", () => {
			const bar = renderSeekBar();
			clickThumb(bar.thumb());
			act(() => {
				fireEvent.keyDown(bar.thumb(), { key: "Tab" });
				screen.getByRole("button", { name: "Stop" }).focus();
			});
			giveFocusBack(bar.thumb());
			expect(bar.thumb()).toHaveAttribute("data-focus-source", "pointer");
		});

		it("counts focus after a click as the click's, even with Tab still down", () => {
			const bar = renderSeekBar();
			tabTo(bar.thumb());
			clickThumb(bar.thumb());
			act(() => {
				screen.getByRole("button", { name: "Stop" }).focus();
				bar.thumb().focus();
			});
			expect(bar.thumb()).toHaveAttribute("data-focus-source", "pointer");
		});

		it("takes its keys back once Tab returns to it", () => {
			const bar = renderSeekBar();
			clickThumb(bar.thumb());
			act(() => bar.thumb().blur());
			expect(bar.thumb()).not.toHaveAttribute("data-focus-source");
			tabTo(bar.thumb());
			fireEvent.keyDown(bar.thumb(), { key: "ArrowLeft" });
			expect(bar.onSeek).toHaveBeenCalledWith(119);
		});
	});

	describe("with a pointer", () => {
		it("shows the drag while playback moves on, then seeks once on release", () => {
			const bar = renderSeekBar();
			withWidth(bar.root());

			press(bar.track(), { clientX: 500 });
			fireEvent.pointerMove(bar.track(), { pointerId: 1, clientX: 750 });
			expect(bar.valueNow()).toBe(1350);
			bar.rerender({ position: 130 });
			expect(bar.valueNow()).toBe(1350);
			expect(bar.onSeek).not.toHaveBeenCalled();

			release(bar.track(), { clientX: 750 });
			expect(bar.onSeek).toHaveBeenCalledTimes(1);
			expect(bar.onSeek).toHaveBeenCalledWith(1350);
			expect(bar.valueNow()).toBe(130);
		});

		it("seeks to a spot pressed on the track without a drag", () => {
			const bar = renderSeekBar();
			withWidth(bar.root());
			press(bar.track(), { clientX: 500 });
			release(bar.track(), { clientX: 500 });
			expect(bar.onSeek).toHaveBeenCalledTimes(1);
			expect(bar.onSeek).toHaveBeenCalledWith(900);
		});

		it("doesn't seek when the thumb is pressed and let go while playback moves on", () => {
			const bar = renderSeekBar();
			withWidth(bar.root());
			press(bar.thumb(), { clientX: 67 });
			bar.rerender({ position: 121 });
			release(bar.thumb(), { clientX: 67 });
			expect(bar.onSeek).not.toHaveBeenCalled();
			expect(bar.valueNow()).toBe(121);
		});

		it("drops the drag without seeking when the touch is canceled", () => {
			const bar = renderSeekBar();
			withWidth(bar.root());
			press(bar.track(), { clientX: 500 });
			fireEvent.pointerCancel(bar.track(), { pointerId: 1 });
			expect(bar.onSeek).not.toHaveBeenCalled();
			expect(bar.valueNow()).toBe(120);
		});

		it("ignores buttons other than the primary one", () => {
			const bar = renderSeekBar();
			withWidth(bar.root());
			press(bar.track(), { clientX: 500, button: 2 });
			release(bar.track(), { clientX: 500, button: 2 });
			expect(bar.onSeek).not.toHaveBeenCalled();
			expect(bar.valueNow()).toBe(120);
		});

		it("ignores a Control-click, which opens the context menu on a Mac", () => {
			const bar = renderSeekBar();
			withWidth(bar.root());
			press(bar.track(), { clientX: 500, ctrlKey: true });
			release(bar.track(), { clientX: 500, ctrlKey: true });
			expect(bar.onSeek).not.toHaveBeenCalled();
			expect(bar.valueNow()).toBe(120);
		});

		it("takes a Control-click on Linux and Windows, where it opens no menu", () => {
			for (const os of ["linux", "windows"] as const) {
				vi.mocked(osPlatform).mockReturnValue(os);
				onTestFinished(() => void vi.mocked(osPlatform).mockReset());
				const bar = renderSeekBar();
				withWidth(bar.root());
				press(bar.track(), { clientX: 500, ctrlKey: true });
				release(bar.track(), { clientX: 500, ctrlKey: true });
				expect(bar.onSeek).toHaveBeenCalledWith(900);
				cleanup();
			}
		});

		it("takes a touch with Control held, as from a keyboard on an iPad", () => {
			const bar = renderSeekBar();
			withWidth(bar.root());
			const touch = { pointerType: "touch", ctrlKey: true };
			press(bar.track(), { ...touch, clientX: 500 });
			release(bar.track(), { ...touch, clientX: 500 });
			expect(bar.onSeek).toHaveBeenCalledWith(900);
		});

		it("follows only the first finger on the bar", () => {
			const bar = renderSeekBar();
			withWidth(bar.root());
			const touch = { pointerType: "touch" };
			press(bar.track(), { ...touch, clientX: 500 });
			press(bar.track(), { ...touch, pointerId: 2, isPrimary: false, clientX: 100 });
			fireEvent.pointerMove(bar.track(), { ...touch, pointerId: 1, clientX: 750 });
			release(bar.track(), { ...touch, clientX: 750 });
			expect(bar.onSeek).toHaveBeenCalledTimes(1);
			expect(bar.onSeek).toHaveBeenCalledWith(1350);

			// The second finger was never pressing the bar, so it doesn't seek
			// once the first one lets go.
			fireEvent.pointerMove(bar.track(), { ...touch, pointerId: 2, clientX: 250 });
			release(bar.track(), { ...touch, pointerId: 2, clientX: 250 });
			expect(bar.onSeek).toHaveBeenCalledTimes(1);
		});

		it("keeps the first finger's drag when a second finger taps the bar", () => {
			const bar = renderSeekBar();
			withWidth(bar.root());
			const touch = { pointerType: "touch" };
			press(bar.track(), { ...touch, clientX: 500 });
			press(bar.track(), { ...touch, pointerId: 2, isPrimary: false, clientX: 100 });
			release(bar.track(), { ...touch, pointerId: 2, clientX: 100 });
			expect(bar.onSeek).not.toHaveBeenCalled();
			expect(bar.valueNow()).toBe(900);

			fireEvent.pointerMove(bar.track(), { ...touch, pointerId: 1, clientX: 750 });
			expect(bar.onSeek).not.toHaveBeenCalled();
			release(bar.track(), { ...touch, clientX: 750 });
			expect(bar.onSeek).toHaveBeenCalledTimes(1);
			expect(bar.onSeek).toHaveBeenCalledWith(1350);
		});

		it("takes a tap while a thumb rests elsewhere on the screen", () => {
			const bar = renderSeekBar();
			withWidth(bar.root());
			// The resting thumb is the primary pointer, so the tap isn't.
			const tap = { pointerType: "touch", pointerId: 2, isPrimary: false, clientX: 250 };
			press(bar.track(), tap);
			release(bar.track(), tap);
			expect(bar.onSeek).toHaveBeenCalledWith(450);
		});

		it("ignores a pen while a finger is down, though both are primary", () => {
			const bar = renderSeekBar();
			withWidth(bar.root());
			press(bar.track(), { pointerType: "touch", clientX: 500 });
			const pen = { pointerType: "pen", pointerId: 2 };
			press(bar.track(), { ...pen, clientX: 100 });
			fireEvent.pointerMove(bar.track(), { ...pen, clientX: 200 });
			release(bar.track(), { ...pen, clientX: 200 });
			expect(bar.onSeek).not.toHaveBeenCalled();
			release(bar.track(), { pointerType: "touch", clientX: 500 });
			expect(bar.onSeek).toHaveBeenCalledWith(900);
		});

		it("takes a new press when the last one's release never arrived", () => {
			const bar = renderSeekBar();
			withWidth(bar.root());
			const touch = { pointerType: "touch" };
			press(bar.track(), { ...touch, clientX: 500 });
			// The capture went away with no release, as when its element is removed.
			captured.delete(1);
			press(bar.track(), { ...touch, pointerId: 3, clientX: 250 });
			release(bar.track(), { ...touch, pointerId: 3, clientX: 250 });
			expect(bar.onSeek).toHaveBeenCalledTimes(1);
			expect(bar.onSeek).toHaveBeenCalledWith(450);
		});

		it("drops a drag when the stream changes under it", () => {
			const bar = renderSeekBar();
			withWidth(bar.root());
			press(bar.track(), { clientX: 500 });
			bar.rerender({ currentUrl: "http://example.com/next.mkv", position: 5 });
			expect(bar.valueNow()).toBe(5);
			fireEvent.pointerMove(bar.track(), { pointerId: 1, clientX: 750 });
			expect(bar.valueNow()).toBe(5);
			release(bar.track(), { clientX: 750 });
			expect(bar.onSeek).not.toHaveBeenCalled();
			// The release ended the dropped drag, so the arrows seek again once
			// Tab brings focus back. The press left it on the thumb.
			act(() => screen.getByRole("button", { name: "Stop" }).focus());
			tabTo(bar.thumb());
			fireEvent.keyDown(bar.thumb(), { key: "ArrowRight" });
			expect(bar.onSeek).toHaveBeenCalledWith(6);
		});

		it("starts clean when the bar comes back after going away mid-drag", () => {
			const bar = renderSeekBar();
			withWidth(bar.root());
			press(bar.track(), { clientX: 500 });
			// A stream that loses its duration hides the bar, so no release arrives.
			bar.rerender({ duration: 0 });
			expect(screen.queryByRole("slider", { name: "Seek" })).toBeNull();
			bar.rerender({ position: 200 });
			expect(bar.valueNow()).toBe(200);
			// No drag is left over, so the arrows seek straight away.
			tabTo(bar.thumb());
			fireEvent.keyDown(bar.thumb(), { key: "ArrowRight" });
			expect(bar.onSeek).toHaveBeenCalledWith(201);
		});
	});
});
