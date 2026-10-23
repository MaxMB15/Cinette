// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach, beforeAll, afterAll, onTestFinished } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { platform as osPlatform } from "@tauri-apps/plugin-os";
import { installPointerEvent } from "@/test/pointer-event";
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

type ControlsProps = ComponentProps<typeof Controls>;

/** The desktop bar for an episode that's playing. Override what a test needs. */
const renderControls = (overrides: Partial<ControlsProps> = {}) => {
	const controls = (props: Partial<ControlsProps>) => (
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
			{...props}
		/>
	);
	const view = render(controls(overrides));
	return {
		...view,
		/** Renders again with `next` on top of the first overrides. */
		rerender: (next: Partial<ControlsProps>) =>
			view.rerender(controls({ ...overrides, ...next })),
	};
};

describe("Controls", () => {
	afterEach(cleanup);

	it("moves play and the skip buttons to the middle row on touch layouts", () => {
		renderControls({ touchLayout: true });
		const pause = screen.getByRole("button", { name: "Pause" });
		const middleRow = pause.parentElement!;
		expect(screen.getAllByRole("button", { name: "Pause" })).toHaveLength(1);
		expect(middleRow).toContainElement(
			screen.getByRole("button", { name: "Skip back 10 seconds" })
		);
	});

	it("keeps the episode buttons out of the middle row, where a double-tap skips", () => {
		renderControls({ touchLayout: true });
		const middleRow = screen.getByRole("button", { name: "Pause" }).parentElement!;
		for (const name of ["Previous episode", "Next episode"]) {
			const button = screen.getByRole("button", { name });
			expect(middleRow).not.toContainElement(button);
		}
	});

	it("leaves out play, pause and skip while the stream can't play", () => {
		for (const touchLayout of [true, false]) {
			renderControls({ touchLayout, hideCenterControls: true });
			expect(screen.queryByRole("button", { name: /^(Play|Pause)$/ })).toBeNull();
			expect(screen.queryByRole("button", { name: /^Skip/ })).toBeNull();
			// Stop still works, to give up on a stream that won't open.
			expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
			cleanup();
		}
	});

	it("shows the episode buttons in the bar on desktop", () => {
		renderControls();
		expect(screen.getByRole("button", { name: "Previous episode" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Next episode" })).toBeInTheDocument();
	});

	it("shows only skip, play, stop and mute by default", () => {
		renderControls({ onPrevEpisode: undefined, onNextEpisode: undefined });
		const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
		expect(names).toEqual([
			"Skip back 10 seconds",
			"Pause",
			"Skip forward 10 seconds",
			"Stop",
			"Mute",
		]);
	});

	it("lets taps through to the video while the controls are hidden", () => {
		const view = renderControls({ visible: false });
		const bar = view.container.firstElementChild;
		expect(bar).toHaveClass("pointer-events-none");
		view.rerender({ visible: true });
		expect(bar).not.toHaveClass("pointer-events-none");
	});

	it("shows play in the bar while paused or stopped, and plays when pressed", () => {
		for (const state of [
			{ ...playing, isPaused: true },
			{ ...playing, isPlaying: false },
		]) {
			const onPlay = vi.fn();
			const onPause = vi.fn();
			renderControls({ state, onPlay, onPause });
			expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
			fireEvent.click(screen.getByRole("button", { name: "Play" }));
			expect(onPlay).toHaveBeenCalledTimes(1);
			expect(onPause).not.toHaveBeenCalled();
			cleanup();
		}
	});

	it("pauses from the bar while playing", () => {
		const onPlay = vi.fn();
		const onPause = vi.fn();
		renderControls({ onPlay, onPause });
		fireEvent.click(screen.getByRole("button", { name: "Pause" }));
		expect(onPause).toHaveBeenCalledTimes(1);
		expect(onPlay).not.toHaveBeenCalled();
	});

	it("skips back and forward by the set lengths from the bar", () => {
		const onSkip = vi.fn();
		renderControls({ skip: { back: 5, forward: 30 }, onSkip });
		fireEvent.click(screen.getByRole("button", { name: "Skip back 5 seconds" }));
		expect(onSkip).toHaveBeenLastCalledWith(-5);
		fireEvent.click(screen.getByRole("button", { name: "Skip forward 30 seconds" }));
		expect(onSkip).toHaveBeenLastCalledWith(30);
		expect(onSkip).toHaveBeenCalledTimes(2);
	});

	it("leaves out the skip buttons when the stream can't seek", () => {
		renderControls({ skip: undefined });
		expect(screen.queryByRole("button", { name: /^Skip/ })).toBeNull();
		expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
	});

	it("stops playback", () => {
		const onStop = vi.fn();
		renderControls({ onStop });
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(onStop).toHaveBeenCalledTimes(1);
	});

	it("mutes and unmutes through the volume when there's no mute handler", () => {
		const onVolumeChange = vi.fn();
		const view = renderControls({ onVolumeChange });
		fireEvent.click(screen.getByRole("button", { name: "Mute" }));
		expect(onVolumeChange).toHaveBeenLastCalledWith(0);
		view.rerender({ state: { ...playing, volume: 0 } });
		fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
		expect(onVolumeChange).toHaveBeenLastCalledWith(100);
	});

	it("leaves muting to the mute handler when there is one", () => {
		const onToggleMute = vi.fn();
		const onVolumeChange = vi.fn();
		renderControls({ onToggleMute, onVolumeChange });
		fireEvent.click(screen.getByRole("button", { name: "Mute" }));
		expect(onToggleMute).toHaveBeenCalledTimes(1);
		expect(onVolumeChange).not.toHaveBeenCalled();
	});

	it("leaves out the volume slider on devices whose buttons set the volume", () => {
		renderControls({ showVolumeSlider: false });
		expect(screen.queryByRole("slider", { name: "Volume" })).toBeNull();
		expect(screen.getByRole("button", { name: "Mute" })).toBeInTheDocument();
	});

	it("opens the channel info from the first button in the bar", () => {
		const onInfo = vi.fn();
		renderControls({ onInfo });
		const info = screen.getByRole("button", { name: "Channel info" });
		expect(screen.getAllByRole("button")[0]).toBe(info);
		fireEvent.click(info);
		expect(onInfo).toHaveBeenCalledTimes(1);
	});

	it("moves to the previous and next episode", () => {
		const onPrevEpisode = vi.fn();
		const onNextEpisode = vi.fn();
		renderControls({ onPrevEpisode, onNextEpisode });
		fireEvent.click(screen.getByRole("button", { name: "Previous episode" }));
		expect(onPrevEpisode).toHaveBeenCalledTimes(1);
		expect(onNextEpisode).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
		expect(onNextEpisode).toHaveBeenCalledTimes(1);
	});

	it("opens the subtitles and marks the button while they're on", () => {
		const onSubtitles = vi.fn();
		const view = renderControls({ onSubtitles });
		const subtitles = () => screen.getByRole("button", { name: "Subtitles" });
		expect(subtitles()).not.toHaveClass("text-blue-400");
		fireEvent.click(subtitles());
		expect(onSubtitles).toHaveBeenCalledTimes(1);
		view.rerender({ hasSubtitles: true });
		expect(subtitles()).toHaveClass("text-blue-400");
	});

	it("shows the download control it's given", () => {
		renderControls({ downloadSlot: <button type="button">Download</button> });
		expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
	});

	it("opens the keyboard shortcuts and names the key for them", () => {
		const onShortcuts = vi.fn();
		renderControls({ onShortcuts });
		const shortcuts = screen.getByRole("button", { name: "Keyboard shortcuts" });
		expect(shortcuts).toHaveAttribute("title", "Keyboard shortcuts (?)");
		fireEvent.click(shortcuts);
		expect(onShortcuts).toHaveBeenCalledTimes(1);
	});

	it("enters fullscreen and leaves it from the same button", () => {
		const onFullscreen = vi.fn();
		const view = renderControls({ onFullscreen });
		fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
		expect(onFullscreen).toHaveBeenCalledTimes(1);
		view.rerender({ isFullscreen: true });
		expect(screen.queryByRole("button", { name: "Fullscreen" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
		expect(onFullscreen).toHaveBeenCalledTimes(2);
	});
});

describe("Controls focus as they hide", () => {
	afterEach(cleanup);

	it("hands focus back when the bar hides with a control focused", () => {
		const onHideWithFocus = vi.fn();
		const view = renderControls({ onHideWithFocus });
		screen.getByRole("button", { name: "Stop" }).focus();
		view.rerender({ visible: false });
		expect(onHideWithFocus).toHaveBeenCalledTimes(1);
		// Not as the bar shows again.
		view.rerender({ visible: true });
		expect(onHideWithFocus).toHaveBeenCalledTimes(1);
	});

	it("hands focus back when the focused control goes away with the bar", () => {
		const onHideWithFocus = vi.fn();
		const sources = ["http://main.example.com/a.m3u8", "http://backup.example.com/a.ts"];
		const view = renderControls({ sources, onSelectSource: vi.fn(), onHideWithFocus });
		fireEvent.click(screen.getByRole("button", { name: "Source" }));
		screen.getByRole("menuitemradio", { name: /^Source 2/ }).focus();
		view.rerender({ visible: false });
		expect(screen.queryByRole("menu")).toBeNull();
		expect(onHideWithFocus).toHaveBeenCalledTimes(1);
	});

	it("leaves focus alone when it's somewhere else", () => {
		const onHideWithFocus = vi.fn();
		const view = renderControls({ onHideWithFocus });
		const outside = document.createElement("button");
		document.body.append(outside);
		onTestFinished(() => outside.remove());
		screen.getByRole("button", { name: "Stop" }).focus();
		outside.focus();
		view.rerender({ visible: false });
		expect(document.activeElement).toBe(outside);
		expect(onHideWithFocus).not.toHaveBeenCalled();
	});
});

describe("Controls autoplay toggle", () => {
	const autoplayToggle = () => screen.queryByRole("button", { name: /^Autoplay/ });

	it("turns autoplay on and off", () => {
		const onAutoplayChange = vi.fn();
		const view = renderControls({ autoplay: false, onAutoplayChange });
		fireEvent.click(screen.getByRole("button", { name: "Autoplay off" }));
		expect(onAutoplayChange).toHaveBeenLastCalledWith(true);
		view.rerender({ autoplay: true });
		fireEvent.click(screen.getByRole("button", { name: "Autoplay on" }));
		expect(onAutoplayChange).toHaveBeenLastCalledWith(false);
	});

	it("shows the toggle only for series, which have episode buttons", () => {
		const view = renderControls({
			onAutoplayChange: vi.fn(),
			onPrevEpisode: undefined,
			onNextEpisode: undefined,
		});
		expect(autoplayToggle()).toBeNull();
		// The first episode has no previous one, and the last has no next one.
		view.rerender({ onNextEpisode: noop });
		expect(autoplayToggle()).toBeInTheDocument();
		view.rerender({ onNextEpisode: undefined, onPrevEpisode: noop });
		expect(autoplayToggle()).toBeInTheDocument();
	});

	it("leaves out the toggle when autoplay can't be changed", () => {
		renderControls({ autoplay: true });
		expect(autoplayToggle()).toBeNull();
	});
});

describe("Controls source menu", () => {
	const sources = [
		"http://main.example.com/live/news.m3u8",
		"http://backup.example.com/live/news.ts",
	];
	const sourceButton = () => screen.getByRole("button", { name: "Source" });
	const openMenu = () => fireEvent.click(sourceButton());

	it("offers a choice only with two or more sources and a way to switch", () => {
		const view = renderControls({ onSelectSource: vi.fn() });
		expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
		view.rerender({ sources: [sources[0]] });
		expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
		view.rerender({ sources });
		expect(sourceButton()).toBeInTheDocument();
		view.rerender({ onSelectSource: undefined });
		expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
	});

	it("lists the sources in order, marking the default and the one playing", () => {
		renderControls({ sources, currentSource: sources[1], onSelectSource: vi.fn() });
		expect(sourceButton()).toHaveAttribute("aria-expanded", "false");
		openMenu();
		expect(sourceButton()).toHaveAttribute("aria-expanded", "true");
		const [first, second] = screen.getAllByRole("menuitemradio");
		expect(first).toHaveTextContent("Source 1 (default)");
		expect(first).toHaveTextContent("main.example.com · M3U8");
		expect(first).toHaveAttribute("aria-checked", "false");
		expect(second).toHaveTextContent("Source 2");
		expect(second).not.toHaveTextContent("(default)");
		expect(second).toHaveTextContent("backup.example.com · TS");
		expect(second).toHaveAttribute("aria-checked", "true");
		// The check mark is on the one playing only.
		expect(first.querySelector(".lucide-check")).toBeNull();
		expect(second.querySelector(".lucide-check")).not.toBeNull();
	});

	it("never shows the login an address carries", () => {
		const xtream = "http://xtream.example.com:8080/live/alice/hunter2/1001.ts";
		renderControls({ sources: [sources[0], xtream], onSelectSource: vi.fn() });
		openMenu();
		const menu = screen.getByRole("menu");
		expect(menu).toHaveTextContent("xtream.example.com · TS");
		expect(menu).not.toHaveTextContent("alice");
		expect(menu).not.toHaveTextContent("hunter2");
		// Nor in a tooltip or a label that screen readers read out.
		expect(menu.outerHTML).not.toMatch(/alice|hunter2/);
	});

	it("switches to the chosen source and closes the menu", () => {
		const onSelectSource = vi.fn();
		renderControls({ sources, currentSource: sources[0], onSelectSource });
		openMenu();
		fireEvent.click(screen.getByRole("menuitemradio", { name: /^Source 2/ }));
		expect(onSelectSource).toHaveBeenCalledTimes(1);
		expect(onSelectSource).toHaveBeenCalledWith(sources[1]);
		expect(screen.queryByRole("menu")).toBeNull();
		expect(sourceButton()).toHaveAttribute("aria-expanded", "false");
	});

	it("closes the menu without reloading when the playing source is chosen", () => {
		const onSelectSource = vi.fn();
		renderControls({ sources, currentSource: sources[0], onSelectSource });
		openMenu();
		fireEvent.click(screen.getByRole("menuitemradio", { name: /^Source 1/ }));
		expect(onSelectSource).not.toHaveBeenCalled();
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("closes the menu on a press outside it but not on one inside it", () => {
		renderControls({ sources, onSelectSource: vi.fn() });
		openMenu();
		fireEvent.pointerDown(screen.getByRole("menu"));
		expect(screen.getByRole("menu")).toBeInTheDocument();
		fireEvent.pointerDown(screen.getByRole("button", { name: "Stop" }));
		expect(screen.queryByRole("menu")).toBeNull();
		expect(sourceButton()).toHaveAttribute("aria-expanded", "false");
	});

	it("closes the menu when the source button is pressed again", () => {
		renderControls({ sources, onSelectSource: vi.fn() });
		openMenu();
		fireEvent.pointerDown(sourceButton());
		fireEvent.click(sourceButton());
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("closes the menu when the controls hide, and keeps it closed when they come back", () => {
		const view = renderControls({ sources, onSelectSource: vi.fn() });
		openMenu();
		view.rerender({ visible: false });
		expect(screen.queryByRole("menu")).toBeNull();
		view.rerender({ visible: true });
		expect(screen.queryByRole("menu")).toBeNull();
		expect(sourceButton()).toHaveAttribute("aria-expanded", "false");
	});
});

describe("Controls seek bar", () => {
	const renderSeekBar = (overrides: Partial<PlayerState> = {}) => {
		const onSeek = vi.fn();
		const onVolumeChange = vi.fn();
		const controls = (state: PlayerState) => (
			<Controls
				state={state}
				visible
				onPlay={noop}
				onPause={noop}
				onStop={noop}
				onSeek={onSeek}
				onVolumeChange={onVolumeChange}
			/>
		);
		const view = render(controls({ ...playing, ...overrides }));
		const thumb = () => screen.getByRole("slider", { name: "Seek" });
		// Radix puts the thumb in a positioned wrapper, after the track and its fill.
		const root = () => thumb().parentElement!.parentElement!;
		const track = () => root().firstElementChild!;
		return {
			onSeek,
			onVolumeChange,
			thumb,
			volume: () => screen.getByRole("slider", { name: "Volume" }),
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

	// jsdom has no pointer capture, so captures are kept here by pointer. As in browsers, a touch or pen press captures its pointer
	// before any handler runs, and the release lets it go after them.
	const captured = new Set<number>();
	const captureOnPress = (e: PointerEvent) => {
		if (e.pointerType === "touch" || e.pointerType === "pen") captured.add(e.pointerId);
	};
	const releaseAfterRelease = (e: PointerEvent) => void captured.delete(e.pointerId);
	installPointerEvent();
	const saved = {
		setPointerCapture: Element.prototype.setPointerCapture,
		hasPointerCapture: Element.prototype.hasPointerCapture,
		releasePointerCapture: Element.prototype.releasePointerCapture,
	};
	beforeAll(() => {
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

		it("turns the volume up one step per arrow when reached with Tab", () => {
			const bar = renderSeekBar();
			tabTo(bar.volume());
			fireEvent.keyDown(bar.volume(), { key: "ArrowRight" });
			expect(bar.onVolumeChange).toHaveBeenCalledExactlyOnceWith(101);
		});

		it("lets the volume go up to 150%", () => {
			const bar = renderSeekBar();
			expect(bar.volume()).toHaveAttribute("aria-valuemax", "150");
			tabTo(bar.volume());
			fireEvent.keyDown(bar.volume(), { key: "End" });
			expect(bar.onVolumeChange).toHaveBeenLastCalledWith(150);
		});

		it("leaves the arrows to the player after a click on the volume", () => {
			const bar = renderSeekBar();
			const onWindowKey = vi.fn();
			window.addEventListener("keydown", onWindowKey);
			try {
				clickThumb(bar.volume());
				expect(bar.volume()).toHaveFocus();
				fireEvent.keyDown(bar.volume(), { key: "ArrowRight" });
				expect(onWindowKey).toHaveBeenCalledTimes(1);
				expect(bar.onVolumeChange).not.toHaveBeenCalled();
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
